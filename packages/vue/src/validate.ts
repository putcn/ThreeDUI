import type { z } from 'zod'
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

/**
 * `raw` (a component's Vue props; `undefined` = not given) parsed by `schema`, zod's defaults applied. The first
 * failure throws `GlassUIError('<name>.<path>', reason, …)`: an enum or literal value lists the allowed ones with a
 * suggestion; a wrong type names the expected and the given type, hinting at `:prop` binding when a template passed a
 * string for a number or boolean; a required prop left out says so; anything else (a refinement) gives zod's message.
 */
export function parseProps<P extends z.ZodObject>(name: string, schema: P, raw: Record<string, unknown>): z.output<P> {
  const input = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const path = issue.path.map(String).join('.')
  const scope = path ? `${name}.${path}` : name
  const got = valueAt(input, issue.path)
  if (got === undefined && issue.path.length) {
    if (issue.code === 'invalid_value') throw new GlassUIError(scope, '缺少必填属性', { allowed: issue.values.map(String) })
    if (issue.code === 'invalid_type') throw new GlassUIError(scope, `缺少必填属性（类型应为 ${issue.expected}）`)
  }
  if (issue.code === 'invalid_value') throw new GlassUIError(scope, `非法取值 "${show(got)}"`, { allowed: issue.values.map(String), got: show(got) })
  const expected = issue.code === 'invalid_type' ? [issue.expected] : unionTypes(issue)
  if (expected) {
    const hint = typeof got === 'string' && (expected.includes('number') || expected.includes('boolean')) ? '（模板里数字和布尔值要写成 :prop="…"）' : ''
    throw new GlassUIError(scope, `类型应为 ${expected.join(' | ')}，得到 ${kind(got)}${hint}`)
  }
  throw new GlassUIError(scope, issue.message)
}
