export type DemoLocale = 'zh' | 'en'

const STORAGE_KEY = 'glassui-demo-language'

export function resolveDemoLocale(search: string, saved: string | null, browserLanguage: string): DemoLocale {
  const requested = new URLSearchParams(search).get('lang')
  if (requested === 'zh' || requested === 'en') return requested
  if (saved === 'zh' || saved === 'en') return saved
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function getDemoLocale(): DemoLocale {
  let saved: string | null = null
  try { saved = localStorage.getItem(STORAGE_KEY) } catch { /* Storage can be disabled; the URL still works. */ }
  return resolveDemoLocale(location.search, saved, navigator.language)
}

export function setDemoLocale(locale: DemoLocale): void {
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* Keep the choice in the URL. */ }
  const url = new URL(location.href)
  url.searchParams.set('lang', locale)
  history.replaceState(null, '', url)
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
}
