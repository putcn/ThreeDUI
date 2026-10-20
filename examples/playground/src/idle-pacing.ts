export const IDLE_DELAY_MS = 2000

/** Pace only after render idle and user input have each been absent for their full independent grace period. */
export function idlePacing(now: number, rootIdle: boolean, lastInput: number, idleSince: number | null): { idleSince: number | null; paced: boolean } {
  const since = rootIdle ? idleSince ?? now : null
  return {
    idleSince: since,
    paced: rootIdle && since !== null && now - since >= IDLE_DELAY_MS && now - lastInput >= IDLE_DELAY_MS,
  }
}
