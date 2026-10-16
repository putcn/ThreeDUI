import { arcSlots, type ArcSlot } from '@glassui/vue'

/**
 * The spatial scene's arc (world units): Spatial.vue's Space lays its Blocks on it, and main.ts builds the curved wall
 * round the same centre, (0, 0, radius). Tune it here and both follow.
 *
 * Radius 10, gap 0.2 (the 9F sketch had 7 and 0.5 for Blocks a third this size): the overview is 1440 pt wide, so the
 * camera frames little more than it, and a flatter arc with a narrow gap lets the neighbours show at the frame's
 * edges (about a tenth of each at 16:9; at 4:3 only with the parallax, so the Blocks also link to each other).
 */
export const ARC = { radius: 10, gap: 0.2 } as const

/** pt per world unit (the Block default). */
const PT = 244
/** The WMS Blocks' sizes (pt), left to right on the arc. */
export const BLOCKS = {
  orders: { width: 880, height: 900 },
  overview: { width: 1440, height: 900 },
  network: { width: 1600, height: 1000 },
  twin: { width: 1280, height: 900 },
} as const

/** The arc's slots, left to right: orders, overview, network, twin. */
const SLOTS = arcSlots([BLOCKS.orders, BLOCKS.overview, BLOCKS.network, BLOCKS.twin].map(b => b.width / PT), ARC.radius, ARC.gap)
/**
 * The network map's and the twin's poses: the arc's third and fourth slots, after orders and overview, written out
 * (`position`/`rotation` on their Blocks) so their info panels can stand relative to them.
 */
export const NETWORK: ArcSlot = SLOTS[2]!
export const TWIN: ArcSlot = SLOTS[3]!

/**
 * The bin info panel: a glass Surface `width` × `height` pt at `ptPerUnit`, its centre at `offset` (world units) in the
 * twin's own frame: right of and below the twin's centre, over the front-right racks, and 2.05 units out, its back
 * face 500 pt (the twin's) in front of the twin's origin. It must clear the racks under it, which stand up to about
 * 475 pt out there once the model turns (test/scene.test.ts checks every yaw), and stay clear of the twin's title row
 * and legend as the camera sees it: being nearer the camera, it looks bigger and further from the centre than it is,
 * so it is drawn at 360 pt a unit (not 244) to look about 300 × 170 pt there.
 */
export const PANEL = { width: 300, height: 170, ptPerUnit: 360, offset: [1.15, -0.74, 2.05] as [number, number, number] }

/**
 * The place panel (the network map's): like the bin panel, a glass Surface `width` × `height` pt at `ptPerUnit`, its
 * centre at `offset[side]` (world units) in the network Block's frame: in the map's upper corner on the side away from
 * the hovered place (`right` when the place shows left of the map's centre), below the title row and legend, and 1.25
 * units out, its back face 255 pt in front of the map's plate: the map stands out of the glass by its seat, which is at
 * most about 141 pt (`SQUASH` × half the plate's height × tan 1.2, the steepest pitch) at the plate's near edge and
 * less under the panel (test/scene.test.ts checks every pitch). Seen from the focus pose it looks about 1.18 × its size.
 */
export const PLACE_PANEL = {
  width: 320, height: 236, ptPerUnit: 360,
  offset: { right: [1.93, 0.78, 1.25], left: [-1.93, 0.78, 1.25] } as Record<'left' | 'right', [number, number, number]>,
}

/**
 * The curved wall round the arc (main.ts): about the arc's centre, `out` units past the Blocks, `height` tall like the
 * plane (a focus pose sees no more than |y| ≈ 4.9: the network Block's at 4:3, the camera farthest back), spanning the
 * Blocks' arc angles plus `margin` on each side: an end Block's focus pose sees up to about 26° past its angle at 16:9
 * and 32° at 21:9, the rig's ±2.5° parallax included (the network's, mid-arc, 33°). test/scene.test.ts checks every
 * Block at four aspects.
 */
export const WALL = { out: 4, height: 11, margin: 34 * Math.PI / 180 } as const
/** The wall's span (radians, as the arc measures angles) for Blocks at `angles`. */
export function wallSpan(angles: readonly number[]): { from: number; to: number } {
  return { from: Math.min(...angles) - WALL.margin, to: Math.max(...angles) + WALL.margin }
}

/** `offset` in the frame of `pose` (a turn about y only, as the arc's), added to its position. */
export function inFrameOf(pose: ArcSlot, offset: readonly [number, number, number]): ArcSlot {
  const [x, y, z] = offset, a = pose.rotation[1], [px, py, pz] = pose.position
  return { position: [px + x * Math.cos(a) + z * Math.sin(a), py + y, pz - x * Math.sin(a) + z * Math.cos(a)], rotation: [...pose.rotation] }
}
