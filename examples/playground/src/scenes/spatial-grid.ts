import { Euler, Quaternion, Vector3 } from 'three'
import { gridSlots } from '@glassui/vue'
import { framePose } from '@glassui/render'
import { focusPose } from '@glassui/render/internal'
import type { ArcSlot } from '@glassui/vue'

export const GRID = { columns: 3, radius: 24, gap: 1.5, cameraMargin: 0.19 } as const
/** The six-Block overview remains in the camera's frustum on a tall viewport. */
export const SPATIAL_CAMERA_FAR = 200
const PT = 244
export const BLOCKS = {
  orders: { width: 1100, height: 960 }, dashboard: { width: 1440, height: 900 }, network: { width: 1350, height: 950 },
  twin: { width: 1280, height: 900 }, inventory: { width: 1280, height: 900 }, settings: { width: 1000, height: 1000 },
} as const
export const BLOCK_NAMES = ['orders', 'dashboard', 'network', 'twin', 'inventory', 'settings'] as const
const slotSizes = BLOCK_NAMES.map(name => ({ width: BLOCKS[name].width / PT, height: BLOCKS[name].height / PT }))
// Keep the grid's reading order, but give the dashboard the nearest plane and let
// the supporting views recede. The offset is real world depth, not a 2D shadow.
export const DEPTH_BY_NAME = { orders: 0.35, dashboard: 1.55, network: 0.1, twin: -0.45, inventory: -0.15, settings: -0.8 } as const
export const BLOCK_SCALE = { orders: 1, dashboard: 1.16, network: 1, twin: 1, inventory: 1, settings: 1 } as const
export const SLOTS: ArcSlot[] = gridSlots(slotSizes, GRID.columns, GRID.radius, GRID.gap).map((slot, i) => {
  const name = BLOCK_NAMES[i]!
  return { ...slot, position: [slot.position[0], slot.position[1], slot.position[2] + DEPTH_BY_NAME[name]] }
})
export const SLOT_BY_NAME = Object.fromEntries(BLOCK_NAMES.map((name, i) => [name, SLOTS[i]!])) as Record<(typeof BLOCK_NAMES)[number], ArcSlot>
export const NETWORK = SLOT_BY_NAME.network
export const TWIN = SLOT_BY_NAME.twin
export const PANEL = { width: 300, height: 170, ptPerUnit: 360, offset: [1.15, -0.74, 2.05] as [number, number, number] }
export const PLACE_PANEL = { width: 320, height: 216, ptPerUnit: 360, offset: { right: [1.35, 0.45, 1.25], left: [-1.35, 0.45, 1.25] } as Record<'left' | 'right', [number, number, number]> }
export const TRACE_PANEL = { width: 460, height: 236, ptPerUnit: 300, offset: [-1.36, -1.4, 2.15] as [number, number, number] }
export const WALL = { out: 4, height: 20, margin: 34 * Math.PI / 180 } as const
export const DOME = { out: 8, yawMargin: 6 * Math.PI / 180, pitchMargin: 6 * Math.PI / 180 } as const
export interface RestPose { position: readonly [number, number, number]; rotation: readonly [number, number, number] }
export function inFrameOf(pose: ArcSlot, offset: readonly [number, number, number]): ArcSlot {
  const position = new Vector3(...offset).applyQuaternion(new Quaternion().setFromEuler(new Euler(...pose.rotation))).add(new Vector3(...pose.position))
  return { position: [position.x, position.y, position.z], rotation: [...pose.rotation] }
}
export function wallSpan(angles: readonly number[]): { from: number; to: number } {
  return { from: Math.min(...angles) - WALL.margin, to: Math.max(...angles) + WALL.margin }
}
export function wallSpanOf(poses: readonly RestPose[]): { from: number; to: number } {
  const angles = poses.map(p => arcAngleOf(p.position))
  return wallSpan(angles)
}

/** The camera's visible spherical angles at each supported aspect, including the Space rig's parallax corners. */
export function domeSpan(): { yaw: [number, number]; pitch: [number, number] } {
  const aspects = [4 / 3, 16 / 10, 16 / 9, 1512 / 808, 21 / 9]
  const halfFov = 38 * Math.PI / 360, center = new Vector3(0, 0, GRID.radius)
  const yaws: number[] = [], pitches: number[] = []
  for (const aspect of aspects) {
    const targets = SLOTS.map((slot, i) => {
      const name = BLOCK_NAMES[i]!
      return { restPose: { position: [...slot.position], rotation: [...slot.rotation], scale: [BLOCK_SCALE[name], BLOCK_SCALE[name], BLOCK_SCALE[name]] }, parent: null, contentPlaneZ: 0, model: { width: BLOCKS[name].width, height: BLOCKS[name].height, ptPerUnit: PT } }
    })
    const poses: { position: Vector3; quaternion: Quaternion }[] = []
    for (const scale of [1, 1.25]) {
      const pose = { position: new Vector3(), quaternion: new Quaternion() }
      framePose(targets as never, 38, aspect, GRID.cameraMargin, scale, pose)
      poses.push(pose)
    }
    for (const target of targets) {
      const pose = { position: new Vector3(), quaternion: new Quaternion() }
      focusPose(target as never, 38, aspect, GRID.cameraMargin, pose)
      poses.push(pose)
    }
    for (const pose of poses) for (const x of [-1, 1]) for (const y of [-1, 1]) for (const px of [-3, 3]) for (const py of [-3, 3]) {
      const q = pose.quaternion.clone().multiply(new Quaternion().setFromEuler(new Euler(py * Math.PI / 180, px * Math.PI / 180, 0, 'YXZ')))
      const dir = new Vector3(x * Math.tan(halfFov) * aspect, y * Math.tan(halfFov), -1).normalize().applyQuaternion(q)
      const o = pose.position.clone().sub(center), b = o.dot(dir), c = o.lengthSq() - (GRID.radius + DOME.out) ** 2
      const hit = pose.position.clone().addScaledVector(dir, -b + Math.sqrt(b * b - c)).sub(center).normalize()
      yaws.push(Math.atan2(hit.x, -hit.z)); pitches.push(Math.asin(hit.y))
    }
  }
  return { yaw: [Math.min(...yaws) - DOME.yawMargin, Math.max(...yaws) + DOME.yawMargin], pitch: [Math.min(...pitches) - DOME.pitchMargin, Math.max(...pitches) + DOME.pitchMargin] }
}
export const arcAngleOf = (position: readonly [number, number, number]): number => Math.atan2(position[0], GRID.radius - position[2])
