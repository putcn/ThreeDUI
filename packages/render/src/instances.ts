import { DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry } from 'three'

/** Growable per-instance vec4 attributes on one `InstancedBufferGeometry`; `begin(n)` then `set` then `commit`. */
export class InstanceBuffer {
  readonly geometry: InstancedBufferGeometry
  count = 0
  private capacity: number
  private attrs = new Map<string, InstancedBufferAttribute>()

  constructor(base: InstancedBufferGeometry, private readonly names: readonly string[], capacity = 16) {
    this.geometry = base
    this.capacity = Math.max(1, capacity)
    for (const n of names) this.create(n, this.capacity)
  }

  private create(name: string, capacity: number, copyFrom?: InstancedBufferAttribute): void {
    const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    a.setUsage(DynamicDrawUsage)
    if (copyFrom) (a.array as Float32Array).set(copyFrom.array as Float32Array)
    this.attrs.set(name, a)
    this.geometry.setAttribute(name, a)
  }

  /**
   * Starts a new fill of `n` instances, growing storage (×2) when needed; earlier data is kept. Growth replaces each
   * attribute object on the geometry, so shaders must read these by name (`attribute(name)`), not bind the objects.
   */
  begin(n: number): void {
    if (n > this.capacity) {
      let c = this.capacity; while (c < n) c *= 2
      for (const name of this.names) this.create(name, c, this.attrs.get(name))
      this.capacity = c
    }
    this.count = n
  }

  set(i: number, name: string, x: number, y: number, z = 0, w = 0): void {
    const a = this.attrs.get(name)
    if (!a) throw new Error(`[render] unknown instance attribute ${name}; known: ${this.names.join(', ')}`)
    const arr = a.array as Float32Array, o = i * 4
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w
  }

  get(i: number, name: string): [number, number, number, number] {
    const a = this.attrs.get(name)
    if (!a) throw new Error(`[render] unknown instance attribute ${name}`)
    const arr = a.array as Float32Array, o = i * 4
    return [arr[o]!, arr[o + 1]!, arr[o + 2]!, arr[o + 3]!]
  }

  commit(): void {
    for (const a of this.attrs.values()) a.needsUpdate = true
    this.geometry.instanceCount = this.count
  }

  dispose(): void { this.geometry.dispose() }
}
