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
  twin: { width: 1280, height: 900 },
} as const

/**
 * The twin's pose: the arc's third slot after orders and overview, written out (`position`/`rotation` on its Block) so
 * the info panel can stand relative to it.
 */
export const TWIN: ArcSlot = arcSlots([BLOCKS.orders.width / PT, BLOCKS.overview.width / PT, BLOCKS.twin.width / PT], ARC.radius, ARC.gap)[2]!

/**
 * The bin info panel: a glass Surface `width` × `height` pt at `ptPerUnit`, its centre at `offset` (world units) in the
 * twin's own frame: right of and below the twin's centre, over the front-right racks, and 2.05 units out, its back
 * face 500 pt (the twin's) in front of the twin's origin. It must clear the racks under it, which stand up to about
 * 475 pt out there once the model turns (test/scene.test.ts checks every yaw), and stay clear of the twin's title row
 * and legend as the camera sees it: being nearer the camera, it looks bigger and further from the centre than it is,
 * so it is drawn at 360 pt a unit (not 244) to look about 300 × 170 pt there.
 */
export const PANEL = { width: 300, height: 170, ptPerUnit: 360, offset: [1.15, -0.74, 2.05] as [number, number, number] }

/** `offset` in the frame of `pose` (a turn about y only, as the arc's), added to its position. */
export function inFrameOf(pose: ArcSlot, offset: readonly [number, number, number]): ArcSlot {
  const [x, y, z] = offset, a = pose.rotation[1], [px, py, pz] = pose.position
  return { position: [px + x * Math.cos(a) + z * Math.sin(a), py + y, pz - x * Math.sin(a) + z * Math.cos(a)], rotation: [...pose.rotation] }
}
