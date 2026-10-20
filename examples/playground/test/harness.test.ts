import { expect, it } from 'vitest'
import type { Surface, UIRoot } from '@glassui/render'
import { createFakeRoot, flush } from '../../../packages/vue/test/fixtures/fake-root'
import { createFrameStats, createSceneHarness, imeFocused } from '../src/harness'

it('reports the last completed draws and the mean of only the last 60 rAF intervals', () => {
  const stats = createFrameStats()
  stats.record(0, 3)
  for (let i = 1; i <= 65; i++) stats.record(i * i, i)
  expect(stats.read()).toEqual({ frameMs: (65 * 65 - 5 * 5) / 60, draws: 65 })
})
it('requires an active field and the actually focused IME proxy', () => {
  const proxy = { matches: (selector: string) => selector.includes('aria-hidden') }
  expect(imeFocused(null, proxy)).toBe(false)
  expect(imeFocused({ active: {} }, null)).toBe(false)
  expect(imeFocused({ active: {} }, { matches: () => false })).toBe(false)
  expect(imeFocused({ active: {} }, proxy)).toBe(true)
})
it('retains Block focus while a Dialog owns the pointer bridge', () => {
  const root = createFakeRoot(), block = root.createSurface({ width: 200, height: 200, layer: 'world' }), dialog = root.createSurface({ width: 100, height: 100 })
  const harness = createSceneHarness(root as unknown as UIRoot, new Map<Surface, string>([[block, 'inputs']]))
  root.pointer!.setActive(block)
  expect(harness.focus()).toBe('inputs')
  root.pointer!.setActive(dialog)
  expect(harness.focus()).toBe('inputs')
})
it('waits for the root idle flag and preserves the remembered focus', async () => {
  const root = createFakeRoot(), block = root.createSurface({ width: 200, height: 200, layer: 'world' }), next = root.createSurface({ width: 200, height: 200, layer: 'world' })
  root.pointer!.setActive(block)
  const harness = createSceneHarness(root as unknown as UIRoot, new Map([[block, 'inputs'], [next, 'buttons']]))
  ;(root as { idle: boolean }).idle = false
  let done = false
  const idle = harness.idle().then(() => { done = true })
  await flush(); expect(done).toBe(false)
  root.pointer!.setActive(next); (root as { idle: boolean }).idle = true; root.tick(); await idle
  expect(done).toBe(true); expect(harness.focus()).toBe('buttons')
})

it('keeps dark wall gradients below 0.04 linear RGB for readable light controls', async () => {
  const { arcPastel } = await import('../src/wall')
  for (const u of [0, 0.2, 0.5, 0.8, 1]) for (const v of [0, 0.5, 1]) {
    const light = arcPastel(u, v), dark = arcPastel(u, v, 'dark')
    expect(dark.every(n => n < 0.04)).toBe(true)
    dark.forEach((n, i) => expect(n).toBeCloseTo(light[i]! * 0.035, 10))
  }
})

it('resolves immediately when the root already reports idle', async () => {
  const root = createFakeRoot(), harness = createSceneHarness(root as unknown as UIRoot, new Map())
  await harness.idle()
})

it('uses brighter dark caption tokens for glass backplates while preserving every light token', async () => {
  const { defaultTheme } = await import('@glassui/core')
  const { playgroundTheme } = await import('../src/theme')
  const theme = playgroundTheme()
  expect(theme.colors.light).toEqual(defaultTheme.colors.light)
  expect(theme.colors.dark).toMatchObject({ label: '#ffffff', secondaryLabel: '#f2f2f7', tertiaryLabel: '#e4e4ed' })
  expect(defaultTheme.colors.dark.secondaryLabel).toBe('#aeaeb8')
})
