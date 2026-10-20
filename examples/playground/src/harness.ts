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

export function createSceneHarness(root: UIRoot, blocks: ReadonlyMap<Surface, string>) {
  let focused: string | null = null
  const focus = (): string | null => {
    const active = root.pointer?.active
    if (active && blocks.has(active)) focused = blocks.get(active)!
    return focused
  }
  return {
    focus,
    async idle(): Promise<void> {
      while (!root.idle) {
        const dt = await root.afterTick()
        if (dt === 0) return // disposed root: no future tick can arrive
        focus()
      }
    },
  }
}
