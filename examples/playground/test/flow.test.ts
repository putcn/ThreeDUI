import { describe, expect, it } from 'vitest'
import { AUTO_ZOOM_MS, arrived, autoZoom, chose, initialFlow, loggedOut, loginSucceeded } from '../src/wms/flow'

describe('the WMS demo flow', () => {
  it('moves login → entering → overview → dashboard once', () => {
    let f = initialFlow({})
    expect(f).toEqual({ stage: 'login', focus: null, standby: true, autoZoomed: false })
    f = loginSucceeded(f)
    expect(f).toMatchObject({ stage: 'entering', standby: false, focus: null })
    const a = arrived(f, null)
    expect(a.autoZoomIn).toBe(AUTO_ZOOM_MS)
    f = a.flow
    expect(f.stage).toBe('overview')
    f = autoZoom(f)
    expect(f).toMatchObject({ stage: 'operating', focus: 'dashboard', autoZoomed: true })
    f = chose(f, null)
    expect(f).toMatchObject({ stage: 'overview', focus: null })
    expect(arrived(f, null).autoZoomIn).toBeNull()
    expect(autoZoom(f)).toEqual(f)
  })

  it('lets a user choice during the overview hold win over auto zoom', () => {
    let f = arrived(loginSucceeded(initialFlow({})), null).flow
    f = chose(f, 'twin')
    expect(autoZoom(f)).toEqual(f)
    expect(f).toMatchObject({ stage: 'operating', focus: 'twin' })
  })

  it('supports direct-entry query states and logout resets the flow', () => {
    expect(initialFlow({ stage: 'overview' })).toEqual({ stage: 'overview', focus: null, standby: false, autoZoomed: true })
    expect(initialFlow({ focus: 'orders' })).toEqual({ stage: 'operating', focus: 'orders', standby: false, autoZoomed: true })
    expect(loggedOut(initialFlow({ focus: 'orders' }))).toEqual(initialFlow({}))
  })
})
