import { describe, expect, it } from 'vitest'
import { BackSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { createAuroraDome } from '../src/aurora'

function fakeRenderer() {
  let target: unknown = null
  return {
    targets: [] as unknown[],
    getRenderTarget: () => target,
    setRenderTarget(value: unknown) { target = value; this.targets.push(value) },
    render() {},
  }
}

describe('the aurora dome', () => {
  it('renders at most 15 times a second live, once frozen, and holds under reduced motion', () => {
    const options = { center: [0, 0, 24] as [number, number, number], radius: 32, yaw: [-0.6, 0.6] as [number, number], pitch: [-0.3, 0.3] as [number, number] }
    const dome = createAuroraDome(options), renderer = fakeRenderer()
    expect(dome.update(renderer as never, 0, 'live')).toBe(true)
    expect(dome.update(renderer as never, 0.03, 'live')).toBe(false)
    expect(dome.update(renderer as never, 0.07, 'live')).toBe(true)
    const frozen = createAuroraDome(options)
    expect(frozen.update(renderer as never, 5, 'frozen')).toBe(true)
    expect(frozen.update(renderer as never, 9, 'frozen')).toBe(false)
    const reduced = createAuroraDome(options)
    expect(reduced.update(renderer as never, 1, 'reduced')).toBe(true)
    expect(reduced.update(renderer as never, 2, 'reduced')).toBe(false)
    expect(renderer.getRenderTarget()).toBeNull()
    dome.dispose(); frozen.dispose(); reduced.dispose()
  })

  it('draws the dome from inside without casting or receiving shadows', () => {
    const dome = createAuroraDome({ center: [0, 0, 24], radius: 32, yaw: [-0.6, 0.6], pitch: [-0.3, 0.3] })
    expect(dome.mesh.castShadow).toBe(false)
    expect(dome.mesh.receiveShadow).toBe(false)
    expect((dome.mesh.material as MeshBasicNodeMaterial).side).toBe(BackSide)
    const positions = dome.mesh.geometry.getAttribute('position'), yaw: number[] = []
    for (let i = 0; i < positions.count; i++) yaw.push(Math.atan2(positions.getX(i), -positions.getZ(i)))
    expect(Math.min(...yaw)).toBeCloseTo(-0.6, 1)
    expect(Math.max(...yaw)).toBeCloseTo(0.6, 1)
    dome.dispose()
  })
})
