import type { Order } from './data'

/** Local sample credentials only; the demo has no account service. */
export const DEMO_LOGIN = { email: 'demo@fortbrain.ai', password: 'Demo2026!' } as const

export interface InboundForm {
  supplier: string; poNumber: string
  sku0: string; qty0: string; sku1: string; qty1: string; sku2: string; qty2: string
  sampled: boolean; coldChain: boolean; note: string
}
export function validateLogin(form: { email: string; password: string }): { email?: string; password?: string } {
  const errors: { email?: string; password?: string } = {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = '请输入有效的邮箱地址'
  if (form.password.length < 6) errors.password = '密码至少 6 位'
  return errors
}
export function validateInbound(form: InboundForm): Partial<Record<keyof InboundForm, string>> {
  const errors: Partial<Record<keyof InboundForm, string>> = {}
  if (!form.supplier.trim()) errors.supplier = '请选择供应商'
  if (!form.poNumber.trim()) errors.poNumber = '请输入采购单号'
  let complete = false
  for (const i of [0, 1, 2] as const) {
    const sku = form[`sku${i}`].trim(), rawQty = form[`qty${i}`].trim(), qty = Number(rawQty)
    if (sku && !(qty > 0)) errors[`qty${i}`] = '请输入大于 0 的数量'
    else if (!sku && rawQty) errors[`sku${i}`] = '请输入 SKU 编码'
    else if (sku && qty > 0) complete = true
  }
  if (!complete && !errors.sku0 && !errors.qty0 && !errors.sku1 && !errors.qty1 && !errors.sku2 && !errors.qty2) errors.sku0 = '至少填写一行 SKU 和数量'
  return errors
}
export function inboundNumber(date: Date, seq: number): string {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0')
  return `RK-${y}${m}${d}-${String(Math.max(0, Math.floor(seq))).padStart(3, '0')}`
}
export function filterOrders<T extends Order & { overdue?: boolean; today?: boolean }>(orders: readonly T[], filter: { query: string; overdueOnly: boolean; todayOnly: boolean }): T[] {
  const q = filter.query.trim().toLocaleLowerCase()
  return orders.filter(order => (!q || `${order.no} ${order.customer}`.toLocaleLowerCase().includes(q)) && (!filter.overdueOnly || order.overdue === true) && (!filter.todayOnly || order.today === true))
}
