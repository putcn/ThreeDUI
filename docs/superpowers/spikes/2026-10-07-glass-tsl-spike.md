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
