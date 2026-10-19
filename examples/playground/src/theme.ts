import { defaultTheme, type Theme } from '@glassui/core'

/** Small captions sit on refractive glass backplates: lift only the playground's dark text tokens for contrast. */
export const playgroundTheme = (): Theme => ({
  ...defaultTheme,
  colors: {
    ...defaultTheme.colors,
    dark: { ...defaultTheme.colors.dark, label: '#ffffff', secondaryLabel: '#f2f2f7', tertiaryLabel: '#e4e4ed' },
  },
})
