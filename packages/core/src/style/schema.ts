import { z } from 'zod'
import { GlassUIError } from '../errors'

const Length = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?%$/, 'length must be a number (pt) or "N%"'), z.literal('auto')])
const Pt = z.number()
const Token = z.string()   // design-token name or literal colour; resolved by theme.ts

export const GlassParamsSchema = z.object({
  variant: z.enum(['regular', 'clear']).optional(),
  thickness: Pt.optional(), fillet: Pt.optional(), filletBottom: Pt.optional(),
  profile: z.enum(['fillet', 'lens']).optional(),
  scatter: z.number().min(0).max(1).optional(), lift: z.number().min(0).max(1).optional(),
  edgeGlow: z.number().min(0).optional(),
  glow: z.object({ color: Token, strength: z.number().min(0), split: z.number().min(0).max(1).optional() }).nullable().optional(),
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
  border: z.object({ width: Pt, color: Token }).strict().optional(),
  shadow: Token.optional(),
  opacity: z.number().min(0).max(1).optional(),
  font: Token.optional(), fontSize: z.union([Pt, Token]).optional(), fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().optional(), letterSpacing: z.number().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), color: Token.optional(),
  maxLines: z.number().int().min(1).optional(), wrap: z.boolean().optional(),
  glass: GlassParamsSchema.partial().optional(),
  transition: z.record(z.string(), Transition).optional(),
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
export const STYLE_KEYS: readonly string[] = [...Object.keys(Base.shape), 'hover', 'pressed', 'focused', 'disabled']

export function validateStyle(style: unknown, scope = 'style'): Style {
  const r = StyleSchema.safeParse(style)
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const path = issue.path.map(String)
  const key = path[0] ?? ''
  const where = path.length ? `${scope}.${path.join('.')}` : scope
  if (issue.code === 'unrecognized_keys') {
    const bad = (issue as { keys: string[] }).keys[0]!
    throw new GlassUIError(scope, `未知键 "${bad}"`, { allowed: STYLE_KEYS, got: bad })
  }
  if (issue.code === 'invalid_value') {
    const allowed = ((issue as { values?: unknown[] }).values ?? []).map(String)
    throw new GlassUIError(where, `非法取值`, { allowed, got: String((style as Record<string, unknown>)[key]) })
  }
  throw new GlassUIError(where, issue.message)
}
