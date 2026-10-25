// Web Vitals collection on top of Google's official library (CYJS-28). Here
// we test the GLUE, not the measurement: `web-vitals` is mocked and its callbacks
// are driven by hand, because what this module must guarantee is the moment
// of sending, the grouping into a single batch and the absence of duplicates — the
// correctness of LCP/INP/CLS is Google's responsibility (and test suite).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metric } from 'web-vitals'
import { onCLS } from 'web-vitals/onCLS.js'
import { onFCP } from 'web-vitals/onFCP.js'
import { onINP } from 'web-vitals/onINP.js'
import { onLCP } from 'web-vitals/onLCP.js'
import { onTTFB } from 'web-vitals/onTTFB.js'
import { Client } from '../src/client'
import { installWebVitals } from '../src/integrations/browser/webVitals'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

vi.mock('web-vitals/onCLS.js', () => ({ onCLS: vi.fn() }))
vi.mock('web-vitals/onFCP.js', () => ({ onFCP: vi.fn() }))
vi.mock('web-vitals/onINP.js', () => ({ onINP: vi.fn() }))
vi.mock('web-vitals/onLCP.js', () => ({ onLCP: vi.fn() }))
vi.mock('web-vitals/onTTFB.js', () => ({ onTTFB: vi.fn() }))

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'proj-1',
  environment: 'production',
  trackWebVitals: true,
}

function harness(options: Partial<CloseYourItOptions> = {}): {
  client: Client
  calls: Array<{ payload: unknown; url: string }>
} {
  const calls: Array<{ payload: unknown; url: string }> = []
  const transport = {
    send: vi.fn((payload: unknown, url: string) => {
      calls.push({ payload, url })
      return true
    }),
    flush: vi.fn(async () => {}),
  }
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport },
  )
  return { client, calls }
}

const REGISTRARS = { LCP: onLCP, CLS: onCLS, INP: onINP, TTFB: onTTFB, FCP: onFCP }

// Delivers a measurement as `web-vitals` would, invoking the callback that
// the integration registered for that metric.
function report(
  name: Metric['name'],
  value: number,
  navigationType: Metric['navigationType'] = 'navigate',
): void {
  const registrar = vi.mocked(REGISTRARS[name])
  // `.calls[0]`, not the last one: registration with web-vitals happens only
  // once per page, and the dispatch registered then stays the only live one.
  const callback = registrar.mock.calls[0]?.[0]
  callback?.({
    name,
    value,
    delta: value,
    id: `v6-${name}`,
    rating: 'good',
    entries: [],
    navigationType,
    navigationId: 1,
  } as Metric)
}

function batchOf(call: { payload: unknown }): EventPayload[] {
  return call.payload as EventPayload[]
}

function metricsIn(call: { payload: unknown }): string[] {
  return batchOf(call)
    .map((entry) => String(entry['metric']))
    .sort()
}

function measure(call: { payload: unknown }, name: string): EventPayload | undefined {
  return batchOf(call).find((entry) => entry['metric'] === name)
}

let uninstall: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  uninstall()
  uninstall = () => {}
  vi.useRealTimers()
  history.pushState({}, '', '/')
})

describe('installWebVitals', () => {
  it('sends LCP, INP, CLS, TTFB and FCP in a single send when the page leaves the stage', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('TTFB', 412.3)
    report('FCP', 980.6)
    report('LCP', 2431.4)
    report('CLS', 0.0812)
    report('INP', 183.7)
    expect(calls).toHaveLength(0)

    window.dispatchEvent(new Event('pagehide'))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/web_vitals')
    expect(metricsIn(calls[0]!)).toEqual(['cls', 'fcp', 'inp', 'lcp', 'ttfb'])
    expect(measure(calls[0]!, 'ttfb')!['value']).toBe(412)
    expect(measure(calls[0]!, 'fcp')!['value']).toBe(981)
    expect(measure(calls[0]!, 'lcp')!['value']).toBe(2431)
    expect(measure(calls[0]!, 'cls')!['value']).toBe(0.0812)
    expect(measure(calls[0]!, 'inp')!['value']).toBe(184)
  })

  it('subscribes only once per page, with the library default behavior', () => {
    const { client } = harness()
    uninstall = installWebVitals(client)

    for (const registrar of Object.values(REGISTRARS)) {
      const calls = vi.mocked(registrar).mock.calls
      // One registration in all, for the whole life of the module: `web-vitals`
      // does not unsubscribe and every call opens new PerformanceObservers that
      // keep working until the end of the page.
      expect(calls).toHaveLength(1)
      // `reportAllChanges` would call the callback on every change: it would be
      // one request per update instead of one per load.
      expect(calls[0]![1]).toBeUndefined()
    }
  })

  it('a reinstall does not open a second round of observers', () => {
    const first = harness()
    const off = installWebVitals(first.client)
    off()

    const second = harness()
    uninstall = installWebVitals(second.client)

    for (const registrar of Object.values(REGISTRARS)) {
      expect(vi.mocked(registrar).mock.calls).toHaveLength(1)
    }

    // And the measurements go to the live client, not to the switched-off one.
    report('LCP', 1700)
    window.dispatchEvent(new Event('pagehide'))

    expect(first.calls).toHaveLength(0)
    expect(second.calls).toHaveLength(1)
    expect(measure(second.calls[0]!, 'lcp')!['value']).toBe(1700)
  })

  it('the hidden tab triggers the send', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

    report('LCP', 900)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(calls).toHaveLength(1)
    expect(measure(calls[0]!, 'lcp')!['value']).toBe(900)
  })

  it('the page becoming visible again triggers nothing', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')

    report('LCP', 900)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(calls).toHaveLength(0)
  })

  it('a metric already sent is not sent again', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('CLS', 0.04)
    window.dispatchEvent(new Event('pagehide'))
    // The page stayed alive and the CLS grew: web-vitals reports it
    // again. Two values from the same load inside a percentile skew it
    // more than a value frozen at the first send.
    report('CLS', 0.31)
    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(10_000)

    expect(calls).toHaveLength(1)
    expect(measure(calls[0]!, 'cls')!['value']).toBe(0.04)
  })

  it('until the batch has left the most recent value counts', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    // The CLS grows while the page is still open: it is the same measurement being
    // updated, not two measurements.
    report('CLS', 0.04)
    report('CLS', 0.19)
    window.dispatchEvent(new Event('pagehide'))

    expect(metricsIn(calls[0]!)).toEqual(['cls'])
    expect(measure(calls[0]!, 'cls')!['value']).toBe(0.19)
  })

  it('without collected measurements no request leaves', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(10_000)

    expect(calls).toHaveLength(0)
  })

  it('attributes the measurements to the loaded page, not to the last SPA route', () => {
    const { client, calls } = harness()
    history.pushState({}, '', '/catalog')
    uninstall = installWebVitals(client)

    report('LCP', 2000)
    history.pushState({}, '', '/cart')
    window.dispatchEvent(new Event('pagehide'))

    expect(measure(calls[0]!, 'lcp')!['path']).toBe('/catalog')
  })

  it('attaches the navigation type translated into the backend vocabulary', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('LCP', 1500, 'back-forward')
    window.dispatchEvent(new Event('pagehide'))

    expect(measure(calls[0]!, 'lcp')!['navigation_type']).toBe('back-forward')
  })

  it('a navigation type the ingest does not know does not block the measurement', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('LCP', 1500, 'back-forward-cache')
    window.dispatchEvent(new Event('pagehide'))

    expect(measure(calls[0]!, 'lcp')!['value']).toBe(1500)
    expect(measure(calls[0]!, 'lcp')).not.toHaveProperty('navigation_type')
  })

  it('before the page leaves the courtesy timer sends nothing', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    // TTFB and FCP are final after a few moments, LCP/CLS/INP are not: sending them
    // right away would mean two requests per load instead of one.
    report('TTFB', 300)
    report('FCP', 800)
    vi.advanceTimersByTime(60_000)

    expect(calls).toHaveLength(0)
  })

  it('the measurement arriving after the first send leaves within five seconds', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('TTFB', 300)
    window.dispatchEvent(new Event('pagehide'))
    expect(calls).toHaveLength(1)

    // After the page leaves there is no second `pagehide` to count on: a
    // late measurement would stay in the buffer forever.
    report('INP', 250)
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(5000)

    expect(calls).toHaveLength(2)
    expect(metricsIn(calls[1]!)).toEqual(['inp'])
  })

  it('late measurements arriving together leave in a single send', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('TTFB', 300)
    window.dispatchEvent(new Event('pagehide'))

    report('LCP', 2100)
    vi.advanceTimersByTime(2000)
    report('CLS', 0.02)
    vi.advanceTimersByTime(5000)

    expect(calls).toHaveLength(2)
    expect(metricsIn(calls[1]!)).toEqual(['cls', 'lcp'])
  })

  it('a new page exit does not wait for the courtesy, and does not leave the timer on', () => {
    const { client, calls } = harness()
    uninstall = installWebVitals(client)

    report('TTFB', 300)
    window.dispatchEvent(new Event('pagehide'))
    report('LCP', 2100)

    // The page leaves the stage again before the five seconds: the pending
    // measurement leaves immediately, and the already armed timer must be switched off — otherwise
    // it would fire later on an empty buffer, with the SDK possibly already closed.
    window.dispatchEvent(new Event('pagehide'))
    expect(calls).toHaveLength(2)
    expect(metricsIn(calls[1]!)).toEqual(['lcp'])

    vi.advanceTimersByTime(10_000)
    expect(calls).toHaveLength(2)
  })

  it('teardown sends the collected measurements and ignores the later ones', () => {
    const { client, calls } = harness()
    const off = installWebVitals(client)

    report('LCP', 1500)
    off()

    expect(calls).toHaveLength(1)
    expect(measure(calls[0]!, 'lcp')!['value']).toBe(1500)

    // `web-vitals` does not unsubscribe: its callbacks stay alive and must
    // find the door closed, otherwise a later `init` would see measurements
    // from the previous configuration.
    report('INP', 400)
    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(10_000)

    expect(calls).toHaveLength(1)
  })
})
