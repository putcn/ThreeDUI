import { Node, parseTw, defaultTheme as theme, type Style } from '@glassui/core'
import type { Surface, UIRoot } from '@glassui/render'
import { iconCanvas, knobCanvas, type IconName } from './icons'

// Reference layout (docs/images/signup-front.jpg): 1024 px wide, panel 885 × 1045 centred at (512, 642), so its
// top-left is (70, 120); 84 pt inputs. Positions below are written as "reference px − panel origin" so the numbers stay
// recognisably the reference's (x − 70, y − 120, and a centre y minus half the height).
const M = theme.metrics
const tw = (s: string): Style => parseTw(s, theme)
export const abs = (left: number, top: number, width: number, height: number) => ({ position: 'absolute' as const, left, top, width, height })

export const INK = '#1c1c22', MUTED = '#6a6a78', HINT = '#8a8a98', BODY = '#3a3a48', LINK = '#5b52f0'
/** The panel's size in pt (the reference's px). */
export const SIGNUP = { width: 885, height: 1045 } as const

export function text(value: string, style: Partial<Style>, id?: string): Node {
  const n = new Node('text', id)
  n.setProp('value', value)
  n.setStyle(style)
  return n
}

export function icon(name: IconName, size: number, color?: string, stroke?: number): Node {
  const n = new Node('image')
  n.setProp('src', iconCanvas(name, size, color, stroke))
  n.setStyle({ width: size, height: size, flexShrink: 0 })
  return n
}

export interface PillOptions {
  label?: string; labelColor?: string; labelSize?: number; labelWeight?: number
  /** Leading/trailing icon colour (default: the label colour, or `HINT` for a placeholder row). */
  iconColor?: string
  leading?: IconName; trailing?: IconName
  glow?: string; strength?: number
  /** `start`: a field row (icon, label, then the trailing icon at the far edge); `center`: an icon + label group, centred. */
  align?: 'center' | 'start'
  id?: string; tabIndex?: number
}

/**
 * A clear glass pill with optional leading/trailing icons and a label (spec §8.2 metrics: padding 26, 28 pt icons,
 * 14 pt icon–text gap in a field row, a centred icon + text group 12 pt apart).
 */
export function pill(left: number, top: number, width: number, height: number, opts: PillOptions): Node {
  const start = opts.align === 'start'
  const n = new Node('glass', opts.id)
  n.setStyle({
    ...abs(left, top, width, height), radius: 'capsule', ...tw('flex-row items-center'),
    paddingX: M.controlPadding, gap: start ? M.iconGap : M.groupGap, justifyContent: start ? 'flex-start' : 'center',
    ...(opts.glow ? { glass: { glow: { color: opts.glow, strength: opts.strength ?? 1.1 } } } : {}),
    transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' }, pressed: { scale: 0.96 },
  })
  n.setProp('tabIndex', opts.tabIndex ?? 0)
  const labelColor = opts.labelColor ?? INK
  const iconColor = opts.iconColor ?? labelColor
  if (opts.leading) n.appendChild(icon(opts.leading, M.icon, iconColor, start ? 0.1 : 0.12))
  if (opts.label) {
    n.appendChild(text(opts.label, { fontSize: opts.labelSize ?? 23, fontWeight: opts.labelWeight ?? 600, color: labelColor, lineHeight: 1.2, flexShrink: 0 }))
  }
  if (opts.trailing) {
    if (start) { const spacer = new Node('box'); spacer.setStyle({ flexGrow: 1 }); n.appendChild(spacer) }
    n.appendChild(icon(opts.trailing, M.icon, iconColor, start ? 0.1 : 0.12))
  }
  return n
}

/** A field row: a placeholder-coloured pill, content aligned to the start (the reference's inputs). */
const field = (top: number, leading: IconName, placeholder: string, id: string, trailing?: IconName): Node =>
  pill(122 - 70, top, 760, 84, { leading, label: placeholder, labelColor: HINT, labelWeight: 500, align: 'start', id, ...(trailing ? { trailing } : {}) })

/**
 * A glass switch, `on` (spec §8.2/§8.3: 136 × 62, knob 48 at margin 7; the glow is split softly at the knob centre).
 * The knob is a flat decal riding on the switch's top face (spec §5: decoration, not geometry), an image so it draws
 * on top of the glass rather than refracted under it.
 */
export function glassSwitch(left: number, top: number, id: string): Node {
  const knobX = M.switchWidth / 2 - M.knobMargin - M.knob / 2   // knob centre, from the switch centre
  const sw = new Node('glass', id)
  sw.setStyle({
    ...abs(left, top, M.switchWidth, M.switchHeight), radius: 'capsule',
    glass: { glow: { color: 'accent', strength: 1.1, split: 0.5 + knobX / M.switchWidth } },
    transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' }, pressed: { scale: 0.96 },
  })
  sw.setProp('tabIndex', 0)
  const pad = 4   // room for the knob's soft shadow
  const size = M.knob + 2 * pad
  const knob = new Node('image', `${id}-knob`)
  knob.setProp('src', knobCanvas(size, M.knob))
  knob.setStyle(abs(M.switchWidth / 2 + knobX - size / 2, M.switchHeight / 2 - size / 2, size, size))
  sw.appendChild(knob)
  return sw
}

export function buildSignup(root: UIRoot): Surface {
  const s = root.createSurface({ id: 'signup', width: SIGNUP.width, height: SIGNUP.height, background: 'glass', cornerRadius: 48, left: 0, top: 0 })
  const r = s.root
  const L = 122 - 70, W = 760   // inputs: x 122…882 in the reference

  r.appendChild(text('Create your account', { ...abs(L, 192 - 120 - 28, 700, 56), fontSize: 44, fontWeight: 700, color: INK }, 'title'))
  // the CJK path, exercised where the checkpoint can see it
  r.appendChild(text('开始 14 天免费试用，无需信用卡。', { ...abs(L, 240 - 120 - 14, 700, 32), fontSize: 22, fontWeight: 500, color: MUTED }, 'subtitle'))

  const close = pill(878 - 70 - 26, 200 - 120 - 26, 52, 52, { id: 'close' })
  close.setStyle({ paddingX: 0, glass: { scatter: 0.5 } })
  close.appendChild(icon('x', 24, '#4a4a58'))
  r.appendChild(close)

  r.appendChild(field(345 - 120 - 42, 'user', 'Full name', 'name'))
  r.appendChild(field(455 - 120 - 42, 'mail', 'Email address', 'email'))
  r.appendChild(field(565 - 120 - 42, 'lock', 'Password', 'password', 'eye'))

  // terms: a 44 × 44 clear glass button with a check, and its text on the panel
  const cb = new Node('glass', 'terms')
  cb.setStyle({
    ...abs(L, 680 - 120 - M.checkbox / 2, M.checkbox, M.checkbox), radius: M.checkboxRadius, ...tw('items-center justify-center'),
    glass: { thickness: 14, fillet: 4, filletBottom: 2 }, transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' }, pressed: { scale: 0.9 },
  })
  cb.setProp('tabIndex', 0)
  cb.appendChild(icon('check', 30, '#6b63f5', 0.14))
  r.appendChild(cb)
  r.appendChild(text('I agree to the Terms & Privacy', { ...abs(L + M.checkbox + 16, 680 - 120 - 14, 400, 30), fontSize: 21, fontWeight: 500, color: BODY }))

  // remember me: the switch right-aligned with the inputs, its label 16 pt to its left
  const swLeft = L + W - M.switchWidth
  r.appendChild(glassSwitch(swLeft, 680 - 120 - M.switchHeight / 2, 'remember'))
  r.appendChild(text('Remember me', { ...abs(swLeft - 16 - 150, 680 - 120 - 14, 150, 30), fontSize: 20, fontWeight: 500, color: BODY, textAlign: 'right' }))

  // the primary action: glowing glass, the label and arrow centred together
  r.appendChild(pill(L, 795 - 120 - 42, W, 84, { label: 'Create account', labelColor: '#ffffff', labelSize: 25, labelWeight: 700, trailing: 'arrow-right', glow: 'accent', strength: 1.15, id: 'submit' }))

  r.appendChild(text('or continue with', { ...abs(0, 878 - 120 - 14, SIGNUP.width, 30), fontSize: 19, fontWeight: 500, color: HINT, textAlign: 'center' }))
  r.appendChild(pill(312 - 70 - 182, 955 - 120 - 39, 365, 78, { leading: 'apple', label: 'Apple', id: 'apple' }))
  r.appendChild(pill(692 - 70 - 182, 955 - 120 - 39, 365, 78, { leading: 'google', label: 'Google', id: 'google' }))

  // "Already have an account? Sign in", centred as one line
  const footer = new Node('box')
  footer.setStyle({ ...abs(0, 1072 - 120 - 15, SIGNUP.width, 30), ...tw('flex-row items-center justify-center'), gap: 10 })
  footer.appendChild(text('Already have an account?', { fontSize: 20, fontWeight: 500, color: MUTED, lineHeight: 1.3, flexShrink: 0 }))
  footer.appendChild(text('Sign in', { fontSize: 20, fontWeight: 700, color: LINK, lineHeight: 1.3, flexShrink: 0 }, 'signin'))
  r.appendChild(footer)

  wireHover(s)
  return s
}

/**
 * Hover tilt ≤ 3° toward the pointer and a 6 pt lift on every glass element of `s` (spec §8.3; the components own this
 * in Plan 3). `pointermove` bubbles, so moving over a pill's icon or label still reaches the pill with `localX/localY`
 * relative to it.
 */
export function wireHover(s: Surface): void {
  s.root.walk(n => {
    if (n.type !== 'glass') return
    s.events.on(n, 'pointermove', e => {
      if (!(n.layout.width > 0 && n.layout.height > 0)) return
      n.tilt = { x: -(e.localY / n.layout.height - 0.5) * 0.1, y: (e.localX / n.layout.width - 0.5) * 0.1 }
    })
    s.events.on(n, 'pointerenter', () => { n.elevation = 6 })
    s.events.on(n, 'pointerleave', () => { n.elevation = 0; n.tilt = { x: 0, y: 0 } })
  })
}
