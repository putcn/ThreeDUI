import { computed, h, inject, onBeforeUnmount, onMounted, onUpdated, provide, ref, shallowRef, Teleport, toRef, watch, watchEffect, type ShallowRef } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, type Node } from '@glassui/core'
import type { CreateSurfaceOptions, Surface } from '@glassui/render'
import { defineGlassComponent, fallthrough } from '../define'
import { useMotion, useRoot } from '../inject'
import { holdContent } from '../renderer'
import { BLOCK, LIFT, RECEDE, SPACE, type BlockHandle } from '../spatial/context'
import { checkBackground, useRenderSurface } from '../surface-host'

type Vec3 = [number, number, number]
const Vec3 = z.tuple([z.number(), z.number(), z.number()])
const Scale = z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])])
/** An enter / leave offset from the rest pose, in the Block's own frame (spatial spec §3.3). */
const Offset = z.object({ position: Vec3.optional(), rotation: Vec3.optional(), scale: Scale.optional(), opacity: z.number().min(0).max(1).optional() }).strict()
type Offset = z.output<typeof Offset>

/** pt per world unit when `ptPerUnit` is left out (the render Surface's default). */
const PT_PER_UNIT = 244

const BlockProps = z.object({
  name: z.string().min(1).describe('名字，在 Space 里唯一：v-model:focus 用它指定焦点 Block；弧上的位置也按名字记住（v-if 移除再回来，回到原位）'),
  width: z.number().positive().describe('宽，pt（固定）'),
  height: z.number().positive().describe('高，pt（固定，不随内容撑开：内容超出时开发期会 console.warn）'),
  position: Vec3.optional().describe('Block 中心的位置 [x, y, z]，世界单位；省略时由 Space 排在弧上（给了就不占弧上的位置）'),
  rotation: Vec3.optional().describe('旋转 [x, y, z]，弧度，XYZ 顺序；省略时取弧上的朝向（正对弧心），给了 position 而省略它时不旋转'),
  scale: Scale.optional().describe('缩放：一个数或 [x, y, z]（默认 1）'),
  radius: z.number().min(0).default(48).describe('圆角，pt：背板和内容盒的圆角；内容盒里写 radius: concentric 的子项按它减去 40 pt 内边距取圆角（Card 默认 24 pt，不随它变）'),
  background: z.string().default('glass').describe('背景：glass（玻璃背板，默认）、none（透明）或颜色 token / #hex（不透明底色）'),
  ptPerUnit: z.number().positive().optional().describe('每个世界单位多少 pt（默认 244）：越大，同样 pt 尺寸的 Block 在场景里越小'),
  unfocusedOpacity: z.number().min(0).max(1).default(1).describe('聚焦别的 Block 时的透明度；默认 1'),
  enterFrom: Offset.default({ position: [0, 0, -1.2], scale: 0.92, opacity: 0 }).describe(
    '进场起点 { position?, rotation?, scale?, opacity? }：相对原位的偏移，在 Block 自己的坐标系里（−z 是远离观众）；position 与 rotation 相加，scale 与 opacity 相乘。整个替换默认值，省略的字段不偏移（opacity 省略即 1）。默认 { position: [0, 0, -1.2], scale: 0.92, opacity: 0 }：从后方淡入'),
  leaveTo: Offset.default({ position: [0, 0, -1.5], scale: 0.9, opacity: 0 }).describe(
    '离场终点，写法同 enterFrom；飞到这里后 Block 才移除，内容随它一起飞走。默认 { position: [0, 0, -1.5], scale: 0.9, opacity: 0 }：向后飞并淡出；向左飞出如 { position: [-4, 0, -1], opacity: 0 }'),
})
type Props = z.output<typeof BlockProps>
/** A pose: the scale per axis. */
interface Rest { position: Vec3; rotation: Vec3; scale: Vec3 }
/** An offset from a rest pose, in the pose's own frame: an `enterFrom` / `leaveTo` (less its opacity), or `RECEDE`. */
interface Shift { readonly position?: Readonly<Vec3> | undefined; readonly rotation?: Readonly<Vec3> | undefined; readonly scale?: number | Readonly<Vec3> | undefined }

const add = (a: Vec3, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const axis = (s: number | Readonly<Vec3>, i: 0 | 1 | 2): number => typeof s === 'number' ? s : s[i]
const times = (a: Vec3, b: number | Readonly<Vec3>): Vec3 => [a[0] * axis(b, 0), a[1] * axis(b, 1), a[2] * axis(b, 2)]
/** `v` rotated by the XYZ Euler `r` (three's order: the matrix Rx·Ry·Rz, so about z first). */
function rotate([x, y, z]: Readonly<Vec3>, [a, b, c]: Readonly<Vec3>): Vec3 {
  const x1 = x * Math.cos(c) - y * Math.sin(c), y1 = x * Math.sin(c) + y * Math.cos(c)
  const x2 = x1 * Math.cos(b) + z * Math.sin(b), z2 = z * Math.cos(b) - x1 * Math.sin(b)
  return [x2, y1 * Math.cos(a) - z2 * Math.sin(a), y1 * Math.sin(a) + z2 * Math.cos(a)]
}
/** `r` ⊕ `o`: the position offset rotated into `r`'s frame and added, the rotations added, the scales multiplied. */
const place = (r: Rest, o: Shift): Rest => ({
  position: add(r.position, rotate(o.position ?? [0, 0, 0], r.rotation)),
  rotation: add(r.rotation, o.rotation ?? [0, 0, 0]),
  scale: times(r.scale, o.scale ?? 1),
})
/** The rest pose with an enter / leave offset applied in the Block's own frame (rest ⊕ offset), with its opacity. */
const offset = (r: Rest, o: Offset): Rest & { opacity: number } => ({ ...place(r, o), opacity: o.opacity ?? 1 })

export const Block = defineGlassComponent({
  name: 'Block',
  description: '空间界面里的一块界面：一块玻璃背板的世界层 Surface，只能放在 <Space> 里（name 在 Space 里唯一）。width / height 是 pt，固定不随内容撑开（ptPerUnit 默认 244 pt 一个世界单位）。没给 position 时 Space 把它排在弧上，镜头对焦到焦点 Block 的正前方。出现时从 enterFrom 弹到原位，被 v-if / v-for 移除或 Space 卸载时飞到 leaveTo 并淡出，内容随它一起飞走后才移除。默认插槽是内容，排在一个纵向排列的内容盒里（padding 40、gap 24）；tw / class / style 落到这个内容盒上。非焦点 Block 向后退一点（沿自身 −z 0.4、缩到 0.96）；总览模式下按球面网格排布，不后退，悬停会向前浮起并显示焦点边框，点击进入操作模式。非焦点内容不接收指针。分组用 <Card>：更薄的玻璃（圆角 24 pt），浮在背板上方 24 pt 并在背板上投下阴影，Block 进场时依次升起。',
  props: BlockProps,
  events: { error: { payload: 'Error', description: '该 Block 的 Surface 渲染失败（它已停止绘制）' } },
  slots: { default: 'Block 的内容（纵向排列，padding 40、gap 24）' },
  examples: [
    '<Space v-model:focus="page"><Block name="login" :width="488" :height="560"><Text value="登录" size="3xl" :weight="700" /><Text value="欢迎回来" color="secondaryLabel" /></Block><Block name="home" :width="880" :height="620"><Text value="首页" size="3xl" :weight="700" /></Block></Space>',
    '<Space><Block name="stats" :width="880" :height="400" tw="justify-center"><Stack direction="horizontal" :gap="16"><Card title="本周活跃" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="1,284" size="3xl" :weight="700" /></Card><Card title="完成任务" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="36" size="3xl" :weight="700" /></Card></Stack></Block></Space>',
    '<Space><Block name="list" :width="560" :height="480"><Text value="列表" size="2xl" :weight="700" /></Block><Block v-if="open" name="detail" :width="560" :height="480" :position="[3, 0, 2]" :rotation="[0, -0.6, 0]" :leave-to="{ position: [4, 0, 0], opacity: 0 }"><Text value="详情" size="2xl" :weight="700" /></Block></Space>',
  ],
  mistakes: [
    { mistake: '<Block> 放在 Space 外（直接放在页面或 <Surface> 里）', fix: 'Block 只能是 <Space> 的直接子项：<Space><Block name="a" …>…</Block></Space>' },
    { mistake: '<Block name="a" width="400" height="300">', fix: '<Block name="a" :width="400" :height="300">（数字要绑定）' },
    { mistake: "给 Block 里的内容写 pointerEvents: 'auto'（如 :style=\"{ pointerEvents: 'auto' }\"）", fix: "不要写：非焦点 Block 的内容盒用 pointerEvents: 'none' 挡住按下与悬停，里面写 'auto' 会重新打开；总览 Block 只响应悬停与进入操作模式的按下" },
  ],
}, (p, { slots, attrs, emit }) => {
  const space = inject(SPACE, null)
  if (!space) throw new GlassUIError('Block', '必须放在 <Space> 里')
  const root = useRoot(), motion = useMotion(), immediate = motion === 'frozen'
  /** The props once valid, with a background the theme knows (else the error). */
  const state = computed((): { v: Props } | { error: unknown } => {
    try { const v = p.value; checkBackground('Block', v.background, root.theme, root.scheme); return { v } } catch (error) { return { error } }
  })
  const initial = state.value
  if ('error' in initial) throw initial.error              // nothing registered, nothing made
  /** The last valid props: while they are invalid the Block stays as it was (the render reports the error). */
  const v = computed<Props>(prev => { const s = state.value; return 'error' in s ? prev ?? initial.v : s.v })

  // registered before the Surface is made: a duplicate name makes nothing, and the arc slot is there for the enter pose
  let host: { surface: Readonly<ShallowRef<Surface | null>> } | undefined
  const handle: BlockHandle = {
    surface: toRef(() => host?.surface.value ?? null),
    width: computed(() => v.value.width / (v.value.ptPerUnit ?? PT_PER_UNIT) * axis(v.value.scale ?? 1, 0)),
    height: computed(() => v.value.height / (v.value.ptPerUnit ?? PT_PER_UNIT) * axis(v.value.scale ?? 1, 1)),
    arc: computed(() => v.value.position === undefined),
  }
  const name = ref(initial.v.name)
  let unregister = space.register(name.value, handle)
  watch(() => v.value.name, n => { const off = space.register(n, handle); unregister(); unregister = off; name.value = n })
  const focused = computed(() => space.focused.value === name.value)
  // the Cards inside: they hover only while the Block is the focus, and rise in staggered, in setup order. The count
  // starts over once a tick has passed, so the Cards that appear together form one wave (later ones do not wait on the
  // first wave's delays)
  let cards = 0
  provide(BLOCK, {
    focused,
    nextCard: () => { if (cards === 0) void root.afterTick().then(() => { cards = 0 }); return cards++ },
  })

  /** Where the Block stands: its own position / rotation, else its arc slot's; receded (`RECEDE`) unless focused. */
  const rest = computed((): Rest => {
    const x = v.value, slot = space.slot(name.value), s = x.scale ?? 1
    const own: Rest = { position: x.position ?? slot?.position ?? [0, 0, 0], rotation: x.rotation ?? slot?.rotation ?? [0, 0, 0], scale: typeof s === 'number' ? [s, s, s] : s }
    if (space.mode.value === 'overview') return space.highlighted.value === name.value ? place(own, LIFT) : own
    return focused.value ? own : place(own, RECEDE)
  })
  const opacity = computed(() => space.standby.value ? Math.min(0.35, v.value.unfocusedOpacity) : space.mode.value === 'focus' && !focused.value ? v.value.unfocusedOpacity : 1)
  const { surface } = useRenderSurface(() => {
    const s = state.value
    if ('error' in s) return null
    const x = s.v, options: CreateSurfaceOptions = { layer: 'world', width: x.width, height: x.height, background: x.background, cornerRadius: x.radius }
    if (x.ptPerUnit !== undefined) options.ptPerUnit = x.ptPerUnit
    return { key: JSON.stringify([x.background, x.radius, x.ptPerUnit]), options }
  }, {
    onError: e => { emit('error', e) },
    // the enter: placed at rest ⊕ enterFrom, then sprung to its rest pose
    onCreate: s => {
      const from = offset(rest.value, v.value.enterFrom)
      s.position.set(...from.position); s.rotation.set(...from.rotation); s.scale.set(...from.scale)
      s.opacity = from.opacity
      void s.animateTo({ ...rest.value, opacity: opacity.value }, { immediate })
    },
    // the leave: the content stays in the Surface while Vue unmounts its components, and flies to rest ⊕ leaveTo with
    // it; the Surface goes when it lands. `release` has already cancelled its press and blurred it
    onUnmount: s => {
      holdContent(s.root)
      s.interactive = false
      void s.animateTo(offset(rest.value, v.value.leaveTo), { immediate }).then(() => { root.removeSurface(s) })
    },
  })
  host = { surface }
  onBeforeUnmount(() => { unregister() })
  // a new rest pose (its slot moved, its position changed, the focus came or went) springs the Block there
  let opacityTimer: ReturnType<typeof setTimeout> | undefined
  watch([() => JSON.stringify(rest.value), () => opacity.value], () => {
    if (opacityTimer) clearTimeout(opacityTimer)
    const s = surface.value
    if (!s) return
    const delay = !space.standby.value && s.opacity < 1 && motion !== 'frozen' ? space.row(name.value) * 60 : 0
    const apply = (): void => { opacityTimer = undefined; void s.animateTo({ ...rest.value, opacity: opacity.value }, { immediate }) }
    if (delay) opacityTimer = setTimeout(apply, delay); else apply()
  })
  onBeforeUnmount(() => { if (opacityTimer) clearTimeout(opacityTimer) })
  watchEffect(() => {
    const s = surface.value, { width, height } = v.value
    if (s && (s.model.width !== width || s.model.height !== height)) s.setSize(width, height)
  })

  // content taller than the (fixed-size) Block: measured after the frame that lays out a mount or a re-render, and
  // warned once per Block (spatial spec §5; the package has no dev / prod switch, so it always checks)
  const content = shallowRef<Node | null>(null)
  let warned = false, waiting = false
  const measure = (): void => {
    const n = content.value
    if (warned || !n) return
    let bottom = 0
    for (const c of n.children) bottom = Math.max(bottom, c.layout.y + c.layout.height)
    const s = n.style, extent = bottom + (s.paddingBottom ?? s.paddingY ?? s.padding ?? 0), { height } = v.value
    if (extent <= height + 0.5) return
    warned = true
    console.warn(`[Block "${name.value}"] 内容高 ${Math.round(extent)}pt 超出 block 高 ${height}pt：调大 height 或减少内容`)
  }
  const check = (): void => {
    if (warned || waiting) return
    waiting = true
    void root.afterTick().then(() => { waiting = false; measure() })
  }
  onMounted(check); onUpdated(check)

  return () => {
    const st = state.value
    if ('error' in st) throw st.error
    const s = surface.value
    if (!s) return null
    // the content box: unfocused, it lets no press or hover through to the content (the root box takes the press, to
    // focus the Block); focused, it sets nothing, inheriting 'auto' (no explicit 'auto' anywhere: it would reopen a
    // 'none' subtree). It does not shrink, so content taller than the Block overflows it instead of being squashed.
    // It fills the Surface and carries its corner radius, so a `concentric` Card inside resolves against it (that
    // radius less the Card's inset; the Surface root has no radius of its own). The root box stays square: all of it
    // takes the press
    const overview = space.mode.value === 'overview', highlighted = overview && space.highlighted.value === name.value
    const inner = fallthrough(h('box', { ref: content, style: { flexGrow: 1, flexShrink: 0, flexDirection: 'column', padding: 40, gap: 24, radius: st.v.radius, ...(!focused.value || overview) ? { pointerEvents: 'none' as const } : {} } }, slots.default?.()), attrs)
    return h(Teleport, { to: s.root }, [
      h('box', { style: { width: '100%', height: '100%', ...(highlighted ? { radius: st.v.radius, border: { width: 4, color: 'accent' } } : {}) }, onPointerenter: () => { if (overview) space.highlight(name.value, 'pointer') }, onPointerleave: () => { if (overview && space.highlighted.value === name.value) space.highlight(null, 'pointer') }, onPointerdown: () => { if (overview || !focused.value) space.requestFocus(name.value) } }, [inner]),
    ])
  }
})
