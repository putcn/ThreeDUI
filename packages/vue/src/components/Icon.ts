import { h, onScopeDispose, shallowRef } from '@vue/runtime-core'
import { z } from 'zod'
import { defineGlassComponent } from '../define'
import { useCanvasFactory, useRoot, useScheme } from '../inject'
import { ICON_NAMES, iconCanvas } from '../icons'
import { colorOf } from './tokens'

export const Icon = defineGlassComponent({
  name: 'Icon',
  description: '内置线条图标（SF Symbols 风格：24 单位网格，圆头圆角描边），以 2 倍分辨率画成图片并缓存；颜色 token 按当前主题与明暗模式解析，切换时重绘。apple 是实心标志，google 保留品牌四色。图标与文字并排用 Stack direction="horizontal"。',
  props: z.object({
    name: z.enum(ICON_NAMES).describe('图标名（内置图标之一）'),
    size: z.number().positive().default(24).describe('边长，pt'),
    color: z.string().default('label').describe('颜色 token（label、secondaryLabel、accent…）或 #hex'),
    weight: z.number().positive().max(0.5).default(0.1).describe('描边粗细，占 size 的比例'),
  }),
  examples: [
    '<Icon name="check" :size="20" color="accent" />',
    '<Icon name="search" color="secondaryLabel" />',
    '<Icon name="warning" :size="28" color="danger" :weight="0.12" />',
  ],
  mistakes: [
    { mistake: 'size="20" (a string)', fix: ':size="20"' },
    { mistake: 'name="close"', fix: 'name="x"' },
  ],
  // names from other icon sets → ours, for the error's suggestion only (an alias is still an invalid name)
  aliases: {
    name: {
      close: 'x', cross: 'x', times: 'x', settings: 'gear', cog: 'gear', ok: 'check', tick: 'check', checkmark: 'check',
      back: 'chevron-left', previous: 'chevron-left', prev: 'chevron-left', forward: 'chevron-right', next: 'chevron-right',
      add: 'plus', remove: 'minus', subtract: 'minus', person: 'user', profile: 'user', account: 'user', email: 'mail', envelope: 'mail',
      alert: 'warning', error: 'warning', favorite: 'heart', like: 'heart', hide: 'eye-slash', show: 'eye', password: 'lock', magnifier: 'search',
    },
  },
}, (p) => {
  const root = useRoot(), scheme = useScheme(), createCanvas = useCanvasFactory()
  // the theme too (a `setTheme` with the same scheme swaps the colours the tokens name)
  const theme = shallowRef(root.theme)
  onScopeDispose(root.on('theme', e => { theme.value = e.theme }))
  return () => {
    const { name, size, color, weight } = p.value
    const src = iconCanvas(name, size, colorOf('Icon.color', color, theme.value, scheme.value), weight, createCanvas)
    return h('image', { src, style: { width: size, height: size, flexShrink: 0 } })
  }
})
