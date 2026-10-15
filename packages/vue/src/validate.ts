import { z } from 'zod'
import { GlassUIError } from '@glassui/core'

// `valueAt` / `show` as in core's style/schema.ts (copied: core re-exports that module whole, and two generic names
// do not belong in its public API)
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let v = input
  for (const k of path) v = (v as Record<PropertyKey, unknown> | null | undefined)?.[k]
  return v
}
/** Short printable form of an offending value; never throws (cycles, BigInt, hostile toString). */
function show(v: unknown): string {
  let s: string
  try {
    s = typeof v === 'object' && v !== null ? JSON.stringify(v) ?? Object.prototype.toString.call(v) : String(v)
  } catch {
    s = Object.prototype.toString.call(v)
  }
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}
/** What a value is, for "得到 …": `NaN` / `Infinity` by name (zod's number rejects them, "得到 number" would contradict). */
const kind = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v

type Issue = z.core.$ZodIssue
/** The types a union takes, when each of its branches failed on the value's type alone; else null. */
function unionTypes(issue: Issue): string[] | null {
  if (issue.code !== 'invalid_union') return null
  const types = issue.errors.map(b => b.length === 1 && b[0]!.code === 'invalid_type' && b[0]!.path.length === 0 ? b[0]!.expected : null)
  return types.every((t): t is NonNullable<typeof t> => t !== null) ? types : null
}

/** `s` without its optional / default / nullable wrappers. */
function unwrap(s: z.ZodType): z.ZodType {
  let t = s
  while (t instanceof z.ZodOptional || t instanceof z.ZodDefault || t instanceof z.ZodNullable) t = t.unwrap() as z.ZodType
  return t
}
/** The (unwrapped) schema at `path` under `schema`: object keys, array items, and the union branch that has the step. */
function schemaAt(schema: z.ZodType, path: readonly PropertyKey[]): z.ZodType | null {
  const step = (s: z.ZodType, k: PropertyKey): z.ZodType | null => {
    const t = unwrap(s)
    if (t instanceof z.ZodObject) return Object.hasOwn(t.shape, k) ? t.shape[k as string] as z.ZodType : null
    if (t instanceof z.ZodArray) return typeof k === 'number' ? t.element as z.ZodType : null
    if (t instanceof z.ZodUnion) for (const o of t.options as readonly z.ZodType[]) { const hit = step(o, k); if (hit) return hit }
    return null
  }
  let t: z.ZodType | null = schema
  for (const k of path) if (!(t = t && step(t, k))) return null
  return t && unwrap(t)
}

/** zod's own (English) size messages start so; a schema's custom message (`.min(0, '不能为负数')`) is kept as written. */
const DEFAULT_SIZE = /^Too (big|small):/
/** A size issue in Chinese: a number's range (both bounds when the schema has them), a string's length, an array's items. */
function sizeReason(issue: z.core.$ZodIssueTooBig | z.core.$ZodIssueTooSmall, at: z.ZodType | null, got: unknown): string {
  const big = issue.code === 'too_big', bound = Number(big ? (issue as z.core.$ZodIssueTooBig).maximum : (issue as z.core.$ZodIssueTooSmall).minimum)
  if (issue.origin === 'string') return `长度${big ? '不能超过' : '不能少于'} ${bound} 个字符，得到 ${String(got).length} 个`
  if (issue.origin === 'array' || issue.origin === 'set') return `${big ? '最多' : '至少'} ${bound} 项，得到 ${Array.isArray(got) ? got.length : show(got)} 项`
  // `.int()` alone bounds a number by ±MAX_SAFE_INTEGER: not a range anyone wrote
  const real = (b: number | null | undefined): b is number => typeof b === 'number' && Math.abs(b) < Number.MAX_SAFE_INTEGER
  const lo = at instanceof z.ZodNumber ? at.minValue : null, hi = at instanceof z.ZodNumber ? at.maxValue : null
  if (real(lo) && real(hi)) return `超出范围（${lo}–${hi}），得到 ${show(got)}`
  const rule = big ? (issue.inclusive ? '不能大于' : '应小于') : (issue.inclusive ? '不能小于' : '应大于')
  return `${rule} ${bound}，得到 ${show(got)}`
}

/** Per prop, names an agent may reach for → the allowed value they mean (`{ name: { close: 'x' } }`): only the suggestion uses them. */
export type PropAliases = Readonly<Record<string, Readonly<Record<string, string>>>>

/**
 * The readable error for `issue` (at `base` + its own path) of `name`'s props. A union whose single non-type-mismatch
 * branch failed deeper (a `Text` fragment's field) is reported as that branch's first issue, at its full path.
 */
function describe(name: string, schema: z.ZodType, input: Record<string, unknown>, issue: Issue, base: readonly PropertyKey[], aliases: PropAliases | undefined): GlassUIError {
  const full = [...base, ...issue.path]
  if (issue.code === 'invalid_union') {
    const deep = issue.errors.filter(b => !(b.length === 1 && b[0]!.code === 'invalid_type' && b[0]!.path.length === 0))
    if (deep.length === 1 && deep[0]!.length) return describe(name, schema, input, deep[0]![0]!, full, aliases)
  }
  const path = full.map(String).join('.')
  const scope = path ? `${name}.${path}` : name
  const got = valueAt(input, full)
  if (issue.code === 'unrecognized_keys') {
    const at = schemaAt(schema, full), key = issue.keys[0]!
    return new GlassUIError(scope, `未知属性 "${key}"`, { allowed: at instanceof z.ZodObject ? Object.keys(at.shape) : [], got: key })
  }
  if (got === undefined && full.length) {
    if (issue.code === 'invalid_value') return new GlassUIError(scope, '缺少必填属性', { allowed: issue.values.map(String) })
    if (issue.code === 'invalid_type') return new GlassUIError(scope, `缺少必填属性（类型应为 ${issue.expected}）`)
  }
  if (issue.code === 'invalid_value') {
    // an alias names the value meant: as `got`, it becomes the suggestion (GlassUIError reads `got` for nothing else)
    const table = full.length === 1 && aliases && Object.hasOwn(aliases, String(full[0])) ? aliases[String(full[0])] : undefined
    const alias = table && typeof got === 'string' && Object.hasOwn(table, got.toLowerCase()) ? table[got.toLowerCase()] : undefined
    return new GlassUIError(scope, `非法取值 "${show(got)}"`, { allowed: issue.values.map(String), got: alias ?? show(got) })
  }
  if ((issue.code === 'too_big' || issue.code === 'too_small') && DEFAULT_SIZE.test(issue.message)) return new GlassUIError(scope, sizeReason(issue, schemaAt(schema, full), got))
  const expected = issue.code === 'invalid_type' ? [issue.expected] : unionTypes(issue)
  if (expected) {
    const hint = typeof got === 'string' && (expected.includes('number') || expected.includes('boolean')) ? '（模板里数字和布尔值要写成 :prop="…"）' : ''
    return new GlassUIError(scope, `类型应为 ${expected.join(' | ')}，得到 ${kind(got)}${hint}`)
  }
  return new GlassUIError(scope, issue.message)
}

/**
 * `raw` (a component's Vue props; `undefined` = not given) parsed by `schema`, zod's defaults applied. The first
 * failure throws `GlassUIError('<name>.<path>', reason, …)`:
 * - an enum or literal value lists the allowed ones with a suggestion (from `aliases` when one names the value, else
 *   the nearest allowed value);
 * - a wrong type names the expected and the given type, hinting at `:prop` binding when a template passed a string for
 *   a number or boolean; a required prop or key left out says so;
 * - an unknown key of a nested object (a `Text` fragment's) lists the object's keys with a suggestion;
 * - a number out of range gives the range (both bounds when the schema has them), a string or array its size limit;
 * - inside a union, the branch that got past the type check is followed to its own field (`Text.value.0.weight`);
 * - anything else (a refinement, a custom message) gives zod's message.
 */
export function parseProps<P extends z.ZodObject>(name: string, schema: P, raw: Record<string, unknown>, aliases?: PropAliases): z.output<P> {
  const input = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))
  const r = schema.safeParse(input)
  if (r.success) return r.data
  throw describe(name, schema, input, r.error.issues[0]!, [], aliases)
}
