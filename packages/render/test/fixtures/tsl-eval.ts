// A float64 CPU interpreter for the TSL node subset the slab vertex stage and the flat materials use, so tests can hold
// shader graphs to their CPU references (`evalSlabVertex`, `superellipseSDF`) point by point. It walks node fields
// directly (r186 node classes); an unsupported node type or method throws, so a graph change that outgrows it fails
// loudly rather than silently.

type Vec = number[]
interface AnyNode { constructor: { type?: string }; [k: string]: any }

const SWIZZLE: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

function broadcast(a: Vec, b: Vec, f: (x: number, y: number) => number): Vec {
  const n = Math.max(a.length, b.length)
  return Array.from({ length: n }, (_, i) => f(a.length === 1 ? a[0]! : a[i]!, b.length === 1 ? b[0]! : b[i]!))
}
function broadcast3(a: Vec, b: Vec, c: Vec, f: (x: number, y: number, z: number) => number): Vec {
  const n = Math.max(a.length, b.length, c.length), at = (v: Vec, i: number) => v.length === 1 ? v[0]! : v[i]!
  return Array.from({ length: n }, (_, i) => f(at(a, i), at(b, i), at(c, i)))
}
const TERNARY: Record<string, (x: number, y: number, z: number) => number> = {
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t) },
}

const OPS: Record<string, (x: number, y: number) => number> = {
  '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
  '<': (x, y) => +(x < y), '>': (x, y) => +(x > y), '<=': (x, y) => +(x <= y), '>=': (x, y) => +(x >= y),
  '==': (x, y) => +(x === y), '!=': (x, y) => +(x !== y), '&&': (x, y) => +(!!x && !!y), '||': (x, y) => +(!!x || !!y),
}
const UNARY: Record<string, (x: number) => number> = {
  abs: Math.abs, sign: Math.sign, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, exp: Math.exp, negate: x => -x,
}

/**
 * Evaluates `node` for one vertex (or fragment); `attributes` maps attribute names to their (vec4) values. Only taken
 * `select` branches run, as in the if/else three emits; `onPow` sees the base of every `pow` that runs. A fragment
 * graph's `fwidth(x)` evaluates to `fwidth` (the screen footprint of x, which a single point cannot know); without it,
 * `fwidth` throws. A texture sample evaluates to `sample(texture, uv)` (its uv evaluated); without it, a texture throws,
 * as does one with a uv matrix (`texture(t).sample(uv)` keeps the texture's own transform; `texture(t, uv)` does not).
 */
export function evalNode(node: unknown, attributes: Record<string, readonly number[]>, onPow?: (base: readonly number[]) => void, fwidth?: number, sample?: (texture: unknown, uv: readonly number[]) => Vec): Vec {
  const memo = new Map<unknown, Vec>()
  const ev = (n: AnyNode): Vec => {
    let r = memo.get(n)
    if (!r) { r = compute(n); memo.set(n, r) }
    return r
  }
  const compute = (n: AnyNode): Vec => {
    const type = n.constructor.type
    switch (type) {
      case 'VaryingNode': case 'VarNode': case 'SubBuild': return ev(n.node)
      case 'ConstNode': case 'UniformNode': {   // a uniform evaluates to its current value
        const v = n.value
        if (typeof v === 'number') return [v]
        if (typeof v === 'boolean') return [+v]
        if (v?.isVector2) return [v.x, v.y]
        if (v?.isVector3) return [v.x, v.y, v.z]
        if (v?.isVector4) return [v.x, v.y, v.z, v.w]
        throw new Error(`tsl-eval: unsupported constant ${String(v)}`)
      }
      case 'AttributeNode': {
        const a = attributes[n._attributeName]
        if (!a) throw new Error(`tsl-eval: no value for attribute ${n._attributeName}`)
        return [...a]
      }
      case 'SplitNode': { const v = ev(n.node); return [...(n.components as string)].map(c => v[SWIZZLE[c]!]!) }
      case 'JoinNode': return (n.nodes as AnyNode[]).flatMap(ev)
      case 'ConditionalNode': return ev(n.condNode)[0] ? ev(n.ifNode) : ev(n.elseNode)
      case 'OperatorNode': {
        const f = OPS[n.op]
        if (!f) throw new Error(`tsl-eval: unsupported operator ${n.op}`)
        return broadcast(ev(n.aNode), ev(n.bNode), f)
      }
      case 'MathNode': {
        const m = n.method as string, a = ev(n.aNode)
        const u = UNARY[m]
        if (u) return a.map(u)
        if (m === 'length') return [Math.sqrt(a.reduce((s, x) => s + x * x, 0))]
        if (m === 'fwidth') {
          if (fwidth === undefined) throw new Error('tsl-eval: fwidth needs a value')
          return a.map(() => fwidth)
        }
        const b = ev(n.bNode)
        const t = TERNARY[m]
        if (t) return broadcast3(a, b, ev(n.cNode), t)
        if (m === 'dot') return [a.reduce((s, x, i) => s + x * b[i]!, 0)]
        if (m === 'pow') { onPow?.(a); return broadcast(a, b, Math.pow) }
        if (m === 'min' || m === 'max') {
          const f = m === 'min' ? Math.min : Math.max
          const ab = broadcast(a, b, f)
          return n.cNode ? broadcast(ab, ev(n.cNode), f) : ab
        }
        throw new Error(`tsl-eval: unsupported math method ${m}`)
      }
      case 'TextureNode': {
        if (!sample) throw new Error('tsl-eval: a texture needs a sampler')
        if (n.updateMatrix || n.levelNode || n.biasNode || !n.uvNode) throw new Error('tsl-eval: unsupported texture sample (uv matrix, level, bias or default uv)')
        return sample(n.value, ev(n.uvNode))
      }
      default: throw new Error(`tsl-eval: unsupported node type ${String(type)}`)
    }
  }
  return ev(node as AnyNode)
}
