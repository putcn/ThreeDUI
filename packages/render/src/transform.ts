import { Matrix4, Euler, Quaternion, Vector3 } from 'three'
import { apply, invert, type ClipRect, type InstanceTransform, type Rect } from '@glassui/core'
import type { InstanceBuffer } from './instances'
import { surfaceToLocal, type SurfaceDims } from './units'

const q = new Quaternion(), e = new Euler(), v = new Vector3(), tmp = new Matrix4()

/**
 * Local (centred, y up, z from the surface) → Surface-local units. The 2D affine from core is applied in surface pt,
 * then re-expressed in units (y flipped); its √|det| scales thickness; tilt rotates about the transformed centre.
 */
export function instanceMatrix(inst: { rect: Rect } & InstanceTransform, s: SurfaceDims, out = new Matrix4()): Matrix4 {
  const { a, b, c, d } = inst.transform
  const [cx, cy] = apply(inst.transform, inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2)
  const [ux, uy] = surfaceToLocal(cx, cy, s)
  const sz = Math.sqrt(Math.abs(a * d - b * c))
  // linear part in units: E·A·D with E = diag(1/ppu, −1/ppu), D = diag(ppu, −ppu)
  // (`0 − x` rather than `−x`: a zero shear packs as +0, not −0)
  out.set(
    a, 0 - c, 0, 0,
    0 - b, d, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  )
  if (inst.tilt.x !== 0 || inst.tilt.y !== 0) {
    q.setFromEuler(e.set(inst.tilt.x, inst.tilt.y, 0, 'XYZ'))
    tmp.makeRotationFromQuaternion(q)
    out.premultiply(tmp)
  }
  v.set(ux, uy, inst.elevation / s.ptPerUnit)
  out.setPosition(v)
  return out
}

/** Rows 0–2 of `m` into three vec4 attributes (row-major, so the shader does `dot(row, vec4(p, 1))`). */
export function writeMatrixRows(buf: InstanceBuffer, i: number, m: Matrix4, names: [string, string, string] = ['iMat0', 'iMat1', 'iMat2']): void {
  const el = m.elements
  buf.set(i, names[0], el[0]!, el[4]!, el[8]!, el[12]!)
  buf.set(i, names[1], el[1]!, el[5]!, el[9]!, el[13]!)
  buf.set(i, names[2], el[2]!, el[6]!, el[10]!, el[14]!)
}

/** Clip rect (surface pt, `w = −1` for none) and the inverse of its transform, for the fragment-side rounded-rect test. */
export function writeClip(buf: InstanceBuffer, i: number, clip: ClipRect | undefined, names: [string, string, string] = ['iClipRect', 'iClipInv', 'iClipT']): void {
  if (!clip) { buf.set(i, names[0], 0, 0, -1, 0); buf.set(i, names[1], 1, 0, 0, 1); buf.set(i, names[2], 0, 0, 0, 0); return }
  const inv = invert(clip.transform)
  buf.set(i, names[0], clip.x, clip.y, clip.width, clip.height)
  buf.set(i, names[1], inv.a, inv.b + 0, inv.c + 0, inv.d)   // `+ 0`: `invert` negates a zero shear to −0
  buf.set(i, names[2], inv.tx, inv.ty, clip.radius, 0)
}
