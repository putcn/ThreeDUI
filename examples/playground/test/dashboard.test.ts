import { it, expect, vi } from 'vitest'
import { h } from 'vue'
import type { Node } from '@glassui/core'
import { mountInSurface } from '../../../packages/vue/test/fixtures/mount'
import { fire } from '../../../packages/vue/test/fixtures/events'
import Dashboard from '../src/wms/Dashboard.vue'
import Inbound from '../src/wms/Inbound.vue'

function find(root: Node, id: string): Node {
  let result: Node | undefined
  root.walk(node => { if (node.id === id) result = node })
  if (!result) throw new Error(`missing ${id}`)
  return result
}

it('Dashboard breadcrumb returns to overview with a null focus', () => {
  const navigate = vi.fn()
  const m = mountInSurface(() => h(Dashboard, { onNavigate: navigate }), { motion: 'frozen' })
  fire(find(m.c, 'crumb-overview-dashboard'), 'click')
  expect(navigate).toHaveBeenCalledWith(null)
  expect(m.errors).toEqual([])
  m.app.unmount()
})

it('inbound quantity fields are numeric inputs', () => {
  const m = mountInSurface(() => h(Inbound), { motion: 'frozen' })
  const quantity = find(m.c, 'inbound-qty-0')
  m.surface.focus.focus(quantity); expect(m.root.ime.active?.kind).toBe('number')
  m.surface.focus.focus(find(m.c, 'inbound-qty-1')); expect(m.root.ime.active?.kind).toBe('number')
  m.surface.focus.focus(find(m.c, 'inbound-qty-2')); expect(m.root.ime.active?.kind).toBe('number')
  expect(m.errors).toEqual([])
  m.app.unmount()
})
