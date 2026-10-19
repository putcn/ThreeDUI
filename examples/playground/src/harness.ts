import type { PerspectiveCamera } from 'three'
import type { Surface, UIRoot } from '@glassui/render'

/** rAF intervals, rather than CPU render duration; draws always belongs to the completed frame. */
export function createFrameStats() {
  const intervals: number[] = []
  let last: number | undefined, draws = 0
  return {
    record(t: number, completedDraws: number) {
      if (last !== undefined) { intervals.push(t - last); if (intervals.length > 60) intervals.shift() }
      last = t; draws = completedDraws
    },
    resetIntervals() { intervals.length = 0; last = undefined },
    read: () => ({ frameMs: intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0, draws }),
  }
}

/** An active canvas field may still be waiting for browser activation: require the real DOM proxy focus as well. */
export function imeFocused(bridge: { active: unknown } | null, element: { matches(selector: string): boolean } | null): boolean {
  return !!bridge?.active && !!element?.matches('textarea[aria-hidden="true"][tabindex="-1"], input[aria-hidden="true"][tabindex="-1"]')
}

/**
 * Temporary playground adapter until root.idle / rig.settled exists (Task 19A). Only public state is read. Two
 * consecutive stable ticks (pose deltas <= 1e-6), unchanged Block focus and no active Surface/node animation count
 * as idle. A moving pointer's live parallax can postpone it; frozen motion is deterministic. Every call awaits ticks,
 * even when already quiet. This measures observable pose stability, rather than the rig's private spring state.
 */
export function createSceneHarness(root: UIRoot, camera: PerspectiveCamera, blocks: ReadonlyMap<Surface, string>) {
  let focused: string | null = null
  const focus = (): string | null => {
    const active = root.pointer?.active
    if (active && blocks.has(active)) focused = blocks.get(active)!
    return focused
  }
  const pose = (): number[] => [
    ...camera.position.toArray(), ...camera.quaternion.toArray(),
    ...root.surfaces.flatMap(s => [s.position.x, s.position.y, s.position.z, s.rotation.x, s.rotation.y, s.rotation.z, s.scale.x, s.scale.y, s.scale.z, s.opacity]),
  ]
  return {
    focus,
    async idle(): Promise<void> {
      let previous = pose(), lastFocus = focus(), stable = 0
      while (stable < 2) {
        const dt = await root.afterTick()
        if (dt === 0) return // disposed root: no future tick can arrive
        const current = pose(), name = focus()
        const moving = root.anim.active > 0 || root.surfaces.some(s => s.needsFrame)
        const same = current.length === previous.length && current.every((n, i) => Math.abs(n - previous[i]!) <= 1e-6)
        stable = !moving && same && name === lastFocus ? stable + 1 : 0
        previous = current; lastFocus = name
      }
    },
  }
}
