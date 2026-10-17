# GlassUI 空间界面：Block、镜头与 3D 可视化（设计）

- 日期：2026-10-15
- 状态：待用户审阅
- 关系：补充核心 spec `2026-10-07-glassui-core-design.md`（§3 运行时对象、§7 交互、§8 Vue 层），并修改其 §8.3 的第一条（见 §9）。两者冲突时以本文为准。
- 落地：作为 Plan 3（`docs/superpowers/plans/2026-10-14-glassui-plan-3-vue.md`）的插入任务 9A–9G，并调整 Task 18–21、23（见 §8）。
- 2026-10-16 第四轮（§13）：总览模式、球面网格、极光背景、组件进 WMS；覆盖 §4 第 1、6 步与 §3.5 的部分前提。

## 0. 目标与非目标

用户的原话："我们总体目标是把传统2D的vue app放到3D空间去呈现，一些常见的组件3D化，比如表单，按钮等。整体风格按照苹果的液态玻璃和 fortbrain.ai/concepts/glassui-signup 呈现的效果来。vue里面的容器也都3D空间玻璃背板化。让用户既有之前操作2D UI的熟悉感，又有3D空间带来的体验和效果提升，同时能够原始的在3D空间内渲染3D擅长的可视化，比如3D的chart之类的。"

**目标**
- 一个 Vue 应用的各个界面块（Block）摆在 3D 空间里。每个 Block 是一块玻璃背板，里面是熟悉的 2D 布局与控件，控件本身是 3D 玻璃（同 signup 演示）。
- 切换界面时，离开的 Block 向后飞并淡出，镜头沿弹簧曲线移到新 Block 的正前方；闲置时镜头随指针轻微视差。
- Block 里可以放原生 3D 内容：通用的 3D 插槽，加一个内置的 3D 柱状图。
- 写法对 AI agent 友好：不给坐标也能得到合理的空间排布；写错时有可读的中文错误。

**非目标（本期不做）**
- 自由漫游、拖拽 Block、Block 之间的物理碰撞。
- 柱状图以外的图表类型（折线、散点、饼图），以及坐标轴刻度与图例。
- 读屏语义树（仍按核心 spec §12 后置）。
- Block 高度随内容自动撑开（本期 Block 尺寸固定，内容超出时给开发期警告，见 §5）。

## 1. 已定决策（用户在头脑风暴中选定）

| 问题 | 决定 |
|---|---|
| 导航模型 | 混合：Block 有固定的空间位置，切换时离开的 Block 向后飞并淡出，镜头移到新 Block 前 |
| 闲置镜头 | 跟随指针的轻微视差；减少动态效果时关闭 |
| 实现路线 | A：引擎层做变换动画、镜头、3D 视口，Vue 层做组件（否决 B：Vue 每帧补间，会抖、且重复每帧工作；否决 C：移动整个 UI 而不动镜头，背景墙没有视差） |
| 范围 | 空间 Block 与 3D 可视化一起设计，一起插进 Plan 3 |
| 3D 可视化 | 通用 3D 插槽 + 内置柱状图 |

## 2. 架构

四层，自下而上。`@glassui/vue` 仍不在运行时 import three（核心 spec §2）：它只调用 `UIRoot` 与 `Surface` 上的方法（类型来自 `@glassui/render`，与 Task 4 的 `GlassRoot` 相同的 `Pick` 方式），3D 物体在 Vue 层是 `unknown`。

### 2.1 render：Surface 变换动画

```ts
interface SurfacePose {
  position?: [number, number, number]          // 世界单位
  rotation?: [number, number, number]          // 弧度，XYZ
  scale?: number | [number, number, number]
  opacity?: number                             // 0–1，整个 Surface
}
surface.animateTo(target: SurfacePose, opts?: { spring?: Transition; immediate?: boolean }): Promise<boolean>
surface.opacity: number                        // 当前视觉不透明度；直接赋值即跳变
surface.restPose: Required<SurfacePose>        // 当前动画的终点；没有动画时等于当前姿态
```

- 每个通道（位置、旋转、缩放、不透明度）各自一根弹簧，由 `root.tick` 推进。默认弹簧 `{ response: 0.55, dampingFraction: 0.86 }`；`spring` 接受核心 spec §4.4 的全部写法（主题预设、`response/dampingFraction`、刚度/阻尼）。
- 新的 `animateTo` 只改它提到的通道的目标，保留这些通道的当前速度（弹簧连续）。旧调用的 Promise：若有通道被改了目标，以 `false` 结束；否则在它的通道全部停稳时以 `true` 结束。旋转按四元数插值（取短弧）。
- `immediate: true`、`root.anim.reducedMotion` 为真时：直接写到终点，下一次 `tick` 以 `true` 结束。Surface 已销毁（或 `error` 已置位）：立刻以 `false` 结束（同 Plan 3 账本里 GlassTransition 对"死 Surface"的裁定）。
- 不透明度作用于该 Surface 的全部绘制：内容 quad、背板 slab、元素玻璃、rim、前景文字与图片、挂在它上面的 3D 物体（§2.3）。阴影也随之变淡：玻璃投出的阴影强度乘以这个不透明度（叠在一起的 Block 共用一张阴影贴图，阴影会落到别的 Block 上），动画进行时每帧重绘阴影贴图。
- 不透明度 < 1 时，这个 Surface 的绘制关闭深度写入（淡出中的 Block 不能在后画的东西上打出"洞"）；= 1 时恢复。
- 不透明度 = 0 时该 Surface 不绘制、不做屏幕捕获、不参与命中（`layer.visible = false`）。
- **不在视野内的 Surface 跳过**：投影多边形完全落在视口外时，本帧不绘制、不做屏幕捕获；内容脏标记保留，重新进入视野时补画。
- **内容 RT 尺寸策略**（顺带完成核心 spec §12 的"内容 RT 缩小迟滞"，取代 Plan 3 Task 21 第 5 项）：所需尺寸超过当前 RT 时，按所需 × 1.25 分配（上限不变），所以连续放大时至多每涨 25 % 重分配一次；所需尺寸更小时，只有在这个 Surface 与相机连续 30 帧都没有移动之后，才缩到所需尺寸。

### 2.2 render：`CameraRig`

```ts
const rig = root.createCameraRig({ response?: 0.8, margin?: 0.08, parallax?: 2.5, parallaxResponse?: 0.4 })
rig.focus(target: Surface, opts?: { immediate?: boolean }): Promise<boolean>
rig.parallax: boolean          // 默认 true
rig.dispose(): void            // 停止驱动相机，相机留在原处
```

- 一个 root 至多一个 rig（第二次 `createCameraRig` 抛 `GlassUIError`）。rig 存在期间每次 `tick` 都写相机位姿：宿主不能同时开 OrbitControls 一类控制器（在文档与 manifest 里写明）。rig 在 `tick` 里先于屏幕层与灯光跟随相机的那一步更新。
- **对焦位姿**：相机的朝向等于目标 Surface 的世界朝向（相机 −z 对着 Surface 的正面），位置在 Surface 中心沿其法线向外 `d` 处。`d` 让 Surface 加上每边 `margin`（8 %）的边距刚好装进视口：按竖直 fov 与宽高比各算一个距离，取较大者。每次 `tick` 都按当前宽高比与目标的 `restPose` 重算，所以窗口尺寸变化、目标还在飞入时，镜头瞄的是目标的终点而不是它的中间姿态。
- **运动**：位置与朝向用临界阻尼弹簧（`dampingFraction: 1`，`response` 默认 0.8 秒），不过冲。`focus` 的 Promise 在到位时以 `true` 结束，被下一次 `focus` 打断或目标被移除时以 `false` 结束。目标被移除时镜头停在原处。
- **视差**：镜头绕当前目标中心小幅环绕，指针在画布上的归一化位置 [−1, 1] 映射到偏航与俯仰各至多 `parallax`（2.5°），带 `parallaxResponse`（0.4 秒）的平滑；目标始终在画面中央，背景墙与旁边的 Block 产生错位。指针离开画布时回到 0。只响应 `pointerType` 为 `mouse` 或 `pen` 的指针（触屏没有悬停），`reducedMotion` 时关闭。
- `immediate` 或 `reducedMotion`：直接切到对焦位姿。

### 2.3 render：3D 视口

```ts
surface.attach3D(node: Node, object: Object3D, opts?: {
  depth?: number                                        // pt，物体离开内容面的最大高度，用于阴影拟合；默认 = 节点宽度
  update?: (dt: number, ctx: Viewport3DContext) => boolean   // 每次 tick 调用；返回 true 表示还需要下一帧
}): () => void                                          // 卸下
interface Viewport3DContext {
  width: number; height: number; reducedMotion: boolean; theme: Theme; scheme: ColorScheme
  eye?: readonly [number, number, number]               // 对焦位姿的相机，在锚点坐标系里（pt）；不知道视图时缺省
}
surface.focusView: { fovDeg: number; aspect: number; margin: number } | null   // root 每次 tick 写入
rig.margin: number                                      // 只读：对焦时每边留的边距比例（CameraRigOptions.margin）
RIG_MARGIN = 0.08                                       // （internal，经 @glassui/render/internal 导出）没有 rig 时用的默认边距
```

- **坐标系**：物体挂在一个锚点 Group 下。原点在节点盒子的中心，z = 0 在它所贴的面上：最近的玻璃祖先（如 Card）的顶面，没有则是内容面；x 向右、y 向上、z 朝外，1 个局部单位 = 1 pt。每次 `tick` 在布局之后按节点的 `worldRect` 更新锚点。
- **只在世界层**：挂到屏幕层 Surface、节点不属于这个 Surface、同一节点挂两次，都抛 `GlassUIError`。
- **绘制顺序**：物体一律进透明队列（attach 时把材质设为 `transparent`，深度写入与深度测试保持开启），`renderOrder` 排在本 Surface 的 rim 之后、前景图片与文字之前（新增 `SURFACE_ORDER.viewport = 3.25`）。这保证：本 Block 的背板在它自己的第一次绘制前捕获画面时，图表还没画上去；挡在前面的其它 Block 的背板捕获的是整帧，会正常折射图表。
- **限制（本期）**：同一 Block 里叠在图表上方的玻璃元素看不到图表（元素玻璃采样的是内容 RT，3D 物体不在其中）。悬停数值标签因此用平面面板，不用玻璃。
- **物体内部的顺序与投影**：物体里各部件自己的 `renderOrder` 保留为槽内的细分（`viewport ± clamp(自身, 100) × 1e-3`，不越过相邻的 rim 与前景图片）；部件的 `userData.noShadow = true` 时不投影（底板、文字平面这类薄片不应投出方块阴影），Surface 的 `castShadows` 关时一律不投影。
- **淡出**：attach 时记下每个材质原有的 `opacity` 与 `transparent`，每帧以 原值 × `surface.opacity` 写回；detach 时恢复原值。
- **光照与阴影**：物体在 UI 场景里，受 UI 灯光照射；`castShadow` 打开，投影落在背板与 Card 上。阴影相机的拟合范围把 `depth` 算进去。
- **命中**：射线同时测试内容 quad 与已挂物体（递归），取最近者。命中挂载物体时，事件派发给挂载的节点，事件对象多一个 `object`（命中的 Object3D；在 core 里类型为 `unknown`）。节点的悬停范围是"盒子区域 ∪ 物体"：射线落在物体上，即使它在内容面上的投影已出了盒子，也仍算在节点内；`pointermove` 每次带上当前的 `object`（落在盒子空白处时缺省）。
- `update` 返回 true 时 root 继续出帧（`needsFrame`）。
- **对焦视点 `eye`（Task 9P）**：
  - `root.tick` 每次 tick 把一个视图对象写给每个世界层 Surface 的 `focusView`：相机的有效竖直 fov、视口宽高比、rig 的 `margin`（没有 rig 时用 `RIG_MARGIN`，即 rig 的默认值 0.08）。这个对象在 root 里只有一个，每次 tick 改写其中的值。正交相机没有透视可拟合，`focusView` 为 `null`。
  - Surface 用它算出对焦距离：内容面中心沿法线到对焦位姿相机的距离，换算成这个 Surface 自己的 pt，交给附件（`Viewport3DStep.focus`，pt；不知道视图时缺省）。拟合距离与尺寸成正比，所以均匀的静止缩放（如非焦点 Block 的 0.96）会抵消，直接用 Surface 自身的尺寸。
  - 附件再把它换成 `Viewport3DContext.eye`：对焦位姿的相机在锚点坐标系里的位置，即从盒子中心回到 Surface 的轴线、再向外 `focus − 面高`。它跟随静止位姿，不跟随实际相机（没有视差，也不随飞行）；不知道视图时缺省。`eye` 元组是附件自己的，每次 tick 改写：要保留就复制其中的值。
  - **用途**：盒子偏离画面中心时，朝观者立起的内容在透视下会向外投射，越出盒子（9P 检查中，总览右侧 Card 里的矩阵越出 Card 约 90 px）。3D 图表（`FrameChart`：`SurfaceChart`、`BarMatrix`）因此按 Block 对焦时看到的样子拟合自己的盒子：从 `eye` 把轮廓（底板、满高时的曲面或柱子的角、立着的刻度，以及悬停柱子抬起的高度）投到玻璃上，平移使投影在盒子里居中，缩放（不超过 1）使它离每条边至少 16 pt。`eye` 的变化小于其距离的 2 % 时不重新拟合（Card 悬停抬起 16 pt 不会让图表"呼吸"）。

### 2.4 render：嵌套玻璃（Card 里放玻璃控件）

核心 spec §12 后置了 physicalStacking（玻璃看见玻璃）。容器玻璃化之后，Card 里放按钮、输入框会很常见；不处理的话，内层玻璃只采样内容 RT，看不到外层 Card，会像在 Card 上开了透明的洞。本期做一个近似：

- 一个 Surface 的渲染列表里出现"祖先也是玻璃"的玻璃元素时，它在内容 RT 之后再画一张**叠层 RT**：内容 RT；外层玻璃画成半透明面板，颜色按 `'fill'` 模式的取色规则（有发光色取发光色，否则 tint，否则主题 `fill`），不透明度 0.35，带 1 pt `tertiaryLabel` 边框（同样乘 0.35）；再加上外层玻璃上的前景文字与图标。（用面板而不用 fill 模式的玻璃材质：后者的受光外壳在没有灯光的离屏场景里会发黑。）
- 内层玻璃改为采样叠层 RT（及其模糊层）；外层玻璃仍采样内容 RT。叠层 RT 只在内容 RT 重绘时重画，没有嵌套玻璃的 Surface 不分配它。
- 只区分两层：第三层及更深的玻璃与第二层一样采样叠层 RT，彼此看不见。
- 内层玻璃本期不做自适应变暗（luma），它的索引会与外层冲突；后置。
- minimal 档本来就不采样背景（全部 `'fill'`），不需要叠层 RT。

### 2.5 render：柱状图

```ts
const chart = root.createBarChart()            // Object3D，配合 attach3D 使用
chart.set({ values: number[]; colors: Color[]; max: number }): void
chart.hover(index: number | null): void
chart.update(dt: number, ctx: Viewport3DContext): boolean   // 交给 attach3D 的 update
```

- **布局**（Vue 侧标签行用同一规则）：盒宽 W、高 H、n 根柱子；n 等分列，第 i 根中心 x = (i + 0.5)·W/n − W/2，柱宽 = 0.6·W/n，高 = value/max·H，底边在 y = −H/2，从 z = 0 向外伸出 0.6·柱宽的厚度。
- **几何与材质**：每根柱子一个圆角长方体 Mesh（圆角 0.12·柱宽，按目标高度建几何），`MeshStandardNodeMaterial`，roughness 0.35，metalness 0。柱子少，不用 instancing，换来静止时精确的圆角与精确的射线命中（`object.userData.index` 即柱序号）。
- **生长**：第一次 `set` 时每根柱子的高与厚从 0 弹到目标（主题 `smooth` 弹簧，相邻两根间隔 40 ms 起步），像从背板里长出来；之后的 `set` 从当前高度弹到新高度，新增的柱子从 0 长出。`reducedMotion` 时直接到位。
- **悬停**：被悬停的柱子亮度 × 1.2、厚度 × 1.15，弹簧过渡。

### 2.6 vue：组件

| 组件 | 是什么 | props | 事件 / 插槽 |
|---|---|---|---|
| `Space` | 空间容器：排布 Block、持有镜头 rig、管理焦点 | `focus?: string`（`v-model:focus`；省略时取第一个出现的 Block），`radius?: number`（弧半径，世界单位，默认 7），`gap?: number`（相邻 Block 间隔，默认 0.5），`camera?: boolean`（默认 true；false 时只排布与管理焦点，不动相机），`parallax?: boolean`（默认 true） | `update:focus`；默认插槽只放 `Block`（`v-if`/`v-for` 照常可用）。没绑定 `focus` 时 Space 自己记住焦点，点击非焦点 Block 照样切换 |
| `Block` | 一块玻璃背板的世界层 Surface，装一个界面 | `name: string`（必填，Space 内唯一），`width: number`、`height: number`（pt），`position?`、`rotation?`、`scale?`（同 `Surface`），`radius?: number`（默认 48），`background?: 'glass' \| string`（默认 `'glass'`），`ptPerUnit?: number`（默认 244），`enterFrom?`、`leaveTo?`（`SurfacePose` 形状的偏移，见 §3.3） | `error`；默认插槽；`style`/`tw`/`class` 落到内层内容盒（默认纵向排列、`padding: 40`、`gap: 24`） |
| `Card` | Block 内的分组容器：更薄的玻璃 | `title?: string`（17 pt、600 字重的标题） | 默认插槽；`style`/`tw`/`class` 落到 Card 本身（默认 `bg: 'glass'`、`radius: 'xl'`（24 pt）、`padding: 24`、`gap: 12`，玻璃厚度 12 pt：主题的默认厚度是短边的比例，大卡片会厚到 60 pt）。不用 `'concentric'`：它只认直接父节点，放在 Block 里是 48 − 40 = 8 pt、放在一行 Stack 里是 0，都显得方（9F 截图检查的裁定） |
| `Viewport3D` | 通用 3D 插槽：一个布局盒，挂一个 three 物体 | `object: unknown`（一个 `Object3D`），`depth?: number`，`update?: (dt, ctx) => boolean` | `pointerenter/leave/move`、`click`（事件带 `object`） |
| `BarChart3D` | 内置 3D 柱状图 | `data: { label: string; value: number; color?: string }[]`，`max?: number`（默认把最大值向上取到 1/2/5 × 10ⁿ），`format?: (v: number) => string`（默认最多两位小数） | `select`（点击某根柱子，payload `{ index, label, value }`） |

- `Block` 内部就是一个 `background: 'glass'` 的世界层 Surface（复用 Task 9 的 `<Surface>` 实现），外加：从 `Space` 取得排布位置，进场时 `animateTo` 从 `enterFrom` 弹到原位，离场时弹到 `leaveTo` 后再移除。
- **离场时内容不能先消失**：Block 卸载时先把它的 Surface 标为保留（渲染器的 `holdContent`）：对保留 Surface 里的节点，渲染器的 `remove` 不执行，Vue 照常卸载组件，节点留在原处；Block 再 `animateTo(leaveTo)`，结束后移除整个 Surface（节点随之释放）。`v-if`、`v-for` 与整个 Space 卸载都走这一条。挂在其中的 3D 物体也随 Block 飞走，Surface 销毁时才卸下。`motion: 'frozen'` 时离场立即完成。
- `BarChart3D` 由 `Viewport3D`（图表区，`flex: 1`）与其下的标签行（n 等分列，13 pt `secondaryLabel`）组成；悬停时在柱顶上方 8 pt 处显示一个平面填充面板，里面是 `format(value)`。颜色 token 按当前主题与明暗解析，切换明暗时更新。空数组时只显示居中的"暂无数据"。
- `Viewport3D` 与 `BarChart3D` 放进 `scroll` 节点里会报错（本期不支持对 3D 物体做裁剪）。

## 3. 规则

### 3.1 自动排布

- 没给 `position` 的 Block 由 `Space` 放在一条朝向观众的弧上：弧心 C = (0, 0, `radius`)。第一个 Block 在原点、正面朝 +z；之后的依次向右，第 i 个的角度 θᵢ = θᵢ₋₁ + (wᵢ₋₁/2 + `gap` + wᵢ/2) / `radius`（w 为 Block 的世界宽度），位置 C + `radius`·(sin θᵢ, 0, −cos θᵢ)，绕 y 轴旋转 −θᵢ，即正面朝向弧心。
- 槽位按 `name` 记住，顺序按首次出现。Block 被 `v-if` 移除后再回来，回到原来的槽位，其它 Block 不挪动。
- 给了 `position`/`rotation` 的 Block 用自己的值，不占槽位。
- 默认值（radius 7、gap 0.5）在 spatial 场景的视觉检查点按截图调整：要求镜头对着 landing 时，右侧的设置 Block 至少露出一部分。

### 3.2 镜头与焦点

- `Space` 挂载时（`camera` 为 true）创建 rig，并立即（`immediate`）对焦到当前焦点 Block；卸载时 `dispose`。
- `focus` 变化时：rig 对焦到新 Block；焦点 Block 成为键盘的目标 Surface（`PointerBridge.setActive`），并打开 `trapFocus`，Tab 只在它里面循环；原焦点 Block 里获得焦点的节点失焦（输入框随之结束输入法组合）。
- `motion: 'frozen'` 时：对焦、进场、离场都 `immediate`，视差关闭（截图不受鼠标位置影响）。

### 3.3 过渡与交互

- 默认 `enterFrom = { position: [0, 0, -1.2], scale: 0.92, opacity: 0 }`，`leaveTo = { position: [0, 0, -1.5], scale: 0.9, opacity: 0 }`。偏移在 Block 自己的坐标系里（−z 是远离观众），位置与旋转相加、缩放与不透明度相乘。改方向只需覆盖它们，例如向左飞出：`:leave-to="{ position: [-4, 0, -1], opacity: 0 }"`。
- 离场的 Block 立即不可交互：`interactive = false`，取消它的按压与悬停，失焦。
- 进场的 Block 一出现就可以交互。
- **非焦点 Block**：看得见也点得着，但一次按下只把它设为焦点（`Space` 发出 `update:focus`），不传给里面的控件；它里面也不显示悬停效果。实现：Block 的内层内容盒在非焦点时 `pointerEvents: 'none'`，Block 的根节点接住 `pointerdown`。这样斜着的 Block 上的按钮不会被误触。

### 3.4 偏好设置

- **减少动态效果**：进出场与镜头直接到终态，视差关闭，柱子不生长（§2.1–§2.5 各自的规则）。
- **降低透明度**：沿用 minimal 档（实底磨砂、带边框）。飞行与镜头照常。
- **读屏**：不在本期（§0）。

### 3.5 性能

- 每个玻璃背板的 Block 每帧一次整帧拷贝。靠 §2.1 的两条跳过规则（不透明度 0、完全出视野），演示中同时付这笔开销的 Block 不超过 3 个。
- 目标 60 fps（参考机：本机 Mac，WebGPU，high 档，1280 × 900）。§6 的测试在切换过程中采样帧间隔，p95 超过 33 ms 判失败（门槛放宽以免测试不稳）。

## 4. 演示流程（playground `?scene=spatial`）：云仓 WMS

用户要求（2026-10-15）：照实际商业软件的样子做；登录用用户给的演示；登录后是有数据、有 2D 折线图、有 3D 图表、有 3D 仓储数据孪生的仪表盘。演示是一个虚构的仓储运营平台"云仓 WMS"，数据用固定种子生成，看起来真实。

1. **登录**（2026-10-16 起由 §13.4 取代：登录是总览前的 HUD）（Task 19，需要 Task 10–13 的控件）：登录 Block 就是用户给的演示表单（`?scene=signup` 的设计与文案，全部用组件重建）。主按钮进入约 0.6 秒的 `loading`，然后登录 Block 绕 x 轴向后翻倒（−0.5 rad）、退入深处并淡出，镜头向前推到总览 Block。
2. **总览**（Block `overview`，居中，约 1440 × 900 pt）：
   - 顶栏：品牌标识与"云仓 WMS"、仓库切换（"徐州一号仓"）、分页标签（总览 · 物流网络 · 仓储孪生 · 订单）、日期、头像。
   - 4 张 KPI Card：库存 SKU、今日出库单、准时发货率、库位利用率，各带环比（涨绿跌红）。
   - "近 14 天出库热力" Card：`<SurfaceChart3D>`（§12.1），x = 0–23 时，z = 近 14 天，高度 = 每小时出库单量；下方是峰值、工作日日均、休息日日均。
   - "库区 × 品类 库存" Card：`<BarMatrix3D>`（§12.2），高度 = 件数，颜色 = 周转天数。
   - （第二轮的 `<LineChart>` 与 `<BarChart3D>` 仍是库里的组件，演示不再使用；2026-10-16 第三轮按用户要求换掉。）
3. **物流网络**（Block `network`，在总览右侧）：徐州的物流网络地图，见 §12.4。
4. **仓储孪生**（Block `twin`，在物流网络右侧）：
   - 标题、仓库概况与图例（空闲 / 正常 / 繁忙 / 满载）。
   - `<Viewport3D>` 里是一座 3D 仓库：地面与通道线；6 排货架，每排 10 列、4 层库位，库位按占用率着色；一台 AGV 沿主通道循环行驶。仓库像桌面模型一样向观众倾斜，可以按住拖动、绕竖直轴旋转。
   - 悬停某个库位：库位高亮、略微抬起；孪生前方浮出一块玻璃信息面板（独立的世界层 Surface，放在孪生的立体内容之外：货架凸出背板 190–250 pt，所以面板在孪生前方约 1.4 单位；不遮挡标题与图例；不投影，`castShadows: false`），显示库位号、SKU、数量、占用率。面板会折射后方的货架（§11.4）。
5. **订单与告警**（Block `orders`，在总览左侧）：最近 8 条订单（单号、客户、件数、状态标签、时间），一张异常告警 Card。
6. **切换**（2026-10-16 起由 §13.4 取代：导航坞、面包屑、总览模式）：点击旁边露出的 Block、总览的分页标签或各 Block 的"‹ 总览"切换焦点；非焦点 Block 后退（§11.2）。头像进入设置 Block（Task 19）；"退出登录"回到登录 Block。

9K 先做第 2、4–6 步的预览（从总览开始，没有登录块）；9P 加上第 3 步并把演示改为徐州（§12.4）；Task 19 补上第 1 步与设置。

## 5. 错误处理

沿用核心 spec §9 的格式：`[<组件>.<prop>] <原因>。允许值：… 你可能想要：…`，经应用的 `errorHandler` 报告（控制台 + 画布内错误标记）。

| 情形 | 处理 |
|---|---|
| `Block` 不在 `Space` 里 | `[Block] 必须放在 <Space> 里` |
| 两个 Block 同名 | 报错，指出重名的 `name` |
| `Space` 的插槽里有 Block 以外的组件或元素 | 报错：`[Space] 插槽里只能放 <Block>` |
| `focus` 指向不存在的 Block | 等本轮 Vue 更新结束再检查（同一轮里刚经 `v-if` 加入的 Block 算存在）；仍不存在则报错，列出现有名字中最接近的；镜头不动 |
| `Viewport3D` 在屏幕层，或 `object` 不是 `Object3D`，或放在 `scroll` 里 | 报错 |
| `BarChart3D` 的 `value` 为负数、NaN 或无穷 | zod 校验报错 |
| Block 内容超出高度 | 开发期 `console.warn` 一次：`[Block "landing"] 内容高 812pt 超出 block 高 700pt：调大 height 或减少内容` |
| `animateTo` / `focus` 被打断、目标已销毁 | Promise 以 `false` 结束，不抛错（§2.1、§2.2） |
| 第二个 `createCameraRig` | `GlassUIError` |

## 6. 测试

- **render 单测**（Node，无 GPU；纯函数与假 Surface）：弹簧变换（通道独立、打断保速、Promise 结果、reducedMotion 跳变、死 Surface）；不透明度传到每个绘制的材质与深度写入开关；出视野跳过；RT 尺寸策略（1.25 倍分配、30 帧静止后才缩）；对焦距离与位姿（横竖两种限制、resize 重算、瞄 `restPose`）；视差映射与触屏关闭；锚点换算（玻璃祖先顶面、pt 单位）；透明队列与 `renderOrder`；材质 opacity 记录与恢复；命中取最近者、悬停的并集语义；叠层 RT 只在有嵌套玻璃时分配、内层与外层各自采样的 RT；柱状图布局、实例数、生长错开、悬停。
- **vue 单测**（假 root）：Space/Block 注册、弧形槽位与按名记位；`focus` 驱动 rig 与 `setActive`；非焦点 Block 的按下只发 `update:focus`；离场时内容保持到 `animateTo` 结束；`frozen` 下全部 immediate；§5 的每条错误；BarChart3D 的 max 取整、标签列、悬停面板、空数据。
- **视觉回归**（Plan 3 Task 20）：`?scene=spatial&motion=frozen&hud=0`，靠真实点击走流程，截 4 帧：登录、总览、孪生、悬停一个库位；WebGPU 与 WebGL2 各一套，共 8 张新基线。控制台错误闸门照常。
- **帧时间**：`?scene=spatial&motion=live`，点"登录"后 1.2 秒内采样 rAF 间隔，WebGPU 上 p95 ≤ 33 ms。

## 7. 与现有 Plan 3 的衔接

- 插入任务全部排在 Task 9 之后、Task 10 之前，用 9A–9G 编号，不改动已有任务的编号（账本按编号引用）。
- 9F、9G 时 Button / Input 等控件还不存在：这两步的可视检查用一个 spatial 场景雏形（Block 里只有 Text、Stack、Card、图表，靠点击非焦点 Block 切换焦点）；完整的登录流程在 Task 19 用真实控件重建。
- Plan 3 账本里给 Task 13（Input）与 Task 14（Dialog）的携带说明不受影响。另加两条：给 Task 12/13，世界层 Input 获得焦点、镜头仍在移动时，IME 代理需要每帧跟随光标的投影位置；给 Task 14，Dialog 关闭后键盘的目标 Surface 回到打开前的那个（在空间界面里就是焦点 Block，它的 `trapFocus` 保持开启）。

## 8. 插入 Plan 3 的任务

| 任务 | 层 | 内容 |
|---|---|---|
| 9A | render | Surface 变换动画（§2.1）：`animateTo`、整块不透明度、深度写入开关、出视野跳过、内容 RT 尺寸策略 |
| 9B | render | `CameraRig`（§2.2）：对焦、视差、减少动态效果；加进 `GlassRoot` |
| 9C | render + core | 3D 视口（§2.3）：`attach3D`、锚点、透明队列与顺序、材质淡出、阴影拟合、命中与事件的 `object` |
| 9D | render | 嵌套玻璃（§2.4）：叠层 RT |
| 9E | render | 柱状图（§2.5）：`createBarChart`；加进 `GlassRoot` |
| 9F | vue | `Space`、`Block`、`Card`（§2.6、§3）；spatial 场景雏形；可视检查 |
| 9G | vue | `Viewport3D`、`BarChart3D`；雏形里加上图表；可视检查 |
| 9H | render | 灯光锚定在空间里（§11.1） |
| 9I | vue | 深度：非焦点 Block 后退、Card 浮起、悬停倾斜与上浮、升起入场（§11.2、§11.3） |
| 9J | vue | `<LineChart>` 2D 折线图（§11.5） |
| 9L | render + core | 抬起的玻璃投下看得见的影子（§11.7） |
| 9K | playground + core/render | WMS 仪表盘预览与仓储孪生（§4 第 2–5 步）；实例化物体命中带 `instanceId`（§11.6）；可视检查后给用户看 |
| 9M | render | 玻璃上的背景面板随玻璃抬起（§11.8） |
| 9N | render + vue + core | `<SurfaceChart3D>` 出库热力曲面；3D 命中带命中点（§12.1、§12.3） |
| 9O | render + vue | `<BarMatrix3D>` 库区×品类库存矩阵（§12.2） |
| 9P | playground + core/render | 物流网络地图（徐州 GIS）、演示改为徐州、总览换成新图表；指针按键（§12.4、§12.5）；可视检查后给用户看 |

对已有任务的调整：
- **Task 18（manifest）**：收录五个新组件，示例里给出一个完整的 Space/Block 写法；`mistakes` 写明"不要同时用 OrbitControls""Block 必须在 Space 里""`width/height` 是数字"。
- **Task 19（playground）**：`?scene=spatial` 补上 §4 的登录（用户的演示表单）与设置，接入真实控件。gallery 改为空间布局：每个分区是 `Space` 里的一个 Block，`?focus=<分区名>` 指定初始焦点（视觉测试用它逐个分区截图）。
- **Task 20（视觉回归）**：加上 §6 的 spatial 用例；gallery 的整页与各状态截图改为"先用 `?focus=` 聚焦对应分区，再按分区区域裁剪"。
- **Task 21（性能）**：第 5 项（RT 缩小迟滞）已在 9A 完成，这里只测量；perf 测试加上 §6 的帧时间用例。
- **Task 23（验收）**：让一个全新的 agent 只读 manifest，写一个带 Space、两个 Block、一个 BarChart3D 的应用，能直接跑通。

## 9. 对核心 spec 的修改

- §8.3 第一条原文："玻璃只用于控制层（按钮、输入框、开关、对话框面板、工具条）；内容区用填充色与 vibrancy，不叠玻璃。"改为："玻璃用于容器与控件：Block 背板、Card、对话框面板，以及按钮、输入框、开关、工具条。`Box` 只负责布局，不带玻璃；文字与列表项不单独玻璃化，落在所在容器的玻璃上。玻璃里的玻璃按空间界面 spec §2.4 处理。"
- §8.2 表格之后加一句：空间组件（`Space`、`Block`、`Card`、`Viewport3D`、`BarChart3D`）见本文。

## 10. 后置

- 真正的 physicalStacking（玻璃里折射外层玻璃的完整光学效果）：本期以 §2.4 的 fill 近似代替。
- 同一 Block 里叠在 3D 物体上方的玻璃看见 3D 物体（§2.3 的限制）。
- 3D 物体在 `scroll` 里的裁剪。
- Block 高度随内容自动撑开；拖拽、自由漫游。
- 更多图表类型、坐标轴与图例。

## 11. 第二轮：让 3D 有价值（2026-10-15）

用户反馈："你现在的样式和 css 的 3D transform 之后的结果没什么区别，要能体现出 3D 空间的价值。" 原因：内容全贴在背板上，没有层次；灯光跟着相机走，镜头移动时光影不变；雏形里没有 3D 控件与 3D 内容；转场只有平移与淡出。下面只做 CSS 做不到的事。

### 11.1 灯光锚定在空间里（render，9H）

- 有 CameraRig 且有目标时，UI 灯光不再跟随相机，而跟随 rig 的"灯光位姿"：焦点位姿（不含视差），用临界阻尼弹簧追随，`lightResponse` 默认 1.2 秒（比镜头的 0.8 秒慢）。
- 效果：视差时相机动、灯不动，玻璃的高光、亮边与卡片的投影相对内容流动；切换焦点时灯光落后于镜头，高光扫过玻璃。
- 没有 rig（或 rig 没有目标）时，灯光照旧跟随相机。灯光位姿变化时重新拟合阴影。`immediate` 与减少动态效果时灯光直接到位。

### 11.2 非焦点 Block 后退（vue，9I）

- 非焦点 Block 的停放位姿 = 槽位位姿 ⊕ `{ position: [0, 0, -0.4], scale: 0.96 }`（Block 自身坐标系，−z 远离观众）；焦点切换时用弹簧过去。`motion: 'frozen'` 时直接到位。

### 11.3 Card 的深度（vue，9I）

- **浮起**：Card 的 `elevation` 24 pt，在背板上投下真实阴影。
- **悬停**：上浮到 40 pt，并朝指针倾斜（`tilt`，两个方向各最多 4°），离开时回落；只在焦点 Block 里生效；减少动态效果时只上浮、不倾斜。
- **升起入场**：Block 进场时，Card 的 `elevation` 从 0 升到 24，同一 Block 里按出现顺序每张延迟 60 ms；`frozen` 时直接 24。

### 11.4 玻璃折射立体内容

- 不需要新代码：一个世界层玻璃 Surface 放在 3D 物体前方，它的背板捕获的是整帧画面（§2.3），会折射后面的立体内容。演示里孪生前方的信息面板就是这样（§4）。

### 11.5 2D 折线图 `<LineChart>`（vue，9J）

- props：`labels: string[]`（至少 2 个），`series: { name: string; data: number[]; color?: string }[]`（每条长度等于 `labels`），`height?: number`（默认 200），`format?: (v: number) => string`，`yMin?: number`（默认 0）。
- 画法：Canvas2D 按 2 倍像素栅格化成一张图，放在一个 `image` 节点里：横向网格线与 y 轴刻度（3–6 个"好看"的刻度，步长 1/2/5 × 10ⁿ）、x 轴标签（最多 6 个，均匀抽取）、平滑曲线、曲线下的渐变面积、顶部图例。颜色 token 按当前主题与明暗解析，明暗切换时重画；宽度变化时重画。
- 悬停：最近的 x 处画一条竖直准线，旁边浮出一块平面面板，列出各系列在该点的 `format` 值。
- 错误：系列长度与 `labels` 不一致、数值不是有限数 → `[LineChart.series] …`；`series` 为空 → 显示"暂无数据"。

### 11.6 实例化物体的命中（core + render，9K）

- 射线命中 `InstancedMesh` 时，`SurfaceHit.target` 与事件对象多带 `instanceId`（命中的实例序号；不是实例化物体时缺省）。孪生的库位用一个 InstancedMesh 画，靠它知道悬停的是哪个库位。
- 指针事件多带 `screenX`/`screenY`（指针在画布上的 CSS px；键盘、焦点事件缺省）。拖动 3D 物体时用屏幕位移，不用命中点：后者随指针下的几何体跳变。
- Surface 多一个 `castShadows`（默认 true）：false 时它的玻璃与挂载物体都不投影。远离背板浮着的面板（孪生信息面板）用它避免在后面的 Block 上投出一大块灰影。

### 11.7 抬起的玻璃投下看得见的影子（render + core，9L）

- 9I 之后的检查发现：Card 浮起 24 pt，但看不到投影。VSM 阴影落在内容 quad 上，而玻璃 Block 背板上空着的地方内容 quad 是透明的，玻璃 slab 本身不接收阴影。浮起是最强的深度线索，必须看得见。
- 做法：每个高出其所在面的玻璃元素（高度 = 合成 elevation 减去最近的玻璃祖先的顶面，即该祖先的 elevation + 厚度；没有玻璃祖先时就是合成 elevation；只在 > 0 时）在内容 RT 里画一块柔和的投影贴片（新的装饰种类 `shadow`），位置是元素形状沿主光方向偏移：偏移（pt）= `高度 × (−lₓ/l_z, l_y/l_z)`（l 是方向光的方向：主光位置减其 target，转到该 Surface 的坐标系，y 向下为正；所有 Surface 共用同一方向），每个分量限制在 1.5 × elevation 以内；模糊半径 4 + 0.5 × elevation；不透明度浅色 0.22、深色 0.35。
- 投影只画在投射者自身轮廓之外，不压暗卡片自己的内容。它在背板上可见，透过卡片玻璃也能看到（折射）。
- 光方向是 Surface 级的 uniform：方向变化使该 Surface 上最高的投影偏移改变超过 0.5 pt 时，内容 RT 重画。灯光锚定后，视差不触发重画，只有焦点切换时的灯光过渡才会。

### 11.8 玻璃上的背景面板随玻璃抬起（render，9M）

- 9K 的检查发现：Card 浮起 24 pt、厚 12 pt 之后，Card 里带背景的 Box（订单的状态标签、图表的悬停数值面板）仍画在内容 RT 里（背板高度），而它们的文字跟着玻璃顶面抬起 36 pt；斜着看两者错开约 15 pt。
- 规则：最近的祖先里有玻璃的面板（背景、边框），和文字、图片一样画在那块玻璃的顶面上（抬起该玻璃的厚度，随玻璃的 elevation、倾斜与缩放），排在玻璃之后、rim 与文字之前；没有玻璃祖先的面板照旧画进内容 RT。玻璃节点自己的焦点环也画在该玻璃的顶面上（与它的 rim 一样随 elevation、倾斜与缩放）：画在内容 RT 里时，抬起的玻璃按钮的焦点环在透视下与按钮错开，像一道重影（Task 10 V1 修订；原文：玻璃节点自己的焦点环仍在内容 RT，在玻璃边缘下方）。
- 叠层 RT（§2.4）里外层玻璃上的面板也随之画进去（与外层玻璃上的文字一样）。

## 12. 第三轮：有意义的 3D 图表与物流网络地图（2026-10-16）

用户反馈："3D柱状图只是几个大柱子太普通了，只是把2D的事3D化了而已，这俩chart都换成真正有意义的3维的chart，另外再增加一个大的panel，用来显示3D化的地图，显示仓库之间的物流关系，gis数据和样式可以参考 Fortbrain 的 retail-warehouse-screen。" 用户选定：出库热力曲面 + 库区×品类库存矩阵。

### 12.1 出库热力曲面 `<SurfaceChart3D>`（render + vue，9N）

- 数据：`xLabels`（列，如 0–23 时）、`yLabels`（行，如近 14 天）、`values: number[][]`（行 × 列）；第三维（高度）就是数值。
- 画法：网格曲面（每个数据点一个顶点，平滑法线），顶点颜色按高度在色带上取（默认 accent 系由浅到深：低值淡蓝紫、高值深紫/品红），曲面下方有半透明底板与沿行列的细网格线；坐标轴标签（时段、日期、数值刻度）是贴在底板边缘上的文字平面（画布纹理），随图表一起透视。
- 生长：进场时曲面高度从 0 弹到目标（行依次错开）；减少动态效果时直接到位。
- 悬停：命中点所在的格子高亮（一根竖直指示线 + 顶点圆点），平面读数面板显示"日期 · 时段 · 单量"；`hover` 事件给出 `{ row, col, value } | null`。

### 12.2 库区 × 品类库存矩阵 `<BarMatrix3D>`（render + vue，9N）

- 数据：`rows`（库区 A–F）、`cols`（品类）、`values: number[][]`（高度 = 库存）、`colorValues?: number[][]`（第四维，颜色 = 周转天数，配色带与图例）。
- 画法：方阵排布的圆角柱（每柱一个 Mesh），底板上有行列标签（文字平面）；颜色按 `colorValues` 在绿—黄—红色带上取，没有 `colorValues` 时按高度。
- 生长、悬停（柱子提亮、读数面板"A 区 · 日化 · 4,580 件 · 周转 12 天"）、`select` 事件。

### 12.3 命中点（core + render，9N）

- 3D 命中时事件多带 `point`（命中点在挂载锚点坐标系里的位置，单位 pt）；曲面图据此算出格子。

### 12.4 物流网络地图（playground + core/render，9P）

- 新 Block `network`（大面板，约 1600 × 1000 pt）：标题"物流网络 · 徐州"、图例（仓库、门店、供应商；库存充足/偏紧/缺货）、统计（仓库数、门店数、在途单数、逾期）、一张深色地图板（参照 Fortbrain 的深海军蓝风格：区县面、青色路网细线、水系），以及操作提示"滚轮缩放 · 左键平移 · 右键（或 Shift）旋转"。
- 地图是 `<Viewport3D>` 里的 three.js 模型：
  - 区县面略微挤出、带亮边；路网按等级粗细与亮度分层（高速/主干/次干，细路省略）；水系线。
  - 地点：仓库、门店、供应商是立在地图上的棱柱，高度 = 在库件数，颜色 = 状态（充足绿、偏紧橙、缺货红、仓库金），顶部有菱形描边；仓库有文字标牌（画布纹理平面，始终朝向镜头）。
  - 物流关系：仓库之间、仓库到门店的调拨线是拱起的曲线，粗细 = 件数，沿线有流动的光点表示方向；逾期的采购在途线为红色。
  - 交互：滚轮缩放（有上下限），左键拖动平移，右键或 Shift+左键拖动旋转；初始视角已放大到能看清仓库与门店的程度；悬停地点在地图上方浮出玻璃信息面板（不投影）。
- GIS 数据：Fortbrain 接口需要登录，取不到；改从它注明的公开来源取：区县边界 DataV GeoAtlas `320300_full`，路网与水系 OSM Overpass（徐州 bbox，只取高速到次干与主要水系），简化后作为静态 JSON 放进 playground，并在地图角落注明 "© OpenStreetMap contributors · DataV"。
- 业务数据（仓库、门店、供应商、调拨与采购）用固定种子生成，坐标落在徐州各区；整个演示改为"云仓 WMS · 徐州"（徐州一号仓、二号仓……），与地图一致。

### 12.5 指针按键（core + render，9P）

- 指针事件多带 `buttons`（DOM 的按键位掩码）与 `shiftKey`；右键按下除了 `contextmenu` 之外，随后的移动事件带 `buttons & 2`，地图据此旋转。playground 在画布上阻止浏览器右键菜单。


## 13. 第四轮：总览模式、极光背景、组件进 WMS（2026-10-16）

用户要求（原话摘要）："要把我们做的组件包含进去；一开始像一个 HUD 一样，每个 view 是缩小版、以 grid 的方式排列在空间里，以略微球形的空间排布（像弧形屏幕一样），这个模式叫 overview 模式；背景做一个非常缓慢的、类似极光的动态背景，整体是现有背景颜色的浅色形式，摄像机离远了看；停留 1 秒然后 zoom in 到 dashboard，进入操作模式；用户可以在这个界面里跳转到其他 view，以空间移动的方式移动到摄像机的中间；用户 zoom out 可以回到 overview；overview 可以根据鼠标做轻微的空间动作，点击某个 view 进入它的操作模式。极光参考 Fortbrain 网站，但不能跑到前景里去，要在背景里动。"

用户在头脑风暴中选定：

| 问题 | 决定 |
|---|---|
| view 数量 | 6 个，3 列 × 2 行：现有 4 个 + 新的"入库作业"与"设置"；组件也自然用进现有 view |
| 回到总览 | 触控板捏合缩小（或 Ctrl/⌘ + 滚轮向外）、Esc、"总览"按钮，三者都可以；普通滚轮仍归内容 |
| 登录 | 登录卡片是总览前的一层 HUD：网格在后方待机（远、半透明），登录成功后网格变实、停 1 秒、推进 |
| 实现路线 | A：在库里扩展 `<Space>`（球面网格排布、总览状态、待机状态），demo 只用公开 API（否决 B：全写在 demo 里，agent 用不上；否决 C：总览用缩略图贴图，不是实时内容） |

本节覆盖 §4 的第 1 步（登录）与第 6 步（切换），以及 §3.5 的"同时付整帧拷贝的 Block 不超过 3 个"；与 §2.2、§2.6、§3.1–§3.3 冲突处以本节为准。

### 13.1 球面网格排布（vue，`Space`）

- `Space` 新增 `layout?: 'arc' | 'grid'`（默认 `'arc'`，旧用法不变）与 `columns?: number`（`grid` 时必填，正整数）。`grid` 时 `radius` 是球面半径（默认 24），`gap` 是格子间距（默认 0.4）。
- 槽位顺序同 §3.1（按 `name` 首次出现，被 `v-if` 移除再回来时回到原槽位），按行优先填格：第 i 个在第 ⌊i / columns⌋ 行、第 i mod columns 列。
- 列宽 = 该列最宽 Block 的世界宽度，行高 = 该行最高 Block 的世界高度；Block 在格子里居中。把格子中心铺成平面坐标 (x, y)：列从左到右、行从上到下，相邻格子之间留 `gap`，整个网格的中心在 (0, 0)。
- 平面坐标卷到球面内侧：球心 C = (0, 0, `radius`)，偏航 θ = x / `radius`，俯仰 φ = y / `radius`；位置 C + `radius`·(sin θ·cos φ, sin φ, −cos θ·cos φ)；朝向：先绕 y 转 −θ，再绕自身 x 转 φ，使正面朝向球心。网格中心落在原点、正面朝 +z。
- 给了 `position`/`rotation` 的 Block 照旧用自己的值，不占格子。
- 演示的网格（pt，每单位 244 pt）：上排 订单 880 × 900 | 运营看板 1440 × 900 | 物流网络 1600 × 1000；下排 入库作业 1100 × 900 | 仓储孪生 1280 × 900 | 设置 1000 × 900。网格约 17 × 8 单位，在半径 24 的球面上约占 41° × 19°。

### 13.2 总览与待机（vue `Space` + render `CameraRig`）

- `Space` 新增 `overview?: boolean`（默认 false）。为 true 时 `focus` 可以是 `null`，表示总览；为 false 时 `null` 报错（§13.8）。`focus` 省略（未绑定）时行为同 §2.6，由 Space 自己记住，开始时是第一个 Block。
- `Space` 新增 `standby?: boolean`（默认 false，只在总览时生效）：待机。登录前用：镜头比总览再退远 25 %，所有 Block 的不透明度 0.35（向明亮背景变浅，不加任何灰色遮罩）。
- `Space` 新增事件 `arrive`（payload `string | null`）：镜头到达新的焦点或总览位姿时发出（rig 的 Promise 以 `true` 结束时）。
- **CameraRig 新增"框住一组 Surface"**：`rig.frame(targets: Surface[], opts?: { immediate?: boolean; distanceScale?: number; pivot?: [x, y, z] }): Promise<boolean>`。
  - 视线方向取各目标正面法线的平均（`grid` 时就是 −z）。
  - 距离：让所有目标的四个角（按各自 `restPose`）连同每边 `margin` 都装进视口，按竖直 fov 与宽高比各算，取较大者；再乘 `distanceScale`（待机 1.25）。
  - 每次 `tick` 按当前宽高比重算，同 §2.2。
- **总览视差**：镜头绕 `pivot`（网格中心）偏航、俯仰各至多 3°，平滑与指针类型规则同 §2.2。待机时也有。
- **总览里的 Block**：看得见、内容实时，但不可操作（内层内容盒 `pointerEvents: 'none'`，同 §3.3 的非焦点 Block），不后退（§11.2 的后退只在操作模式）。
  - 悬停的 Block 沿自身法线朝镜头浮起 0.25 单位，并显示焦点环那样的亮边。
  - 点击，或在它上面捏合放大（Ctrl/⌘ + 滚轮向内），`Space` 发出 `update:focus(name)`。
  - 键盘：Tab / Shift+Tab 在 Block 之间移动选中（亮边），方向键按网格移动，Enter 进入。
  - 地图与孪生等视口在非焦点时不播放动画（`active` 为 false，同 9P）。
- **回到总览**（`overview` 为 true 且在操作模式）：`Space` 发出 `update:focus(null)` 的情形：
  - 捏合缩小（Ctrl/⌘ + 滚轮向外，累计 deltaY ≥ 40，300 ms 内）；
  - Esc：只在焦点 Block 里没有聚焦的文字输入框时（有时第一次 Esc 只让输入框失焦）；打开的 Dialog 在它自己的屏幕层 Surface 上处理 Esc，不会传到 Block。
- **Ctrl/⌘ 滚轮归 Space**：带 `ctrlKey` 或 `metaKey` 的 wheel 不派发给 Block 里的内容（地图、孪生只收普通滚轮），而交给 Space；canvas 上阻止浏览器自身的页面缩放。为此指针事件的 `wheel` 多带 `ctrlKey` 与 `metaKey`（core + render，同 §12.5 的做法）。

### 13.3 镜头的飞行（render `CameraRig`）

- **操作模式里 Block 到 Block**：飞行中镜头的目标点沿目标 Block 的法线向后推 `hop × 剩余距离`（`hop` 默认 0.35，推远量不超过对焦距离的 40 %）。剩余距离随飞行缩小，所以路径向外拱起、最后正对目标到达；视觉上是"稍微拉远，再推近"。
- **总览 ↔ 操作模式**：直接推拉（不拱起）。
- 减少动态效果：镜头直接到位（同 §2.2）；Block 与 HUD 的出现、消失改用 0.2 秒的纯不透明度淡入淡出。

### 13.4 演示流程（playground `?scene=spatial`）

dashboard 改名为"运营看板"（Block 名 `dashboard`），"总览"一词只指总览模式。

1. **待机 + 登录 HUD**：`Space` 以 `overview`、`standby` 开始，`focus = null`。屏幕中央是登录卡片：屏幕层玻璃 Surface，设计与文案同 `?scene=signup`，用组件重建（邮箱、密码 `Input`，密码可切换显示；"记住我" `Checkbox`；"登录" 主 `Button`）。
   - 校验：邮箱格式不对，或密码少于 6 位，在对应字段下显示红字；其余输入都算成功（演示）。
   - 成功：按钮 `loading` 约 0.8 秒。
2. **进入总览**：
   - 登录卡片缩小并淡出（0.35 秒，`GlassTransition`），同时 `standby` 变为 false。
   - 镜头推近到总览位姿（约 0.9 秒）；Block 的不透明度从 0.35 到 1，按行依次错开 60 ms。
3. **停留并推进**：
   - 收到 `arrive(null)` 后计时 1 秒，然后 `focus = 'dashboard'`。
   - 计时内用户点了别的 Block，就去那个 Block。
   - 自动推进只在登录后发生一次。
4. **操作模式**：
   - 屏幕底部浮出导航坞：屏幕层 Surface，里面是 `GlassContainer`，相邻按钮的玻璃融成一条。坞里有一个"总览"按钮（网格图标）和 6 个 view 的图标按钮。
   - 当前 view 的按钮是着色玻璃（不参与融合，见 Task 16 的裁定），带 `glassId`：换 view 时它重新挂载，高亮从旧位置流到新位置。
   - 坞在总览与待机时收起。
   - 每个 view 的标题栏有面包屑"总览 / <view 名>"，点"总览"回到总览。view 里原有的跳转（看板卡片上的链接等）都改成设置 `focus`。
5. **回到总览**：§13.2 的捏合与 Esc，坞上的"总览"，面包屑的"总览"。之后不再自动推进。
6. **退出登录**：设置里点"退出登录"，弹出确认 `Dialog`；确认后 `focus = null`、`standby = true`，登录卡片重新出现，表单清空。
7. **测试入口**：
   - `?focus=<name>`：跳过登录，直接在该 view 的操作模式（`standby` false）。
   - `?stage=login`：停在待机 + 登录；`?stage=overview`：停在总览，不自动推进。
   - `motion=frozen` 时极光冻结在固定时刻，视差关闭。

### 13.5 极光背景（playground）

- **形状**：取代现在的弧形背景墙（`createCurvedWall`），改成网格后方的一片球面穹顶：与网格同心，半径 `radius + 8`。它覆盖总览、待机、每个 view 的对焦位姿，以及各自视差能看到的全部范围，在五种宽高比下都盖满（同 9F 背景墙的测试做法）。
- **材质**：不受光照（`MeshBasicNodeMaterial`），不投影，不接收阴影。
- **底色**：现有粉彩配色整体向白色提亮约 50 %；去掉现在左下角偏暗的紫灰色块与暗角，没有灰色蒙层。
- **光带**：
  - 3～4 条 fbm 噪声光带：中心线随噪声起伏，下方挂着垂直的丝状纹理。做法参考 Fortbrain 网站 `js/scene.js` 的 `auroraFrag`。
  - 颜色是淡青、淡紫、浅杏金，在浅底上柔和混色（`mix`，强度约 0.35），不用加法叠加，不会过曝发白。
- **速度**：一条光带漂过整个画面约 60–90 秒；丝状纹理有轻微闪动。
- **只在背景**：穹顶在所有 Block 之后，参与深度测试，被 Block 挡住，被玻璃折射与模糊；不存在任何画在 view 前面的极光平面。
- **性能**：
  - 极光先画进一张小 RT（512 × 256，3 层 fbm），每秒更新 15 次，穹顶采样这张 RT。
  - 闲置降帧：root 新增只读的 `idle`（上一次 tick 没有任何 Surface 变化、动画或视口请求帧，镜头静止）。playground 的循环在 `idle` 持续 2 秒后改为每秒渲染 15 次，任何输入或动画立即恢复每帧渲染。
  - 减少动态效果时极光静止。

### 13.6 六个 view 与组件

1. **运营看板**（现有 `Overview.vue`）：
   - 标题栏右侧加"自动刷新" `Switch`：打开时每 5 秒按固定种子微调 KPI 与当日数字。
   - 时间范围"今日 / 本周 / 本月"是 `GlassContainer` 里的三个 `Button`，选中项是着色玻璃，带 `glassId`；切换时数据随之切换。
2. **订单**（现有 `Orders.vue`）：
   - 顶部是搜索 `Input`（单号或客户，边输入边筛选，支持中文输入法）、两个 `Checkbox`（"只看逾期"、"只看今日"），以及"导出"次要按钮（`loading` 0.8 秒后显示"已导出" 2 秒，不真的下载）。
   - 点一行，弹出订单详情 `Dialog`，里面有"标记已发货"主按钮，点了改变该行状态。
3. **物流网络**（现有）：地图右上角浮一条 `GlassContainer` 工具条：放大、缩小、复位视角，以及门店、仓库、供应商三个图层开关（隐藏或显示对应的棱柱与线路）。
4. **仓储孪生**（现有）：
   - 视角预设工具条（俯视 / 斜视 / 正视，`GlassContainer`）。
   - "只显示低库存" `Switch`：其余库位变淡。
5. **入库作业**（新，`Inbound.vue`）：
   - 字段：供应商、采购单号、3 行 SKU（SKU 编码 + 数量，数量是数字输入）、"已抽检" `Checkbox`、"需要冷链" `Switch`、备注。
   - 底部按钮："暂存"（次要）、"提交入库"（主）。
   - 提交流程：先校验，不通过的字段下显示红字；通过后弹出确认 `Dialog`，汇总所填内容；确认后按钮 `loading`，然后表单上方显示"入库单 RK-<日期>-<三位序号> 已提交"（如 RK-20261016-001），表单清空。
6. **设置**（新，`Settings.vue`）：
   - 通知：三个 `Switch`（逾期提醒、低库存预警、每日报表邮件）。
   - 显示：
     - "减少动态效果" `Switch`，实际生效：写 `root.anim.reducedMotion`，极光静止、镜头不飞。
     - "画质：高 / 中 / 低" `GlassContainer` 三按钮，实际切换 `root.quality`。
   - 账户：显示名 `Input`；"修改密码"按钮，打开一个带两个密码 `Input` 的 `Dialog`。
   - "退出登录"（§13.4 第 6 步）。

新 view 的数据用固定种子生成，与现有的"徐州一号仓"一致。

### 13.7 性能

- 总览时 6 个玻璃背板同时可见，超过了 §3.5"不超过 3 个"的前提。目标：总览静止与视差时，参考机（本机 Mac，WebGPU，high 档，1512 × 808，DPR 2）帧间隔 p95 ≤ 25 ms。
- 超标时：屏幕投影互不重叠的 Block 共用一次背景拷贝（它们都只看见穹顶），由 render 实现。
- 由 Task 21 测量。

### 13.8 错误处理（补充 §5）

| 情形 | 处理 |
|---|---|
| `layout: 'grid'` 没给 `columns`，或不是正整数 | zod 报错 |
| `focus` 为 `null` 而 `overview` 为 false | `[Space.focus] 只有 overview 为 true 时才能为 null（表示总览）` |
| `standby` 为 true 而 `focus` 不是 `null` | 开发期 `console.warn` 一次；`standby` 不生效 |

### 13.9 测试

- **render 单测**：`rig.frame` 的距离（横竖两种限制、`distanceScale`、resize 重算）；总览视差绕 `pivot`；`hop` 路径向外拱起、到达时正对目标、推远量有上限；`idle` 的判定；wheel 事件带 `ctrlKey`/`metaKey`。
- **vue 单测**（假 root）：
  - `grid` 槽位：行优先、列宽行高、球面位置与朝向、按名记位；
  - `focus: null` 驱动 `rig.frame`；`standby` 的距离与不透明度；`arrive` 事件；
  - 总览里的点击、捏合放大、Tab/方向键/Enter；操作模式里的捏合缩小与 Esc（有聚焦的输入框时 Esc 不回总览）；Ctrl/⌘ 滚轮不传给内容；
  - §13.8 的错误。
- **playground**：穹顶在总览、待机、每个对焦位姿及其视差角落、五种宽高比下都盖满视野；网格槽位与 §13.1 的尺寸一致。
- **视觉回归**（Task 20，替换 §6 的 spatial 用例）：
  - `motion=frozen`：待机 + 登录、总览、运营看板、入库作业（含一个红字校验）、设置、订单详情对话框；
  - WebGPU 与 WebGL2 各一套。
- **帧时间**：§13.7 的总览用例，加上 §6 的切换用例（改为坞上切换 view）。

### 13.10 插入 Plan 3 的任务

Task 19 保留 signup、world、gallery 与性能场景的 Vue 化；它原来的 spatial 部分（登录与设置）移到 19D。新任务排在 Task 19 之后、Task 20 之前：

| 任务 | 层 | 内容 |
|---|---|---|
| 19A | render + core | `rig.frame`、总览视差绕 `pivot`、`hop` 飞行路径（§13.2、§13.3）；`root.idle`（§13.5）；wheel 带 `ctrlKey`/`metaKey` |
| 19B | vue | `Space` 的 `layout: 'grid'`、`columns`、`overview`、`standby`、`arrive`；总览里的悬停、点击、键盘；捏合与 Esc 回总览；Ctrl/⌘ 滚轮归 Space（§13.1、§13.2、§13.8） |
| 19C | playground | 极光穹顶与闲置降帧（§13.5）；可视检查 |
| 19D | playground | 演示流程（§13.4）：登录 HUD、总览停留与推进、导航坞、面包屑、退出登录、测试入口；六个 view 与组件（§13.6）；可视检查后给用户看 |

对已有任务的调整：Task 20 的 spatial 用例按 §13.9；Task 21 加上 §13.7 的总览帧时间；Task 18 的 manifest 收录 `Space` 的新 props 与事件，示例里给一个 `layout="grid"` + `overview` 的写法。
