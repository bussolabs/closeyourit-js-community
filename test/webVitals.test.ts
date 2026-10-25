// Payload builder for a Web Vital measurement. Backend contract
// `POST …/web_vitals` (CYRA-538): metric/value/hostname/path/navigation_type.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWebVital, normalizeNavigationType, roundWebVital } from '../src/webVitals'

afterEach(() => vi.unstubAllGlobals())

describe('buildWebVital', () => {
  it('builds the measurement with hostname and path of the current page', () => {
    const payload = buildWebVital({ metric: 'lcp', value: 2431.44 })

    expect(payload.metric).toBe('lcp')
    expect(payload.hostname).toBe(location.hostname)
    expect(payload.path).toBe(location.pathname)
    expect(payload.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(payload.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('the path never carries the query string', () => {
    const payload = buildWebVital({
      metric: 'lcp',
      value: 1000,
      path: '/orders?token=secret&q=1',
    })

    expect(payload.path).toBe('/orders')
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('the path never carries the fragment', () => {
    expect(
      buildWebVital({ metric: 'cls', value: 0.1, path: '/faq#privacy' }).path,
    ).toBe('/faq')
  })

  it('rounds the millisecond metrics, and cls to four decimals', () => {
    expect(buildWebVital({ metric: 'lcp', value: 2431.44 }).value).toBe(2431)
    expect(buildWebVital({ metric: 'inp', value: 183.7 }).value).toBe(184)
    expect(buildWebVital({ metric: 'ttfb', value: 412.3 }).value).toBe(412)
    expect(buildWebVital({ metric: 'fcp', value: 1099.5 }).value).toBe(1100)
    expect(buildWebVital({ metric: 'cls', value: 0.123456 }).value).toBe(0.1235)
  })

  it('includes navigation_type only if known to the backend', () => {
    expect(
      buildWebVital({ metric: 'lcp', value: 1, navigationType: 'reload' })[
        'navigation_type'
      ],
    ).toBe('reload')
    expect(
      buildWebVital({ metric: 'lcp', value: 1, navigationType: 'boh' })[
        'navigation_type'
      ],
    ).toBeUndefined()
  })
})

describe('normalizeNavigationType', () => {
  it('translates Navigation Timing back_forward into the backend value', () => {
    expect(normalizeNavigationType('back_forward')).toBe('back-forward')
  })

  it('keeps the already canonical types', () => {
    expect(normalizeNavigationType('navigate')).toBe('navigate')
    expect(normalizeNavigationType('reload')).toBe('reload')
    expect(normalizeNavigationType('prerender')).toBe('prerender')
    expect(normalizeNavigationType('restore')).toBe('restore')
  })

  it('drops unknown types and a missing value', () => {
    expect(normalizeNavigationType('teleport')).toBeUndefined()
    expect(normalizeNavigationType(undefined)).toBeUndefined()
  })

  it('drops the types web-vitals knows but the backend does not', () => {
    // `back-forward-cache` and `soft-navigation` exist in the web-vitals
    // vocabulary, not in the ingest one: sending them would get the send rejected.
    // Better a measurement without a navigation type than a lost measurement.
    expect(normalizeNavigationType('back-forward-cache')).toBeUndefined()
    expect(normalizeNavigationType('soft-navigation')).toBeUndefined()
  })
})

describe('roundWebVital', () => {
  it('cls stays decimal, the ms metrics become integers', () => {
    expect(roundWebVital('cls', 0.00004)).toBe(0)
    expect(roundWebVital('lcp', 0.4)).toBe(0)
    expect(roundWebVital('inp', 0.6)).toBe(1)
    expect(roundWebVital('ttfb', 0.6)).toBe(1)
    expect(roundWebVital('fcp', 0.4)).toBe(0)
  })
})
