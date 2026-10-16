import { computed, h, markRaw, onBeforeUnmount, provide, shallowRef, Teleport, watch, type VNodeChild } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, Style, UIEvent } from '@glassui/core'
import type { Surface } from '@glassui/render'
import { defineGlassComponent, fallthrough } from '../define'
import { useMotion, useRoot } from '../inject'
import { GLASS_SURFACE } from '../keys'
import { useSpring } from '../spring'
import { Stack } from './Stack'
import { Text } from './Text'

/** The panel's corner radius, pt (spec §8.3: panels have a fixed radius). */
const RADIUS = 32
/** The panel's height until its content has been measured, pt. */
const PROVISIONAL = 200
/** The scale the panel springs in from and leaves to (spec §8.3: appear and disappear with scale 0.9 → 1). */
const FROM = 0.9
/** A content height this close to the panel's (pt) leaves its size alone. */
const SLACK = 0.5
/**
 * The content column: padding 28, gap 20. It keeps its content's height (the panel is sized from it) rather than
 * shrinking to the panel's provisional one, and carries the panel's radius, so `concentric` children resolve against it.
 */
const COLUMN: Style = { flexDirection: 'column', padding: 28, gap: 20, flexShrink: 0, radius: RADIUS }
/** The backdrop's root box: the scheme's scrim, its opacity springing as it fades. */
const SCRIM: Style = { bg: 'scrim', opacity: 1, transition: { opacity: 'smooth' } }

const DialogProps = z.object({
  open: z.boolean().default(false).describe('是否打开（v-model:open）：true 时显示；用户按 Escape 或点背景时发出 update:open（false），由 v-model 关闭'),
  title: z.string().optional().describe('标题，22 pt 粗体，在内容上方；省略时没有标题'),
  width: z.number().positive().default(480).describe('面板宽，pt（默认 480）；高度随内容'),
  closeOnBackdrop: z.boolean().default(true).describe('点面板外的暗化背景时关闭（默认 true）'),
  closeOnEscape: z.boolean().default(true).describe('按 Escape 时关闭（默认 true）'),
})
type Props = z.output<typeof DialogProps>
const DEFAULTS: Props = DialogProps.parse({})

/** The two screen Surfaces an open Dialog owns. */
interface Pair { backdrop: Surface; panel: Surface }

export const Dialog = defineGlassComponent({
  name: 'Dialog',
  description: '模态对话框：打开时整个屏幕铺上一层暗化背景，中间浮起一块玻璃面板（圆角 32，宽 width，默认 480，高度随内容），面板从 0.9 弹到原大小并淡入，背景同时淡入；关闭时反向退场，结束后移除。用 v-model:open 控制（受控：Dialog 自己不改 open）：用户按 Escape 或点击背景时发出 update:open（false）和 close（closeOnEscape / closeOnBackdrop 可关掉），父组件把 open 改成 false 时只关闭、不发 close。面板里是一列（padding 28、间距 20）：title（22 pt 粗体）、默认插槽、footer 插槽（右对齐的一行，间距 12，放按钮；footer 的按钮不会自动关闭对话框）。打开时键盘只在面板里（Tab 在面板内循环），第一个可聚焦的控件（如 Input）获得焦点；关闭时键盘和焦点回到打开前的 Surface 与控件（在 Space 里就是焦点 Block）。Dialog 在它所在的位置不占空间，可以写在任何组件里；tw / class / style / id 落到面板里的内容列上。motion 为 frozen 或减少动态效果时直接出现、直接消失。屏幕层的 Surface 按创建顺序叠放：对话框打开期间新建的 Surface 会叠在它上方。面板高度随内容、不滚动：内容高过屏幕时超出部分看不到，长内容放进对话框里一个固定高度的 <scroll>。',
  props: DialogProps,
  events: {
    'update:open': { payload: 'false', description: '用户要求关闭（按 Escape 或点击背景）：v-model:open 据此关闭' },
    close: { payload: '无', description: '用户关闭了对话框（按 Escape 或点击背景）；父组件把 open 改为 false 时不发' },
  },
  slots: { default: '内容（标题下方，纵向排列，间距 20）', footer: '底部按钮行（右对齐，间距 12）：通常是取消与确认 Button' },
  examples: [
    '<Dialog v-model:open="confirming" title="删除项目？"><Text value="此操作不可撤销。" color="secondaryLabel" /><template #footer><Button label="取消" @press="confirming = false" /><Button variant="filled" label="删除" @press="remove" /></template></Dialog>',
    '<Dialog v-model:open="renaming" title="重命名" :width="420"><Input v-model="name" placeholder="新名称" @submit="rename" /><template #footer><Button label="取消" @press="renaming = false" /><Button variant="glassProminent" label="保存" @press="rename" /></template></Dialog>',
    '<Dialog v-model:open="syncing" title="正在同步" :close-on-backdrop="false" :close-on-escape="false"><Text value="请稍候，完成后自动关闭。" color="secondaryLabel" /></Dialog>',
  ],
  mistakes: [
    { mistake: '<Dialog :open="show">（只绑定 open，不处理 update:open）', fix: 'Dialog 是受控的：<Dialog v-model:open="show">；只写 :open 时按 Escape 或点背景只发出事件，对话框不会关' },
    { mistake: '<Dialog v-model="show">', fix: '<Dialog v-model:open="show">：开关是 open 属性，不是 modelValue' },
    { mistake: '<template #footer><Button label="取消" /></template>（以为 footer 的按钮会自动关闭）', fix: '<Button label="取消" @press="show = false" />：按钮自己把 open 改为 false' },
    { mistake: '<Dialog v-if="show" v-model:open="show">', fix: '去掉 v-if，只用 v-model:open：v-if 卸载时面板立即消失，没有退场动画' },
    { mistake: '对话框打开期间再新建屏幕层 Surface（如此时才出现的 <Surface layer="screen">，或改了它 fill / center 等创建时固定的属性）', fix: '屏幕层的 Surface 按创建顺序叠放，打开期间新建的会叠在对话框上方：要放在对话框里的内容写进 Dialog 的插槽，其余的 Surface 在打开对话框之前就创建好' },
    { mistake: '<Dialog title="选择城市"><Stack><Text v-for="c in 300个城市" … /></Stack></Dialog>（内容高过屏幕）', fix: '面板高度随内容、不滚动，超出屏幕的部分看不到：保持对话框简短；长列表放进固定高度的 <scroll :style="{ height: 360 }">' },
  ],
}, (p, { slots, attrs, emit }) => {
  const root = useRoot(), frozen = useMotion() === 'frozen'
  /** The last valid props (the render reports invalid ones): while they are invalid the Dialog stays as it was. */
  const v = computed<Props>(prev => { try { return p.value } catch { return prev ?? DEFAULTS } })

  /** The backdrop and the panel: made on open, kept through the leave, removed when it ends (or on unmount). */
  const pair = shallowRef<Pair | null>(null)
  /**
   * The Surface the content renders into, as `useSurface` / `useSurfaceRef` see it there: the panel while the Dialog is
   * open; null from the moment it closes (the content stays on the panel through the leave, but the keys are gone).
   */
  const surface = shallowRef<Surface | null>(null)
  provide(GLASS_SURFACE, surface)
  /** The content column, measured after every tick. */
  const column = shallowRef<Node | null>(null)
  /** The panel has been sized from its content: it shows from then on. */
  let measured = false
  /** Bumped by every open and close: a leave that ends after a newer open (or the unmount) leaves the Surfaces alone. */
  let token = 0
  /** Who held the keys before the Dialog took them: the Surface, its focused node and that node's ring. */
  let before: { surface: Surface | null; node: Node | null; visible: boolean } | null = null
  /** The last open came from the keyboard: the opener showed its focus ring. */
  let fromKeys = false
  let gone = false

  /** The panel at the spring's value: scale 0 and invisible until measured; then scaled, fading in from FROM to 1. */
  const show = (x: number): void => {
    const panel = pair.value?.panel
    if (!panel) return
    panel.scale.setScalar(measured ? x : 0)
    panel.opacity = measured ? Math.min(1, Math.max(0, (x - FROM) / (1 - FROM))) : 0
  }
  const pop = useSpring(FROM, { spring: 'snappy', onStep: show })

  // after every tick while there are Surfaces: the panel takes its content's height (and the width prop); the first
  // measure shows it and, while open, springs it in
  let armed = false
  const measure = (): void => {
    armed = false
    const ps = pair.value, n = column.value
    if (gone || !ps || ps.panel.disposed) return
    if (n && n.layout.height > 0) {
      const width = v.value.width, height = n.layout.height, m = ps.panel.model
      if (m.width !== width || Math.abs(m.height - height) > SLACK) ps.panel.setSize(width, height)
      if (!measured) { measured = true; show(pop.value); if (surface.value) void pop.to(1) }
    }
    arm()
  }
  const arm = (): void => { if (!armed) { armed = true; void root.afterTick().then(measure) } }

  const dismiss = (): void => { emit('update:open', false); emit('close') }
  /**
   * Escape reaching the panel's root (from the focused node, or the root itself when none is), or the backdrop's (it
   * holds the keys while a press on it is held).
   */
  const onKey = (e: UIEvent): void => { if (e.key === 'Escape' && v.value.closeOnEscape && surface.value) dismiss() }
  const onBackdropClick = (): void => { if (v.value.closeOnBackdrop && surface.value) dismiss() }
  /**
   * A press on the backdrop gave it the keys (the pointer bridge hands them to the Surface pressed, blurring the panel):
   * they go back to the panel, and with `refocus` so does the node that this press blurred there, its ring as it was
   * (`PointerBridge.blurred`, read before the switch back records its own). Nothing comes back when nothing was focused
   * in the panel as the press began. The up of a press that closes (`closeOnBackdrop`: its click follows) gives the keys
   * back only.
   */
  const keysToPanel = (refocus: boolean): void => {
    const ps = pair.value, pointer = root.pointer
    if (!ps || !surface.value || pointer?.active !== ps.backdrop) return
    const blurred = pointer.blurred
    pointer.setActive(ps.panel)
    if (refocus && blurred?.surface === ps.panel && !ps.panel.focus.current) ps.panel.focus.focus(blurred.node, { visible: blurred.visible })
  }

  /** Gives the keys back to the Surface that held them before, with its focused node and ring, unless they went elsewhere meanwhile. */
  function giveBack(ps: Pair): void {
    const b = before, pointer = root.pointer
    before = null
    if (!pointer || (pointer.active !== ps.panel && pointer.active !== ps.backdrop)) return
    const to = b?.surface && root.surfaces.includes(b.surface) && !b.surface.error ? b.surface : null
    pointer.setActive(to)
    if (to && b?.node) to.focus.focus(b.node, { visible: b.visible })
  }
  /**
   * Opens: makes the two Surfaces (or turns a leaving pair back), takes the keys (trapped in the panel), and once the
   * content is in, focuses its first focusable (the post watcher below).
   */
  function enter(): void {
    token++
    let ps = pair.value
    if (!ps) {
      // neither casts into the UI's shadow map: a Surface's content quad would cast its whole rectangle there (a
      // viewport-sized shadow over the scene, from the backdrop's first frame on)
      const backdrop = markRaw(root.createSurface({ layer: 'screen', fill: true, background: 'none', width: 1, height: 1, castShadows: false }))
      const panel = markRaw(root.createSurface({ layer: 'screen', center: true, background: 'glass', cornerRadius: RADIUS, width: v.value.width, height: PROVISIONAL, castShadows: false }))
      pair.value = ps = { backdrop, panel }
      measured = false
      pop.jump(FROM)                                          // hidden (scale 0) until measured
      panel.trapFocus = true
      panel.root.setHandler('keydown', onKey)
      backdrop.root.setStyle(SCRIM)
      if (!frozen) root.anim.seed(backdrop.root, { opacity: 0 })   // fades in from 0
      backdrop.root.setHandler('keydown', onKey)
      backdrop.root.setHandler('click', onBackdropClick)
      backdrop.root.setHandler('pointerup', () => { keysToPanel(!v.value.closeOnBackdrop) })
      backdrop.root.setHandler('pointercancel', () => { keysToPanel(true) })
    } else {
      ps.backdrop.interactive = true; ps.panel.interactive = true
      ps.backdrop.root.setStyle({ opacity: 1 })
      if (measured) void pop.to(1)
    }
    const active = root.pointer?.active ?? null
    if (active !== ps.panel && active !== ps.backdrop) {
      const node = active?.focus.current ?? null
      before = { surface: active, node, visible: node?.state.focusVisible ?? false }
    }
    fromKeys = before?.visible ?? false
    root.pointer?.setActive(ps.panel)
    surface.value = ps.panel
    arm()
  }
  /**
   * Lets go of the panel: the content stops seeing it first (a blur listener that refocuses through `useSurfaceRef`
   * finds no Surface, rather than landing back in the panel: two focused nodes), then its press and focus go (an Input
   * there lets the IME go), then the keys go back.
   */
  function release(ps: Pair): void {
    surface.value = null
    ps.panel.pointer.cancel(); ps.backdrop.pointer.cancel()
    ps.panel.focus.focus(null)
    giveBack(ps)
  }
  /** Both Surfaces go; the content unmounts after them (the next render has no Teleport), as a `<Surface>`'s does. */
  function drop(ps: Pair): void {
    if (pair.value === ps) pair.value = null
    measured = false
    root.removeSurface(ps.backdrop); root.removeSurface(ps.panel)
  }
  /** Closes: lets go of the panel, then the leave (the reverse of the enter) plays and both Surfaces go. */
  function leave(): void {
    const ps = pair.value
    if (!ps || !surface.value) return
    const t = ++token
    release(ps)
    if (frozen || ps.panel.disposed || ps.backdrop.disposed) { drop(ps); return }
    ps.backdrop.interactive = false; ps.panel.interactive = false
    ps.backdrop.root.setStyle({ opacity: 0 })
    const shrink = measured ? pop.to(FROM) : Promise.resolve(true)   // never shown: nothing to shrink
    void Promise.all([shrink, root.anim.whenSettled(ps.backdrop.root)]).then(() => { if (t === token) drop(ps) })
  }

  // once the render has put the content in the panel, its first focusable takes the focus. Its ring shows as CSS
  // `:focus-visible` would: after an open from the keyboard (the opener showed its ring), and always on a text field
  // (an Input's host is marked `textField`); a Button after a click shows none
  watch(surface, s => {
    const first = s?.focus.focusables()[0]
    if (s && first) s.focus.focus(first, { visible: fromKeys || first.props.textField === true })
  }, { flush: 'post' })
  watch(() => v.value.open, open => { if (open) enter(); else leave() }, { immediate: true })
  // unmounted (open, or mid-leave): both Surfaces go at once, before the content unmounts (its blur listeners still run)
  onBeforeUnmount(() => {
    gone = true; token++
    const ps = pair.value
    if (!ps) return
    if (surface.value) release(ps)
    drop(ps)
  })

  return () => {
    const x = p.value
    const ps = pair.value
    if (!ps) return null
    const children: VNodeChild[] = [
      x.title ? h(Text, { value: x.title, size: 22, weight: 700 }) : null,
      slots.default?.(),
      slots.footer ? h(Stack, { direction: 'horizontal', gap: 12, justify: 'end' }, slots.footer) : null,
    ]
    // the attrs go onto the column (a Teleport root has nowhere to put them)
    return h(Teleport, { to: ps.panel.root }, [fallthrough(h('box', { ref: column, style: COLUMN }, children), attrs)])
  }
})
