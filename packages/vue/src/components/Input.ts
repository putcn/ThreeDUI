import { computed, defineComponent, h, nextTick, onBeforeUnmount, ref, shallowRef, watch, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import { absoluteRect, type Node, type Rect, type Style, type Theme, type UIEvent } from '@glassui/core'
import type { ImeBridge, ImeField, ImeState, Surface } from '@glassui/render'
import type { TextRun } from '@glassui/text'
import { withAlpha } from '../colors'
import { controlStyle, useGlassControl } from '../control'
import { defineGlassComponent } from '../define'
import { ICON_ALIASES, ICON_NAMES, type IconName } from '../icons'
import { useMotion, useRoot, useScheme, useSurfaceRef, useTheme } from '../inject'
import { filterNumber, fitLength, mask, oneLine, parseNumber, scrollToShow, textOf, wordAt } from '../textedit'
import { Icon } from './Icon'

type Size = 'small' | 'regular' | 'large'
type Kind = ImeField['kind']
type Composition = NonNullable<ImeState['composition']>
type Selection = readonly [number, number]

/**
 * A size's height, font, side padding, icon and icon–field gap (pt). The large one is the reference's 84 pt field
 * (spec §8.2): the theme's control padding, icon and icon–text gap.
 */
function sizeOf(size: Size, theme: Theme): { height: number; font: number; padX: number; icon: number; gap: number } {
  const m = theme.metrics
  switch (size) {
    case 'small': return { height: 36, font: 15, padX: 14, icon: 18, gap: 8 }
    case 'regular': return { height: 52, font: 18, padX: 20, icon: 22, gap: 10 }
    case 'large': return { height: 84, font: 23, padX: m.controlPadding, icon: m.icon, gap: m.iconGap }
  }
}

/** The text's weight and line height (a multiple of its size): the reference field's 500 at 1.2. */
const WEIGHT = 500, LINE = 1.2
/** The field's basis, in its font size: about ten characters where nothing stretches it (a row). */
const FIELD_EM = 10
/** How far the scroll keeps the caret inside the field's edges, pt. */
const PAD = 2
/** The caret: 2 pt wide, 0.9 of the line high, blinking every 530 ms (with live motion). */
const CARET = { width: 2, height: 0.9, blinkMs: 530 } as const
/** The composition's underline, pt. */
const UNDERLINE = 1.5
/** The icons' stroke, of their size: the reference field's. */
const ICON_WEIGHT = 0.1
/** The press-free look of a control: the hover lift, tilt and glint (a field does not shrink under a press). */
const CONTROL = controlStyle()
/** The clear and eye buttons: fainter under the pointer. */
const BUTTON: Style = { flexShrink: 0, alignItems: 'center', justifyContent: 'center', transition: { opacity: 'snappy' }, hover: { opacity: 0.7 } }

/**
 * The field's parts take no pointer: a press anywhere on the field is the field's, so a part that appears under the
 * pointer (the caret the first click of a double click places) never takes the second click from it.
 */
const PART: Style = { position: 'absolute', pointerEvents: 'none' }

/** The caret: its own component, so its blink re-renders it alone. `stamp` changing shows it solid and restarts the blink. */
const Caret = defineComponent({
  name: 'InputCaret',
  props: { x: { type: Number, required: true }, top: { type: Number, required: true }, height: { type: Number, required: true }, stamp: { type: Number, required: true }, live: Boolean },
  setup(props) {
    const on = ref(true)
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => { clearInterval(timer); timer = undefined }
    watch(() => props.stamp, () => {
      stop(); on.value = true
      if (props.live) timer = setInterval(() => { on.value = !on.value }, CARET.blinkMs)
    }, { immediate: true })
    onBeforeUnmount(stop)
    return () => h('box', {
      part: 'caret',
      style: { ...PART, left: props.x, top: props.top, width: CARET.width, height: props.height, bg: 'accent', radius: 1, opacity: on.value ? 1 : 0 },
    })
  },
})

export const Input = defineGlassComponent({
  name: 'Input',
  description: '单行文本输入框（Liquid Glass 控件）：胶囊形清玻璃，里面是可编辑的文字，前面可放图标。用 v-model 双向绑定。打字、输入法（中文拼音等，组字时下划线标出、候选窗出现在光标下方）、复制粘贴、撤销都由页面里一个看不见的原生输入框代理，世界层（场景里的面板）上同样可用。type：text 文本（默认）；password 显示为圆点，右侧的眼睛图标切换明文；number 只接受数字（可带负号与一个小数点），v-model 得到 number，空或只有 "-" 时为 null。点击放置光标，拖动选择，双击选中一个词；文字超出时随光标横向滚动；粘贴的多行文字换行变成空格。Enter 发出 submit，Escape 退出编辑（这一按键照样向外层传递：在 Dialog 里按 Escape 直接关闭对话框）；Tab 在 Surface 的可聚焦控件间移动（键盘聚焦时全选并显示焦点环）。v-model 只在组字结束后更新（与 Vue 原生 input 的 v-model 一致）。clearable 在有内容时显示清除按钮；maxLength 限制长度（UTF-16 码元，同原生 maxlength）。size：small 高 36、regular 高 52、large 高 84（参考稿的输入框）。纵向容器里默认拉满宽度，横向容器里约十个字宽。鼠标、触控笔悬停时上浮、朝指针倾斜（最多 3°）、高光增强；按下不缩小。disabled 时变淡、不响应、不在 Tab 顺序里。没有 label：标签用它上方的 Text，提示用 placeholder。',
  props: z.object({
    modelValue: z.union([z.string(), z.number(), z.null()]).optional().describe('输入的值；用 v-model 双向绑定（受控：外部改变时输入框跟着变）。type="number" 时是 number 或 null'),
    placeholder: z.string().optional().describe('值为空（且没有在组字）时显示的提示文字，三级标签色'),
    type: z.enum(['text', 'password', 'number']).default('text').describe('类型：text 文本（默认）、password 密码（圆点显示，眼睛图标切换明文）、number 数字（v-model 为 number 或 null）'),
    clearable: z.boolean().default(false).describe('有内容时在右侧显示清除按钮，点击清空并保持编辑'),
    disabled: z.boolean().default(false).describe('禁用：变淡（不透明度 0.4），不响应指针和键盘，不在 Tab 顺序里'),
    size: z.enum(['small', 'regular', 'large']).default('regular').describe('尺寸：small 高 36、regular 高 52（默认）、large 高 84（参考稿的输入框）；字号、图标、留白随尺寸'),
    leadingIcon: z.enum(ICON_NAMES).optional().describe('文字前的内置图标（如 mail、lock、user、search）；给了 leading 插槽时由插槽代替'),
    maxLength: z.number().int().positive().optional().describe('最多多少个字符（UTF-16 码元，同原生 maxlength）：超出的粘贴被截断，继续输入无效'),
  }),
  events: {
    'update:modelValue': { payload: 'string（type="number" 时为 number | null）', description: '用户编辑后的新值（v-model 靠它更新）；组字过程中不发，组字结束时发' },
    submit: { payload: 'string（type="number" 时为 number | null）', description: '在输入框里按了 Enter：当前的值' },
    focus: { payload: '无', description: '开始编辑（点击或 Tab 聚焦）' },
    blur: { payload: '无', description: '结束编辑（焦点移走、Escape，或点击了页面别处）' },
  },
  slots: { leading: '代替 leadingIcon 的前置内容', trailing: '文字后、清除按钮与眼睛图标前的后置内容（如单位、按钮）' },
  examples: [
    '<Input v-model="email" size="large" leading-icon="mail" placeholder="Email address" @submit="next" />',
    '<Input v-model="password" type="password" size="large" leading-icon="lock" placeholder="Password" />',
    '<Stack :gap="8"><Text value="数量" size="sm" color="secondaryLabel" /><Input v-model="qty" type="number" clearable placeholder="0" :max-length="6" /></Stack>',
  ],
  mistakes: [
    { mistake: '<Input v-model:value="name" />', fix: '<Input v-model="name" />：输入框的值是 modelValue（默认的 v-model）' },
    { mistake: '<Input label="邮箱" v-model="email" />', fix: '没有 label：<Stack :gap="8"><Text value="邮箱" /><Input v-model="email" placeholder="name@example.com" /></Stack>，或只用 placeholder' },
    { mistake: '<Input type="email" />', fix: 'type 只有 text、password、number：邮箱用 type="text"（默认），在 @submit 或 v-model 变化时自己校验' },
    { mistake: '<Input v-model="q" @keyup.enter="search" />', fix: '@submit="search"：按键交给页面里的原生输入框，Enter 以 submit 发出（组字中按的 Enter 只确认候选，不提交）' },
    { mistake: '<Input v-model="age" type="number" />，然后 age.trim() / age === ""', fix: 'type="number" 时 v-model 是 number 或 null（空、只有 "-" 时为 null），不是字符串' },
  ],
  aliases: {
    type: { email: 'text', search: 'text', url: 'text', tel: 'text', string: 'text', pwd: 'password', secret: 'password', numeric: 'number', integer: 'number', int: 'number', decimal: 'number', float: 'number' },
    size: { sm: 'small', mini: 'small', md: 'regular', medium: 'regular', normal: 'regular', lg: 'large', big: 'large' },
    leadingIcon: ICON_ALIASES,
  },
}, (p, { slots, emit }) => {
  const root = useRoot(), surfaceRef = useSurfaceRef(), theme = useTheme(), scheme = useScheme(), live = useMotion() === 'live'
  const el = shallowRef<Node | null>(null), fieldEl = shallowRef<Node | null>(null)
  /** The props, null while they are invalid (the render throws that error; nothing here should throw it again). */
  const valid = computed(() => { try { return p.value } catch { return null } })
  const inert = computed(() => !valid.value || valid.value.disabled)
  const kind = computed((): Kind => valid.value?.type ?? 'text')
  const hover = useGlassControl(el, { disabled: inert, onActivate: () => {} }).handlers

  // ── the field's state: its text, the selection, the IME's composition range, the horizontal scroll ──
  /** A model value as the field shows it (one line, `maxLength`, a number's text): as an edit would leave it. */
  const fromModel = (m: unknown): string => textOf(m, kind.value, valid.value?.maxLength)
  const text = ref(fromModel(valid.value?.modelValue)), sel = shallowRef<Selection>([text.value.length, text.value.length])
  const comp = shallowRef<Composition | null>(null), scrollX = ref(0)
  /** Focused: the caret shows and the IME bridge has the field. */
  const editing = ref(false)
  /** A password shown in plain text (the eye). */
  const revealed = ref(false)
  /** Bumped on every edit and caret move: the caret shows solid and its blink starts over. */
  const stamp = ref(0)
  /** The root's IME bridge while editing (null where the page has none). */
  let bridge: ImeBridge | null = null
  /**
   * A blur that came with the Surface going (a `<Surface>` making its render Surface again, or unmounting) waits for
   * the update to end: the same node focused again in the next Surface meanwhile is no blur (the IME keeps the field
   * and its composition).
   */
  let leaving = false
  /**
   * The IME is composing: the last report carried a composition, shown or refused (a number field's letters). Holds the
   * text and selection from before it, what a refused commit goes back to; null outside a composition. The one flag a
   * press, a double click, the clear button and an outside change of the model go by.
   */
  let composing: { text: string; sel: Selection } | null = null
  /** The text the model stands for (as given, or as last emitted). */
  let modelText = text.value
  /** The model changed from outside while the IME composed: it is applied when the composition ends. */
  let outside = false
  /** A drag from a mouse or pen press on the field extends the selection from `anchor`. */
  let anchor = 0, dragging = false
  /** The touch press under way is the one focusing the Input: its click hands the proxy the page focus again. */
  let tapFocus = false
  /** The field width `follow` last kept the caret in. */
  let width = 0

  const type = computed(() => {
    const font = sizeOf(valid.value?.size ?? 'regular', theme.value).font
    return { font: { family: 'system-ui', size: font, weight: WEIGHT }, lineHeight: Math.round(LINE * font) }
  })
  /** What the text node shows (the placeholder aside): the value, or a password's bullets. */
  const shown = computed(() => kind.value === 'password' && !revealed.value ? mask(text.value) : text.value)
  /** The shown text as the text engine lays it out: the text node's own type (its style below). */
  const run = computed((): TextRun => ({ text: shown.value, font: type.value.font, lineHeight: type.value.lineHeight, letterSpacing: 0, wrap: false }))
  const xAt = (i: number): number => root.text.caretRect(run.value, undefined, i).x
  const caretX = computed(() => xAt(sel.value[1]))
  const selRects = computed(() => { const [a, b] = sel.value; return a < b ? root.text.selectionRects(run.value, undefined, a, b) : [] })

  /** Whether the model `m` stands for the text `t` (a number field's `1.` is the model 1). */
  const matches = (t: string, m: unknown): boolean => kind.value === 'number' ? parseNumber(t) === parseNumber(fromModel(m)) : t === fromModel(m)
  /** The text as the model's value. */
  const out = (t: string): string | number | null => kind.value === 'number' ? parseNumber(t) : t

  /** The bridge's proxy takes the field's state (outside a composition: the bridge leaves one alone). */
  const push = (): void => { if (editing.value) bridge?.sync(field) }

  /** Keeps the caret (or the composition's end, or `at`) in view; the text never ends short of the right edge. */
  function follow(at?: number): void {
    width = fieldEl.value?.layout.width ?? 0
    if (!editing.value || width <= 0) { scrollX.value = 0; return }
    const c = comp.value, x = xAt(at ?? (c ? c.end : sel.value[1])), end = xAt(shown.value.length)
    scrollX.value = Math.min(scrollToShow(scrollX.value, x, width, PAD), Math.max(0, end - width + PAD))
  }
  /**
   * The field's state; nothing when it is the same (the proxy reports a selection made here back, as `selectionchange`:
   * the scroll a drag set stays).
   */
  function set(value: string, s: Selection, c: Composition | null): void {
    const was = comp.value
    if (value === text.value && s[0] === sel.value[0] && s[1] === sel.value[1] && (c === was || (c && was && c.start === was.start && c.end === was.end))) return
    text.value = value; sel.value = s; comp.value = c; stamp.value++
    follow()
  }
  /** A selection made here (a press, a drag, a double click): the proxy takes it; `at` is the end to keep in view. */
  function select(a: number, b: number, at = b): void {
    sel.value = a <= b ? [a, b] : [b, a]; stamp.value++
    follow(at); push()
  }
  /** The text after an edit that is over (no composition): the model hears it, or an outside change made meanwhile wins. */
  function commit(): void {
    if (outside) { outside = false; set(modelText, [modelText.length, modelText.length], null); push(); return }
    if (text.value === modelText) return
    modelText = text.value
    emit('update:modelValue', out(text.value))
  }
  /** The proxy's state after an edit: one line, a number's characters and `maxLength` first; a refused edit goes back. */
  function apply(s: ImeState): void {
    if (s.composition && !composing) composing = { text: text.value, sel: sel.value }   // a composition starts
    const base = composing ?? { text: text.value, sel: sel.value }
    if (!s.composition) composing = null
    const v = valid.value
    let t: ImeState | null = oneLine(s)
    if (t && kind.value === 'number') {
      const n = filterNumber(text.value, t.value)
      t = n === null ? null : n === t.value ? t : { ...t, value: n }
    }
    // a native maxlength holds at the commit, not while the IME composes
    if (t && v?.maxLength !== undefined && !t.composition) t = fitLength(base.text, t, v.maxLength)
    // refused: back to the text before; at a composition's end an outside change made meanwhile is applied now
    if (!t) { set(base.text, base.sel, null); push(); if (!s.composition) commit(); return }
    set(t.value, [t.selectionStart, t.selectionEnd], t.composition)
    if (t !== s) push()
    if (!t.composition) commit()
  }

  const caretOut = { x: 0, y: 0, height: 0 }, rect: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** What the IME bridge edits: this field's state, its caret, its keys. */
  const field: ImeField = {
    // the current Surface (a <Surface> makes its render Surface again): null while it does, so the root's removal of
    // the old one does not take the field with it (no tick comes in between)
    get surface() { return surfaceRef.value as Surface },
    get value() { return text.value },
    get selectionStart() { return sel.value[0] },
    get selectionEnd() { return sel.value[1] },
    get kind() { return kind.value },
    // read every tick while editing (the proxy follows the caret on a moving Surface): no allocation, no text layout;
    // a field laid out at a new width since scrolls again
    caret() {
      const n = fieldEl.value
      if (n) { absoluteRect(n, rect); if (n.layout.width !== width) follow() }
      caretOut.x = rect.x + caretX.value - scrollX.value; caretOut.y = rect.y; caretOut.height = type.value.lineHeight
      return caretOut
    },
    onChange: apply,
    onKey(e) {
      if (e.key === 'Enter') { emit('submit', out(text.value)); return true }
      if (e.key === 'Escape') {
        // the keydown goes on up the tree from the field, as the canvas's keys go from the focused node (a Dialog
        // around it closes on it); then the field is left
        const s = surfaceRef.value, n = el.value
        if (s && n) s.events.dispatch(n, 'keydown', { key: 'Escape' })
        surfaceRef.value?.focus.focus(null)
        return true
      }
      return false
    },
    onBlur() { const s = surfaceRef.value, n = el.value; if (s && n && s.focus.current === n) s.focus.focus(null) },
  }

  /** Editing ends: the bridge lets the field go (a cut composition is reported first), the scroll goes back to the start. */
  function stop(): void {
    editing.value = false; dragging = false
    const b = bridge; bridge = null
    b?.blur(field)
    composing = null; outside = false; comp.value = null
    follow()
  }
  /** A blur that waited for the update: unless focused again meanwhile, editing ends. */
  const settleBlur = (): void => {
    if (!leaving) return
    leaving = false
    stop()
    emit('blur')
  }

  // an outside change of the model: the field takes it (the caret at its end), or after the running composition
  watch(() => valid.value?.modelValue, m => {
    if (matches(modelText, m)) return   // what was emitted, coming back
    modelText = fromModel(m)
    if (composing) { outside = true; return }
    set(modelText, [modelText.length, modelText.length], null); push()
  })
  // a new kind needs the other proxy element (a password's); the bridge swaps it
  watch(kind, () => { if (editing.value) bridge?.focus(field) })
  // disabled while focused: the focus goes
  watch(inert, off => {
    if (!off) return
    dragging = false
    const s = surfaceRef.value, n = el.value
    if (s && n && s.focus.current === n) s.focus.focus(null)
  })
  onBeforeUnmount(() => { leaving = false; if (editing.value) stop() })

  /** The caret index under (`lx`, `ly`), field-local pt. */
  const indexAt = (lx: number, ly: number): number => root.text.caretFromPoint(run.value, undefined, lx + scrollX.value, ly)
  const host = {
    onFocus() {
      if (leaving) { leaving = false; bridge?.focus(field); return }   // blurred and focused again in one update: still editing
      if (el.value?.state.focusVisible) sel.value = [0, text.value.length]   // from the keyboard: all of it, as a native field
      editing.value = true; stamp.value++
      follow()
      bridge = root.ime
      bridge?.focus(field)
      emit('focus')
    },
    onBlur() {
      if (!editing.value || leaving) return
      if (!surfaceRef.value) { leaving = true; void nextTick(settleBlur); return }   // the Surface is going: see `leaving`
      stop()
      emit('blur')
    },
    // a touch's pointerdown is no user activation: the focus it brings opens no soft keyboard (iOS, Android). The tap's
    // click (its pointerup, which is one) gives the proxy the page focus again; it already has it, so blur it first
    onPointerdown(e: UIEvent) { tapFocus = e.pointerType === 'touch' && !editing.value },
    onClick(e: UIEvent) {
      const tap = tapFocus && e.pointerType === 'touch'
      tapFocus = false
      if (tap && editing.value && !composing && bridge) { bridge.blur(field); bridge.focus(field) }
    },
    onPointerenter: hover.onPointerenter,
    onPointerleave: hover.onPointerleave,
    // over the whole host, so a drag carries on past the field's ends (the field's local x from the Surface's)
    onPointermove(e: UIEvent) {
      hover.onPointermove?.(e)
      const n = fieldEl.value
      if (!dragging || inert.value || !n?.state.pressed) return
      absoluteRect(n, rect)
      const i = indexAt(e.x - rect.x, e.y - rect.y)
      const a = Math.min(anchor, i), b = Math.max(anchor, i)
      if (a !== sel.value[0] || b !== sel.value[1]) select(anchor, i, i)
    },
  }
  const onField = {
    onPointerdown(e: UIEvent) {
      if (inert.value || composing) return   // mid-composition a press leaves the IME's text alone
      const i = indexAt(e.localX, e.localY)
      anchor = i; dragging = e.pointerType !== 'touch'   // a finger places the caret; it does not drag-select
      select(i, i)
    },
    onDblclick(e: UIEvent) {
      if (inert.value || composing) return
      if (kind.value === 'password' && !revealed.value) { select(0, text.value.length); return }   // no words in bullets
      // the character under the pointer (the caret index is the nearest boundary)
      const i = indexAt(e.localX, e.localY), at = i > 0 && xAt(i) > e.localX + scrollX.value ? i - 1 : i
      const [a, b] = wordAt(text.value, at)
      select(a, b)
    },
  }
  // mid-composition the proxy keeps the IME's text (it refuses a sync): the click is ignored, as a press on the field is
  const clear = (): void => { if (composing) return; set('', [0, 0], null); push(); commit() }
  const toggleEye = (): void => { revealed.value = !revealed.value; follow() }

  return () => {
    const v = p.value, t = theme.value, size = sizeOf(v.size, t), lh = type.value.lineHeight
    const sx = scrollX.value, [a, b] = sel.value, c = comp.value, on = editing.value
    const empty = text.value === '' && !c
    const style: Style = {
      height: size.height, flexDirection: 'row', alignItems: 'center', flexShrink: 0, paddingX: size.padX, gap: size.gap, radius: 'capsule',
      transition: CONTROL.transition,
      // a disabled Input shows no hover
      ...(inert.value ? {} : { hover: CONTROL.hover }),
      disabled: { opacity: 0.4 },
    }
    const icon = (name: IconName): VNode => h(Icon, { name, size: size.icon, color: 'tertiaryLabel', weight: ICON_WEIGHT })
    // the field's parts, keyed: a selection appearing never remounts the text
    const parts: VNode[] = []
    if (on && a < b) {
      const bg = withAlpha('accent', 0.25, t, scheme.value)
      selRects.value.forEach((r, i) => parts.push(h('box', { key: `selection${i}`, part: 'selection', style: { ...PART, left: r.x - sx, top: r.y, width: r.width, height: r.height, bg } })))
    }
    parts.push(h('text', {
      key: 'text', part: 'text', value: empty ? v.placeholder ?? '' : shown.value,
      // `0 - sx`: no −0 at the start
      style: { ...PART, left: 0 - sx, top: 0, fontSize: size.font, fontWeight: WEIGHT, lineHeight: LINE, wrap: false, maxLines: 1, color: empty ? 'tertiaryLabel' : 'label' },
    }))
    if (c) {
      const x0 = xAt(c.start), x1 = xAt(c.end)
      parts.push(h('box', { key: 'composition', part: 'composition', style: { ...PART, left: x0 - sx, top: lh - UNDERLINE, width: x1 - x0, height: UNDERLINE, bg: 'label' } }))
    }
    if (on && a === b) parts.push(h(Caret, { key: 'caret', x: caretX.value - sx, top: (lh - CARET.height * lh) / 2, height: CARET.height * lh, stamp: stamp.value, live }))
    const dot = Math.round(size.icon * 0.82)
    // `textField`: what a Dialog that focuses it on open reads (a text field shows its ring however focus came, as CSS
    // `:focus-visible` does)
    return h('glass', { ref: el, style, tabIndex: v.disabled ? -1 : 0, disabled: v.disabled, textField: true, ...host }, [
      slots.leading ? slots.leading() : v.leadingIcon ? icon(v.leadingIcon) : null,
      // a row: an absolute child of a column is held to its width, and the text must keep its own to scroll
      h('box', {
        ref: fieldEl, part: 'field', ...onField,
        style: { flexDirection: 'row', flexGrow: 1, flexShrink: 1, flexBasis: FIELD_EM * size.font, height: lh, overflow: 'hidden' },
      }, parts),
      slots.trailing ? slots.trailing() : null,
      v.clearable && text.value !== '' && !v.disabled
        ? h('box', { part: 'clear', style: { ...BUTTON, width: dot, height: dot, radius: 'capsule', bg: 'tertiaryLabel' }, onClick: clear }, [
          h(Icon, { name: 'x', size: Math.round(dot * 0.6), color: 'fill', weight: 0.16 }),
        ])
        : null,
      v.type === 'password' ? h('box', { part: 'eye', style: BUTTON, onClick: toggleEye }, [icon(revealed.value ? 'eye-slash' : 'eye')]) : null,
    ])
  }
})
