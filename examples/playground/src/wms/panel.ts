import { computed, onMounted, type ComputedRef } from 'vue'
import { useMotion, useRoot, useScheme, useSurfaceRef } from '@glassui/vue'

/** World units an info panel starts behind its place, toward what it is about. */
export const PANEL_FROM = 0.3

/**
 * What the info panels share (BinPanel, LocationPanel: the content of a glass Surface floating in front of the twin
 * or the map): `veil`, the theme's fill at 62 % (#rrggbb + alpha; a fill written otherwise is used as it is), the
 * panel's text sits on it inset 8 pt so it reads over what is behind while the glass rim round it still bends it; and
 * the entrance: on mount the Surface flies in from `PANEL_FROM` behind its place (toward the Block), faded out and
 * slightly small, to its place (at once under frozen motion). Call it in the panel's `setup`.
 */
export function useInfoPanel(): { veil: ComputedRef<string> } {
  const root = useRoot(), scheme = useScheme()
  const veil = computed(() => { const fill = root.theme.colors[scheme.value].fill ?? '#ffffff'; return /^#[0-9a-f]{6}$/i.test(fill) ? `${fill}9e` : fill })
  const surface = useSurfaceRef(), frozen = useMotion() === 'frozen'
  onMounted(() => {
    const s = surface.value
    if (!s) return
    const { x, y, z } = s.position, a = s.rotation.y
    s.position.set(x - PANEL_FROM * Math.sin(a), y, z - PANEL_FROM * Math.cos(a))
    s.opacity = 0; s.scale.setScalar(0.94)
    void s.animateTo({ position: [x, y, z], scale: 1, opacity: 1 }, { spring: { response: 0.4, dampingFraction: 0.9 }, immediate: frozen })
  })
  return { veil }
}
