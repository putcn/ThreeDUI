/**
 * The spatial scene's arc (world units): Spatial.vue's Space lays its Blocks on it, and main.ts builds the curved wall
 * round the same centre, (0, 0, radius). Tune it here and both follow.
 */
export const ARC = { radius: 7, gap: 0.5 } as const
