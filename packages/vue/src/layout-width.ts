import { onMounted, onScopeDispose, shallowRef, type Ref } from '@vue/runtime-core'
import type { Node } from '@glassui/core'
import type { GlassRoot } from './root'

/**
 * The laid-out width (pt) of the node `box` holds, for a component that draws to its box's width (a chart). It is read
 * at the end of every root tick from the calling component's mount until its scope ends, and written only when it
 * changes. A resize of the box alone (its Surface resized, a flex sibling grown, a parent restyled) therefore reaches
 * the component, which re-renders once; an unchanged width costs no render. It is 0 until the first tick after mount,
 * and while `box` holds no node.
 *
 * The loop also ends once the root has no Surfaces. A disposed root has none, and its `afterTick` resolves at once,
 * so re-arming there would spin forever; with no Surface there is also nothing laid out to read.
 */
export function useLaidOutWidth(root: GlassRoot, box: Readonly<Ref<Node | null>>): Readonly<Ref<number>> {
  const width = shallowRef(0)
  let live = false
  const arm = (): void => {
    void root.afterTick().then(() => {
      if (!live) return
      const w = box.value?.layout.width ?? 0
      if (w !== width.value) width.value = w
      if (root.surfaces.length > 0) arm()
    })
  }
  onMounted(() => { live = true; arm() })
  onScopeDispose(() => { live = false })
  return width
}
