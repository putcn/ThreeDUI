import { describe, it, expect } from 'vitest'
import * as pub from '../src/index'
import * as internal from '../src/internal'

describe('package entries', () => {
  it('the public entry exports only the public API; internal keeps the rest', () => {
    expect(Object.keys(pub).sort()).toEqual(['ImeBridge', 'QUALITY', 'QualityController', 'RENDER_VERSION', 'ScreenLayer', 'Surface', 'createUIRoot', 'defaultImageLoader', 'fillColors'].sort())
    for (const k of ['GlassBatch', 'createGlassMaterial', 'ContentPass', 'hitSurfaces', 'KawasePyramid', 'SurfaceMotion', 'rtTarget']) expect(k in internal).toBe(true)
  })
  it('internal is a superset of the public entry, the same bindings', () => {
    const all = internal as Record<string, unknown>
    for (const [k, v] of Object.entries(pub)) expect(all[k]).toBe(v)
  })
})
