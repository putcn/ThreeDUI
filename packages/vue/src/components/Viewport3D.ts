import { computed, h, onBeforeUnmount, shallowRef, toRaw, watch } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, type Node, type UIEvent } from '@glassui/core'
import type { Attach3DOptions, Surface, Viewport3DContext } from '@glassui/render'
import { defineGlassComponent } from '../define'
import { useSurfaceRef } from '../inject'
import { isHeld } from '../renderer'

const EVENT = 'UIEvent，object 为命中的 Object3D（不在物体上时缺省）'

const Viewport3DProps = z.object({
  object: z.custom<object>(v => typeof v === 'object' && v !== null, '需要一个 three.js 的 Object3D').describe(
    '要挂的 three.js 物体（Object3D：Mesh、Group…），原点放在盒子中心。用 shallowRef 或 markRaw 持有它（深层 ref 会把它包成代理）；换成另一个物体时先卸下旧的。Viewport3D 不销毁物体：几何体与材质由你在不用时 dispose'),
  depth: z.number().positive().optional().describe('pt：物体从所贴的面最多凸出多高，用来框定阴影范围；默认取盒子的宽'),
  update: z.custom<(dt: number, ctx: Viewport3DContext) => boolean>(v => typeof v === 'function', '需要一个函数 (dt, ctx) => boolean').optional().describe(
    '每帧调用 (dt, ctx) => boolean：dt 是秒，ctx 是 { width, height, reducedMotion, theme, scheme }（width / height 为盒子的 pt 尺寸）；返回 true 表示还要下一帧（动画没停）'),
})

export const Viewport3D = defineGlassComponent({
  name: 'Viewport3D',
  description: '通用 3D 插槽：一个布局盒（默认 alignSelf: stretch、高 200 pt），把一个 three.js 物体挂在上面，随所在的 Block 一起移动、淡入淡出、飞走。物体的坐标：原点在盒子中心，z = 0 在盒子所贴的面上（最近的玻璃祖先如 Card 的顶面，没有就是 Block 的内容面），x 向右、y 向上、z 朝外，1 个单位 = 1 pt。指针打在物体上算打在这个盒子上：pointerenter / pointerleave / pointermove / click 的事件带 object（命中的 Object3D）。只能用在世界层（<Block> 或世界层 <Surface> 里），不能放进 scroll。tw / class / style 落到盒子上（如 :style="{ height: 320 }"）。柱状图直接用 <BarChart3D>。',
  props: Viewport3DProps,
  events: {
    pointerenter: { payload: EVENT, description: '指针进入盒子或其上的物体' },
    pointerleave: { payload: EVENT, description: '指针离开盒子与物体' },
    pointermove: { payload: EVENT, description: '指针在盒子或物体上移动；在物体上时 object 是命中的那个（如一根柱子），用它的 userData 区分' },
    click: { payload: EVENT, description: '点击盒子或物体；点在物体上时 object 是命中的那个' },
  },
  examples: [
    '<Space><Block name="model" :width="560" :height="480"><Text value="模型预览" size="2xl" :weight="700" /><Card><Viewport3D :object="model" :depth="120" :style="{ height: 260 }" /></Card></Block></Space>',
    '<Space><Block name="spin" :width="488" :height="400"><Viewport3D :object="cube" :update="spin" @click="e => picked = e.object" /></Block></Space>',
    '<Space><Block name="globe" :width="600" :height="520"><Viewport3D :object="globe" :style="{ flexGrow: 1 }" @pointermove="e => hovered = e.object ?? null" @pointerleave="hovered = null" /></Block></Space>',
  ],
  mistakes: [
    { mistake: 'const mesh = ref(new Mesh(geometry, material))（深层 ref 持有 three 物体）', fix: 'const mesh = shallowRef(new Mesh(geometry, material)) 或 markRaw(new Mesh(…))：深层 ref 把物体包成代理，three 读它的只读属性时会报错' },
    { mistake: '<ScreenLayer><Surface …><Viewport3D :object="mesh" /></Surface></ScreenLayer>（放在屏幕层）', fix: '3D 物体只挂在世界层：放进 <Space> 里的 <Block>（或世界层的 <Surface>）' },
    { mistake: '把 Viewport3D 放进可滚动的 scroll 里', fix: '本期不支持裁剪 3D 物体：放在 scroll 外，Block 的高度给够' },
  ],
}, (p, { emit }) => {
  const surface = useSurfaceRef()
  /** The last valid props: while they are invalid the attachment stays as it was (the render reports the error). */
  const v = computed<z.output<typeof Viewport3DProps> | null>(prev => { try { return p.value } catch { return prev ?? null } })
  const node = shallowRef<Node | null>(null)
  /** The current attachment's detach (it stays bound to the Surface it was made on). */
  let detach: (() => void) | null = null
  const release = (): void => { const d = detach; detach = null; d?.() }

  // after the render: the box is in its Surface (a Surface made again has the content by then)
  watch([surface, node, () => v.value?.object, () => v.value?.depth, () => v.value?.update], ([s, n, object, depth, update]) => {
    release()
    if (!s || !n || object === undefined) return
    for (let a = n.parent; a; a = a.parent) if (a.type === 'scroll') throw new GlassUIError('Viewport3D', '不能放在 scroll 里：本期不支持裁剪 3D 物体')
    const opts: Attach3DOptions = {}
    if (depth !== undefined) opts.depth = depth
    if (update !== undefined) opts.update = update
    // raw: a reactive proxy of a three object breaks three (read-only properties); the render checks it is an Object3D
    detach = s.attach3D(n, toRaw(object) as Parameters<Surface['attach3D']>[1], opts)
  }, { flush: 'post' })
  // in a leaving Block the object flies out with the content: the Surface's dispose takes it off
  onBeforeUnmount(() => { const n = node.value; if (!(n && isHeld(n))) release() })

  const on = (type: 'pointerenter' | 'pointerleave' | 'pointermove' | 'click') => (e: UIEvent): void => { emit(type, e) }
  const handlers = { onPointerenter: on('pointerenter'), onPointerleave: on('pointerleave'), onPointermove: on('pointermove'), onClick: on('click') }
  return () => h('box', { ref: node, style: { alignSelf: 'stretch', height: 200 }, ...handlers }, [])
})
