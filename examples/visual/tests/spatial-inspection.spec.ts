import { test, expect } from '@playwright/test'

type GlassHandle = {
  camera: { position: { toArray(): number[] }; quaternion: { toArray(): number[] } }
  rectOf(id: string): { cx: number; cy: number } | null
  focus(): string | null
}

test('spatial demo starts with a usable login and supports camera inspection after entry', async ({ page }) => {
  await page.goto('/?scene=spatial&quality=medium&motion=frozen&webgl&hud=0')
  await page.evaluate(() => window.__glassui?.ready)
  const pose = () => page.evaluate(() => ({ position: (window.__glassui as unknown as GlassHandle).camera.position.toArray(), quaternion: (window.__glassui as unknown as GlassHandle).camera.quaternion.toArray() }))
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((n, i) => n - b[i]!))
  const login = await page.evaluate(() => (window.__glassui as unknown as GlassHandle).rectOf('login-submit'))
  expect(login).not.toBeNull()
  await page.mouse.click(login!.cx, login!.cy)
  await expect.poll(() => page.evaluate(() => (window.__glassui as unknown as GlassHandle).focus()), { timeout: 20_000 }).toBe('dashboard')
  await expect.poll(async () => {
    const a = await pose()
    await page.waitForTimeout(250)
    const b = await pose()
    return distance(a.position, b.position) + distance(a.quaternion, b.quaternion)
  }, { timeout: 20_000 }).toBeLessThan(0.005)

  const before = await pose()
  await page.mouse.move(35, 90)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(145, 130, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await expect.poll(async () => distance((await pose()).position, before.position)).toBeGreaterThan(0.1)
  const panned = await pose()
  expect(distance(panned.quaternion, before.quaternion)).toBeLessThan(0.01)

  await page.mouse.move(35, 90)
  await page.mouse.wheel(0, -500)
  await expect.poll(async () => distance((await pose()).position, panned.position)).toBeGreaterThan(0.1)
  const zoomed = await pose()

  await page.mouse.move(35, 90)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(145, 130, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => distance((await pose()).quaternion, zoomed.quaternion)).toBeGreaterThan(0.02)

  const overview = await page.evaluate(() => (window.__glassui as unknown as GlassHandle).rectOf('dock-overview'))
  expect(overview).not.toBeNull()
  await page.mouse.click(overview!.cx, overview!.cy)
  await expect.poll(() => page.evaluate(() => (window.__glassui as unknown as GlassHandle).focus())).toBeNull()
})
