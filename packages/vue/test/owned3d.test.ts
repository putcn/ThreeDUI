import { it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from '@vue/runtime-core'
import type { Node } from '@glassui/core'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { useOwned3D } from '../src/owned3d'
import { createFakeRoot, flush } from './fixtures/fake-root'
import { mountGlass } from './fixtures/mount'

/** A component owning `object` through `useOwned3D`, its root box the one the composable reads. */
const owner = (object: { dispose(): void }) => defineComponent(() => {
  const box = shallowRef<Node | null>(null)
  useOwned3D(object, box)
  return () => h('box', { ref: box, style: { height: 40 } })
})

it('useOwned3D: unmounted from a staying Block, the object is disposed at once, once', async () => {
  const root = createFakeRoot(), object = { dispose: vi.fn() }, Owner = owner(object), show = ref(true)
  mountGlass(() => h(Space, { camera: false }, () => [h(Block, { name: 'a', width: 488, height: 488 }, () => [show.value ? h(Owner) : null])]), { root })
  await flush(); root.tick()
  expect(object.dispose).not.toHaveBeenCalled()
  show.value = false; await nextTick()
  expect(object.dispose).toHaveBeenCalledTimes(1)
  root.tick(); await flush(); expect(object.dispose).toHaveBeenCalledTimes(1)
  expect(root.surfacesMade[0]!.listenerCount('dispose')).toBe(0)                          // nothing left waiting on the Surface
})
it('useOwned3D: in a leaving Block (its content held) the dispose waits for the Surface\'s own dispose', async () => {
  const root = createFakeRoot(), object = { dispose: vi.fn() }, Owner = owner(object), show = ref(true)
  mountGlass(() => h(Space, { camera: false }, () => [show.value ? h(Block, { name: 'a', width: 488, height: 488 }, () => [h(Owner)]) : null]), { root })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!
  show.value = false; await nextTick()
  expect(object.dispose).not.toHaveBeenCalled(); expect(s.disposed).toBe(false)
  root.tick(); await flush()                                                              // the leave animation ends: the Surface goes
  expect(s.disposed).toBe(true); expect(object.dispose).toHaveBeenCalledTimes(1)
})
it('useOwned3D: never on a Surface, it is disposed at unmount', async () => {
  const object = { dispose: vi.fn() }, Owner = owner(object), show = ref(true)
  mountGlass(() => (show.value ? h(Owner) : null)); await flush()
  show.value = false; await nextTick()
  expect(object.dispose).toHaveBeenCalledTimes(1)
})
