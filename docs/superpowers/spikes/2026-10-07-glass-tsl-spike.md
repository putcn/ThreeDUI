# Spike ①+②：TSL Liquid Glass 单 quad 原型（可抛弃）

代码：`spikes/glass/`（`pnpm spike:glass`，`?webgl` 强制 WebGL2 后端）。

## 结论
- `viewportMipTexture()` 在 WebGPU 与 WebGL2 后端行为一致，画面像素级相同；节点按 `updateBeforeType=RENDER` 在**首个使用它的对象绘制前**拷贝一次帧缓冲。因此：同一节点实例 = 同一份 backdrop（玻璃互不可见，Apple 语义）；每个"层级"一个节点实例 = 后画的玻璃能看到先画的玻璃（physical stacking），代价是每层一次全屏拷贝 + mip 生成。spec §5.1 的分层模型成立。
- 折射位移在面板空间计算、经 `cameraProjectionMatrix * modelViewMatrix` 投影到屏幕 UV 后再采样，在任意旋转/透视下正确（见截图 3，约 60° 侧视仍无撕裂）。注意 `screenUV` 为 y 向下，投影差值需翻转 y。
- 超椭圆 SDF：胶囊/圆形必须用指数 n=2，否则 radius=半高会得到 squircle；固定半径形状用 n≈4.5。spec §4.1 `radius:'capsule'` 需隐含 n=2。
- 模糊用 mip lod（frost×6）足够做磨砂观感；dual-Kawase 留到正式实现（mip 三线性在大 lod 下有方块感）。
- 解析 AA（`fwidth`）边缘干净，无需 MSAA。
- 性能：1512×808@2x，1 个面板 + 11 个玻璃元素 + 阴影 + 文字，59 draws，WebGL2 后端 ~47 fps（M 系列 Mac，带截图开销；两次全屏 mip 拷贝是主要成本）。正式实现要按 spec §5.1 把贴在内容面上的玻璃改为面板空间采样，去掉屏幕拷贝。

## 遗留
- 未做：smin 形状融合、自适应亮度、深度拒绝、dual-Kawase、质量分级。
- 文字用 Canvas2D 贴图临时方案（spike ③ 另测 @pmndrs/glyph）。

---

# Spike ②b：真 3D 版本（`spikes/glass3d/`，`pnpm spike:glass3d`）

按修订后的 spec §5 重做：玻璃是真实几何，光照/反射/阴影由引擎完成。

## 做法
- `slab.ts`：超椭圆圆角矩形 × 凸起剖面（squircle/circle）的实体网格，前面 + 倒角 + 背面，`computeVertexNormals`。胶囊/圆用指数 2。
- `glass.ts`：`MeshPhysicalNodeMaterial` + `backdropNode`/`backdropAlphaNode`（three 内置钩子：backdrop 替换 diffuse 项，specular 仍由灯光与环境贴图提供）。backdrop = 用真实法线做 Snell 折射、沿折射方向穿过真实厚度到背面、投影到屏幕采样 `viewportMipTexture`（roughness → mip lod），三通道不同 IOR 做色散，Beer-Lambert 吸收做 tint。clearcoat 作为抛光顶层。
- 场景：RoomEnvironment PMREM 环境贴图、方向光 VSM 阴影（UI 元素互相投射、投到世界几何）、MSAA。按压 = 真实缩放 + 下沉，悬停 = 真实倾斜。

## 结论
- 与平面版相比，倒角高光、厚度、边缘折射、元素间阴影全部"免费"且随相机/灯光正确变化；WebGPU 与 WebGL2 后端一致，无控制台错误。
- `backdropNode` 钩子完全够用，不需要改 three 内部；spec §5.3 可直接按此实现。
- 坑：① 网格绕序反了会只看到平的背面（表现为"没有任何高光"），用法线采样即可定位；② 倒角太窄时高光只有几像素，按钮应用接近半圆的 pillow 剖面（bezel = 半高）；③ 无 tone mapping 时灯光预算要控制在 ≈1，否则白玻璃过曝；④ frosted 玻璃的 diffuse 项要用 tint 着色，否则 tint 被洗白；⑤ 透过玻璃能看到世界几何在墙上的阴影，物理正确但视觉上像污渍，正式实现中内容面板应作为主要 backdrop。
- 性能（1512×808@2x，WebGPU）：1 面板 + 11 玻璃 + 3 物体，41 draws，42.7k tris，60 fps（含两次全屏 mip 拷贝与一次 VSM 阴影 pass）。

## 遗留
- 贴在内容面上的玻璃改为面板空间采样（去掉屏幕拷贝）；9-slice 实例化几何；smin/几何融合；自适应明暗；dual-Kawase；质量分级；文字仍是 Canvas2D 贴图。

---

# Spike ②c：对标参考图的质感迭代

## 新增做法
- **棚拍环境图**（`studio.ts`）：暗房 + 左上大柔光箱 + 底部细光带 + 一个小热点，PMREM 后做 `scene.environment`。倒角面反射柔光箱 → 顶边细亮线（Apple glint）自然出现；RoomEnvironment 太均匀，出不来。
- **彩色透射阴影**：three 原生支持——`renderer.shadowMap.transmitted = true` + `material.castShadowNode = vec4(透过色, alpha)`。接收面在阴影处乘以透过色，彩色玻璃下面就有同色光晕/阴影，世界几何也能收到。自己写的"灯光视角透射贴图 pass"已删除（原生更简单、更一致）。
- **iridescence**（薄膜干涉）用于清色玻璃的彩虹边；折射色散加大。
- 文字是按钮网格的子节点（随抬起/倾斜/缩放）。
- 几何：平顶 + 窄圆弧倒角（bezel ≈ 32% 半高，厚度 ≈ 9% 高）；整半圆 pillow 会像塑料糖。

## 坑
- **VSM 下 `receiveShadow` 的物体也会被画进阴影贴图**（`ShadowBaseNode.js:90`），要让布景不投影得同时关掉 castShadow 和 receiveShadow。
- `shadow.intensity` 同时缩放彩色阴影；0.6 左右能看到颜色又不脏。
- 清色玻璃的"白"来自磨砂层对天光的反射，用 `lift`（透射项向白混合 ~0.14）表达；没有它清色按钮会灰。
- 灯光预算（无 tone mapping）：hemi 0.65 + key 1.8 + env 0.45，墙面基色 ×0.95。

## 性能（1565×784@2x，WebGPU）：51 draws、52k tris、70 fps（含 VSM 阴影 pass 与两次全屏 mip 拷贝）。

---

# Spike ②d：按参考图纠正形状、反射与阴影

- **剖面改为 `fillet`**：竖直侧壁 + 顶面小半径圆角 + 平顶（参考图的"直切 + 圆润"），侧壁用独立顶点保持棱线清晰。枕形/透镜剖面只保留给 ring 一类元素。spec §5.2 的默认剖面应为 fillet，`bezel` 改名/并入 `fillet`。
- **面板反射组件**：TSL `reflector({ resolutionScale: 0.5, generateMipmaps: true })`，`target` 挂在面板网格上（局部 +Z = 镜面法线），`.level(2.5)` 取模糊反射，按 `alpha × 强度` 混入透射项（不乘 alpha 会把镜面的空背景混成灰）。代价：每帧多一次全场景镜像渲染（149 draws / 53 fps，vs 不开 85 draws / 90 fps）；正式实现里面板空间的内容层 RT 可以直接拿来做反射，不必再渲染一遍场景。
- **不再往墙上投影**：面板 `castShadow=false`，墙不 `receiveShadow`。组件只投到面板上。
- **平面元素**：checkbox 方块、滑块钮、小圆点、Modal 灰段、卡片与环内的白方块都是 Canvas2D 平面贴图，挂在对应 slab 的顶面上。结论：不是所有东西都该是几何，"面板上的小装饰"用 2D 更干净，spec §5.5 要加"平面装饰层"。
