// A float64 CPU interpreter for the TSL node subset the slab vertex stage uses, so tests can hold the shader graph to
// the CPU reference (`evalSlabVertex`) vertex by vertex. It walks node fields directly (r186 node classes); an
// unsupported node type or method throws, so a graph change that outgrows it fails loudly rather than silently.

type Vec = number[]
interface AnyNode { constructor: { type?: string }; [k: string]: any }

const SWIZZLE: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

function broadcast(a: Vec, b: Vec, f: (x: number, y: number) => number): Vec {
  const n = Math.max(a.length, b.length)
  return Array.from({ length: n }, (_, i) => f(a.length === 1 ? a[0]! : a[i]!, b.length === 1 ? b[0]! : b[i]!))
}

const OPS: Record<string, (x: number, y: number) => number> = {
  '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
  '<': (x, y) => +(x < y), '>': (x, y) => +(x > y), '<=': (x, y) => +(x <= y), '>=': (x, y) => +(x >= y),
  '==': (x, y) => +(x === y), '!=': (x, y) => +(x !== y), '&&': (x, y) => +(!!x && !!y), '||': (x, y) => +(!!x || !!y),
}
const UNARY: Record<string, (x: number) => number> = {
  abs: Math.abs, sign: Math.sign, sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, negate: x => -x,
}

/**
 * Evaluates `node` for one vertex; `attributes` maps attribute names to their (vec4) values. Only taken `select`
 * branches run, as in the if/else three emits; `onPow` sees the base of every `pow` that runs.
 */
export function evalNode(node: unknown, attributes: Record<string, readonly number[]>, onPow?: (base: readonly number[]) => void): Vec {
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
        const b = ev(n.bNode)
        if (m === 'dot') return [a.reduce((s, x, i) => s + x * b[i]!, 0)]
        if (m === 'pow') { onPow?.(a); return broadcast(a, b, Math.pow) }
        if (m === 'min' || m === 'max') {
          const f = m === 'min' ? Math.min : Math.max
          const ab = broadcast(a, b, f)
          return n.cNode ? broadcast(ab, ev(n.cNode), f) : ab
        }
        throw new Error(`tsl-eval: unsupported math method ${m}`)
      }
      default: throw new Error(`tsl-eval: unsupported node type ${String(type)}`)
    }
  }
  return ev(node as AnyNode)
}
