import { describe, expect, it } from 'vitest'
import { filterOrders, inboundNumber, validateInbound, validateLogin, type InboundForm } from '../src/wms/forms'
import { orders } from '../src/wms/data'

const blank: InboundForm = {
  supplier: '', poNumber: '', sku0: '', qty0: '', sku1: '', qty1: '', sku2: '', qty2: '',
  sampled: false, coldChain: false, note: '',
}

describe('WMS form helpers', () => {
  it('validates login email and password', () => {
    expect(validateLogin({ email: 'a@b', password: '12345' })).toEqual({ email: '请输入有效的邮箱地址', password: '密码至少 6 位' })
    expect(validateLogin({ email: 'li@yuncang.cn', password: '123456' })).toEqual({})
  })

  it('validates inbound fields and each SKU row', () => {
    expect(validateInbound(blank)).toMatchObject({ supplier: expect.any(String), poNumber: expect.any(String), sku0: expect.any(String) })
    expect(validateInbound({ ...blank, supplier: '徐州供应链', poNumber: 'PO-1', sku0: 'SKU-1' })).toMatchObject({ qty0: expect.any(String) })
    expect(validateInbound({ ...blank, supplier: '徐州供应链', poNumber: 'PO-1', qty0: '12' })).toMatchObject({ sku0: expect.any(String) })
    expect(validateInbound({ ...blank, supplier: '徐州供应链', poNumber: 'PO-1', sku0: 'SKU-1', qty0: '12' })).toEqual({})
  })

  it('formats inbound receipt numbers by date and sequence', () => {
    expect(inboundNumber(new Date(2026, 9, 16), 1)).toBe('RK-20261016-001')
  })

  it('filters orders by number, Chinese customer, overdue and today', () => {
    expect(filterOrders(orders, { query: orders[0]!.no, overdueOnly: false, todayOnly: false })).toContain(orders[0])
    const customer = orders.find(o => /[\u4e00-\u9fff]/.test(o.customer))!
    expect(filterOrders(orders, { query: customer.customer.slice(0, 2), overdueOnly: false, todayOnly: false })).toContain(customer)
    expect(filterOrders(orders, { query: '', overdueOnly: true, todayOnly: false }).length).toBeGreaterThan(0)
    expect(filterOrders(orders, { query: '', overdueOnly: false, todayOnly: true }).map(o => o.no)).toEqual([orders.find(o => o.today)!.no])
  })
})
