import type { InjectionKey, Ref } from '@vue/runtime-core'
import type { Surface } from '@glassui/render'
import type { ArcSlot } from './arc'

/** What a Block registers with its Space. */
export interface BlockHandle {
  /** Its render Surface (null until made, and once it has left). */
  surface: Readonly<Ref<Surface | null>>
  /** Its width in world units: what its arc slot is sized by. */
  width: Readonly<Ref<number>>
  /** Whether it stands on the arc: false for a Block given its own `position`, which takes no slot. */
  arc: Readonly<Ref<boolean>>
}

/** What a `<Space>` provides to its Blocks. */
export interface SpaceContext {
  /**
   * Registers a Block under `name` and returns its unregister. Throws on a name already registered. The name keeps its
   * slot after unregistering (with its last width), so a Block that comes back returns to it and no other Block moves.
   */
  register(name: string, block: BlockHandle): () => void
  /** The arc slot of `name` (reactive); null for a name that is not on the arc. */
  slot(name: string): ArcSlot | null
  /** The focused Block's name; null while there is none. */
  focused: Readonly<Ref<string | null>>
  /** Asks to focus the Block `name` (a press on an unfocused Block): `update:focus`, and the focus itself unless bound. */
  requestFocus(name: string): void
}

export const SPACE: InjectionKey<SpaceContext> = Symbol('glassui.space')
