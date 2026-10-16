import { GlassUIError } from '@glassui/core'
import type { Surface } from './surface/surface'
import type { UIRoot } from './root'

/** What an editable node hands the bridge (the Input component implements it). */
export interface ImeField {
  surface: Surface
  value: string
  selectionStart: number
  selectionEnd: number
  /** 'text' | 'password' | 'number': the proxy's `type`/`inputMode` (number → inputmode="decimal"). */
  kind: 'text' | 'password' | 'number'
  /** The caret's rect in Surface pt (x, y = top, height): where the proxy and the IME candidate window go. */
  caret(): { x: number; y: number; height: number }
  /** The proxy's state after every edit, selection move or composition step. */
  onChange(s: ImeState): void
  /** Keys the field handles itself: Enter (submit), Escape (blur). `handled` → the bridge prevents the default. */
  onKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean
  /**
   * The proxy lost the page focus to something outside the canvas UI (another page element, or a programmatic blur). A
   * window or tab switch is not leaving: the page keeps the proxy focused, as it keeps a native input.
   */
  onBlur(): void
}
/** The proxy's value and selection; `composition`: the range the IME is composing (underlined), null outside one. */
export interface ImeState { value: string; selectionStart: number; selectionEnd: number; composition: { start: number; end: number } | null }

/** The parts of `document` the bridge uses (tests pass a fake). */
export interface DocLike {
  createElement(tag: 'textarea' | 'input'): TextareaLike
  body: { appendChild(n: unknown): void; removeChild(n: unknown): void }
  addEventListener(t: string, fn: () => void): void
  removeEventListener(t: string, fn: () => void): void
  activeElement: unknown
}
/** The parts of a `<textarea>` (or, for passwords, an `<input type="password">`) the bridge uses. */
export interface TextareaLike {
  value: string; selectionStart: number; selectionEnd: number; style: Record<string, string>
  setAttribute(k: string, v: string): void
  addEventListener(t: string, fn: (e: any) => void): void
  removeEventListener(t: string, fn: (e: any) => void): void
  focus(opts?: { preventScroll?: boolean }): void
  blur(): void
  setSelectionRange(a: number, b: number): void
}
/** `window.visualViewport`'s events: a soft keyboard or a pinch-zoom moves the canvas on the page. */
export interface ViewportLike { addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void }

export interface ImeBridgeOptions {
  /**
   * The UI's canvas: the proxy is placed from its page rect; `focus` hands it the page focus back after an edit, so its
   * keys (Tab) reach the Surfaces again; its `mousedown` is listened to (see `ImeBridge`).
   */
  canvas: {
    getBoundingClientRect(): { left: number; top: number; width: number; height: number }
    focus?(opts?: { preventScroll?: boolean }): void
    addEventListener?(t: string, fn: (e: any) => void): void
    removeEventListener?(t: string, fn: (e: any) => void): void
  }
  /** Surface pt → CSS px from the canvas's top-left; null when it cannot be projected (`UIRoot.screenFromPoint`). */
  screenFromPoint: UIRoot['screenFromPoint']
  /** Default: the global `document` (a `GlassUIError` where there is none). */
  doc?: DocLike
  /** Default: the global `visualViewport`, where there is one. */
  viewport?: ViewportLike
  /** The root's pointer bridge: `focus` makes the field's Surface the one that takes the canvas's keys (`setActive`). */
  pointer?: { setActive(s: Surface | null): void } | null
}

/** The fields of the DOM events on the proxy (input, select, keys, composition) that the bridge reads. */
interface ProxyEvent {
  key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean
  isComposing?: boolean; keyCode?: number; data?: string | null
  preventDefault?(): void
}

/** Spec §7.3: invisible but present (opacity 0.01, not 0, so engines keep it editable), never hit, above everything. */
const PROXY_STYLE: Readonly<Record<string, string>> = {
  position: 'fixed', left: '0px', top: '0px', opacity: '0.01', caretColor: 'transparent', color: 'transparent', background: 'transparent',
  border: '0', outline: 'none', resize: 'none', overflow: 'hidden', whiteSpace: 'pre', padding: '0', margin: '0',
  width: '2px', lineHeight: '1', zIndex: '2147483647', pointerEvents: 'none',
}
/** No autocorrection, hidden from assistive tech (the canvas UI is what is read), never a Tab stop of the page. */
const PROXY_ATTRS: readonly (readonly [string, string])[] = [
  ['autocomplete', 'off'], ['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'],
  ['aria-hidden', 'true'], ['enterkeyhint', 'done'], ['tabindex', '-1'],
]

/**
 * Spec §7.3: text input for a canvas UI through a transparent proxy `<textarea>` (an `<input type="password">` for a
 * password field) in the page. While a field is active the proxy holds the page focus, carries the field's value and
 * selection, and sits at the field's caret projected to the page (world Surfaces too), as tall as the projected caret
 * (its `font-size` too), so the IME candidate window opens under the line; typing, IME composition, the clipboard, undo
 * and the system shortcuts are the proxy's own, and every change is reported back (`ImeField.onChange`).
 *
 * - `input`, `select`, `keyup` and the document's `selectionchange` (while the proxy has the page focus) report the
 *   proxy's state; during a composition every report carries its range (`compositionstart` records its start, each
 *   `compositionupdate` its length; `compositionend` reports it gone), clamped to the value (a `compositionupdate`
 *   arrives before the value has the new text).
 * - `keydown`: a key the IME owns (`isComposing`, or `keyCode` 229: Safari sends the Enter that commits a composition
 *   after `compositionend`) is left alone. Tab / Shift+Tab are prevented and step the field's Surface's focus (the
 *   field's blur then detaches it); any other key, outside a composition, goes to `ImeField.onKey`, prevented when it
 *   returns true.
 * - The proxy losing the page focus other than through `blur` (to another page element, or blurred by the page's code)
 *   detaches the field and calls `ImeField.onBlur`. A window or tab switch does not: the page keeps the proxy as its
 *   `activeElement` and focuses it again on return, so the field stays active (as a native input stays focused).
 * - A composition cut short (`blur`, an outside blur, another field or element taking over) is reported over first: the
 *   field's last `ImeState` has `composition: null`.
 * - A `mousedown` on the canvas while a field is active is prevented: its default would move the page focus from the
 *   proxy to the canvas right after a press focused the field (the press itself arrives as `pointerdown`, before).
 *   With no field active the canvas takes focus as usual.
 * - `visualViewport` `resize`/`scroll` re-place the proxy; so does the root's `tick` (`reposition`), every frame
 *   while a field is active, so it follows a caret on a moving Surface.
 *
 * One proxy element, made on the first `focus`, swapped when a field needs the other element; its value is cleared
 * whenever no field is active.
 */
export class ImeBridge {
  private field: ImeField | null = null
  private proxy: TextareaLike | null = null
  private tag: 'textarea' | 'input' = 'textarea'
  private composing = false
  private compStart = 0
  private compEnd = 0
  /** The active field's last projected caret height (CSS px): used while the caret's bottom cannot be projected. */
  private goodHeight = Number.NaN
  /** What the proxy's style holds (CSS px): written only when they change. */
  private styleLeft = Number.NaN
  private styleTop = Number.NaN
  private styleHeight = Number.NaN
  private disposed = false
  private readonly doc: DocLike
  private readonly viewport: ViewportLike | null

  private readonly report = (): void => { const f = this.field, el = this.proxy; if (f && el) f.onChange(this.read(el)) }
  private readonly onSelectionChange = (): void => { if (this.proxy && this.doc.activeElement === this.proxy) this.report() }
  private readonly onViewport = (): void => { this.reposition() }
  private readonly onCanvasDown = (e: { preventDefault?(): void }): void => { if (this.field) e.preventDefault?.() }
  private readonly handlers: readonly (readonly [string, (e: ProxyEvent) => void])[] = [
    ['input', this.report], ['select', this.report], ['keyup', this.report],
    ['compositionstart', () => { if (!this.field || !this.proxy) return; this.composing = true; this.compStart = this.compEnd = this.proxy.selectionStart }],
    ['compositionupdate', e => { if (!this.field) return; this.compEnd = this.compStart + (e.data ?? '').length; this.report() }],
    ['compositionend', () => { if (!this.field) return; this.composing = false; this.report() }],
    ['keydown', e => this.keydown(e)],
    ['blur', () => {
      // still the page's focused element: the window or tab lost focus, and the proxy gets it back on return
      if (this.doc.activeElement === this.proxy) return
      const f = this.field
      if (!f) return   // `blur` (or a swap) detached it first
      this.endComposition()
      this.detach()
      f.onBlur()
    }],
  ]

  constructor(private readonly opts: ImeBridgeOptions) {
    const doc = opts.doc ?? (typeof document !== 'undefined' ? document as unknown as DocLike : null)
    if (!doc) throw new GlassUIError('ImeBridge', '没有 document：在浏览器之外请传入 doc')
    this.doc = doc
    this.viewport = opts.viewport ?? (typeof visualViewport !== 'undefined' ? visualViewport : null)
    doc.addEventListener('selectionchange', this.onSelectionChange)
    this.viewport?.addEventListener('resize', this.onViewport)
    this.viewport?.addEventListener('scroll', this.onViewport)
    opts.canvas.addEventListener?.('mousedown', this.onCanvasDown)
  }

  get active(): ImeField | null { return this.field }

  /** Make `field` the edited one: the proxy takes its value, selection and kind, moves to its caret and takes focus. */
  focus(field: ImeField): void {
    if (this.disposed) return
    const tag = field.kind === 'password' ? 'input' : 'textarea'
    // focused again mid-composition, in the same element: the IME keeps its text. Otherwise a composition ends here
    const keep = this.field === field && this.composing && this.proxy !== null && this.tag === tag
    if (!keep) this.endComposition()
    if (field !== this.field) this.goodHeight = Number.NaN   // a new caret: no height of another's to fall back on
    this.field = null                                         // what the swap below fires belongs to no field
    if (this.proxy && this.tag !== tag) this.remove()
    const el = this.proxy ?? this.create(tag)
    el.setAttribute('inputmode', field.kind === 'number' ? 'decimal' : 'text')
    if (!keep) this.write(el, field)
    this.field = field
    this.reposition()
    el.focus({ preventScroll: true })
    this.opts.pointer?.setActive(field.surface)
  }

  /** Stop editing `field` (if it is the active one): the proxy blurs, the canvas takes focus back (keys keep working). */
  blur(field: ImeField): void {
    const el = this.proxy
    if (field !== this.field || !el) return
    const focused = this.doc.activeElement === el
    this.endComposition()
    this.field = null      // the proxy's blur below is not the field's (no `onBlur`)
    if (focused) el.blur() // commits a composition: its events reach no field
    this.detach()
    // only focus the proxy holds is handed to the canvas: the page may have moved it elsewhere already
    if (focused) this.opts.canvas.focus?.({ preventScroll: true })
  }

  /** The app changed the field's value or selection (v-model, click): push it to the proxy (outside a composition). */
  sync(field: ImeField): void {
    if (field !== this.field || this.composing || !this.proxy) return
    this.write(this.proxy, field)
  }

  /**
   * Re-place the proxy at the active caret (the root calls this every tick while a field is active). A caret top that
   * cannot be projected (behind the camera) leaves the proxy where it is; a bottom that cannot keeps the last height.
   */
  reposition(): void {
    const f = this.field, el = this.proxy
    if (!f || !el) return
    const c = f.caret()
    const top = this.opts.screenFromPoint(f.surface, c.x, c.y)
    if (!top || !Number.isFinite(top.x) || !Number.isFinite(top.y)) return
    const bottom = this.opts.screenFromPoint(f.surface, c.x, c.y + c.height)
    if (bottom && Number.isFinite(bottom.x) && Number.isFinite(bottom.y)) this.goodHeight = Math.hypot(bottom.x - top.x, bottom.y - top.y)
    const height = Number.isFinite(this.goodHeight) ? this.goodHeight : c.height
    const r = this.opts.canvas.getBoundingClientRect()
    const left = r.left + top.x, y = r.top + top.y
    if (left !== this.styleLeft) { this.styleLeft = left; el.style.left = `${left}px` }
    if (y !== this.styleTop) { this.styleTop = y; el.style.top = `${y}px` }
    if (height !== this.styleHeight) { this.styleHeight = height; el.style.height = el.style.fontSize = `${height}px` }
  }

  /** Detaches the field, removes the proxy from the page and every listener the bridge added; later calls do nothing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const el = this.proxy
    this.field = null
    if (el && this.doc.activeElement === el) el.blur()
    this.detach()
    this.remove()
    this.doc.removeEventListener('selectionchange', this.onSelectionChange)
    this.viewport?.removeEventListener('resize', this.onViewport)
    this.viewport?.removeEventListener('scroll', this.onViewport)
    this.opts.canvas.removeEventListener?.('mousedown', this.onCanvasDown)
  }

  private keydown(e: ProxyEvent): void {
    const f = this.field
    if (!f || !e.key || e.isComposing || e.keyCode === 229) return
    if (e.key === 'Tab') {
      e.preventDefault?.()
      f.surface.focus.key(e.shiftKey ? 'Shift+Tab' : 'Tab')
      return
    }
    if (this.composing) return
    if (f.onKey({ key: e.key, shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey })) e.preventDefault?.()
  }

  private read(el: TextareaLike): ImeState {
    const n = el.value.length
    const composition = this.composing ? { start: Math.min(this.compStart, n), end: Math.min(this.compEnd, n) } : null
    return { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd, composition }
  }

  private write(el: TextareaLike, f: ImeField): void {
    if (el.value !== f.value) el.value = f.value
    el.setSelectionRange(f.selectionStart, f.selectionEnd)
  }

  /** A composition in progress is over (cut short): the active field hears its state without one. */
  private endComposition(): void {
    if (!this.composing) return
    this.composing = false
    this.report()
  }

  /** No field is active: nothing the proxy fires reaches one, and nothing typed stays in the page. */
  private detach(): void {
    this.field = null
    this.composing = false
    if (this.proxy) this.proxy.value = ''
  }

  private create(tag: 'textarea' | 'input'): TextareaLike {
    const el = this.doc.createElement(tag)
    Object.assign(el.style, PROXY_STYLE)
    for (const [k, v] of PROXY_ATTRS) el.setAttribute(k, v)
    if (tag === 'input') el.setAttribute('type', 'password')
    for (const [t, fn] of this.handlers) el.addEventListener(t, fn)
    this.doc.body.appendChild(el)
    this.proxy = el; this.tag = tag
    this.composing = false   // a fresh element composes nothing
    this.styleLeft = this.styleTop = this.styleHeight = Number.NaN
    return el
  }

  private remove(): void {
    const el = this.proxy
    if (!el) return
    for (const [t, fn] of this.handlers) el.removeEventListener(t, fn)
    el.value = ''
    this.doc.body.removeChild(el)
    this.proxy = null
  }
}
