import { z } from 'zod'
import { GlassUIError } from '../errors'

const Length = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?%$/, 'length must be a number (pt) or "N%"'), z.literal('auto')])
const Pt = z.number()
const Token = z.string()   // design-token name or literal colour; resolved by theme.ts

const Glow = z.object({ color: Token, strength: z.number().min(0), split: z.number().min(0).max(1).optional() }).strict()
const Border = z.object({ width: Pt, color: Token }).strict()

export const GlassParamsSchema = z.object({
  variant: z.enum(['regular', 'clear']).optional(),
  thickness: Pt.optional(), fillet: Pt.optional(), filletBottom: Pt.optional(),
  profile: z.enum(['fillet', 'lens']).optional(),
  scatter: z.number().min(0).max(1).optional(), lift: z.number().min(0).max(1).optional(),
  edgeGlow: z.number().min(0).optional(),
  glow: Glow.nullable().optional(),
  ior: z.number().optional(), dispersion: z.number().min(0).max(1).optional(), roughness: z.number().min(0).max(1).optional(),
  tint: Token.nullable().optional(), absorption: z.number().min(0).optional(),
  envIntensity: z.number().min(0).optional(), specularIntensity: z.number().min(0).optional(),
  innerGlow: z.number().min(0).optional(), adaptive: z.boolean().optional(),
  cornerExponent: z.number().min(2).optional(),
}).strict()

const Transition = z.union([
  z.enum(['snappy', 'smooth', 'bouncy']),
  z.object({ stiffness: z.number(), damping: z.number(), mass: z.number().optional() }).strict(),
  z.object({ response: z.number(), dampingFraction: z.number() }).strict(),
  z.object({ duration: z.number(), easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']) }).strict(),
])

/** Properties a `transition` may animate (spec §4.4). */
const ANIMATABLE_KEYS = ['x', 'y', 'width', 'height', 'scale', 'opacity', 'color', 'bg', 'radius', 'glass', 'elevation', 'tilt'] as const

const Base = z.object({
  display: z.enum(['flex', 'none']).optional(),
  position: z.enum(['relative', 'absolute']).optional(),
  flexDirection: z.enum(['row', 'column', 'row-reverse', 'column-reverse']).optional(),
  justifyContent: z.enum(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']).optional(),
  alignItems: z.enum(['flex-start', 'center', 'flex-end', 'stretch', 'baseline']).optional(),
  alignSelf: z.enum(['auto', 'flex-start', 'center', 'flex-end', 'stretch']).optional(),
  flexWrap: z.enum(['nowrap', 'wrap']).optional(),
  flex: z.number().optional(), flexGrow: z.number().optional(), flexShrink: z.number().optional(), flexBasis: Length.optional(),
  width: Length.optional(), height: Length.optional(),
  minWidth: Length.optional(), maxWidth: Length.optional(), minHeight: Length.optional(), maxHeight: Length.optional(),
  aspectRatio: z.number().optional(),
  padding: Pt.optional(), paddingX: Pt.optional(), paddingY: Pt.optional(),
  paddingTop: Pt.optional(), paddingRight: Pt.optional(), paddingBottom: Pt.optional(), paddingLeft: Pt.optional(),
  margin: Pt.optional(), marginX: Pt.optional(), marginY: Pt.optional(),
  marginTop: Pt.optional(), marginRight: Pt.optional(), marginBottom: Pt.optional(), marginLeft: Pt.optional(),
  gap: Pt.optional(), rowGap: Pt.optional(), columnGap: Pt.optional(),
  top: Length.optional(), right: Length.optional(), bottom: Length.optional(), left: Length.optional(), inset: Length.optional(),
  overflow: z.enum(['visible', 'hidden', 'scroll']).optional(),
  pointerEvents: z.enum(['auto', 'none']).optional(),
  bg: z.union([Token, z.literal('glass'), z.literal('glass-clear'), z.literal('none')]).optional(),
  radius: z.union([Pt, z.literal('capsule'), z.literal('concentric'), Token]).optional(),
  border: Border.optional(),
  shadow: Token.optional(),
  opacity: z.number().min(0).max(1).optional(),
  font: Token.optional(), fontSize: z.union([Pt, Token]).optional(), fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().optional(), letterSpacing: z.number().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), color: Token.optional(),
  maxLines: z.number().int().min(1).optional(), wrap: z.boolean().optional(),
  glass: GlassParamsSchema.partial().optional(),
  // partialRecord: zod 4's z.record with enum keys is exhaustive (would require every key).
  transition: z.partialRecord(z.enum(ANIMATABLE_KEYS), Transition).optional(),
}).strict()

export const StyleSchema: z.ZodType<Style> = Base.extend({
  hover: z.lazy(() => Base).optional(),
  pressed: z.lazy(() => Base).optional(),
  focused: z.lazy(() => Base).optional(),
  disabled: z.lazy(() => Base).optional(),
}).strict()

type BaseStyle = z.infer<typeof Base>
export interface Style extends BaseStyle {
  hover?: BaseStyle | undefined; pressed?: BaseStyle | undefined; focused?: BaseStyle | undefined; disabled?: BaseStyle | undefined
}
export type Length = z.infer<typeof Length>
const STATE_KEYS: readonly string[] = ['hover', 'pressed', 'focused', 'disabled']
export const STYLE_KEYS: readonly string[] = [...Object.keys(Base.shape), ...STATE_KEYS]

/** Own keys of each nested strict object, by the style key it sits under. */
const NESTED_KEYS: Record<string, readonly string[]> = {
  glass: Object.keys(GlassParamsSchema.shape),
  glow: Object.keys(Glow.shape),
  border: Object.keys(Border.shape),
  transition: ANIMATABLE_KEYS,
}

const LENGTH_ALLOWED = ['number(pt)', '"N%"', 'auto']
/** Readable allowed forms for union-typed keys (zod's union issues carry no usable value list). */
const UNION_ALLOWED: Record<string, readonly string[]> = {
  bg: ['glass', 'glass-clear', 'none', '<颜色 token 或 #hex>'],
  radius: ['number', 'capsule', 'concentric', '<radius token>'],
  fontSize: ['number', '<fontSize token>'],
  transition: ['snappy', 'smooth', 'bouncy', '{stiffness,damping,mass?}', '{response,dampingFraction}', '{duration,easing}'],
  ...Object.fromEntries(Object.entries(Base.shape).filter(([, s]) => s.unwrap() === Length).map(([k]) => [k, LENGTH_ALLOWED])),
}

const isState = (k: string | undefined): boolean => k !== undefined && STATE_KEYS.includes(k)

/** Allowed keys of the object at `path` (top level, a state branch, or a nested object). */
function keysAt(path: readonly string[]): readonly string[] {
  const last = path[path.length - 1]
  if (last === undefined) return STYLE_KEYS
  if (isState(last)) return Object.keys(Base.shape)
  return NESTED_KEYS[last] ?? []
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let v = input
  for (const k of path) v = (v as Record<PropertyKey, unknown> | null | undefined)?.[k]
  return v
}

const show = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))

export function validateStyle(style: unknown, scope = 'style'): Style {
  const r = StyleSchema.safeParse(style)
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const path = issue.path.map(String)
  const at = (p: readonly string[]): string => (p.length ? `${scope}.${p.join('.')}` : scope)
  if (issue.code === 'unrecognized_keys') {
    const bad = issue.keys[0]!
    throw new GlassUIError(at(path), `未知键 "${bad}"`, { allowed: keysAt(path), got: bad })
  }
  // Any failure at or below a union-typed value is reported at the union's own path with its readable forms.
  const i = isState(path[0]) ? 1 : 0
  const key = path[i]
  const unionAllowed = key === undefined ? undefined : UNION_ALLOWED[key]
  const unionDepth = i + (key === 'transition' ? 2 : 1)
  if (unionAllowed && path.length >= unionDepth) {
    const got = show(valueAt(style, issue.path.slice(0, unionDepth)))
    throw new GlassUIError(at(path.slice(0, unionDepth)), `非法取值 "${got}"`, { allowed: unionAllowed, got })
  }
  if (issue.code === 'invalid_value') {
    const got = show(valueAt(style, issue.path))
    throw new GlassUIError(at(path), `非法取值 "${got}"`, { allowed: issue.values.map(String), got })
  }
  throw new GlassUIError(at(path), issue.message)
}
