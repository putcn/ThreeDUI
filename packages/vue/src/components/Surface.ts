import { computed, h, inject, markRaw, onBeforeUnmount, provide, shallowRef, Teleport, watch, watchEffect, type InjectionKey } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, type ColorScheme, type Theme } from '@glassui/core'
import type { CreateSurfaceOptions, Surface as RenderSurface } from '@glassui/render'
import { defineGlassComponent } from '../define'
import { useRoot } from '../inject'
import { GLASS_SURFACE } from '../keys'
import { colorOf } from './tokens'

type Layer = 'screen' | 'world'
/** The layer a `<Surface>` without a `layer` prop goes to: the nearest `<ScreenLayer>` / `<WorldLayer>`'s. */
const LAYER: InjectionKey<Layer> = Symbol('glassui.layer')

/**
 * Throws when a layer component, or a `<Surface>`, is given attributes: none of them renders a node of its own (the
 * layers render their slot as it is, a Surface teleports it into the render Surface it makes), so a `tw`, `class`,
 * `style`, `id` or listener would be dropped without a word.
 */
function noAttrs(name: string, attrs: Record<string, unknown>): void {
  for (const k of Object.keys(attrs)) {
    throw new GlassUIError(`${name}.${k}`, `${name} 不接受 ${k}（它自己不渲染节点，${k} 无处可放）：写在内容里的元素上，如 <Box>`)
  }
}

const Vec3 = z.tuple([z.number(), z.number(), z.number()])
const SurfaceProps = z.object({
  layer: z.enum(['screen', 'world']).optional().describe('所在层：screen 屏幕层或 world 世界层；省略时取最近的 <ScreenLayer> / <WorldLayer>，都没有时为 world'),
  width: z.number().positive().describe('宽，pt（fill 时只是初始宽度，之后跟随视口）'),
  height: z.number().positive().describe('高，pt（fill 时只是初始高度，之后跟随视口）'),
  fill: z.boolean().optional().describe('屏幕层：铺满视口，尺寸跟随视口'),
  left: z.number().optional().describe('屏幕层：左上角到视口左边的距离，CSS px（默认 0）'),
  top: z.number().optional().describe('屏幕层：左上角到视口上边的距离，CSS px（默认 0）'),
  center: z.boolean().optional().describe('屏幕层：居中于视口（fill 优先于 center，center 优先于 left / top）'),
  position: Vec3.optional().describe('世界层：Surface 中心的位置 [x, y, z]，世界单位；省略时不动它（创建时在原点）'),
  rotation: Vec3.optional().describe('旋转 [x, y, z]，弧度，XYZ 顺序；省略时不动它（创建时不旋转）'),
  scale: z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])]).optional().describe('缩放：一个数或 [x, y, z]；省略时不动它（创建时为 1）'),
  background: z.string().default('none').describe('背景：none（透明，空白处指针穿过）、glass（整块玻璃面板）或颜色 token / #hex（不透明底色）'),
  radius: z.number().min(0).default(0).describe('Surface 的圆角，pt'),
  billboard: z.boolean().default(false).describe('世界层：每帧转向相机（此时 rotation 不起作用）'),
  interactive: z.boolean().default(true).describe('是否接收指针；false 时指针穿过它'),
  ptPerUnit: z.number().positive().optional().describe('世界层：每个世界单位多少 pt（默认 244）'),
  contentScale: z.number().positive().optional().describe('内容贴图清晰度的倍数（默认 1；大于 1 更清晰，也更占显存）'),
})
type Props = z.output<typeof SurfaceProps>

const SCREEN_ONLY = ['fill', 'left', 'top', 'center'] as const
const WORLD_ONLY = ['position', 'ptPerUnit', 'billboard'] as const
/** Throws for a prop of the other layer (`false` counts as absent) and for a background that is not none, glass or a colour. */
function check(v: Props, layer: Layer, theme: Theme, scheme: ColorScheme): void {
  for (const k of layer === 'world' ? SCREEN_ONLY : WORLD_ONLY) {
    if (v[k] === undefined || v[k] === false) continue
    throw layer === 'world'
      ? new GlassUIError(`Surface.${k}`, '只用于屏幕层：加 layer="screen" 或放进 <ScreenLayer>（世界层的 Surface 用 position / rotation 摆放）')
      : new GlassUIError(`Surface.${k}`, '只用于世界层（layer="world" 或 <WorldLayer>）：屏幕层的 Surface 用 fill、center 或 left / top 摆放，1 pt = 1 CSS px，始终正对屏幕')
  }
  const bg = v.background
  if (bg === 'none' || bg === 'glass') return
  try { colorOf('Surface.background', bg, theme, scheme) } catch (e) {
    if (bg.startsWith('#') || /^rgba?\(/.test(bg)) throw e
    throw new GlassUIError('Surface.background', `未知背景 "${bg}"（none、glass，或颜色 token、#hex）`, { allowed: ['none', 'glass', ...Object.keys(theme.colors[scheme])], got: bg })
  }
}

/** What `root.createSurface` gets: the props a render Surface fixes at creation, absent ones left out. */
function options(v: Props, layer: Layer): CreateSurfaceOptions {
  const o: CreateSurfaceOptions = { layer, width: v.width, height: v.height, background: v.background, cornerRadius: v.radius, billboard: v.billboard, interactive: v.interactive }
  if (v.fill !== undefined) o.fill = v.fill
  if (v.left !== undefined) o.left = v.left
  if (v.top !== undefined) o.top = v.top
  if (v.center !== undefined) o.center = v.center
  if (v.ptPerUnit !== undefined) o.ptPerUnit = v.ptPerUnit
  if (v.contentScale !== undefined) o.contentScale = v.contentScale
  return o
}

export const Surface = defineGlassComponent({
  name: 'Surface',
  description: '一块 Surface：组件画在它上面。屏幕层（layer="screen"）的 Surface 叠在三维场景之上，1 pt = 1 CSS px，用 fill、center 或 left / top 摆放；世界层（layer="world"）的 Surface 是场景里的一块面板，用 position / rotation / scale 摆放（ptPerUnit：每个世界单位多少 pt）。layer 省略时取最近的 <ScreenLayer> / <WorldLayer>，都没有时为 world。默认插槽是它的内容，排在 Surface 的根里（一个与 Surface 同宽高、纵向排列的 flex 盒子）；Surface 自己不渲染节点，tw / class / style 写在内容里的 <Box> 上。background：none 透明（默认，空白处指针穿过）、glass 一整块玻璃面板、颜色 token 或 #hex 不透明底色。layer、fill、left、top、center、background、radius、ptPerUnit、contentScale 在创建时固定，改它们会重建 Surface（内容移进新的 Surface）；width / height、position / rotation / scale、billboard、interactive 就地生效。第一期没有 shadow（Surface 的玻璃投影到场景，castToWorld 还没有效果）。',
  props: SurfaceProps,
  events: { error: { payload: 'Error', description: '该 Surface 的渲染失败（它已停止绘制）' } },
  slots: { default: 'Surface 的内容' },
  examples: [
    '<Surface :width="480" :height="320" :position="[0, 1.4, -2]" :rotation="[0, -0.3, 0]" background="glass" :radius="32"><Stack tw="p-8" :gap="12"><Text value="世界层面板" size="xl" :weight="700" /><Text value="场景里的一块玻璃" color="secondaryLabel" /></Stack></Surface>',
    '<ScreenLayer><Surface fill :width="1280" :height="800"><Box tw="p-6"><Text value="铺满屏幕的 HUD" /></Box></Surface></ScreenLayer>',
    '<Surface layer="screen" center :width="420" :height="280" background="glass" :radius="28"><Stack tw="p-8" :gap="16" align="center"><Text value="登录" size="2xl" :weight="700" /></Stack></Surface>',
  ],
  mistakes: [
    { mistake: '<Surface fill :width="1280" :height="800">（没有 layer）', fix: 'fill、center、left、top 只用于屏幕层：<ScreenLayer><Surface fill …></ScreenLayer> 或 layer="screen"（默认是世界层）' },
    { mistake: '<Surface layer="screen" :position="[0, 1, -2]">', fix: 'position 只用于世界层；屏幕层用 center 或 :left / :top' },
    { mistake: '<Surface tw="p-6">', fix: 'Surface 不接受 tw / class / style：<Surface …><Box tw="p-6">…</Box></Surface>' },
  ],
}, (p, { slots, attrs, emit }) => {
  const root = useRoot(), inherited = inject(LAYER, 'world')
  /** The props with the layer they put the Surface on, once they are valid and fit that layer (else the error). */
  const state = computed((): { v: Props; layer: Layer } | { error: unknown } => {
    try {
      const v = p.value, layer = v.layer ?? inherited
      check(v, layer, root.theme, root.scheme)
      return { v, layer }
    } catch (error) { return { error } }
  })
  // what a render Surface fixes at creation; while the props are invalid it keeps its last value (the Surface stays)
  const key = computed<string | undefined>(prev => {
    const s = state.value
    if ('error' in s) return prev
    const { v, layer } = s
    return JSON.stringify([layer, v.fill, v.left, v.top, v.center, v.background, v.radius, v.ptPerUnit, v.contentScale])
  })
  // the Surface (raw: never a proxy, nor proxies of its nodes, whoever holds it), provided as a ref so a Surface made
  // again is what later `useSurface` reads see
  const surface = shallowRef<RenderSurface | null>(null)
  const forward = (e: { error: Error }): void => { emit('error', e.error) }
  const drop = (): void => {
    const s = surface.value
    if (!s) return
    s.removeEventListener('error', forward)
    root.removeSurface(s)
    surface.value = null
  }
  watch(key, k => {
    const s = state.value
    if (k === undefined || 'error' in s) return
    drop()
    const made = markRaw(root.createSurface(options(s.v, s.layer)))
    made.addEventListener('error', forward)
    surface.value = made
  }, { immediate: true })
  // what applies in place: size (a fill Surface's is its layer's), transform, flags
  watchEffect(() => {
    const s = surface.value, st = state.value
    if (!s || 'error' in st) return
    const { v } = st
    if (!v.fill && (s.model.width !== v.width || s.model.height !== v.height)) s.setSize(v.width, v.height)
    if (v.position) s.position.set(...v.position)
    if (v.rotation) s.rotation.set(...v.rotation)
    if (v.scale !== undefined) { if (typeof v.scale === 'number') s.scale.setScalar(v.scale); else s.scale.set(...v.scale) }
    s.interactive = v.interactive; s.billboard = v.billboard
  })
  provide(GLASS_SURFACE, surface)
  onBeforeUnmount(drop)
  return () => {
    noAttrs('Surface', attrs)
    const st = state.value
    if ('error' in st) throw st.error
    const s = surface.value
    return s ? h(Teleport, { to: s.root }, slots.default?.() ?? []) : null
  }
})

const layerComponent = (name: string, layer: Layer, description: string, examples: string[]) => defineGlassComponent({
  name, description, props: z.object({}), slots: { default: `其中 <Surface> 的默认层（${layer}）` }, examples,
}, (_p, { slots, attrs }) => {
  provide(LAYER, layer)
  return () => { noAttrs(name, attrs); return slots.default?.() }
})

export const ScreenLayer = layerComponent('ScreenLayer', 'screen',
  '屏幕层：其中没有写 layer 的 <Surface> 都放在屏幕层（叠在三维场景之上，1 pt = 1 CSS px，用 fill、center 或 left / top 摆放）。它自己不渲染节点，只渲染默认插槽。',
  ['<ScreenLayer><Surface fill :width="1280" :height="800"><Text value="HUD" /></Surface></ScreenLayer>', '<ScreenLayer><Surface center :width="400" :height="240" background="glass" /></ScreenLayer>'])
export const WorldLayer = layerComponent('WorldLayer', 'world',
  '世界层：其中没有写 layer 的 <Surface> 都是场景里的面板（用 position / rotation / scale 摆放）。没有层组件时 <Surface> 本来就在世界层；它用来在 <ScreenLayer> 里面放回世界层。它自己不渲染节点，只渲染默认插槽。',
  ['<WorldLayer><Surface :width="400" :height="300" :position="[0, 1.5, -2]" background="glass" /></WorldLayer>', '<ScreenLayer><Surface fill :width="1280" :height="800" /><WorldLayer><Surface :width="300" :height="200" :position="[1, 1, -1]" /></WorldLayer></ScreenLayer>'])
