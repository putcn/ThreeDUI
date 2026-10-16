import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { BufferGeometry, Mesh, Line, Vector3, type Object3D } from 'three'
import { defaultTheme, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import { BarMatrix, MATRIX } from '../src/chart/matrix'
import { SurfaceChart } from '../src/chart/surface'
import { FRAME, type FrameChart } from '../src/chart/frame'
import type { Viewport3DContext } from '../src/viewport'

// Task 9P V2: a 3D chart in a box off the view's centre stays inside its box as the focus pose's camera sees it.

const napi: CanvasFactory = (w, h) => createCanvas(w, h) as never
/** The overview's stock matrix Card: a 498 × 420 box, 407 pt right of the Block's centre and 105 pt below it, seen from 1516 pt. */
const OFF: [number, number, number] = [-407, 105, 1516 - 36]
const ctx = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 498, height: 420, reducedMotion: true, theme: defaultTheme, scheme: 'light', ...o })

function matrix(): BarMatrix {
  const m = new BarMatrix({ createCanvas: napi }), grey: RGBA = [0.5, 0.5, 0.5, 1]
  m.set({ values: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 8)), max: 8, colors: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => grey)) })
  m.labels({ rows: ['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区'], cols: ['食品', '饮料', '日化', '家居', '数码', '母婴'] })
  return m
}
function surface(): SurfaceChart {
  const s = new SurfaceChart({ createCanvas: napi })
  // the full height on the four corners (what the fit allows for), lower inside
  const corner = (r: number, c: number): boolean => (r === 0 || r === 13) && (c === 0 || c === 23)
  s.set({ values: Array.from({ length: 14 }, (_, r) => Array.from({ length: 24 }, (_, c) => (corner(r, c) ? 250 : 60 + c * 3))), max: 250, ramp: [[0.8, 0.85, 1, 1], [0.76, 0.1, 0.36, 1]] })
  s.labels({ x: Array.from({ length: 24 }, (_, h) => `${h} 时`), y: Array.from({ length: 14 }, (_, d) => `10-${String(d + 1).padStart(2, '0')}`), ticks: ['0 单', '125 单', '250 单'] })
  return s
}

/** Every vertex the chart draws (shown parts only), in the chart's own frame (the anchor's: pt, the box centre on the glass). */
function points(chart: FrameChart): Vector3[] {
  chart.updateMatrixWorld(true)
  const out: Vector3[] = []
  chart.traverseVisible((o: Object3D) => {
    if (!(o instanceof Mesh || o instanceof Line)) return
    const pos = (o.geometry as BufferGeometry).getAttribute('position')
    for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld))
  })
  return out
}
/** The points as the eye sees them on the glass (z = 0): their bounding box. */
function seen(pts: readonly Vector3[], eye: readonly [number, number, number]): { x0: number; x1: number; y0: number; y1: number } {
  const [ex, ey, ez] = eye
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of pts) {
    const m = ez / (ez - p.z), x = ex + (p.x - ex) * m, y = ey + (p.y - ey) * m
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, x1, y0, y1 }
}

describe('3D charts fit their box as the focus pose sees them (Task 9P V2)', () => {
  for (const [name, make] of [['BarMatrix', matrix], ['SurfaceChart', surface]] as const) {
    it(`${name}: seen from an eye off its box's centre, everything stays ${FRAME.margin} pt inside the box and is centred in it; it never grows past its own size`, () => {
      const c = make(), W = 498, H = 420
      // without the fit (no eye), the same chart seen from there spills past the box's side
      c.update(1 / 60, ctx()); c.update(1 / 60, ctx())
      const loose = seen(points(c), OFF)
      expect(Math.min(loose.x0 + W / 2, W / 2 - loose.x1, loose.y0 + H / 2, H / 2 - loose.y1)).toBeLessThan(FRAME.margin)
      c.update(1 / 60, ctx({ eye: OFF })); c.update(1 / 60, ctx({ eye: OFF }))
      const b = seen(points(c), OFF)
      expect(b.x0).toBeGreaterThanOrEqual(-W / 2 + FRAME.margin - 0.5); expect(b.x1).toBeLessThanOrEqual(W / 2 - FRAME.margin + 0.5)
      expect(b.y0).toBeGreaterThanOrEqual(-H / 2 + FRAME.margin - 0.5); expect(b.y1).toBeLessThanOrEqual(H / 2 - FRAME.margin + 0.5)
      expect(Math.abs(b.x0 + b.x1) / 2).toBeLessThan(1.5); expect(Math.abs(b.y0 + b.y1) / 2).toBeLessThan(1.5)   // centred (to the bars' rounded edges)
      // it fills the box one way (it is as big as the fit allows), and is not scaled past 1
      expect(Math.max((b.x1 - b.x0) / (W - 2 * FRAME.margin), (b.y1 - b.y0) / (H - 2 * FRAME.margin))).toBeGreaterThan(0.97)
      expect(c.inner.scale.x).toBeLessThanOrEqual(1); expect(c.inner.scale.x).toBeGreaterThan(0.5)
      // nothing sinks behind the glass
      expect(Math.min(...points(c).map(p => p.z))).toBeGreaterThanOrEqual(FRAME.seat - 1e-6)
    })
    it(`${name}: the eye moving a little (a Card rising 16 pt on hover) does not refit it; a new eye far enough away does`, () => {
      const c = make()
      c.update(1 / 60, ctx({ eye: OFF }))
      const k = c.inner.scale.x, at = c.inner.position.clone()
      c.update(1 / 60, ctx({ eye: [OFF[0], OFF[1], OFF[2] - 16] }))
      expect(c.inner.scale.x).toBe(k); expect(c.inner.position.equals(at)).toBe(true)
      c.update(1 / 60, ctx({ eye: [0, 0, OFF[2]] }))                               // the box now on the view's axis
      expect(c.inner.scale.x).not.toBe(k)
      const b = seen(points(c), [0, 0, OFF[2]])
      expect(Math.abs(b.x0 + b.x1) / 2).toBeLessThan(1); expect(Math.abs(b.y0 + b.y1) / 2).toBeLessThan(1)
    })
  }
  it('BarMatrix: a hovered bar on the front corner stays inside too (the fit allows for its lift)', () => {
    const c = matrix()
    c.update(1 / 60, ctx({ eye: OFF }))
    c.hover({ row: 5, col: 5 }); c.update(1 / 60, ctx({ eye: OFF })); c.hover({ row: 0, col: 5 }); c.update(1 / 60, ctx({ eye: OFF }))
    const b = seen(points(c), OFF)
    expect(b.x1).toBeLessThanOrEqual(498 / 2 - FRAME.margin + 0.5)
    expect(MATRIX.hoverDepth).toBeGreaterThan(1)
  })
})
