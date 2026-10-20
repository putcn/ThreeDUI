/**
 * `@glassui/render`: the public API — a root (`createUIRoot`) over a host three.js renderer, its Surfaces, the screen
 * layer, the quality tiers, the image loader and the IME bridge. Everything else (batches, materials, passes, pointer
 * routing) is in `@glassui/render/internal` and may change without notice.
 */
export const RENDER_VERSION = '0.0.0'
export { createUIRoot, type UIRoot, type UIRootOptions, type UIRootEventMap, type CreateSurfaceOptions, type UIRenderer } from './root'
export { Surface, fillColors, type SurfaceOptions, type SurfaceEventMap, type FillColors } from './surface/surface'
export type { SurfacePose, PoseSpring } from './surface/motion'
export { framePose, type CameraRig, type CameraRigOptions, type FrameOptions } from './rig'
export type { WheelGesture, KeyGesture } from './pointer'
export type { Viewport3DAttachment, Viewport3DContext, Attach3DOptions } from './viewport'
export type { BarChart, BarChartData } from './chart/bar'
export type { SurfaceChart, SurfaceChartData, SurfaceChartLabels, SurfaceCell } from './chart/surface'
export type { BarMatrix, BarMatrixData, BarMatrixLabels } from './chart/matrix'
export type { GridCell } from './chart/frame'
export { ScreenLayer, type ScreenPlacement } from './surface/screen'
export { QUALITY, QualityController, type QualityTier, type QualityProfile } from './quality'
export { defaultImageLoader, type ImageLoader, type ImageSource } from './image/images'
export { ImeBridge, type ImeBridgeOptions, type ImeField, type ImeState, type DocLike, type TextareaLike, type ViewportLike } from './ime'
