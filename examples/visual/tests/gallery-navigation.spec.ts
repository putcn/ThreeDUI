import { test, expect } from '@playwright/test'

test('gallery supports pan, rotate, zoom, and section navigation', async ({ page }) => {
  await page.goto('/?scene=gallery&focus=primitives&quality=medium&motion=frozen&webgl&hud=0')
  await page.evaluate(() => window.__glassui?.ready)
  const pose = () => page.evaluate(() => {
    const { camera } = window.__glassui as unknown as { camera: { position: { toArray(): number[] }; quaternion: { toArray(): number[] } } }
    return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }
  })
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((n, i) => n - b[i]!))

  const before = await pose()
  await page.mouse.move(640, 100)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(760, 140, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await expect.poll(async () => distance((await pose()).position, before.position)).toBeGreaterThan(0.1)
  const panned = await pose()
  expect(distance(panned.quaternion, before.quaternion)).toBeLessThan(0.01)

  await page.mouse.move(640, 450)
  await page.mouse.wheel(0, -500)
  await expect.poll(async () => distance((await pose()).position, panned.position)).toBeGreaterThan(0.1)
  const zoomed = await pose()

  await page.mouse.down({ button: 'right' })
  await page.mouse.move(750, 500, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => distance((await pose()).quaternion, zoomed.quaternion)).toBeGreaterThan(0.02)

  const nav = await page.evaluate(() => (window.__glassui as unknown as { rectOf(id: string): { cx: number; cy: number } | null }).rectOf('gallery-primitives-to-buttons'))
  expect(nav).not.toBeNull()
  await page.mouse.click(nav!.cx, nav!.cy)
  await expect.poll(() => page.evaluate(() => (window.__glassui as unknown as { focus(): string | null }).focus())).toBe('buttons')
  const reframed = await pose()
  expect(distance(reframed.position, zoomed.position)).toBeGreaterThan(0.5)

  await page.mouse.move(640, 100)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(730, 110, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await expect.poll(async () => distance((await pose()).position, reframed.position)).toBeGreaterThan(0.1)
})
