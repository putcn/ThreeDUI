export type Stage = 'login' | 'entering' | 'overview' | 'operating'
export interface Flow { stage: Stage; focus: string | null; standby: boolean; autoZoomed: boolean }
export const AUTO_ZOOM_MS = 1000
export function initialFlow(p: { stage?: 'login' | 'overview'; focus?: string }): Flow {
  if (p.focus) return { stage: 'operating', focus: p.focus, standby: false, autoZoomed: true }
  if (p.stage === 'overview') return { stage: 'overview', focus: null, standby: false, autoZoomed: true }
  return { stage: 'login', focus: null, standby: true, autoZoomed: false }
}
export function loginSucceeded(f: Flow): Flow { return f.stage === 'login' ? { ...f, stage: 'entering', standby: false } : f }
export function arrived(f: Flow, at: string | null): { flow: Flow; autoZoomIn: number | null } {
  if (f.stage === 'entering' && at === null && !f.autoZoomed) return { flow: { ...f, stage: 'overview' }, autoZoomIn: AUTO_ZOOM_MS }
  return { flow: f, autoZoomIn: null }
}
export function autoZoom(f: Flow): Flow {
  return f.stage === 'overview' && f.focus === null && !f.autoZoomed ? { ...f, stage: 'operating', focus: 'dashboard', autoZoomed: true } : f
}
export function chose(f: Flow, focus: string | null): Flow { return { ...f, stage: focus === null ? 'overview' : 'operating', focus, autoZoomed: true } }
export function loggedOut(_f: Flow): Flow { return initialFlow({}) }
