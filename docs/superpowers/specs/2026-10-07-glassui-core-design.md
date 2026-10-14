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

每个 three 场景一个。持有 `renderer`、`camera`、`scene` 引用；`tick(delta)` 驱动布局、动画、渲染列表；创建 `@pmndrs/pointer-events` 的 forwarder，把 DOM 指针事件（鼠标/触摸/笔，以及 XR 射线）变为对节点的 `pointerdown/up/move/enter/leave/click/wheel`；维护焦点链与键盘事件；持有全局 `FontManager`、`QualityController`、`ImeBridge`（§7.3）。（Plan 2：没有单独的 `FontManager`，root 持有 `text`（`TextEngine`，默认 `SystemFontEngine`）与各 Surface 共享的字形 atlas 页；`ImeBridge` 后置。）

```ts
const root = await createUIRoot({ renderer, scene, camera, theme, quality: 'auto' })
root.screen   // ScreenLayer：面向相机的 Surface 容器，单位 CSS px，DPR 感知，位于相机近平面附近
root.world    // Object3D：挂进 scene 的世界层容器
root.tick(dt) // 在宿主 render loop 里调用，或 root.autoTick(true) 自管
```

`createUIRoot` 默认以 **overlay 模式** 工作：UI 有自己的 `Scene`，在宿主场景之后用同一相机、共享深度缓冲渲染（世界层 Surface 仍被宿主几何遮挡、也遮挡宿主几何），灯光与环境贴图由 UI 场景独享，因此 §5.4 的"只在 Surface 内投影"自然成立（但阴影贴图的类型是渲染器级设置：root 在两种模式下都把 `renderer.shadowMap` 切到 VSM 并开启 `transmitted`，宿主自己的阴影也随之改变；保存/恢复宿主设置后置，§12）；`mode: 'shared'` 把图层挂进宿主场景（宿主灯光生效，UI 阴影可能落到宿主的 receiveShadow 物体上；宿主场景没有 `environment` 时才设为 UI 所用的环境图：默认棚拍，或传入的 `Texture`）。

实现（Plan 2，`packages/render/src/root.ts`）：`createUIRoot` 是 async（先 `await renderer.init()`，失败时 reject `GlassUIError`）。选项：`renderer, scene, camera, theme?, scheme?`（默认 `'light'`）`, quality?: QualityTier | 'auto'`（默认 `'auto'`；未知档位名在动渲染器之前就 reject `GlassUIError`，`root.quality.set()` 同样同步抛出）`, text?: TextEngine`（默认 `SystemFontEngine`）`, createCanvas?, environment?: 'studio' | Texture | null`（默认 `'studio'`）`, mode?: 'overlay' | 'shared'`（默认 `'overlay'`）`, pointer?, keyboard?`（默认 true）`, reducedMotion?, reducedTransparency?`（默认取媒体查询，并订阅其 `change` 实时跟随、`dispose` 时退订；显式传入则固定，不读也不跟随媒体查询）。`UIRoot` 成员：`screen, world, uiScene, lights, theme, scheme, text, quality`（`QualityController`）`, anim`（`AnimationRuntime`）`, surfaces, pointer`（`PointerBridge | null`）`, backend`（`'webgpu' | 'webgl2' | 'unknown'`）；`createSurface({ layer?: 'screen' | 'world', fill?, left?, top?, ...SurfaceOptions })`（屏幕层 `fill` 跟随视口，否则左上角在 CSS px `left/top`；世界层 `ptPerUnit` 默认 244）、`removeSurface(s)`、`tick(dt)`（秒；布局、动画、内容 pass、绘制顺序、阴影拟合，不画）、`render()`（overlay：先宿主场景再叠 UI 场景；shared：宿主场景）、`renderUI()`（overlay：宿主已自己画过时只叠 UI；两者调用后 `renderer.autoClear` 恢复为宿主原值）、`frame(nowMs?)`（钳制 dt 的 `tick` + `render`，`'auto'` 时顺带采样画质）、`autoTick(on)`（经 `renderer.setAnimationLoop` 每帧调 `frame`；`autoTick(false)` 只清除自己装上的循环）、`on('quality' | 'error', fn)`（返回取消函数）、`dispose()`。指针与键盘由自带的 `PointerBridge`（canvas DOM 事件 → 射线 → Surface pt）处理；`@pmndrs/pointer-events` forwarder 与 `ImeBridge` 后置（§12）。

### 3.2 `Surface extends THREE.Object3D`

一张"内容面"。属性：`size: { width, height }`（pt）、`ptPerUnit`（世界层：1 世界单位 = 多少 pt；屏幕层固定为 1 pt = 1 CSS px）、`background: 'none' | 'glass' | color`、`cornerRadius`、`shadow`、`billboard: boolean`、`interactive: boolean`、`contentScale`（RT 分辨率缩放）。（Plan 2：内容层 RT 每 CSS px 至少 1 texel——它就是内容 quad 显示的图像；质量档的 `contentScale` 只限制 DPR > 1 时的超采样，Surface 自己的 `contentScale` 再乘在其上。）

每个 Surface：
- 有自己的 Yoga 根与节点树（根节点由 Vue mount 产生）。
- 有自己的**内容层 RT**（RGBA8 或半浮点按质量档），尺寸 = 投影到屏幕的像素尺寸 × DPR（带上限与整数阶梯，避免抖动），只在脏时重绘；屏幕层静止时零开销。
- 以一个 quad 画进场景（深度写入开，便于被世界几何遮挡与遮挡世界几何）；玻璃元素作为额外 quad 画在其上。
- 屏幕层的 Surface 默认 `size` 跟随视口。（Plan 2：只有 `createSurface({ fill: true })` 才跟随视口；否则保持给定的 `width/height`，左上角放在 CSS px `left/top`，默认 0, 0。）

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

   实现（Plan 2）：玻璃（类 2 与类 3 的底板）只在 `high` 档画背面→正面两遍（`QualityProfile.backFaces`），其余档只画正面一遍；底边亮带与轮廓由装饰层（`rim`）提供。`background: 'glass'` 的 Surface 上，元素玻璃在内容层 RT 透明处复用底板那一次屏幕捕获补上"板后"的像素（按底板的磨砂等级与提亮；`high` 档带深度剔除）——底板是该 Surface 的第一笔绘制，捕获早于它，所以不多一次拷贝、也不采样自己的底板与内容，同一 Surface 内"玻璃不采样玻璃"仍然成立。`background: 'none'` 的 Surface 不做屏幕捕获，其元素玻璃在内容透明处折射为黑（已知限制，§12）。
3. **悬浮玻璃**：`background:'glass'` 的 Surface 自身（浮在 3D 世界上的玻璃面板），折射射线投影到**屏幕空间 backdrop 捕获**。

Apple 规则"玻璃不采样玻璃"按默认遵守：类 2 玻璃只看内容层。提供 `physicalStacking: true` 选项，允许有限次（质量档上限）子矩形重捕获，用于故意叠玻璃的效果。`physicalStacking` 后置（见 §12）。

### 5.2 玻璃几何：`GlassSlab`

每个玻璃元素是一块有厚度的实体：平面轮廓为超椭圆圆角矩形（胶囊/圆形用指数 2，固定半径用指数 ≈4.5）。剖面（spike 验证后的结论）：

- **`fillet`（默认）**：竖直侧壁 + 顶面小半径圆角 + 平顶，底边也有更小的圆角。按钮默认 厚度 = 高度 × 0.2，顶圆角 = 高度 × 0.06，底圆角 = 高度 × 0.04（参考 80pt 高按钮：16 / 5 / 3 pt）。这是"直角的干练 + 圆润精致"的来源；更大的圆角或枕形剖面会显得像塑料糖。
- **`lens`**（`squircle` / `circle` 凸起剖面）：只用于圆环、装饰性元素。

网格参数化为 9-slice 形式：顶点携带 `anchor(±1,±1)`、`cornerOffset`、`profileT` 属性，实际位置在顶点着色器里由实例参数 `size / radius / thickness / fillet / filletBottom` 计算。因此**一个 Surface 内所有玻璃共用一份几何，用 instancing 一次绘制**；尺寸、圆角、厚度、按压缩放都是逐实例数据。玻璃元素按**背面→正面**两遍绘制（背面先画，正面采样含背面的画面），让底边亮带与内部反光出现（Plan 2：仅 `high` 档，见 §5.1）。GlassContainer 的形状融合在几何层做（Phase 2 后半；Plan 2 未做，随组件进 Plan 3，§12）。

### 5.3 玻璃材质（TSL，基于 PBR 节点材质）

以 `MeshPhysicalNodeMaterial` 为基础，用其内置的 `backdropNode / backdropAlphaNode` 钩子替换 diffuse 项（spike 验证：specular、Fresnel、环境反射、iridescence 仍由引擎提供，不需要改 three 内部）。一个玻璃元素由三层组成——这是 spike 中确认的"下面色块 + 上面一层超薄透明玻璃"结构：

1. **玻璃壳**：透明（散射 ≈5%），真实法线做 Snell 折射、穿过真实厚度投影到 backdrop 采样；三通道不同 IOR 做色散；`roughness` → 模糊等级；边缘按 Fresnel 加内发光（`edgeGlow`）。
2. **发光层**（有色元素）：不用实心吸收色，而是材质内的发光项 `emissive = color × (0.55 + 1.2·Fresnel) × strength`，可按 uv 做软分割（开关的左半亮、右半不亮）。颜色属于材质本身，任何角度都没有覆盖错误。主按钮、开关、强调卡片都用这一层。
3. **装饰层**（平面贴片，§5.5）：轮廓细亮线 + 底边亮带、元素下方的透射光晕。

其它：
- **光照与反射**：来自宿主场景的灯与 PMREM 环境贴图。无宿主灯时 `UIRoot` 提供默认 UI key light 和一张内置的**程序化棚拍环境图**（左上大柔光箱 + 底部细光带 + 一个小热点）；均匀的环境图（如 RoomEnvironment）出不来顶边那条亮线。（Plan 2：`UIRoot` 总是创建 UI key light + hemi，随相机移动；overlay 模式下宿主灯不照 UI，见 §3.1。）
- **自适应亮度**：每个玻璃元素在金字塔最小层采样平均亮度，写入"每元素一个 texel"的 ping-pong 纹理并做时间平滑（τ≈0.2s）；前景文字材质读同一 texel 决定明/暗，无 CPU 回读。
  实现（Plan 2）：`setLuma(texture, count)` 的 `count` 是 luma 纹理的宽度（pass 的 `maxCount`），texel `i` 对应玻璃批次第 `i` 个实例；只有 `variant: 'clear'` 且 `adaptive` 的实例带 luma 索引，luma ≥ 0.6 时其透射项 × 0.65。luma 取元素实际看到的背景：内容层（预乘）+ (1 − α)·磨砂后的屏幕（`background: 'glass'` 时取底板上一帧的屏幕捕获，按元素投影到屏幕的包围盒采样；其余 Surface 只取内容层）。每个元素 3×3 次采样，读内容层 RT 的 mip（不是金字塔），层级按元素在 RT 中的短边取 `max(log2(min(w, h)/6), 0)`，半精度目标纹理，τ ≈ 0.2 s 指数平滑。运行频率：`'glass'` Surface 上有 clear+adaptive 玻璃时每帧运行；其余情况在内容重绘后运行 1 s（帧时间）再停。前景文字读 luma 后置（§12）。
- **按压内发光**：以指尖点为中心的发射项，随 `press` 弹簧变化。
- 深度测试开、写入关；类 3 玻璃拒绝"捕获深度 < 玻璃深度"的样本（Plan 2：仅 `high` 档）。
- 灯光预算：不做 tone mapping，hemi + key + env 总量控制在 ≈1，否则白玻璃过曝。

参数（`GlassParams`，全部有默认值，`theme.glass` 可覆盖，节点 `style.glass` 可覆盖）：

```ts
interface GlassParams {
  variant: 'regular' | 'clear'    // clear：低 roughness、低吸收，backdrop 亮时自动加 35% 暗化层
  thickness: number               // pt；默认 minSide*0.2
  fillet: number; filletBottom: number   // 顶/底圆角 pt；默认 minSide*0.06 / *0.04
  profile: 'fillet' | 'lens'
  scatter: number                 // 0–1 磨砂散射比例（透明玻璃 ≈0.05，磨砂面板 ≈0.12–0.5）
  lift: number                    // 透射项向白混合（磨砂层对天光的反射）
  edgeGlow: number                // Fresnel 边缘内发光
  glow: { color: ColorToken; strength: number; split?: number } | null   // 发光层
  ior: number                     // 1.5
  dispersion: number              // 0–1
  roughness: number               // 0–1 → 磨砂
  tint: ColorToken | null; absorption: number   // 吸收仅用于淡淡的染色；饱和色用 glow
  envIntensity: number; specularIntensity: number
  innerGlow: number
  adaptive: boolean
  cornerExponent: number          // 2 = 圆/胶囊；4–5 ≈ Apple 连续圆角（radius:'capsule' 隐含 2）
}
```

### 5.4 阴影与反射

- `UIRoot` 的 UI key light 渲染一张 **VSM**；`renderer.shadowMap.transmitted = true` + `material.castShadowNode = vec4(透过色, alpha)` 得到**彩色透射阴影**（three 原生，spike 验证），彩色玻璃下方自然有同色阴影。（Plan 2：透过色按实例 opacity 向白色淡出，opacity ≤ 0.01 的玻璃经 `maskShadowNode` 不写阴影贴图，淡出的玻璃不再留下整块阴影。）
- **默认只在 Surface 内部投影**：元素投到自己的 Surface 上；Surface 本身不投到世界几何上（`castToWorld: false`），世界几何也不接收 UI 阴影——spike 里投到背景墙的影子透过半透明面板看起来是脏的。需要时可逐 Surface 打开（Plan 2：`castToWorld` 只有字段、尚未生效，§12）。
- 注意 VSM 下 `receiveShadow` 的物体也会被画进阴影贴图，布景要同时关掉 cast 与 receive。
- 阴影贴图覆盖范围按可见 UI 包围盒自动拟合；低/minimal 档回落到解析高斯阴影贴片（Plan 2：贴片后置，目前用 512 VSM，见 §5.6）。
- **面板反射**：玻璃元素把反射方向镜像到面板平面下方、与面板求交后采样内容层 RT（按磨砂取模糊层级，按 Fresnel × 0.2 混入）；不再用 `reflector` 重画场景。Surface 自身的玻璃底板不再倒映控件（spike 的 reflector 路径未移植进 `@glassui/render`）。实现细节：取内容层 RT 的 mip（层级 = 磨砂层级 + 2，`high` 档也不用金字塔），以预乘 over 混入，内容透明处不反射。

### 5.5 面板、文字、图片

- **填充面板**（非玻璃 box）：薄平面 + 超椭圆 SDF 做形状与抗锯齿，受光材质（能接收阴影），支持填充/边框/渐变/裁剪；一个 Surface 内同层面板 instancing 一次绘制。
- **文字**：instanced glyph quad，采样字形 atlas，`fwidth` 抗锯齿；不受光（可读性优先，对应 Apple vibrancy）；颜色可读自适应亮度 texel；带 `elevation` 时沿法线抬升。
- **图片**：第一期单独 draw。
- **装饰层**（Canvas2D/SDF 平面贴片，挂在元素顶面上，随元素抬升/倾斜/缩放）：`rim`（轮廓细亮线 + 顶/底边亮带）、`pool`（元素下方叠加混合的透射光晕，颜色取发光色或白）、小部件（checkbox 的勾、开关滑块、输入框图标、角标圆点）。原则：真 3D 负责形体、厚度、投影、反射、透视；"晶莹感"的光学特征作为可配置装饰层叠在几何上。**不是所有东西都该是几何**：开关滑块、角标、分段控件的灰段等用平面贴片更干净。

### 5.6 每帧流程

1. `core.tick` → 对每个脏 Surface 生成渲染列表与实例缓冲（面板实例、字形实例、玻璃实例、图片）。
2. **内容层重绘**：对脏的 Surface，用正交相机把其非玻璃列表画到该 Surface RT；若有类 2 玻璃，再为该 RT 建 2–4 层模糊金字塔（仅覆盖玻璃矩形并集 + 位移余量）。

   实现（Plan 2）：`high` 档的模糊是 4 层 dual-Kawase 金字塔（RGBA、texel 类型随内容 RT），覆盖整张内容 RT（未裁剪到玻璃并集，也不论有无玻璃），只在内容 RT 重绘时、且 Surface 有玻璃实例时重建（没有玻璃时跳过，玻璃出现后补画；每次重建 9 个 pass：5 次下采样 + 4 次上采样，层 i = 上采样(下采样 i+1)，RMS 半径约 5/10/20/41 texel；玻璃按 roughness 在清晰层与各层间插值）；其余档位用内容 RT 的 mip 链（`lod = roughness × 8`）。
3. **UI 阴影 pass**：UI key light 视角渲染所有 UI 几何到 VSM（仅在 UI 变换/布局脏时重绘）。

   实现（Plan 2）：阴影相机按可见 Surface 的包围盒（内容面到最高玻璃顶面）拟合（`fitShadowCamera`，边距为并集最长边的 5 %）；`shadow.autoUpdate = false`，只在相机移动（灯随相机）、Surface 位姿变化或增删、内容需重绘或动画进行中才重新拟合并 `needsUpdate`，换档时也重绘一次。屏幕层与世界层 Surface 共用这一次拟合与一张 VSM：两者同时存在时（如 playground `?scene=both`）屏幕层 Surface 在世界单位里很小，分到的阴影纹素不足（已知限制，§12）。
4. **世界渲染**：宿主场景 + 所有 Surface 内容 quad（深度写入）+ 填充面板。
5. **屏幕 backdrop 捕获**：仅当存在类 3 玻璃；TSL `viewportSharedTexture`/`viewportMipTexture` 取帧缓冲并建金字塔（scissor 到并集矩形）。

   实现（Plan 2）：每个 `background: 'glass'` 的 Surface 每帧一次整帧缓冲拷贝（`ScreenCapture`，带 mip，未 scissor、无金字塔；minimal 档没有材质引用它，不拷贝），在其底板处取得；同一 Surface 的元素玻璃与 luma 复用它，`high` 档的深度剔除另有一次共享的深度拷贝。
6. **玻璃与前景**：按从远到近画玻璃实例批次，再画其上的文字/图标。
7. MSAA 4× 开启（两个后端均支持）；质量档由 `QualityController` 用 GPU 计时或帧时间迟滞切换，并响应 `prefers-reduced-transparency` / `prefers-reduced-motion`。

   实现（Plan 2）：MSAA 由宿主 renderer 的 `antialias` 决定（playground 开启），内容层 RT 不开 MSAA（面板与文字靠 SDF / `fwidth` 抗锯齿）。显式 `quality` 档位不采样、不自动升降（仍可 `root.quality.set()`），只有 `'auto'` 自适应：初始档按设备（触屏 `medium`，否则 `high`，也是升档上限）；样本以刷新率为基准（`FrameSampler`：最近 60 个帧间隔的最小值为刷新周期 P，钳 4–40 ms；间隔 > 1.5 P 算掉帧、样本取该间隔，否则取 tick+render 的 CPU 时间；> 250 ms 视为暂停、不计）；30 帧一窗，连续 2 窗均值 > 20 ms 降一档，连续 5 窗 < 10 ms 升一档；被自动降过 d 次的档，升回需 5·2^max(0, d−1) 个快窗，降过 3 次后不再自动升回。这个以刷新率为基准的采样有明确的盲区：P 取最近间隔的最小值，所以一个稳定的、受 GPU 限制的帧率（约 17 到 60 fps 之间，间隔从不超过 1.5 P，P 上限 40 ms）会被当成显示器的刷新周期，样本只剩很小的 CPU 时间，`'auto'` 不会降档；只有不稳定的掉帧（或低于约 17 fps）才触发降档。GPU 时间戳查询、以空闲 rAF 间隔初始化 P 等后置（§12）。`prefers-reduced-transparency` 钉在 `minimal`（不采样），`root.quality.setReducedTransparency(false)` 解除后回到钉住期间 `set` 的档，否则回到上限档；未显式传入 `reducedTransparency` / `reducedMotion` 时，两个媒体查询实时跟随（订阅 `change`：钉住/解除 `minimal`、切换 `root.anim.reducedMotion`；`dispose` 时退订），显式传入则固定。

| 档位 | backdrop | 模糊 | 玻璃 | 阴影 |
|---|---|---|---|---|
| high | 全分辨率半浮点 | dual-Kawase 4 层 | 色散 + 环境反射 + 真实折射 | VSM 2048 |
| medium（移动默认） | 半分辨率 RGBA8 | mip 3 层 | 色散仅 ≥0.25px 时 | VSM 1024 |
| low | 四分之一分辨率 | mip 2 层 | 无折射，tint + Fresnel | 解析阴影贴片 |
| minimal / 降低透明度 | 无 | 无 | 近不透明磨砂填充 + 边框 | 解析阴影贴片 |

实现（Plan 2，`QUALITY`）：各档实际差别是内容层 RT 的 texel 类型与超采样上限（high 半浮点 × 1；medium RGBA8 × 0.5；low / minimal RGBA8 × 0.25——RT 每 CSS px 取 `dpr × max(contentScale, 1/dpr)` 个 texel，即永不低于 1 texel / CSS px，比例只在 DPR > 1 时生效：内容 quad 显示的就是这张 RT，"半分辨率 backdrop"不能让文字也降到半分辨率）、背面遍与深度剔除（仅 high）、模糊（high 金字塔，其余 mip）、玻璃模式（`glassMode`）与 VSM 尺寸（2048 / 1024 / 512 / 512）；屏幕捕获的分辨率各档都是整帧。玻璃模式：high / medium `'refract'`（三通道色散折射；medium 的 `dispersion: 'auto'`——仅 ≥ 0.25 px 才色散——尚未实现，目前同 high 一样色散）；low `'straight'`（无折射：元素玻璃沿视线直取其后内容面上的点，按 roughness 模糊，玻璃 Surface 的背板捕获在片元自身的 `screenUV` 处读取；底板直接读 `screenUV`；无光线偏移、无色散、无深度剔除；tint、Fresnel 边缘光与平面反射保留）；minimal `'fill'`（近不透明磨砂填充 + 边框：元素玻璃与底板都不再透过玻璃采样内容 RT，也不读屏幕捕获，而是画不透明度 0.92 的填充色（backdrop alpha，受光外壳也取同色）：底板用主题 `fill`；元素玻璃有发光色取发光色、否则有 tint 取 tint、否则取 `fill` 向 `label` 混 4 %（sRGB；浅色模式略深、深色模式略浅），并沿外轮廓画 1 pt 的 `tertiaryLabel` 边框（片元里按 slab 局部坐标对外轮廓的超椭圆 SDF 求距离，单位 pt，屏幕层与世界层一致；宽度至少 2 个设备像素，否则相对像素网格的相位与轮廓的 MSAA 覆盖会把它抹到只剩几个百分点的对比；默认主题下与卡片对比 ≥ 3:1，WCAG 1.4.11）。边框带上的颜色就是最终颜色：backdrop alpha 取 1、高光/环境反射（`specularIntensityNode`）与全部发光项乘 (1 − 边框)；fill 模式下不画 rim 装饰层（白色亮线会盖掉边框），pool 保留。填充不再叠磨砂提亮与吸收，发光层只保留 Fresnel 边缘项（填充本身即发光色）；阴影保留；不跑 luma、不建金字塔；没有任何材质引用 `ScreenCapture`，因此不做帧缓冲拷贝，换回其它档时同一捕获恢复使用）。low/minimal 的解析阴影贴片后置，目前用 512 VSM。

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

**尺寸与间距 token（spike 中确认，80pt 高控件为基准）**：控件内边距 26、前置/后置图标 28、图标与文字间距 14、图标+文字组整体居中（组内间距 12）、checkbox 玻璃钮 44 × 44（圆角 12）、开关 136 × 62（滑块 48，边距 7，滑块中心 = 半宽 − 边距 − 滑块半径）、同一行内的控件右边缘对齐输入框右边缘。

每个组件：`defineComponent` + zod props schema → 自动导出到 `manifest.json`（名称、描述、props 的类型/默认值/取值说明、events 的 payload、slots、2–3 个示例片段、常见错误）。组件内部只用 `Box/Text/Icon/glass` 原语与 Style，不直接碰 render 包。

### 8.3 Liquid Glass 组件规范（在组件层固定）

- 玻璃只用于控制层（按钮、输入框、开关、对话框面板、工具条）；内容区用填充色与 vibrancy，不叠玻璃。
- 按钮三层结构：发光层（有色）+ 透明玻璃壳（直壁 + 小圆角）+ 装饰层（轮廓亮线、底边亮带、透射光晕）。主按钮 = 发光层强度 ≈1.1；次按钮 = 无发光层的清玻璃；checkbox = 44pt 方形清玻璃钮 + 勾；开关 = 发光层按滑块位置软分割。
- 形状：按钮默认 capsule；面板固定半径；嵌套子元素默认 `radius: 'concentric'`。
- 按压：`scale 0.96 → spring('snappy')`，指尖处内发光；悬停：`glint` 增强 + 轻微 `tilt`（≤3°，仅指针设备）。
- 出现/消失：折射与模糊强度从 0 调制到目标值，同时 scale 0.9→1。
- `prefers-reduced-transparency` → minimal 档；`prefers-reduced-motion` → 关闭弹性与 tilt；`prefers-contrast` → 黑/白实心 + 边框。

## 9. 错误处理

- props/style/tw 校验失败：同步抛出 `GlassUIError`，消息格式 `[<Component>.<prop>] <原因>。允许值：… 你可能想要：…`。开发模式还在 canvas 内画出错误标记。
- 字体加载失败：回退到系统字体引擎并 `console.warn` 一次。
- WebGPU 初始化失败：three 自动回落；若 WebGL2 也不可用，`createUIRoot` reject，带可读原因。
- 质量档降级：触发 `root.on('quality', …)` 事件，可观察。
- 渲染循环内的异常不吞：捕获后停止该 Surface 的渲染并发 `surface.on('error')`，其它 Surface 继续。（Plan 2：`Surface` 没有 `on`；错误经 `surface.addEventListener('error', …)` 派发，并由 root 转发为 `root.on('error', { surface, error })`。）

## 10. 测试

- **core/text（Node，无 GPU）**：Vitest。样式解析与 tw 解析（含错误消息快照）、Yoga 布局结果、事件冒泡与命中测试（圆角、裁剪、elevation）、焦点顺序、滚动物理、spring 数值、文字测量与换行（中英混排）、manifest 生成。
- **vue**：Vitest + 自定义渲染器挂到内存 Surface：`v-if/v-for/slots/Teleport/Transition` 的节点树快照；组件 props 校验。
- **render（浏览器）**：Playwright 跑 `examples/visual`，WebGPU 与 `forceWebGL` 各一遍，像素比对（阈值）；覆盖每个组件各状态、屏幕层/世界层、玻璃四档、中文文本、IME 组合态截图。Plan 2 已有的部分：playground 的 `signup` 与 `world` 两个场景（`high` 档），以及 `medium`、`minimal` 档的 `signup`，1280×900、DPR 1，WebGL2（SwiftShader）与 WebGPU 各一遍（three 回落到 WebGL2 时 WebGPU 一项跳过、不比对），像素差预算 2 %（`maxDiffPixelRatio: 0.02`），另有控制台错误闸门（页面异常或 `console.error` 直接判失败）；基线在参考机上生成、与机器绑定（`examples/visual/README.md`）。
- **性能基线**：playground 内置 100 按钮 + 20 玻璃容器场景，记录帧时间与 draw call 数，CI 上只做回归阈值（Chrome headless，WebGL 路径）。
- **IME**：Playwright 的 `keyboard.imeSetComposition` 做组合输入的自动化；真机手工检查清单（iOS Safari、Android Chrome、macOS 中文输入法）。

## 11. 实施分期

- **Phase 0 · 风险 spike**：①② 已完成（`spikes/glass3d/`，结论见 `docs/superpowers/spikes/2026-10-07-glass-tsl-spike.md`，已回填 §5）；③ `@pmndrs/glyph` 0.1 中文表现 vs Canvas2D atlas 待做，作为实现计划的第一个任务。
- **Phase 1 · core + text**：Node/Style/tw/theme、Yoga、事件/焦点/滚动、spring、SystemFontEngine、渲染列表；全部可在 Node 测试。
- **Phase 2 · render**：Surface RT、面板/文字/阴影材质、玻璃材质与金字塔、屏幕层/世界层、质量分级；playground 可视（Plan 2：`docs/superpowers/plans/2026-10-08-glassui-plan-2-render.md`）。
- **Phase 3 · vue + 组件**：渲染器、11 个组件、Dialog/Portal、IME 桥、manifest、视觉回归、性能基线。

## 12. 待后续期的问题（已知、不阻塞）

无障碍语义树（Flutter/Babylon 式并行 ARIA DOM）；组件全集（Select、Tabs、Table、Menu、Slider、Segmented、Toast、Tooltip、DatePicker…）；Vite 编译期 `tw`；文档站；React 适配；Taffy（CSS Grid）；阴影投到任意世界几何；WebXR 手势与系统键盘。

**Plan 2 后置。** 以下各项也列在 Plan 2 计划文件（`docs/superpowers/plans/2026-10-08-glassui-plan-2-render.md`）的 Deferred 一节：

- `physicalStacking`（玻璃看见玻璃）：需按层把玻璃 pass 再捕获进第二张内容 RT。
- `GlassContainer` 形状融合（§5.2）：随组件进 Plan 3。
- low/minimal 的解析高斯阴影贴片：目前 512 VSM。
- medium 的 `dispersion: 'auto'`（≥0.25 px 才色散）：目前 medium 与 high 一样色散（`dispersion: 'never'` 已生效：只折射一次）。
- 自适应 luma → 文字颜色（§5.5）：需要 `color: 'auto'`/vibrancy 样式信号。
- `@pmndrs/pointer-events`（XR 射线）：`hitSurfaces` 是唯一要替换的接缝。
- `Surface.billboard`、`Surface.shadow`（§3.2）：随 `<Surface>` 组件。
- IME 桥（§7.3）、Vue 渲染器、组件、manifest：Plan 3。
- 悬停 `glint` 增强与 `focusVisible` 焦点环（§7.2）：Plan 3 组件；按压的指尖内发光已接通。
- 从 workspace 去掉 `spikes/*`（glyph spike 引入 React）：spike 归档时做。

执行与评审中另外发现的：

- `castToWorld` 生效：目前只有字段。
- GPU 计时（画质控制目前只用帧时间）；以空闲 rAF 间隔初始化刷新周期 P（§5.6：稳定的 GPU 受限帧率在约 17–60 fps 之间时 `'auto'` 不降档）。
- `high` 档金字塔裁剪到玻璃并集（目前覆盖整张内容 RT；没有玻璃实例时已整体跳过）。
- `renderer.shadowMap`（VSM、`transmitted`）是渲染器级设置：root 改了它，宿主自己的阴影也受影响；拟在 `createUIRoot` 时保存、`dispose` 时恢复。
- 视觉回归基线与机器绑定（系统字体栅格化、GPU 驱动）：CI 需各自生成一次。

**Plan 3 第一项任务（Plan 2 终审遗留，已裁定，不在 Plan 2 修复轮内）：**

- I7：`background: 'none'`（默认）Surface 上的元素玻璃在内容透明处折射为黑：拟仅在有玻璃实例时、在内容 quad 之前惰性捕获一次屏幕；以及全屏 `fill` HUD 在空白处吞掉指针（应穿透到宿主）。
- 公共导出整理：内部模块移到 `@glassui/render/internal`。
- 已 dispose 对象的防护（M3）；每帧分配（M4）；`uiScene` 渲染隔离（M1）。
- 屏幕层与世界层共用一次阴影拟合，屏幕层纹素不足：按层分别拟合或分贴图（g，M8）。
- mip 档的 `lod = roughness × 8` 与 Kawase 顶层（RMS 半径 ≈41 texel）在同一 roughness 下模糊宽度不一致（e）。
- `high` 档每片元 15 次折射采样（3 个色散通道 × 清晰层 + 4 层金字塔；平面反射另读 1 次）（f）。
- 内容 RT 缩小时的迟滞（避免来回重分配）；掠射角下全在相机前的世界层 Surface 投影可达 RT 上限 4096。
- `world` 场景的视觉回归不敏感：UI 只占画面约 350×230 px，2 % 预算约等于卡片的 30 %；拟裁剪到卡片区域比对（M9）。

## 13. 参考

- Apple：WWDC25 219 "Meet Liquid Glass"、356 "Get to know the new design system"、323；HIG Materials；"Applying Liquid Glass to custom views"。
- 实现参考：kube.io liquid glass 深潜（高度轮廓/折射）、iyinchao/liquid-glass-studio（WebGL2/WebGPU）、whynotmake-it/flutter_liquid_glass（几何缓存、smin 角度修正、双壁 glint）、Evan Wallace 圆角矩形阴影、Bjørge dual-Kawase。
- 生态：three.js r186 WebGPURenderer/TSL；yoga-layout 3.2；@pmndrs/pointer-events；@pmndrs/glyph 0.1；TresJS 5.9（nodeOps 模板）；Flutter web `text_editing.dart`（IME 代理）。
