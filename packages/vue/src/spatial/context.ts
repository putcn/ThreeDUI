import type { InjectionKey, Ref } from '@vue/runtime-core'
import type { Surface } from '@glassui/render'
import type { ArcSlot } from './arc'

export interface BlockHandle {
  surface: Readonly<Ref<Surface | null>>
  width: Readonly<Ref<number>>
  height: Readonly<Ref<number>>
  arc: Readonly<Ref<boolean>>
}
export interface SpaceContext {
  register(name: string, block: BlockHandle): () => void
  slot(name: string): ArcSlot | null
  focused: Readonly<Ref<string | null>>
  mode: Readonly<Ref<'overview' | 'focus'>>
  highlighted: Readonly<Ref<string | null>>
  standby: Readonly<Ref<boolean>>
  highlight(name: string | null, by: 'pointer' | 'keys'): void
  row(name: string): number
  requestFocus(name: string | null): void
}
export const SPACE: InjectionKey<SpaceContext> = Symbol('glassui.space')
export const RECEDE = { position: [0, 0, -0.4], scale: 0.96 } as const
export const LIFT = { position: [0, 0, 0.25] } as const
export interface BlockContext {
  focused: Readonly<Ref<boolean>>
  nextCard(): number
}
export const BLOCK: InjectionKey<BlockContext> = Symbol('glassui.block')
