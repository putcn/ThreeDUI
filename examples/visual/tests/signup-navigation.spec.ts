import { test, expect } from '@playwright/test'

test('sign-up supports left pan, wheel zoom, and right rotate without losing the form', async ({ page }) => {
  await page.goto('/?scene=signup&quality=medium&webgl&hud=0')
  await page.evaluate(() => window.__glassui?.ready)
  const pose = () => page.evaluate(() => {
    const camera = (window.__glassui as unknown as { camera?: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } } } | undefined)?.camera
    if (!camera) throw new Error('playground camera is unavailable')
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z, q: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w] }
  })
  const nameField = await page.evaluate(() => (window.__glassui as unknown as { rectOf(id: string): { cx: number; cy: number } | null }).rectOf('name'))
  expect(nameField).not.toBeNull()
  await page.mouse.click(nameField!.cx, nameField!.cy)
  await expect.poll(() => page.evaluate(() => (window.__glassui as unknown as { ime(): boolean }).ime())).toBe(true)
  await page.mouse.click(20, 20)

  const before = await pose()
  await page.mouse.move(620, 100)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(750, 130, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await expect.poll(async () => Math.abs((await pose()).x - before.x)).toBeGreaterThan(0.1)
  const panned = await pose()
  expect(Math.abs(panned.q[0]! - before.q[0]!) + Math.abs(panned.q[1]! - before.q[1]!)).toBeLessThan(0.01)

  await page.mouse.move(640, 450)
  await page.mouse.wheel(0, -500)
  await expect.poll(async () => Math.abs((await pose()).z - panned.z)).toBeGreaterThan(0.1)

  const zoomed = await pose()
  await page.mouse.move(640, 450)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(750, 500, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => {
    const rotated = await pose()
    return rotated.q.reduce((sum, value, i) => sum + Math.abs(value - zoomed.q[i]!), 0)
  }).toBeGreaterThan(0.02)
})
