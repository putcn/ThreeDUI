import type { InstancedBufferGeometry, Texture } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, varying, texture, vec2, float, mix } from 'three/tsl'
import { flatVertex, type SurfaceUniforms } from '../flat'

/**
 * Unlit glyph quads sampling one atlas page's alpha (spec §5.5: readability first, no lighting): colour `iColor.rgb`,
 * opacity = page alpha × `iColor.a` × instance opacity (`iMisc.x`), masked by the instance clip. The quad maps 1:1
 * onto the glyph's atlas slot, which already carries the engine's padding, so it needs no AA margin and the quad's
 * `uv` is the glyph-local uv (with a margin it would be `q / size + 0.5`). `iUV` is the slot as the atlas reports it
 * (top-left origin, v down) and the page texture is flipped (`AtlasPages`), so the slot is sampled at (u, 1 − v).
 *
 * Varyings: `flatVertex`'s clip pair + `iUV`, `iColor`, `iMisc` + the quad uv `vGlyphUV` = 6.
 */
export function createGlyphMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms, page: Texture): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iUV = fv.pack('iUV'), color = fv.pack('iColor'), misc = fv.pack('iMisc')
  const uv = varying(attribute('uv', 'vec2'), 'vGlyphUV')   // named: an attribute read in the fragment gets an anonymous one
  const u = mix(iUV.x, iUV.z, uv.x), v = mix(iUV.y, iUV.w, float(1).sub(uv.y))   // quad uv.y is up; atlas v is down

  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.lights = false   // unlit outright, as the panel material: a lit basic material costs a `v_positionView` varying
  m.positionNode = fv.position
  m.maskNode = fv.mask   // the material discards where the mask is false
  m.colorNode = color.rgb
  // `texture(page, uv)` rather than `texture(page).sample(uv)`: the latter keeps the texture's uv matrix (a uniform and
  // a multiply per fragment, identity for an atlas page)
  m.opacityNode = texture(page, vec2(u, float(1).sub(v))).a.mul(color.a).mul(misc.x)
  return m
}
