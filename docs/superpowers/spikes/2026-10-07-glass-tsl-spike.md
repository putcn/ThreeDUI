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
