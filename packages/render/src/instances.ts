import { DynamicDrawUsage, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute } from 'three'

/**
 * Growable per-instance vec4 attributes on one `InstancedBufferGeometry`; `begin(n)` then `set` then `commit`.
 * All attributes interleave in one `InstancedInterleavedBuffer` (attribute k at float offset 4k of each instance's
 * `4 · names.length` floats), so the GPU sees one vertex buffer however many attributes there are — WebGPU's default
 * `maxVertexBuffers` is 8, and three makes one buffer layout per distinct (non-interleaved) attribute.
 */
export class InstanceBuffer {
  readonly geometry: InstancedBufferGeometry
  count = 0
  private capacity: number
  private data: InstancedInterleavedBuffer
  private readonly offsets = new Map<string, number>()
  private readonly stride: number

  constructor(base: InstancedBufferGeometry, private readonly names: readonly string[], capacity = 16) {
    this.geometry = base
    this.capacity = Math.max(1, capacity)
    this.stride = 4 * names.length
    names.forEach((n, k) => this.offsets.set(n, 4 * k))
    this.data = this.create(this.capacity)
  }

  /** A new interleaved buffer of `capacity` instances (earlier data copied in) and its attributes on the geometry. */
  private create(capacity: number, copyFrom?: InstancedInterleavedBuffer): InstancedInterleavedBuffer {
    const array = new Float32Array(capacity * this.stride)
    if (copyFrom) array.set(copyFrom.array as Float32Array)
    const data = new InstancedInterleavedBuffer(array, this.stride)
    data.setUsage(DynamicDrawUsage)
    for (const [name, offset] of this.offsets) this.geometry.setAttribute(name, new InterleavedBufferAttribute(data, 4, offset))
    return data
  }

  /**
   * Starts a new fill of `n` instances, growing storage (×2) when needed; earlier data is kept. Growth replaces the
   * buffer and every attribute object on the geometry, so shaders must read these by name (`attribute(name)`), not
   * bind the objects.
   */
  begin(n: number): void {
    if (n > this.capacity) {
      let c = this.capacity; while (c < n) c *= 2
      this.data = this.create(c, this.data)
      this.capacity = c
    }
    this.count = n
  }

  private offset(name: string): number {
    const o = this.offsets.get(name)
    if (o === undefined) throw new Error(`[render] unknown instance attribute ${name}; known: ${this.names.join(', ')}`)
    return o
  }

  set(i: number, name: string, x: number, y: number, z = 0, w = 0): void {
    const arr = this.data.array as Float32Array, o = i * this.stride + this.offset(name)
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w
  }

  get(i: number, name: string): [number, number, number, number] {
    const arr = this.data.array as Float32Array, o = i * this.stride + this.offset(name)
    return [arr[o]!, arr[o + 1]!, arr[o + 2]!, arr[o + 3]!]
  }

  commit(): void {
    this.data.needsUpdate = true
    this.geometry.instanceCount = this.count
  }

  dispose(): void { this.geometry.dispose() }
}
