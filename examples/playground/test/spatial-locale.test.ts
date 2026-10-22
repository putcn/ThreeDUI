import { describe, expect, it } from 'vitest'
import { alerts, bins, CATEGORIES, kpis, laneSummary, lanesOf, network, orders, stock, zones } from '../src/wms/data'
import { translateSpatialText as en } from '../src/wms/locale'

describe('spatial demo English copy', () => {
  it('localizes the generated data displayed across all six views', () => {
    const visible = [
      ...kpis.map(item => item.label), ...CATEGORIES, ...stock.cols, ...zones.map(zone => zone.label),
      ...bins.map(bin => bin.name), ...orders.flatMap(order => [order.customer, order.status]),
      ...alerts.flatMap(alert => [alert.title, alert.detail, alert.time]),
      ...network.locations.flatMap(place => [place.name, place.district]),
      ...network.locations.flatMap(place => {
        const { inbound, outbound } = lanesOf(network, place.id)
        return [laneSummary(network, inbound, 'in'), laneSummary(network, outbound, 'out')]
      }),
    ]
    expect(visible.map(en).filter(text => /[\u3400-\u9fff]/u.test(text))).toEqual([])
  })

  it('keeps map and order identifiers intact', () => {
    expect(en('星河超市 · 黄楼店')).toBe('Xinghe Market · Huanglou Store')
    expect(en('C-06-2')).toBe('C-06-2')
  })
})
