import { Comment, computed, Fragment, isVNode, onBeforeUnmount, onMounted, provide, ref, shallowReactive, Text as TextVNode, watch } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError } from '@glassui/core'
import type { CameraRig, Surface } from '@glassui/render'
import { defineGlassComponent } from '../define'
import { useMotion, useRoot } from '../inject'
import { arcSlots } from '../spatial/arc'
import { gridSlots } from '../spatial/grid'
import { createSpaceGestures } from '../spatial/gestures'
import { SPACE, type BlockHandle } from '../spatial/context'
import { Block } from './Block'
import { noAttrs } from './Surface'

const SpaceProps = z.object({
  focus: z.string().nullable().optional().describe('焦点 Block 的 name（v-model:focus）；overview 下 null 表示总览；省略时 Space 自己记住焦点，开始时是第一个 Block'),
  layout: z.enum(['arc', 'grid']).default('arc').describe('自动排布：arc 为弧形；grid 为球面网格（需 columns）'),
  columns: z.number().int().positive().optional().describe('grid 布局的列数；layout 为 grid 时必填正整数'),
  radius: z.number().positive().optional().describe('球面半径；默认 arc 为 7、grid 为 24（世界单位）'),
  gap: z.number().min(0).optional().describe('自动排布间距；默认 arc 为 0.5、grid 为 0.4（世界单位）'),
  overview: z.boolean().default(false).describe('启用总览：focus 为 null 时框住全部 Block，支持鼠标悬停、点击与键盘选择'),
  standby: z.boolean().default(false).describe('待机总览：镜头后退 25%，Block 不透明度降至 0.35'),
  camera: z.boolean().default(true).describe('由 Space 驱动相机；宿主不能同时开 OrbitControls。false 时只排布与管理焦点'),
  parallax: z.boolean().default(true).describe('闲置时镜头随指针轻微视差（减少动态效果或 motion 为 frozen 时关闭）'),
}).superRefine((p, c) => {
  if (p.layout === 'grid' && p.columns === undefined) c.addIssue({ code: 'custom', path: ['columns'], message: 'layout 为 grid 时必须给 columns（正整数）' })
  if (p.focus === null && !p.overview) c.addIssue({ code: 'custom', path: ['focus'], message: '只有 overview 为 true 时才能为 null（表示总览）' })
})
type Props = z.output<typeof SpaceProps>
const DEFAULTS: Props = SpaceProps.parse({})
const BLANK = /^[ \t\n\r\f]*$/
function onlyBlocks(children: readonly unknown[] | undefined): void {
  for (const c of children ?? []) {
    if (c == null || typeof c === 'boolean') continue
    if (Array.isArray(c)) { onlyBlocks(c); continue }
    if (isVNode(c) && c.type === Comment) continue
    if (isVNode(c) && c.type === Fragment && Array.isArray(c.children)) { onlyBlocks(c.children); continue }
    const text = typeof c === 'string' || typeof c === 'number' ? String(c) : isVNode(c) && c.type === TextVNode ? String(c.children ?? '') : null
    if (text !== null && BLANK.test(text)) continue
    if (!(isVNode(c) && c.type === Block)) throw new GlassUIError('Space', '插槽里只能放 <Block>')
  }
}

export const Space = defineGlassComponent({
  name: 'Space',
  description: '空间界面的容器：把 Block 排在弧形或球面网格中并管理焦点。overview 启用总览模式，focus 为 null 时相机框住所有 Block，支持悬停、点击、滚轮与键盘选择；standby 会拉远相机并淡化内容。grid 布局需 columns；radius 与 gap 默认分别为弧形 7 / 0.5、网格 24 / 0.4。没绑定 focus 时 Space 自己记住焦点，开始时为第一个 Block。camera 为 true 时 Space 驱动相机；motion 为 frozen 时动画直接到位。',
  props: SpaceProps,
  events: {
    'update:focus': { payload: 'string | null', description: '切换焦点 Block，或在 overview 下返回总览（null）' },
    arrive: { payload: 'string | null', description: '相机抵达当前焦点或总览位姿' },
  },
  slots: { default: '只放 <Block>' },
  examples: [
    '<Space v-model:focus="page"><Block name="login" :width="488" :height="560"><Text value="登录" size="3xl" :weight="700" /></Block><Block name="home" :width="880" :height="620"><Text value="首页" size="3xl" :weight="700" /></Block></Space>',
    '<Space layout="grid" :columns="3" overview v-model:focus="view"><Block v-for="view in views" :key="view.name" :name="view.name" :width="view.width" :height="view.height"><Text :value="view.name" /></Block></Space>',
    '<Space :camera="false"><Block name="panel" :width="400" :height="300"><Text value="相机由宿主控制" /></Block></Space>',
  ],
  mistakes: [
    { mistake: '<Space> 与 OrbitControls 同时开', fix: 'Space 的相机 rig 每帧写相机位姿；要自己控制相机就写 :camera="false"' },
    { mistake: '<Space :focus="null">（overview 未启用）', fix: '只有 overview 为 true 时 focus 才能是 null；null 表示总览模式' },
    { mistake: '<Space layout="grid"> 没有 columns', fix: 'grid 布局必须写正整数 :columns，例如 <Space layout="grid" :columns="3">' },
    { mistake: '<Space><Text value="标题" /><Block …/></Space>', fix: 'Space 的插槽只放 <Block>：标题等内容放进某个 Block 里' },
  ],
}, (p, { slots, attrs, emit }) => {
  const root = useRoot(), motion = useMotion()
  const v = computed<Props>(prev => { try { return p.value } catch { return prev ?? DEFAULTS } })
  const radius = computed(() => v.value.radius ?? (v.value.layout === 'grid' ? 24 : 7))
  const gap = computed(() => v.value.gap ?? (v.value.layout === 'grid' ? 0.4 : 0.5))
  const blocks = shallowReactive(new Map<string, BlockHandle>()), order = shallowReactive<string[]>([])
  const last = new Map<string, { width: number; height: number; arc: boolean }>()
  const activeNames = computed(() => order.filter(n => blocks.has(n)))
  const slotsByName = computed(() => {
    const on = (n: string): boolean => blocks.get(n)?.arc.value ?? last.get(n)?.arc ?? false
    const names = order.filter(on), sizes = names.map(n => ({
      width: blocks.get(n)?.width.value ?? last.get(n)?.width ?? 0,
      height: blocks.get(n)?.height.value ?? last.get(n)?.height ?? 0,
    }))
    const placed = v.value.layout === 'grid' ? gridSlots(sizes, v.value.columns ?? 1, radius.value, gap.value) : arcSlots(sizes.map(s => s.width), radius.value, gap.value)
    return new Map(names.map((n, i) => [n, placed[i]!]))
  })
  const pressed = ref<string | null | undefined>(undefined), highlighted = ref<string | null>(null)
  const focused = computed((): string | null => {
    if (v.value.focus !== undefined) return v.value.focus
    if (pressed.value === null) return null
    if (pressed.value !== undefined && blocks.has(pressed.value)) return pressed.value
    return order.find(n => blocks.has(n)) ?? null
  })
  const mode = computed(() => v.value.overview && focused.value === null ? 'overview' : 'focus')
  const standby = computed(() => v.value.overview && focused.value === null && v.value.standby)
  const ctx = {
    register(name: string, block: BlockHandle) {
      if (blocks.has(name)) throw new GlassUIError('Block.name', `重名的 Block "${name}"：Space 里每个 Block 的 name 必须唯一`)
      blocks.set(name, block); if (!order.includes(name)) order.push(name)
      return () => { if (blocks.get(name) !== block) return; last.set(name, { width: block.width.value, height: block.height.value, arc: block.arc.value }); blocks.delete(name) }
    },
    slot: (name: string) => slotsByName.value.get(name) ?? null,
    focused, mode, highlighted, standby,
    highlight(name: string | null, _by: 'pointer' | 'keys') { highlighted.value = name && blocks.has(name) ? name : null },
    row(name: string) { const i = [...slotsByName.value.keys()].indexOf(name); return i < 0 ? 0 : Math.floor(i / Math.max(1, v.value.columns ?? 1)) },
    requestFocus(name: string | null) { pressed.value = name; emit('update:focus', name) },
  }
  provide(SPACE, ctx)
  let mounted = false, rig: CameraRig | null = null, first = true, aimed: Surface | null = null, active: Surface | null = null
  const syncRig = (): void => {
    if (v.value.camera && !rig) { rig = root.createCameraRig(); first = true; aimed = null }
    else if (!v.value.camera && rig) { rig.dispose(); rig = null }
    if (rig) rig.parallax = v.value.parallax && motion === 'live'
  }
  const apply = (): void => {
    if (!mounted) return
    if (mode.value === 'overview') {
      const targets = activeNames.value.map(n => blocks.get(n)?.surface.value).filter((s): s is Surface => !!s)
      if (rig && targets.length) {
        const immediate = first || motion === 'frozen'; first = false
        const signature = targets.map(s => String((s as unknown as { uuid?: string }).uuid ?? activeNames.value.find(n => blocks.get(n)?.surface.value === s))).join('|') + `:${standby.value}`
        if (signature !== aimedOverview) {
          aimedOverview = signature
          void rig.frame(targets, { immediate, distanceScale: standby.value ? 1.25 : 1, parallax: 3 }).then(ok => { if (ok && aimedOverview === signature) emit('arrive', null) })
        }
      }
      if (active) active.trapFocus = false
      root.pointer?.setActive(null); active = null; aimed = null
      return
    }
    const name = focused.value
    if (name === null) return
    const block = blocks.get(name)
    if (!block) throw new GlassUIError('Space.focus', `没有名为 "${name}" 的 Block`, { allowed: [...blocks.keys()], got: name })
    const s = block.surface.value
    if (!s) return
    aimedOverview = ''
    if (rig && s !== aimed) {
      const current = s
      void rig.focus(s, { immediate: first || motion === 'frozen' }).then(ok => { if (ok && focused.value === name && block.surface.value === current) emit('arrive', name) })
      first = false; aimed = s
    }
    if (s !== active) { if (active) active.trapFocus = false; s.trapFocus = true; root.pointer?.setActive(s); active = s }
  }
  let aimedOverview = ''
  const focusedSurface = computed(() => focused.value === null ? null : blocks.get(focused.value)?.surface.value ?? null)
  const gestures = createSpaceGestures(ctx, {
    columns: () => v.value.columns ?? activeNames.value.length,
    names: () => activeNames.value,
    focusedSurface: () => focusedSurface.value,
    surfaceName: surface => activeNames.value.find(n => blocks.get(n)?.surface.value === surface) ?? null,
    composing: () => root.ime?.composing === true,
  })
  let offWheel: (() => void) | undefined, offKey: (() => void) | undefined
  const syncGestures = (): void => {
    offWheel?.(); offKey?.(); offWheel = undefined; offKey = undefined
    if (!v.value.overview || !root.pointer) return
    offWheel = root.pointer.addWheelInterceptor(g => gestures.wheel(g))
    offKey = root.pointer.addKeyInterceptor(g => gestures.key(g))
  }
  watch([focused, focusedSurface, () => [...blocks.keys()].join('\n'), () => [...blocks.values()].map(b => `${b.width.value}:${b.height.value}:${b.surface.value?.model.id ?? ''}`).join('|'), standby], apply, { flush: 'post' })
  watch([() => v.value.camera, () => v.value.parallax], () => { if (mounted) { syncRig(); apply() } }, { flush: 'post' })
  watch(() => v.value.overview, () => { syncGestures(); if (mounted) apply() }, { flush: 'post' })
  watch(standby, () => { if (mounted) apply() }, { flush: 'post' })
  onMounted(() => { mounted = true; syncRig(); syncGestures(); apply() })
  onBeforeUnmount(() => { offWheel?.(); offKey?.(); rig?.dispose(); rig = null })
  let warnedStandby = false
  if (v.value.standby && v.value.focus != null) { console.warn('[Space] standby 只在总览（focus 为 null）时生效'); warnedStandby = true }
  watch(() => v.value.standby && v.value.focus != null, on => { if (on && !warnedStandby) { warnedStandby = true; console.warn('[Space] standby 只在总览（focus 为 null）时生效') } }, { flush: 'post' })
  return () => { noAttrs('Space', attrs); const children = slots.default?.(); onlyBlocks(children); return children }
})
