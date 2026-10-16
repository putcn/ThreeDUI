import { Comment, computed, Fragment, isVNode, onBeforeUnmount, onMounted, provide, ref, shallowReactive, Text as TextVNode, watch } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError } from '@glassui/core'
import type { CameraRig, Surface } from '@glassui/render'
import { defineGlassComponent } from '../define'
import { useMotion, useRoot } from '../inject'
import { arcSlots } from '../spatial/arc'
import { SPACE, type BlockHandle } from '../spatial/context'
import { Block } from './Block'
import { noAttrs } from './Surface'

const SpaceProps = z.object({
  focus: z.string().optional().describe('焦点 Block 的 name（v-model:focus）：镜头对焦到它，键盘与 Tab 只在它里面；省略时 Space 自己记住焦点，开始时是第一个 Block，点击非焦点 Block 照样切换'),
  radius: z.number().positive().default(7).describe('自动排布的弧半径，世界单位：没给 position 的 Block 排在这条朝向观众的弧上，第一个在原点，之后依次向右'),
  gap: z.number().min(0).default(0.5).describe('弧上相邻 Block 的间隔，世界单位'),
  camera: z.boolean().default(true).describe('由 Space 驱动相机：挂载时对焦到焦点 Block，焦点变化时镜头沿弹簧移过去；为 true 时宿主不能同时开 OrbitControls 一类控制器。false 时只排布与管理焦点，不动相机'),
  parallax: z.boolean().default(true).describe('闲置时镜头随指针轻微视差（减少动态效果或 motion 为 frozen 时关闭）'),
})
type Props = z.output<typeof SpaceProps>
const DEFAULTS: Props = SpaceProps.parse({})

const BLANK = /^[ \t\n\r\f]*$/
/** Throws unless a slot holds only Blocks: fragments (`v-for`) flattened, comments (`v-if`) and whitespace text skipped. */
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
  description: '空间界面的容器：把一个 Vue 应用的各个界面块（<Block>）摆在 3D 空间里，持有相机并管理焦点。默认插槽只放 <Block>（v-if / v-for 照常可用）；没给 position 的 Block 排在一条朝向观众的弧上（radius、gap，世界单位），按 name 记住位置：被 v-if 移除再回来时回到原位，其它 Block 不挪动。focus（v-model:focus）是焦点 Block 的 name：镜头沿弹簧移到它正前方，它成为键盘的目标（Tab 只在它里面循环），原焦点 Block 里的焦点节点失焦；没绑定时 Space 自己记住焦点，开始时是第一个 Block。点击非焦点 Block 只把它设为焦点（发出 update:focus），不传给里面的控件。camera 为 true 时 Space 每帧写相机位姿：宿主不能同时开 OrbitControls。motion 为 frozen 时对焦、进场、离场都直接到位，视差关闭。Space 自己不渲染节点：它不接受 tw / class / style。一个应用只放一个 Space。',
  props: SpaceProps,
  events: { 'update:focus': { payload: 'string', description: '按下了非焦点 Block：它的 name（v-model:focus 据此切换焦点）' } },
  slots: { default: '只放 <Block>' },
  examples: [
    '<Space v-model:focus="page"><Block name="login" :width="488" :height="560"><Text value="登录" size="3xl" :weight="700" /></Block><Block name="home" :width="880" :height="620"><Text value="首页" size="3xl" :weight="700" /></Block></Space>',
    '<Space v-model:focus="tab" :radius="9" :gap="0.8"><Block v-for="t in tabs" :key="t.id" :name="t.id" :width="560" :height="480"><Text :value="t.title" size="2xl" :weight="700" /></Block></Space>',
    '<Space :camera="false"><Block name="panel" :width="400" :height="300"><Text value="相机由宿主控制" /></Block></Space>',
  ],
  mistakes: [
    { mistake: '<Space> 与 OrbitControls 同时开（宿主自己再控制相机）', fix: 'Space 的相机 rig 每帧写相机位姿，两者会互相打架：用 Space 时不要同时开 OrbitControls 一类控制器；要自己控制相机就写 :camera="false"' },
    { mistake: 'focus 写不存在的名字（v-model:focus="page"，page 是 "landng"）', fix: 'focus 必须是某个 Block 的 name（区分大小写）；报错会列出现有的名字' },
    { mistake: '<Space><Text value="标题" /><Block …/></Space>', fix: 'Space 的插槽只放 <Block>：标题等内容放进某个 Block 里' },
  ],
}, (p, { slots, attrs, emit }) => {
  const root = useRoot(), motion = useMotion()
  /** The last valid props (the render reports invalid ones). */
  const v = computed<Props>(prev => { try { return p.value } catch { return prev ?? DEFAULTS } })

  /** The Blocks there now, by name; `order`: every name in first-registration order (never shrinks). */
  const blocks = shallowReactive(new Map<string, BlockHandle>()), order = shallowReactive<string[]>([])
  /** A departed Block's last width and arc flag, so its slot stays reserved (updated before its entry leaves `blocks`). */
  const last = new Map<string, { width: number; arc: boolean }>()
  const arc = computed(() => {
    const on = (n: string): boolean => blocks.get(n)?.arc.value ?? last.get(n)?.arc ?? false
    const names = order.filter(on), widths = names.map(n => blocks.get(n)?.width.value ?? last.get(n)?.width ?? 0)
    const placed = arcSlots(widths, v.value.radius, v.value.gap)
    return new Map(names.map((n, i) => [n, placed[i]!]))
  })
  /** The focus prop; else the Block last pressed, while it is there; else the first Block there. */
  const pressed = ref<string | null>(null)
  const focused = computed((): string | null => {
    const bound = v.value.focus
    if (bound !== undefined) return bound
    if (pressed.value !== null && blocks.has(pressed.value)) return pressed.value
    return order.find(n => blocks.has(n)) ?? null
  })
  provide(SPACE, {
    register(name, block) {
      if (blocks.has(name)) throw new GlassUIError('Block.name', `重名的 Block "${name}"：Space 里每个 Block 的 name 必须唯一`)
      blocks.set(name, block)
      if (!order.includes(name)) order.push(name)
      return () => {
        if (blocks.get(name) !== block) return
        last.set(name, { width: block.width.value, arc: block.arc.value })
        blocks.delete(name)
      }
    },
    slot: name => arc.value.get(name) ?? null,
    focused,
    requestFocus(name) { pressed.value = name; emit('update:focus', name) },
  })

  // the camera and the keys follow the focused Block, once mounted (the Blocks' Surfaces are made by then)
  let mounted = false, rig: CameraRig | null = null, first = true
  /** The Surface the rig was last sent to, and the one holding the keys. */
  let aimed: Surface | null = null, active: Surface | null = null
  /** Creates or disposes the rig as `camera` asks, with `parallax` (never under frozen motion). */
  const syncRig = (): void => {
    const { camera, parallax } = v.value
    if (camera && !rig) { rig = root.createCameraRig(); first = true; aimed = null }
    else if (!camera && rig) { rig.dispose(); rig = null }
    if (rig) rig.parallax = parallax && motion === 'live'
  }
  /**
   * Sends the rig to the focused Block (at once the first time, or under frozen motion) and hands it the keys with
   * `trapFocus` (the previous one's off; `setActive` blurs what was focused there). A focus naming no Block that is
   * there throws, and the rig stays where it is.
   */
  const apply = (): void => {
    const name = focused.value
    if (!mounted || name === null) return
    const block = blocks.get(name)
    if (!block) throw new GlassUIError('Space.focus', `没有名为 "${name}" 的 Block`, { allowed: [...blocks.keys()], got: name })
    const s = block.surface.value
    if (!s) return
    if (rig && s !== aimed) { void rig.focus(s, { immediate: first || motion === 'frozen' }); first = false; aimed = s }
    if (s !== active) {
      if (active) active.trapFocus = false
      s.trapFocus = true; root.pointer?.setActive(s); active = s
    }
  }
  // after each update (a Block that joined in it counts): the focus, its Block's Surface, and the registrations
  const focusedSurface = computed(() => focused.value === null ? null : blocks.get(focused.value)?.surface.value ?? null)
  watch([focused, focusedSurface, () => [...blocks.keys()].join('\n')], apply, { flush: 'post' })
  watch([() => v.value.camera, () => v.value.parallax], () => { if (mounted) { syncRig(); apply() } }, { flush: 'post' })
  onMounted(() => { mounted = true; syncRig(); apply() })
  onBeforeUnmount(() => { rig?.dispose(); rig = null })

  return () => {
    noAttrs('Space', attrs)
    const children = slots.default?.()
    onlyBlocks(children)
    return children
  }
})
