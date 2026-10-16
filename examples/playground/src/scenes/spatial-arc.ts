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
 * The bin info panel: a glass Surface `width` × `height` pt, its centre at `offset` (world units) in the twin's own
 * frame: up and right of the twin's centre, and 1.37 units out, its back face 290 pt over the twin's content plane
 * (which is the Block slab's 45 pt over the Block's origin). It must clear the racks below it: they stand up to about
 * 250 pt out of the glass there, whatever the model's yaw (test/scene.test.ts checks it). It covers the twin's back
 * rows on screen, so its glass refracts them.
 */
export const PANEL = { width: 300, height: 170, offset: [1.11, 0.82, 1.37] as [number, number, number] }

/** `offset` in the frame of `pose` (a turn about y only, as the arc's), added to its position. */
export function inFrameOf(pose: ArcSlot, offset: readonly [number, number, number]): ArcSlot {
  const [x, y, z] = offset, a = pose.rotation[1], [px, py, pz] = pose.position
  return { position: [px + x * Math.cos(a) + z * Math.sin(a), py + y, pz - x * Math.sin(a) + z * Math.cos(a)], rotation: [...pose.rotation] }
}
