# GlassUI 第一期设计：核心运行时 + Liquid Glass 渲染 + 验证组件

日期：2026-10-07　状态：待审阅　范围：第一期（Phase 0–3）

## 0. 目标与非目标

**目标。** 一套在 three.js canvas 内渲染、在 canvas 内交互的 UI 组件库，用 Vue 3 语法编写，视觉按 Apple Liquid Glass（WWDC25/iOS 26）设计语言，容器可放在 3D 空间任意位置，也可铺在屏幕空间。主要使用者是 AI coding agent：API 可以复杂，但必须显式、强类型、自描述、错误可读。

**成功标准。**
1. 一个 agent 只读 `manifest.json` 与组件文档，就能用 `.vue` 写出一个含面板、按钮、输入框、开关、对话框的界面，在 Chrome（WebGPU）与 Safari/Firefox（WebGL2 回落）上长相一致。
2. 同一份 UI 代码，`root.screen.add(surface)` 像普通 App 一样全屏铺开；`root.world.add(surface)` 放进已有 three.js 场景，带透视、遮挡与射线交互。
3. 中文文本正确显示（含系统字体回退），输入框支持中文输入法 composition 并在正确位置弹出候选框。
4. 移动端中档 GPU 上，玻璃覆盖 ≤30% 屏幕时稳定 60 fps（质量分级自动降级）。

**非目标（后续期）。** Tailwind 组件全集；无障碍语义树；文档站；React 适配；WebXR 手柄/手势交互细节（只保证 `@pmndrs/pointer-events` 的射线路径不被架构堵死）；经典 `WebGLRenderer` 支持。

## 1. 已定决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 主场景 | 3D 与 2D 并重，核心按 3D 设计 | 用户要求 |
| 框架 | 真正的 Vue 3（`@vue/runtime-core` `createRenderer`） | agent 最熟悉的语法；底层仍框架无关 |
| 渲染后端 | three.js `WebGPURenderer` + TSL，自动回落 WebGL2 后端 | TSL 自带 viewport backdrop 节点；WebGLRenderer 不再加新功能 |
| 中文 | 显示与 IME 第一版硬需求 | 用户要求 |
| 节点模型 | 方案 C：自有轻量节点树 + `Surface` 是 `Object3D` | 性能、玻璃层序可控、2D/3D 一套模型、可挂进 TresJS |
| 不基于 pmndrs/uikit | 借鉴其设计，不依赖 | WebGL-only、中文不可用、IME 代理在屏幕外、v2 要重写 |
| 布局引擎 | yoga-layout 3（wasm），置于接口之后 | 成熟；Taffy wasm 绑定未正式发布 |
| 第一期范围 | 核心运行时 + 玻璃 + 11 个组件（含原语） | 控制 spec 与实现周期 |

## 2. 包结构

pnpm monorepo，TypeScript strict，Vite 构建，Vitest 单测，Playwright 做视觉回归。

```
packages/
  core/     @glassui/core    Node 树、样式/主题/token、Yoga 布局、事件与焦点、滚动、动画(spring)、渲染列表。不 import three。
  text/     @glassui/text    字体管理、字形 atlas 页、排版测量、换行。接口 + 两个实现（见 §6）。
  render/   @glassui/render  three.js 后端：TSL 材质、Surface 离屏 RT、backdrop 捕获与模糊金字塔、批处理、质量分级。
  vue/      @glassui/vue     Vue 自定义渲染器、组件库、组合式 API、tw 解析器、manifest 生成。
  tres/     @glassui/tres    TresJS extend 适配（薄）。
examples/
  playground/                Vite 应用：组件展厅、3D 场景示例、屏幕层示例、质量分级开关。
  visual/                    视觉回归场景（Playwright 截图，WebGPU 与 forceWebGL 各跑一次）。
docs/                        superpowers 规范与计划；组件文档后续期从 manifest 生成。
```

`core` 与 `text` 可在 Node 中无 GPU 测试（Yoga wasm 与 Canvas2D 测量可用 `@napi-rs/canvas` 或 jsdom 替身）。`render` 是唯一依赖 three 的包。

## 3. 运行时对象

### 3.1 `UIRoot`

每个 three 场景一个。持有 `renderer`、`camera`、`scene` 引用；`tick(delta)` 驱动布局、动画、渲染列表；创建 `@pmndrs/pointer-events` 的 forwarder，把 DOM 指针事件（鼠标/触摸/笔，以及 XR 射线）变为对节点的 `pointerdown/up/move/enter/leave/click/wheel`；维护焦点链与键盘事件；持有全局 `FontManager`、`QualityController`、`ImeBridge`（§7.3）。

```ts
const root = createUIRoot({ renderer, scene, camera, theme, quality: 'auto' })
root.screen   // ScreenLayer：面向相机的 Surface 容器，单位 CSS px，DPR 感知，位于相机近平面附近
root.world    // Object3D：挂进 scene 的世界层容器
root.tick(dt) // 在宿主 render loop 里调用，或 root.autoTick(true) 自管
```

### 3.2 `Surface extends THREE.Object3D`

一张"内容面"。属性：`size: { width, height }`（pt）、`ptPerUnit`（世界层：1 世界单位 = 多少 pt；屏幕层固定为 1 pt = 1 CSS px）、`background: 'none' | 'glass' | color`、`cornerRadius`、`shadow`、`billboard: boolean`、`interactive: boolean`、`contentScale`（RT 分辨率缩放）。

每个 Surface：
- 有自己的 Yoga 根与节点树（根节点由 Vue mount 产生）。
- 有自己的**内容层 RT**（RGBA8 或半浮点按质量档），尺寸 = 投影到屏幕的像素尺寸 × DPR（带上限与整数阶梯，避免抖动），只在脏时重绘；屏幕层静止时零开销。
- 以一个 quad 画进场景（深度写入开，便于被世界几何遮挡与遮挡世界几何）；玻璃元素作为额外 quad 画在其上。
- 屏幕层的 Surface 默认 `size` 跟随视口。

### 3.3 `Node`

Surface 内的轻量对象，**不是** `Object3D`。字段：

```ts
interface Node {
  id: string; type: NodeType; parent: Node | null; children: Node[]
  props: Readonly<Record<string, unknown>>  // zod 校验后的 props
  style: ResolvedStyle                       // 布局 + 外观 + 状态分支
  layout: { x: number; y: number; width: number; height: number } // 相对父节点，pt
  worldRect: Rect                            // 相对 Surface，布局后缓存
  state: { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean }
  elevation: number; tilt: { x: number; y: number }  // 不进 Yoga，仅进渲染 TBN
  dirty: DirtyFlags                          // layout | paint | text | tree
}
```

节点类型：`box`、`text`、`image`、`glass`（玻璃容器，见 §5）、`scroll`、`portal`（把子树投到另一个 Surface/图层，用于 Dialog、Popover、Toast）、`anchor`（零尺寸占位，供 Vue 片段/`v-if` 锚点）。

## 4. 样式、主题、动画

### 4.1 Style 对象是真相源

```ts
interface Style {
  // 布局（Yoga 子集，键名与 CSS 一致，值用数字 pt 或 token）
  display?: 'flex' | 'none'; position?: 'relative' | 'absolute'
  flexDirection?, justifyContent?, alignItems?, alignSelf?, flexWrap?, flex?, flexGrow?, flexShrink?, flexBasis?
  width?, height?, minWidth?, maxWidth?, minHeight?, maxHeight?, aspectRatio?
  padding?, paddingX?, paddingY?, paddingTop?... ; margin 同理 ; gap?, rowGap?, columnGap?
  top?, right?, bottom?, left?, inset?, overflow?: 'visible' | 'hidden' | 'scroll'
  // 外观
  bg?: ColorToken | 'glass' | 'glass-clear' | 'none'
  radius?: number | 'capsule' | 'concentric' | RadiusToken    // Apple 三类形状
  border?: { width: number; color: ColorToken }
  shadow?: ShadowToken | ShadowSpec
  opacity?: number
  // 排版（text 节点）
  font?: FontToken; fontSize?, fontWeight?, lineHeight?, letterSpacing?, textAlign?, color?: ColorToken, maxLines?, wrap?
  // 玻璃（glass 节点与 bg:'glass' 的节点）
  glass?: Partial<GlassParams>  // 见 §5.2
  // 状态分支（显式字段，不用伪类）
  hover?: Style; pressed?: Style; focused?: Style; disabled?: Style
  // 过渡
  transition?: Partial<Record<AnimatableKey, SpringToken | SpringSpec | { duration: number; easing: Easing }>>
}
```

未知键或非法值在 `setProp`/`setStyle` 时立即抛出可读错误（含最近合法项建议）。

### 4.2 `tw` 字符串糖

`tw="flex-row items-center gap-2 px-4 py-2 rounded-full bg-glass text-sm hover:scale-[1.03]"` 在运行时解析为 Style 对象（第一期运行时解析，Vite 编译期解析后置）。只实现对 canvas 有意义的子集：flex/grid 以外的布局、间距、尺寸、圆角、颜色、排版、阴影、opacity 以及 `hover:`/`focus:`/`active:`/`disabled:` 前缀。未知 class 报错并列出候选，绝不静默忽略。解析结果与同节点的 `style` prop 合并，`style` 优先。

### 4.3 主题与 token

`theme` 是一个纯对象：`colors`（语义色：accent/label/secondaryLabel/fill/…，含 light/dark 两套）、`spacing`（4pt 网格）、`radius`、`font`（字体族与字号阶梯）、`shadow`、`spring`（`snappy`/`smooth`/`bouncy`）、`glass`（默认 GlassParams）。`UIRoot` 持有主题；`<ThemeProvider>` 组件可在子树内覆盖。颜色在 Vue 侧为 token 名，渲染列表里解析为线性空间 RGBA。

### 4.4 动画

`core/animation`：弹簧（质量/刚度/阻尼或 Apple 风格 `response/dampingFraction`）与时长缓动两种驱动；可动画属性：位置、尺寸、scale、opacity、颜色、圆角、玻璃参数、elevation、tilt。每帧 `tick` 推进，写回节点的"视觉值"（与布局值分离，避免布局抖动）。`<Transition>` 的 enter/leave 映射到这套系统；玻璃的出现/消失按 Apple 做法调制折射强度与模糊而不是只调 opacity。

## 5. 渲染管线（`@glassui/render`）—— 真 3D

原则：既然 UI 在 3D 引擎里渲染，厚度、高光、反射、阴影、位移就用引擎的真实几何与光照实现，不在平面上用 shader 伪造。只有"透过玻璃看到后面的像"这一步物理上必须采样 backdrop，予以保留。

### 5.1 三类表面

1. **内容面（Surface 内容层）**：所有非玻璃节点（box/text/image/scroll 的内容）画到 Surface 自己的 RT。
2. **贴在内容面上的玻璃**：`glass` 节点与 `bg:'glass'` 的节点在同一 Surface 内，其 backdrop 就是该 Surface 的内容层 RT；折射射线穿过玻璃后与面板平面求交，交点换算成面板 UV 采样——任意 3D 变换下精确、无需屏幕捕获、可缓存。这是默认路径。
3. **悬浮玻璃**：`background:'glass'` 的 Surface 自身（浮在 3D 世界上的玻璃面板），折射射线投影到**屏幕空间 backdrop 捕获**。

Apple 规则"玻璃不采样玻璃"按默认遵守：类 2 玻璃只看内容层。提供 `physicalStacking: true` 选项，允许有限次（质量档上限）子矩形重捕获，用于故意叠玻璃的效果。

### 5.2 玻璃几何：`GlassSlab`

每个玻璃元素是一块有厚度、带倒角的实体：平面轮廓为超椭圆圆角矩形（胶囊/圆形用指数 2，固定半径用指数 ≈4.5），边缘为凸起 bezel 剖面（`squircle` / `circle` / `lip`），剖面 8–12 段、圆角 8–12 段，有正面、倒角面、侧面与背面。

网格参数化为 9-slice 形式：顶点携带 `anchor(±1,±1)`、`cornerOffset`（单位圆角上的位置）、`profileT`（剖面参数）属性，实际顶点位置在顶点着色器里由实例参数 `size / radius / bezel / thickness` 计算。因此**一个 Surface 内所有玻璃共用一份几何，用 instancing 一次绘制**；尺寸、圆角、厚度、按压缩放都是逐实例数据。GlassContainer 的形状融合在几何层做：相邻 slab 之间生成过渡几何（Phase 2 后半）。

### 5.3 玻璃材质（TSL，基于 PBR 节点材质）

以 `MeshPhysicalNodeMaterial` 的节点图为基础，替换其 transmission 分支：

- **光照与反射**：高光、Fresnel、环境反射来自宿主场景的灯与 PMREM 环境贴图。无宿主灯时 `UIRoot` 提供一盏默认 UI key light（方向光）和一张内置的小尺寸程序化棚拍环境图。Apple 的"沿光轴两侧细高光"由倒角面的真实法线自然产生，随相机/灯光/元素旋转而移动。
- **折射**：用真实法线做 Snell 折射，沿折射方向穿过 `thickness` 到达背面，再按 §5.1 投影到 backdrop 采样。
- **色散**：三通道不同 IOR（`ior ± (ior-1)·k·dispersion`），位移 < 0.25px 时自动退化为单次采样。
- **磨砂**：`roughness` → backdrop mip lod（与 three transmission 一致）；高质量档用 dual-Kawase 金字塔替代 mip 三线性。
- **Tint**：按路径长度做 Beer-Lambert 吸收 `exp(-σ·d)`，厚的玻璃颜色更深，大元素"更厚、更深"自动成立。
- **自适应亮度**：每个玻璃元素在金字塔最小层采样平均亮度，写入"每元素一个 texel"的 ping-pong 纹理并做时间平滑（τ≈0.2s）；前景文字材质读同一 texel 决定明/暗，无 CPU 回读。
- **按压内发光**：以指尖点为中心的发射项（`emissive`），随 `press` 弹簧变化。
- 深度测试开、写入关；类 3 玻璃拒绝"捕获深度 < 玻璃深度"的样本。

参数（`GlassParams`，全部有默认值，`theme.glass` 可覆盖，节点 `style.glass` 可覆盖）：

```ts
interface GlassParams {
  variant: 'regular' | 'clear'    // clear：低 roughness、低吸收，backdrop 亮时自动加 35% 暗化层
  thickness: number               // pt；默认随尺寸 clamp(minSide*0.08, 2, 10)
  bezel: number                   // 倒角宽 pt；默认 clamp(minSide*0.18, 6, 28)
  profile: 'squircle' | 'circle' | 'lip'
  ior: number                     // 1.5
  dispersion: number              // 0–1
  roughness: number               // 0–1 → 磨砂
  tint: ColorToken | null; absorption: number
  envIntensity: number; specularIntensity: number
  innerGlow: number
  adaptive: boolean
  cornerExponent: number          // 2 = 圆/胶囊；4–5 ≈ Apple 连续圆角（radius:'capsule' 隐含 2）
}
```

### 5.4 阴影

`UIRoot` 的 UI key light 渲染一张 **VSM**（方差阴影贴图，模糊半径可调，软阴影便宜）；所有 UI 几何（玻璃 slab、填充面板）既投射也接收：按钮投到面板上、面板投到世界几何上、Dialog 投到其下内容上。接触感来自真实的 `elevation` 距离。阴影贴图覆盖范围按可见 UI 包围盒自动拟合。低/minimal 质量档回落到解析高斯阴影贴片（Evan Wallace erf 法）。

### 5.5 面板、文字、图片

- **填充面板**（非玻璃 box）：薄平面 + 超椭圆 SDF 做形状与抗锯齿，受光材质（能接收阴影），支持填充/边框/渐变/裁剪；一个 Surface 内同层面板 instancing 一次绘制。
- **文字**：instanced glyph quad，采样字形 atlas，`fwidth` 抗锯齿；不受光（可读性优先，对应 Apple vibrancy）；颜色可读自适应亮度 texel；带 `elevation` 时沿法线抬升。
- **图片**：第一期单独 draw。

### 5.6 每帧流程

1. `core.tick` → 对每个脏 Surface 生成渲染列表与实例缓冲（面板实例、字形实例、玻璃实例、图片）。
2. **内容层重绘**：对脏的 Surface，用正交相机把其非玻璃列表画到该 Surface RT；若有类 2 玻璃，再为该 RT 建 2–4 层模糊金字塔（仅覆盖玻璃矩形并集 + 位移余量）。
3. **UI 阴影 pass**：UI key light 视角渲染所有 UI 几何到 VSM（仅在 UI 变换/布局脏时重绘）。
4. **世界渲染**：宿主场景 + 所有 Surface 内容 quad（深度写入）+ 填充面板。
5. **屏幕 backdrop 捕获**：仅当存在类 3 玻璃；TSL `viewportSharedTexture`/`viewportMipTexture` 取帧缓冲并建金字塔（scissor 到并集矩形）。
6. **玻璃与前景**：按从远到近画玻璃实例批次，再画其上的文字/图标。
7. MSAA 4× 开启（两个后端均支持）；质量档由 `QualityController` 用 GPU 计时或帧时间迟滞切换，并响应 `prefers-reduced-transparency` / `prefers-reduced-motion`。

| 档位 | backdrop | 模糊 | 玻璃 | 阴影 |
|---|---|---|---|---|
| high | 全分辨率半浮点 | dual-Kawase 4 层 | 色散 + 环境反射 + 真实折射 | VSM 2048 |
| medium（移动默认） | 半分辨率 RGBA8 | mip 3 层 | 色散仅 ≥0.25px 时 | VSM 1024 |
| low | 四分之一分辨率 | mip 2 层 | 无折射，tint + Fresnel | 解析阴影贴片 |
| minimal / 降低透明度 | 无 | 无 | 近不透明磨砂填充 + 边框 | 解析阴影贴片 |

### 5.7 WebGL2 回落

全部材质用 TSL 写，不写 WGSL/GLSL 字面量；不使用 MRT、compute；金字塔用普通 RT ping-pong；以 `forceWebGL: true` 跑同一套视觉回归。Phase 0 spike 已验证 `viewportMipTexture` 在两个后端行为一致（见 `docs/superpowers/spikes/`）。

## 6. 文字（`@glassui/text`）

接口：

```ts
interface TextEngine {
  measure(run: TextRun, constraints: { maxWidth?: number }): { width: number; height: number; lines: Line[] }
  layout(run: TextRun, rect): GlyphPlacement[]       // 每个字形：atlasPage, uv, x, y, w, h, advance
  caretFromPoint / selectionRects / caretRect        // 输入框用
  atlas: AtlasManager                                // 字形页纹理（2048², 多页），LRU 驱逐
}
```

两个实现，运行时按能力与字体来源选择：
1. **`SystemFontEngine`（第一期默认，兜底）**：Canvas2D 测量与栅格化，按需把字形写进 atlas 页；支持系统字体回退（中文直接用系统 PingFang/Noto），`fontSize` 分档栅格化 + 轻微超采样；旋转/缩放较大时清晰度不如 SDF，但永远不缺字。
2. **`MsdfEngine`（可选）**：对接 `@pmndrs/glyph`（HarfRust 排版、MSDF/Slug、TSL），适合自带字体文件的拉丁/品牌字体与大幅缩放的 3D 文字。Phase 0 spike 决定其在第一期是"默认拉丁 + 系统字体兜底 CJK"还是整体后置。

`Text` 节点在 Yoga 测量回调里调用 `measure`，结果缓存键为（文本、样式、约束）。

## 7. 交互

### 7.1 指针

`@pmndrs/pointer-events` 对 Surface quad 做射线命中（屏幕层与世界层统一），命中点换算为 Surface pt 坐标后，由 `core` 做节点级命中测试（考虑圆角、裁剪、`pointerEvents: 'none'`、elevation 偏移），派发冒泡事件：`pointerdown/up/move/enter/leave/cancel`、`click`、`dblclick`、`wheel`、`contextmenu`。事件对象带 `localX/localY`（节点内 pt）、`surfacePoint`、`worldPoint`、`pointerType`。

### 7.2 焦点与键盘

`UIRoot` 维护焦点节点；`tabIndex` 决定 Tab 顺序（按树序）；键盘事件来自 canvas 的 `keydown/keyup`（canvas `tabindex=0`）或 IME 代理。焦点环：玻璃 `glint` 增强 + 外描边，按 `focusVisible` 规则只在键盘导航时显示。

### 7.3 文本输入与 IME（`ImeBridge`）

Flutter web 方案：一个透明的代理 `<textarea>`（`caret-color: transparent`，`opacity: 0.01`，`position: fixed`），当 `Input`/`TextArea` 节点获得焦点时，**定位到该节点光标矩形在屏幕上的投影位置**（世界层也投影），使系统 IME 候选框出现在正确位置；监听 `beforeinput/input/compositionstart/update/end/keydown/select`，把值、选区、组合中文本同步回节点；组合中文本在 canvas 内带下划线绘制。剪贴板、撤销、系统快捷键由代理原生提供。Chromium 上若有 `EditContext` 则优先使用（可直接上报字符边界）。移动端软键盘弹出不改变 canvas 布局，由屏幕层 `safeArea` 响应 `visualViewport`。

### 7.4 滚动

`scroll` 节点：裁剪矩形 + 内容偏移；`wheel`/拖拽/惯性（指数衰减）+ 边界回弹（spring）；嵌套滚动按方向锁定；滚动条为节点内绘制的薄面板，闲置淡出。

## 8. Vue 层（`@glassui/vue`）

### 8.1 渲染器

`createRenderer<Node, Node>` 的 `nodeOps`：`createElement(tag)` 按 tag 创建 Node（`box/text/image/glass/scroll/portal/surface`）；`createText/createComment` → `text`/`anchor` 节点；`insert(child, parent, anchor)`/`remove`；`patchProp(el, key, prev, next)` → `el.setProp(key, next)`（`on*` 转事件监听，`style`/`tw`/`class` 走样式合并）；`parentNode/nextSibling/querySelector`（后者仅限 id）。Vue 的 `<Teleport to="portal-name">` 映射为 `portal` 节点；`<Transition>` 使用 §4.4。

入口：

```ts
const app = createGlassApp(App, { root })       // 返回 Vue App
app.mount(root.screen.createSurface({ fill: true }))  // 或 mount(someSurface)
```

模板内也能声明 Surface：`<Surface :size="{width:400,height:300}" :position="[0,1.5,-2]" :rotation="[0,-0.3,0]" background="glass">…</Surface>`，渲染器把它创建为 Surface 并挂到当前上下文（屏幕层或世界层，由最近的 `<ScreenLayer>`/`<WorldLayer>` 或 mount 目标决定）。

与宿主 DOM Vue 应用共享状态：`createGlassApp(App, { parent: hostApp })` 复制宿主的 `provide` 与全局组件/插件（Pinia、i18n）。

### 8.2 第一期组件

| 组件 | 说明 | 关键 props / events / slots |
|---|---|---|
| `Surface` | 内容面，见 §3.2 | size, position, rotation, scale, background, radius, shadow, billboard |
| `Box` | 通用容器（div） | style, tw；slot default |
| `Text` | 文本（含富文本片段数组） | value 或 slot，font/size/weight/color、maxLines、selectable |
| `Icon` | 内置 SF-Symbols 风格 SVG 图标集的子集（路径栅格到 atlas） | name, size, color |
| `Stack` | HStack/VStack/ZStack 糖 | direction, gap, align, justify |
| `Button` | 玻璃按钮 | variant: `glass`/`glassProminent`/`filled`/`tinted`/`plain`，size，shape，loading，disabled；`@press`；slot default/leading/trailing |
| `Input` | 单行文本输入 | modelValue(v-model), placeholder, type(text/password/number), clearable, leading/trailing slot；`@submit` |
| `Switch` | 开关 | v-model:checked；spring 拨杆 + 按压拉伸 |
| `Checkbox` | 复选 | v-model:checked, indeterminate |
| `Dialog` | 模态，走 Portal 到顶层 Surface，背景暗化 + 玻璃面板缩放入场 | v-model:open, title, closeOnBackdrop；slot default/footer |
| `GlassContainer` | 对应 Apple `GlassEffectContainer`：子玻璃形状按 `spacing` 融合，支持 `glassId` 形变过渡 | spacing；slot |

每个组件：`defineComponent` + zod props schema → 自动导出到 `manifest.json`（名称、描述、props 的类型/默认值/取值说明、events 的 payload、slots、2–3 个示例片段、常见错误）。组件内部只用 `Box/Text/Icon/glass` 原语与 Style，不直接碰 render 包。

### 8.3 Liquid Glass 组件规范（在组件层固定）

- 玻璃只用于控制层（按钮、输入框、开关、对话框面板、工具条）；内容区用填充色与 vibrancy，不叠玻璃。
- 形状：按钮默认 capsule；面板固定半径；嵌套子元素默认 `radius: 'concentric'`。
- 按压：`scale 0.96 → spring('snappy')`，指尖处内发光；悬停：`glint` 增强 + 轻微 `tilt`（≤3°，仅指针设备）。
- 出现/消失：折射与模糊强度从 0 调制到目标值，同时 scale 0.9→1。
- `prefers-reduced-transparency` → minimal 档；`prefers-reduced-motion` → 关闭弹性与 tilt；`prefers-contrast` → 黑/白实心 + 边框。

## 9. 错误处理

- props/style/tw 校验失败：同步抛出 `GlassUIError`，消息格式 `[<Component>.<prop>] <原因>。允许值：… 你可能想要：…`。开发模式还在 canvas 内画出错误标记。
- 字体加载失败：回退到系统字体引擎并 `console.warn` 一次。
- WebGPU 初始化失败：three 自动回落；若 WebGL2 也不可用，`createUIRoot` reject，带可读原因。
- 质量档降级：触发 `root.on('quality', …)` 事件，可观察。
- 渲染循环内的异常不吞：捕获后停止该 Surface 的渲染并发 `surface.on('error')`，其它 Surface 继续。

## 10. 测试

- **core/text（Node，无 GPU）**：Vitest。样式解析与 tw 解析（含错误消息快照）、Yoga 布局结果、事件冒泡与命中测试（圆角、裁剪、elevation）、焦点顺序、滚动物理、spring 数值、文字测量与换行（中英混排）、manifest 生成。
- **vue**：Vitest + 自定义渲染器挂到内存 Surface：`v-if/v-for/slots/Teleport/Transition` 的节点树快照；组件 props 校验。
- **render（浏览器）**：Playwright 跑 `examples/visual`，WebGPU 与 `forceWebGL` 各一遍，像素比对（阈值）；覆盖每个组件各状态、屏幕层/世界层、玻璃四档、中文文本、IME 组合态截图。
- **性能基线**：playground 内置 100 按钮 + 20 玻璃容器场景，记录帧时间与 draw call 数，CI 上只做回归阈值（Chrome headless，WebGL 路径）。
- **IME**：Playwright 的 `keyboard.imeSetComposition` 做组合输入的自动化；真机手工检查清单（iOS Safari、Android Chrome、macOS 中文输入法）。

## 11. 实施分期

- **Phase 0 · 风险 spike（可抛弃）**：① TSL `viewportSharedTexture`/mip 节点在 WebGPU 与 WebGL2 后端的行为、一致性与成本；② 单 quad 玻璃 shader 原型（SDF + LUT 折射 + 色散 + glint）贴在一张离屏 RT 上，任意旋转下验证正确；③ `@pmndrs/glyph` 0.1 中文表现 vs Canvas2D atlas。产出：三个结论写进 `docs/superpowers/spikes/`，并回填本 spec 的 §5/§6。
- **Phase 1 · core + text**：Node/Style/tw/theme、Yoga、事件/焦点/滚动、spring、SystemFontEngine、渲染列表；全部可在 Node 测试。
- **Phase 2 · render**：Surface RT、面板/文字/阴影材质、玻璃材质与金字塔、屏幕层/世界层、质量分级；playground 可视。
- **Phase 3 · vue + 组件**：渲染器、11 个组件、Dialog/Portal、IME 桥、manifest、视觉回归、性能基线。

## 12. 待后续期的问题（已知、不阻塞）

无障碍语义树（Flutter/Babylon 式并行 ARIA DOM）；组件全集（Select、Tabs、Table、Menu、Slider、Segmented、Toast、Tooltip、DatePicker…）；Vite 编译期 `tw`；文档站；React 适配；Taffy（CSS Grid）；阴影投到任意世界几何；WebXR 手势与系统键盘。

## 13. 参考

- Apple：WWDC25 219 "Meet Liquid Glass"、356 "Get to know the new design system"、323；HIG Materials；"Applying Liquid Glass to custom views"。
- 实现参考：kube.io liquid glass 深潜（高度轮廓/折射）、iyinchao/liquid-glass-studio（WebGL2/WebGPU）、whynotmake-it/flutter_liquid_glass（几何缓存、smin 角度修正、双壁 glint）、Evan Wallace 圆角矩形阴影、Bjørge dual-Kawase。
- 生态：three.js r186 WebGPURenderer/TSL；yoga-layout 3.2；@pmndrs/pointer-events；@pmndrs/glyph 0.1；TresJS 5.9（nodeOps 模板）；Flutter web `text_editing.dart`（IME 代理）。
