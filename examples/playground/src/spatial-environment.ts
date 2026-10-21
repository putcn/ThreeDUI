import { BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, PlaneGeometry, type Material } from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { float, length, positionLocal, sin, smoothstep, uv, vec2 } from 'three/tsl'

/** A pale satin floor grounds the spatial workspace without competing with its glass controls. */
export function createSpatialFloor(center: [number, number, number]): Mesh {
  const material = new MeshStandardNodeMaterial({ color: 0xe9eaf1, roughness: 0.82, metalness: 0.04, transparent: true, depthWrite: false })
  material.opacityNode = float(1).sub(smoothstep(23, 31, length(positionLocal.xy)))
  const floor = new Mesh(new PlaneGeometry(80, 64), material)
  floor.name = 'spatial-floor'
  floor.position.set(...center)
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  floor.castShadow = false
  return floor
}

/** Soft ground contact cues for UI Surfaces, which are rendered after the host floor in a separate scene. */
export function createSpatialGroundShadows(placements: readonly { position: readonly [number, number, number]; width: number }[], floorY: number): Group {
  const group = new Group()
  group.name = 'spatial-ground-shadows'
  const material = new MeshBasicNodeMaterial({ color: 0x656b89, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false })
  material.opacityNode = float(1).sub(smoothstep(0.08, 0.5, length(uv().sub(vec2(0.5, 0.5))))).mul(0.17)
  for (const [index, placement] of placements.entries()) {
    const shadow = new Mesh(new PlaneGeometry(placement.width * 1.7, 4.2), material)
    shadow.name = `block-ground-shadow-${index}`
    shadow.rotation.x = -Math.PI / 2
    shadow.position.set(placement.position[0], floorY + 0.015, placement.position[2] + 0.5)
    shadow.renderOrder = 1
    group.add(shadow)
  }
  return group
}

const LAYERS = [
  { width: 34, base: 3.0, height: 2.8, depth: -5.6, phase: 0.2, color: 0x68c6ba, opacity: 0.12 },
  { width: 29, base: 3.6, height: 2.4, depth: -1.8, phase: 2.1, color: 0x9a90d5, opacity: 0.10 },
  { width: 25, base: 4.1, height: 2.0, depth: 2.4, phase: 4.4, color: 0x85b4ce, opacity: 0.07 },
] as const

function curtainGeometry(width: number, base: number, height: number, depth: number, phase: number): BufferGeometry {
  const columns = 80, rows = 24, positions: number[] = [], texcoords: number[] = [], indices: number[] = []
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) {
    const u = i / columns, v = j / rows, x = (u - 0.5) * width
    const ripple = Math.sin(u * 11 + phase) * 0.42 + Math.sin(u * 23 + phase * 1.7) * 0.13
    const y = base + ripple + v * (height + Math.sin(u * 8 + phase) * 1.0)
    const z = depth + Math.sin(u * 9 + phase) * 1.2 + Math.cos(v * 4 + phase) * 0.45
    positions.push(x, y, z); texcoords.push(u, v)
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const a = j * (columns + 1) + i, b = a + 1, c = a + columns + 1, d = c + 1
    indices.push(a, c, b, b, c, d)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(texcoords, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export interface AuroraVolume {
  readonly group: Group
  update(nowSec: number, reducedMotion: boolean): void
  dispose(): void
}

/** Three overlapping curved sheets create a suspended, softly translucent aurora with real parallax. */
export function createAuroraVolume(center: [number, number, number]): AuroraVolume {
  const group = new Group(), geometries: BufferGeometry[] = [], materials: Material[] = []
  group.name = 'aurora-volume'
  group.position.set(...center)
  for (const [index, layer] of LAYERS.entries()) {
    const geometry = curtainGeometry(layer.width, layer.base, layer.height, layer.depth, layer.phase)
    const material = new MeshStandardNodeMaterial({ color: layer.color, roughness: 0.72, metalness: 0.02, transparent: true, opacity: layer.opacity, side: DoubleSide, depthWrite: false, toneMapped: false })
    const q = uv()
    const edgeX = smoothstep(0, 0.13, q.x).mul(float(1).sub(smoothstep(0.82, 1, q.x)))
    const edgeY = smoothstep(0, 0.26, q.y).mul(float(1).sub(smoothstep(0.57, 1, q.y)))
    const filament = sin(q.x.mul(130).add(index * 3)).mul(0.5).add(0.5).mul(0.36).add(0.64)
    material.opacityNode = edgeX.mul(edgeY).mul(filament).mul(layer.opacity)
    const mesh = new Mesh(geometry, material)
    mesh.name = `aurora-curtain-${index}`
    mesh.position.x = (index - 1) * 1.8
    mesh.frustumCulled = false
    group.add(mesh); geometries.push(geometry); materials.push(material)
  }
  const origin = group.position.clone()
  return {
    group,
    update(nowSec, reducedMotion) {
      if (reducedMotion) return
      group.position.x = origin.x + Math.sin(nowSec * 0.11) * 0.8
      group.position.y = origin.y + Math.sin(nowSec * 0.08) * 0.14
      group.rotation.y = Math.sin(nowSec * 0.06) * 0.012
    },
    dispose() {
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); group.clear()
    },
  }
}
