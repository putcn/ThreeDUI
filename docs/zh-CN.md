# GlassUI 使用文档

GlassUI 目前以 pnpm workspace 源码包提供，尚未发布 npm 正式版本。请在仓库中开发或以仓库里的 Playground 为起点。需要 Node.js 22.12+ 和 pnpm 11。

```bash
git clone https://github.com/putcn/ThreeDUI.git
cd ThreeDUI
pnpm install
pnpm playground
```

打开[演示导航页](http://127.0.0.1:5176/demos.html)，先体验[综合空间应用](http://127.0.0.1:5176/?scene=spatial&stage=overview)和[可交互组件 Gallery](http://127.0.0.1:5176/?scene=gallery)。浏览器侧边栏比较窄时，固定尺寸的组件视图会缩小；建议在完整浏览器窗口查看细节。

[独立注册演示](http://127.0.0.1:5176/?scene=signup)把表单放在世界层：左键拖动平移、右键拖动旋转、滚轮缩放。直接点击仍可操作输入框和按钮。

## 接入方式

宿主应用负责 three.js 的 renderer、scene、camera、canvas 和帧循环。通过 `await createUIRoot({ renderer, scene, camera })` 创建 GlassUI root，再用 `createGlassApp(App, { root }).mount()` 挂载 Vue 组件。每帧调用 `root.frame(time)`。完整、可复制的 `main.ts` 和 `App.vue` 见[快速开始](./getting-started.md)，Playground 的实际宿主代码在 [`main.ts`](../examples/playground/src/main.ts)。

Vue SFC 需要 `@vitejs/plugin-vue`；构建目标至少为 `es2022`。本 workspace 把 Vue 固定为 3.5.44，以便 SFC 与自定义渲染器共用同一个运行时。使用原生 host 标签（`box`、`text`、`image`、`glass`、`scroll`、`portal`）时，按 [Playground 的 Vite 配置](../examples/playground/vite.config.ts)设置 `isCustomElement`。

## 选择界面容器

| 场景 | 组件 | 关键规则 |
| --- | --- | --- |
| 跟随屏幕的登录框、HUD | `Surface layer="screen"` | 用 `center`、`fill` 或 `left`/`top` 定位。 |
| 场景中的独立面板 | `Surface layer="world"` | 用 `position`、`rotation` 设置世界坐标和角度。 |
| 可导航的多视图界面 | `Space` + 直接子项 `Block` | 每个 Block 的 `name` 唯一；Space 管理镜头和焦点。 |
| Block 中的内容分组 | `Card` | 分组玻璃层位于 Block 前方。 |

`Space` 的默认布局是弧形；`layout="grid"` 必须传正整数 `:columns`。只有启用 `overview` 时，`focus = null` 才表示总览。如果 `Space` 控制镜头，就不要同时让 OrbitControls 控制同一相机。`Block` 的 `width`、`height` 是数值型 pt，需要 Vue 数值绑定，例如 `:width="560"`。世界坐标使用 three.js 单位，`ptPerUnit` 决定两种单位之间的换算。

## 用组件搭建内容

布局和内容组件有 `Box`、`Stack`、`Text`、`Icon`。交互组件有 `Button`、`Input`、`Switch`、`Checkbox`、`Dialog`、`GlassContainer`。图表及 3D 内容组件有 `Viewport3D`、`BarChart3D`、`SurfaceChart3D`、`BarMatrix3D`、`LineChart`。请通过[组件指南](./components.md)了解组合方式，通过[机器可读 manifest](../packages/vue/manifest.json)确认每个组件的准确 props、事件、插槽、默认值及常见错误；不要把 HTML 或 Tailwind 的规则直接套用到 GlassUI。

常用交互写法：`Button` 用 `@press`，`Input` 用 `v-model`，`Switch`/`Checkbox` 用 `v-model:checked`，`Dialog` 用 `v-model:open`。`Surface` 自身不渲染布局节点，因此 `tw`、`style` 放到内部 `Box` 或 `Stack`。需要 3D 图表时，把它放在世界层的 `Block` 内，避免放进滚动区域。

更多说明见[空间界面指南](./spatial-ui.md)与[演示指南](./demos.md)。代码示例可从 [`Gallery.vue`](../examples/playground/src/gallery/Gallery.vue) 和 [`Spatial.vue`](../examples/playground/src/scenes/Spatial.vue)开始看。

## 开发验证

```bash
pnpm typecheck
pnpm test
pnpm playground:build
```

修改组件元数据后运行 `pnpm manifest`。视觉截图基线与字体和 GPU 环境有关，更新前请阅读[视觉测试说明](../examples/visual/README.md)。Agent 可使用仓库内的 [build-glassui skill](../.agents/skills/build-glassui/SKILL.md)。
