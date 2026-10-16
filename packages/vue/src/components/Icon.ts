import { h } from '@vue/runtime-core'
import { z } from 'zod'
import { defineGlassComponent } from '../define'
import { useCanvasFactory, useScheme, useTheme } from '../inject'
import { ICON_ALIASES, ICON_NAMES, iconCanvas } from '../icons'
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
  aliases: { name: ICON_ALIASES },
}, (p) => {
  // the theme too (a `setTheme` with the same scheme swaps the colours the tokens name)
  const scheme = useScheme(), theme = useTheme(), createCanvas = useCanvasFactory()
  return () => {
    const { name, size, color, weight } = p.value
    const src = iconCanvas(name, size, colorOf('Icon.color', color, theme.value, scheme.value), weight, createCanvas)
    return h('image', { src, style: { width: size, height: size, flexShrink: 0 } })
  }
})
