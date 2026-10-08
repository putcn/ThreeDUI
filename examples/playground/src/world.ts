import type { Surface, UIRoot } from '@glassui/render'
import { abs, BODY, glassSwitch, INK, MUTED, pill, text, wireHover } from './signup'

/**
 * A world-layer Surface: 600 × 360 pt at 244 pt per unit (2.46 × 1.48 units), standing in the host scene to the right
 * of the form, turned toward the camera and tipped back at the bottom so its lower-left corner passes behind the wall
 * (z = −2.5): perspective, occlusion by host geometry (shared depth) and the world-layer lighting are all visible. The
 * wall cuts the panel diagonally across its lower-left corner and through the left end of the Cancel pill, so raised
 * glass is seen occluded as well as the background slab.
 */
export function buildWorld(root: UIRoot): Surface {
  const s = root.createSurface({ id: 'world', layer: 'world', width: 600, height: 360, ptPerUnit: 244, background: 'glass', cornerRadius: 32 })
  s.position.set(2.2, 0.15, -2.2)
  s.rotation.set(0.3, -0.35, 0)
  const r = s.root
  r.appendChild(text('World layer', { ...abs(36, 30, 400, 40), fontSize: 30, fontWeight: 700, color: INK }))
  r.appendChild(text('Perspective · occlusion · 世界层光照', { ...abs(36, 76, 528, 28), fontSize: 18, fontWeight: 500, color: MUTED }))
  r.appendChild(text('Ambient glow', { ...abs(36, 152, 300, 28), fontSize: 20, fontWeight: 500, color: BODY }))
  r.appendChild(glassSwitch(600 - 36 - 136, 135, 'ambient'))
  r.appendChild(pill(36, 246, 252, 76, { label: 'Cancel', id: 'cancel' }))
  r.appendChild(pill(312, 246, 252, 76, { label: 'Continue', labelColor: '#ffffff', labelWeight: 700, trailing: 'arrow-right', glow: 'accent', strength: 1.1, id: 'continue' }))
  wireHover(s)
  return s
}
