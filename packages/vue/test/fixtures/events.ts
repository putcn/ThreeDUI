import { EventDispatcher, type Node, type UIEvent, type UIEventType } from '@glassui/core'

/**
 * Runs `node`'s element handler for `type` (its Vue `on*` listener) with a `UIEvent` built from `init`: target and
 * currentTarget `node`; `x`, `y`, `localX`, `localY` (default 0), `pointerType` (default `'mouse'`) and `key` as given;
 * a working `stopPropagation`. Only `node`'s own handler runs (no bubbling: `bubble` does that). Throws when `node` has
 * no handler for `type`, so a test never passes by firing into nothing. Returns the event.
 */
export function fire(node: Node, type: UIEventType, init: Partial<Pick<UIEvent, 'x' | 'y' | 'localX' | 'localY' | 'pointerType' | 'key'>> = {}): UIEvent {
  const fn = node.handlers.get(type)
  if (!fn) throw new Error(`no ${type} handler on <${node.type} id=${node.id}>`)
  const e: UIEvent = {
    type, target: node, currentTarget: node,
    x: init.x ?? 0, y: init.y ?? 0, localX: init.localX ?? 0, localY: init.localY ?? 0, pointerType: init.pointerType ?? 'mouse',
    ...(init.key !== undefined ? { key: init.key } : {}),
    propagationStopped: false,
    stopPropagation: () => { e.propagationStopped = true },
  }
  fn(e)
  return e
}

/**
 * Dispatches `type` at `node` through core's own `EventDispatcher`, as a Surface does: `node`'s handler, then each
 * ancestor's (a click on a label reaches the row that holds the handler), with core's bubbling rules (`pointerenter`,
 * `pointerleave`, `focus` and `blur` stay on `node`), `stopPropagation`, and `localX`/`localY` relative to each handling
 * node. `init` as `fire`'s, less the local coordinates. Throws when no handler on the path ran, so a test never passes
 * by firing into nothing. Returns the event.
 */
export function bubble(node: Node, type: UIEventType, init: Partial<Pick<UIEvent, 'x' | 'y' | 'pointerType' | 'key'>> = {}): UIEvent {
  const e = new EventDispatcher().dispatch(node, type, init)
  // core moves `currentTarget` to each node that handles the event: it rests on one with a handler iff one ran
  if (!e.currentTarget.handlers.has(type)) throw new Error(`no ${type} handler on <${node.type} id=${node.id}> or on the nodes it bubbles to`)
  return e
}
