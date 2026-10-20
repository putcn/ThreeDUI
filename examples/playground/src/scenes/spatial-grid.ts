import { Euler, Quaternion, Vector3 } from 'three'
import { gridSlots } from '@glassui/vue'
import type { ArcSlot } from '@glassui/vue'

export const GRID = { columns: 3, radius: 24, gap: 0.4 } as const
const PT = 244
export const BLOCKS = {
  orders: { width: 880, height: 900 }, dashboard: { width: 1440, height: 900 }, network: { width: 1600, height: 1000 },
  inbound: { width: 1100, height: 900 }, twin: { width: 1280, height: 900 }, settings: { width: 1000, height: 900 },
} as const
export const BLOCK_NAMES = ['orders', 'dashboard', 'network', 'inbound', 'twin', 'settings'] as const
const slotSizes = BLOCK_NAMES.map(name => ({ width: BLOCKS[name].width / PT, height: BLOCKS[name].height / PT }))
export const SLOTS: ArcSlot[] = gridSlots(slotSizes, GRID.columns, GRID.radius, GRID.gap)
export const SLOT_BY_NAME = Object.fromEntries(BLOCK_NAMES.map((name, i) => [name, SLOTS[i]!])) as Record<(typeof BLOCK_NAMES)[number], ArcSlot>
export const NETWORK = SLOT_BY_NAME.network
export const TWIN = SLOT_BY_NAME.twin
export const PANEL = { width: 300, height: 170, ptPerUnit: 360, offset: [1.15, -0.74, 2.05] as [number, number, number] }
export const PLACE_PANEL = { width: 320, height: 216, ptPerUnit: 360, offset: { right: [1.35, 0.45, 1.25], left: [-1.35, 0.45, 1.25] } as Record<'left' | 'right', [number, number, number]> }
export const WALL = { out: 4, height: 16, margin: 34 * Math.PI / 180 } as const
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
export const arcAngleOf = (position: readonly [number, number, number]): number => Math.atan2(position[0], GRID.radius - position[2])
