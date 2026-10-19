import { expect, it } from 'vitest'
import { Node } from '@glassui/core'
import { PerspectiveCamera } from 'three'
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
  const harness = createSceneHarness(root as unknown as UIRoot, new PerspectiveCamera(), new Map<Surface, string>([[block, 'inputs']]))
  root.pointer!.setActive(block)
  expect(harness.focus()).toBe('inputs')
  root.pointer!.setActive(dialog)
  expect(harness.focus()).toBe('inputs')
})
it('defers idle to later ticks, waiting through movement, animation and focus changes', async () => {
  const root = createFakeRoot(), camera = new PerspectiveCamera(), block = root.createSurface({ width: 200, height: 200, layer: 'world' }), next = root.createSurface({ width: 200, height: 200, layer: 'world' })
  root.pointer!.setActive(block)
  const harness = createSceneHarness(root as unknown as UIRoot, camera, new Map([[block, 'inputs'], [next, 'buttons']]))
  let done = false
  const idle = harness.idle().then(() => { done = true })
  await flush(); expect(done).toBe(false)
  camera.position.x = 1; root.tick(); await flush(); expect(done).toBe(false)
  root.pointer!.setActive(next); root.tick(); await flush(); expect(done).toBe(false)
  camera.position.x = 2; root.tick(); await flush(); expect(done).toBe(false)
  root.tick(); await flush(); expect(done).toBe(false)
  root.tick(); await idle; expect(done).toBe(true)
})

it('keeps dark wall gradients below 0.04 linear RGB for readable light controls', async () => {
  const { arcPastel } = await import('../src/wall')
  for (const u of [0, 0.2, 0.5, 0.8, 1]) for (const v of [0, 0.5, 1]) {
    const light = arcPastel(u, v), dark = arcPastel(u, v, 'dark')
    expect(dark.every(n => n < 0.04)).toBe(true)
    dark.forEach((n, i) => expect(n).toBeCloseTo(light[i]! * 0.035, 10))
  }
})

it('keeps idle pending while a Surface requests another frame or a node spring is active', async () => {
  const root = createFakeRoot(), camera = new PerspectiveCamera(), surface = root.createSurface({ width: 200, height: 200 })
  const node = new Node('box'); node.setStyle({ width: 50, height: 50, opacity: 1, transition: { opacity: 'smooth' } }); surface.root.appendChild(node)
  root.tick()
  const harness = createSceneHarness(root as unknown as UIRoot, camera, new Map())
  let done = false
  const idle = harness.idle().then(() => { done = true })
  surface.needsFrame = true
  root.tick(); await flush(); root.tick(); await flush(); expect(done).toBe(false)
  surface.needsFrame = false
  node.setStyle({ opacity: 0 }); root.tick(); await flush()
  expect(root.anim.active).toBeGreaterThan(0)
  root.tick(); await flush(); expect(done).toBe(false)
  for (let i = 0; i < 240 && !done; i++) { root.tick(); await flush() }
  await idle; expect(done).toBe(true)
})

it('uses brighter dark caption tokens for glass backplates while preserving every light token', async () => {
  const { defaultTheme } = await import('@glassui/core')
  const { playgroundTheme } = await import('../src/theme')
  const theme = playgroundTheme()
  expect(theme.colors.light).toEqual(defaultTheme.colors.light)
  expect(theme.colors.dark).toMatchObject({ label: '#ffffff', secondaryLabel: '#f2f2f7', tertiaryLabel: '#e4e4ed' })
  expect(defaultTheme.colors.dark.secondaryLabel).toBe('#aeaeb8')
})
