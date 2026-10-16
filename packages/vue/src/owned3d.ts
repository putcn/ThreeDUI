import { onBeforeUnmount, watch, type Ref } from '@vue/runtime-core'
import type { Node } from '@glassui/core'
import type { Surface } from '@glassui/render'
import { useSurfaceRef } from './inject'
import { isHeld } from './renderer'

/**
 * The lifetime of a 3D object a component makes and owns (a chart from `root.createBarChart()`, …): `object.dispose()`
 * runs once, when the component unmounts. `box` holds the component's own root node, read at unmount: while it is held
 * (it is in a leaving Block, whose content flies out attached, spatial spec §2.6), the object is still drawn, so its
 * dispose waits for the Surface it was on to be disposed (its `'dispose'` event). Otherwise (unheld, never laid out on a
 * Surface, or with no node) it is disposed at once. Call it in `setup`.
 */
export function useOwned3D(object: { dispose(): void }, box: Readonly<Ref<Node | null>>): void {
  const surface = useSurfaceRef()
  /** The last Surface the component was on (a leaving Block's Surface is gone from the injection by unmount). */
  let home: Surface | null = null
  watch(surface, s => { if (s) home = s }, { immediate: true })
  onBeforeUnmount(() => {
    const n = box.value, s = home
    if (n && s && isHeld(n)) s.addEventListener('dispose', () => { object.dispose() })
    else object.dispose()
  })
}
