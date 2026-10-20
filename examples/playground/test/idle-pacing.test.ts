import { expect, it } from 'vitest'
import { idlePacing } from '../src/idle-pacing'

it('tracks root idle and input silence independently before pacing', () => {
  let idleSince: number | null = null
  let state = idlePacing(100, true, 100, idleSince); idleSince = state.idleSince
  expect(state.paced).toBe(false)

  // Root has been idle for 2 seconds, but input only stopped 1.1 seconds ago.
  state = idlePacing(2200, true, 1100, idleSince); idleSince = state.idleSince
  expect(state.paced).toBe(false)

  // Once both clocks cross their own two-second threshold, paced rendering starts immediately.
  state = idlePacing(3100, true, 1100, idleSince); idleSince = state.idleSince
  expect(state.paced).toBe(true)

  // A render activity resets only the root-idle interval.
  state = idlePacing(3200, false, 1100, idleSince); idleSince = state.idleSince
  expect(state).toEqual({ idleSince: null, paced: false })
})
