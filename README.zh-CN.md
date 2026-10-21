# ThreeDUI / GlassUI

**像写 Vue 一样，在三维空间里搭建日常界面。** GlassUI 是基于 three.js 的实验性开源组件库：熟悉的 Vue 组件成为真实 3D 场景中的可交互界面。普通控件、图表、地图和业务 3D 内容可以共享同一个场景与镜头。

[English](./README.md) · [中文使用文档](./docs/zh-CN.md) · [完整接入示例](./docs/getting-started.md) · [组件指南](./docs/components.md) · [Agent skill](./.agents/skills/build-glassui/SKILL.md)

![六个业务视图组成的三维工作空间](./docs/images/spatial-overview.jpg)

综合演示包含订单、Dashboard、网络、仓储孪生、库存、设置六个视图。图表、地图与仓储内容和界面共享场景及相机。演示使用本地示例数据，没有连接线上业务后端。

## 体验演示

需要 Node.js 22.12+、pnpm 11。在仓库根目录运行：

```bash
pnpm install
pnpm playground
```

打开 **[演示导航页](http://127.0.0.1:5176/demos.html)**：

| 演示 | 内容 | 直接打开 |
| --- | --- | --- |
| 空间业务系统 | 登录、六个关联视图、镜头聚焦、3D 图表/地图/仓储和上下文面板 | [打开](http://127.0.0.1:5176/?scene=spatial) |
| 组件库 Gallery | 基础元件、按钮、开关、输入框、对话框、玻璃容器的可交互示例 | [打开](http://127.0.0.1:5176/?scene=gallery) |
| 注册表单 | 观察玻璃厚度、输入和光照；左键拖动平移、右键拖动旋转、滚轮缩放 | [打开](http://127.0.0.1:5176/?scene=signup) |

![可交互的 GlassUI 组件 Gallery](./docs/images/gallery.jpg)

想先看六视图总览，可打开[空间总览](http://127.0.0.1:5176/?scene=spatial&stage=overview)。加上 `&focus=inventory` 可以跳到库存视图；其他名称为 `orders`、`dashboard`、`network`、`twin`、`settings`。组件库可以用 `?scene=gallery&focus=buttons` 跳转到指定分区。[演示指南](./docs/demos.md)列出了全部入口和参数。

![有真实厚度的玻璃注册表单](./docs/images/signup-depth.jpg)

## 开始开发

目前提供的是**仓库内 workspace 包，尚未发布 npm 正式版本**。请克隆仓库，在 pnpm workspace 中使用这些包。[快速开始](./docs/getting-started.md)有完整的宿主渲染器与 Vue 示例；[组件指南](./docs/components.md)介绍组合方式；[组件 manifest](./packages/vue/manifest.json)提供完整的 props、事件、插槽和示例。仓库还附带 [Agent skill](./.agents/skills/build-glassui/SKILL.md)，方便 coding agent 依照实际 API 搭建界面。

在本仓库工作的 agent 可通过 [`AGENTS.md`](./AGENTS.md) 找到 skill；其他 agent 也可以直接读取该 skill 文件。

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Space, Block, Card, Text, Button, BarChart3D } from '@glassui/vue'
const focus = ref<string | null>(null)
const visits = [{ label: '周一', value: 120 }, { label: '周二', value: 160 }]
</script>

<template>
  <Space v-model:focus="focus" overview>
    <Block name="home" :width="560" :height="420">
      <Text value="工作空间" size="2xl" />
      <Button label="查看分析" @press="focus = 'analytics'" />
    </Block>
    <Block name="analytics" :width="720" :height="560">
      <Card title="访问量"><BarChart3D :data="visits" /></Card>
    </Block>
  </Space>
</template>
```

`Space` 在世界空间中排列、聚焦 `Block`；每个 `Block` 都有自己的 3D Surface。也可以直接创建世界层或屏幕层 `Surface`。宿主应用负责 three.js 渲染器、相机、canvas 和帧循环，详见[完整接入示例](./docs/getting-started.md)。

## 当前能力与状态

- Vue 3 自定义渲染器、布局、主题、工具类、输入与输入法桥接。
- 屏幕层及世界层 Surface，`Space`/`Block` 空间组合、聚焦与镜头运动。
- `Button`、`Input`、`Switch`、`Checkbox`、`Dialog`、`GlassContainer` 等控件和基础布局/文字组件。
- `Viewport3D`、`BarChart3D`、`SurfaceChart3D`、`BarMatrix3D`、`LineChart` 等与场景结合的可视化组件。
- WebGPU 渲染并可回退 WebGL2；Playground 支持指定质量档位。

项目仍处于早期阶段。包的导出目前指向 TypeScript 源码，适合在本 workspace 内开发；不同设备的浏览器/GPU 支持与性能可能不同。渲染思路见[核心设计文档](./docs/superpowers/specs/2026-10-07-glassui-core-design.md)，空间界面方向见[空间设计文档](./docs/superpowers/specs/2026-10-15-glassui-spatial-ui-design.md)。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [`packages/core`](./packages/core) | UI 树、布局、样式、事件和焦点 |
| [`packages/text`](./packages/text) | 文字与字形基础设施 |
| [`packages/render`](./packages/render) | three.js 渲染器、材质、Surface 和镜头控制 |
| [`packages/vue`](./packages/vue) | Vue 渲染器及组件、[机器可读 manifest](./packages/vue/manifest.json) |
| [`examples/playground`](./examples/playground) | 综合演示、组件 Gallery、独立示例 |
| [`examples/visual`](./examples/visual) | Playwright 截图回归 |
| [`docs`](./docs) | 入门、组件、空间界面指南和设计过程 |

```bash
pnpm typecheck
pnpm test
pnpm playground:build
```

参与开发请看 [Contributing](./CONTRIBUTING.md)。视觉基线依赖机器环境，更新前请阅读[视觉测试说明](./examples/visual/README.md)。

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。
