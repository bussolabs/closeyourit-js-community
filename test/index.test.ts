import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as CloseYourIt from '../src/index'
import { emptyStatsSnapshot } from '../src/stats'

// Browser (jsdom): the credential is the DSN public key (CYJS-1). Events
// go to the /store drop-in; the non-event channels stay on the v1 paths.
const config = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ status: 202 } as Response))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await CloseYourIt.close()
  vi.unstubAllGlobals()
})

it('exposes the current facade client without creating or replacing it', async () => {
  expect(CloseYourIt.getClient()).toBeNull()
  const client = CloseYourIt.init({ ...config, autoInstall: false })
  expect(CloseYourIt.getClient()).toBe(client)
  await CloseYourIt.close()
  expect(CloseYourIt.getClient()).toBeNull()
})

describe('facade — initial state', () => {
  it('is a no-op before init', () => {
    expect(CloseYourIt.isEnabled()).toBe(false)
    expect(CloseYourIt.getTraceId()).toBeUndefined()
    expect(CloseYourIt.getStats()).toEqual(emptyStatsSnapshot())
    // No crash calling the APIs without init.
    CloseYourIt.captureException(new Error('x'))
    CloseYourIt.captureMessage('y')
    CloseYourIt.log('info', 'z')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('facade — W3C propagation (CYJS-13)', () => {
  const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

  it('pre-init: getTraceHeaders is {} and continueTrace does not throw', () => {
    expect(CloseYourIt.getTraceHeaders('/x')).toEqual({})
    expect(() => CloseYourIt.continueTrace({ traceparent: VALID })).not.toThrow()
  })

  it('post-init: continueTrace adopts the trace, getTraceHeaders propagates only to trusted hosts', () => {
    CloseYourIt.init({ ...config, tracePropagationTargets: ['api.internal'] })
    CloseYourIt.continueTrace({ traceparent: VALID })
    expect(CloseYourIt.getTraceId()).toBe(TRACE)
    expect(
      CloseYourIt.getTraceHeaders('https://api.internal/x')['traceparent'],
    ).toContain(TRACE)
    expect(CloseYourIt.getTraceHeaders('https://evil.com/x')).toEqual({})
  })
})

describe('facade — init', () => {
  it('stays a no-op with an incomplete config and is superseded by a valid init', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    CloseYourIt.init({ ...config, publicKey: '' })
    expect(CloseYourIt.isEnabled()).toBe(false)

    CloseYourIt.init(config)
    expect(CloseYourIt.isEnabled()).toBe(true)
    expect(typeof CloseYourIt.getTraceId()).toBe('string')
    warn.mockRestore()
  })

  it('warns (console.warn) on an incomplete config — no longer a silent no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    CloseYourIt.init({ ...config, publicKey: '' })
    expect(CloseYourIt.isEnabled()).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publicKey missing'))
    warn.mockRestore()
  })

  it('does NOT warn when disabling is intended (enabled: false)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    CloseYourIt.init({ ...config, enabled: false })
    expect(CloseYourIt.isEnabled()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is idempotent: a second valid init does not recreate the client', () => {
    const first = CloseYourIt.init(config)
    const second = CloseYourIt.init(config)
    expect(second).toBe(first)
  })
})

describe('facade — re-init (hot reconfiguration, CYJS-8)', () => {
  it('re-init with different options puts the new configuration in use', () => {
    CloseYourIt.init({ ...config, projectId: 'old' })
    CloseYourIt.init({ ...config, projectId: 'new' })
    CloseYourIt.captureException(new Error('boom'))

    const storeCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('/store'),
    )
    expect(storeCalls).toHaveLength(1)
    expect(storeCalls[0]![0] as string).toContain('/api/new/store')
  })

  it('re-init with different options drains the previous client towards its configuration', async () => {
    const closeSpy = vi.spyOn(CloseYourIt.Client.prototype, 'close')
    CloseYourIt.init({ ...config, projectId: 'old' })
    // Buffered log: not yet sent before the teardown of the old client.
    CloseYourIt.log('info', 'queued')
    expect(
      fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/logs')),
    ).toHaveLength(0)

    CloseYourIt.init({ ...config, projectId: 'new' })
    expect(closeSpy).toHaveBeenCalledTimes(1)
    // Waits for the flush + the in-flight sends started by closing the old client.
    await closeSpy.mock.results[0]!.value

    const logCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/logs'))
    expect(logCall).toBeDefined()
    expect(logCall![0] as string).toContain('/projects/old/logs')
    closeSpy.mockRestore()
  })

  it('re-init with equivalent options neither recreates nor closes the client (idempotent)', () => {
    const closeSpy = vi.spyOn(CloseYourIt.Client.prototype, 'close')
    const first = CloseYourIt.init(config)
    // Distinct object, same resolved configuration: it must stay a no-op.
    const second = CloseYourIt.init({ ...config })
    expect(second).toBe(first)
    expect(closeSpy).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it('flush() waits for the previous client to drain (no loss)', async () => {
    CloseYourIt.init({ ...config, projectId: 'old' })
    CloseYourIt.log('info', 'queued') // buffered on the old client
    CloseYourIt.init({ ...config, projectId: 'new' })

    // the facade flush() also waits for the in-flight close of the old client.
    await CloseYourIt.flush()

    const logCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/logs'))
    expect(logCall).toBeDefined()
    expect(logCall![0] as string).toContain('/projects/old/logs')
  })

  it('re-init preserves the current scope (user, tags, trace_id)', () => {
    CloseYourIt.init({ ...config, projectId: 'old' })
    CloseYourIt.setUser({ id: 'u1' })
    CloseYourIt.setTag('area', 'checkout')
    const trace = CloseYourIt.getTraceId()

    CloseYourIt.init({ ...config, projectId: 'new' })
    expect(CloseYourIt.getTraceId()).toBe(trace)

    CloseYourIt.captureMessage('hello')
    const storeCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('/store'),
    )
    const body = JSON.parse((storeCall![1] as RequestInit).body as string)
    expect(body.user).toEqual({ id: 'u1' })
    expect(body.tags).toEqual({ area: 'checkout' })
    expect(body.trace_id).toBe(trace)
  })

  it('is idempotent with a disabled client too (does not close and recreate it)', () => {
    const closeSpy = vi.spyOn(CloseYourIt.Client.prototype, 'close')
    const first = CloseYourIt.init({ ...config, enabled: false })
    const second = CloseYourIt.init({ ...config, enabled: false })
    expect(second).toBe(first)
    expect(closeSpy).not.toHaveBeenCalled()
    closeSpy.mockRestore()
  })

  it('an init during a pending close() stays active (no late reset)', async () => {
    CloseYourIt.init({ ...config, projectId: 'old' })
    const closing = CloseYourIt.close() // in flight, not awaited
    CloseYourIt.init({ ...config, projectId: 'new' }) // concurrent re-init
    await closing

    expect(CloseYourIt.isEnabled()).toBe(true)
    CloseYourIt.captureException(new Error('boom'))
    const storeCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes('/store'),
    )
    expect(storeCall![0] as string).toContain('/api/new/store')
  })
})

describe('facade — capture', () => {
  it('captureException sends to the /store drop-in with ?sentry_key= (browser DSN)', () => {
    CloseYourIt.init(config)
    CloseYourIt.captureException(new Error('boom'))

    expect(CloseYourIt.getStats().enqueued).toBe(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toBe(
      'https://www.closeyour.it/api/p/store?sentry_key=a1b2c3d4e5f60718293a4b5c6d7e8f90',
    )
  })

  it('captureMessage includes the scope that was set', () => {
    CloseYourIt.init(config)
    CloseYourIt.setUser({ id: 'acc_1' })
    CloseYourIt.setTag('area', 'checkout')
    CloseYourIt.setExtra('plan', 'pro')
    CloseYourIt.setContext('billing', { seats: 3 })
    CloseYourIt.captureMessage('hello')

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.user).toEqual({ id: 'acc_1' })
    expect(body.tags).toEqual({ area: 'checkout' })
    expect(body.message).toEqual({ formatted: 'hello' })
  })

  it('log sends in batches to the logs endpoint on flush', async () => {
    CloseYourIt.init(config)
    CloseYourIt.log('info', 'order created', { order_id: 1 })
    await CloseYourIt.flush()

    const call = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/logs'))
    expect(call).toBeDefined()
    const batch = JSON.parse((call![1] as RequestInit).body as string)
    expect(Array.isArray(batch)).toBe(true)
    expect(batch[0].message).toBe('order created')
  })

  it('setTraceId propagates the trace_id to events', () => {
    CloseYourIt.init(config)
    CloseYourIt.setTraceId('trace-42')
    CloseYourIt.captureMessage('x')
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.trace_id).toBe('trace-42')
  })
})

describe('facade — measure, logger, setTags', () => {
  it('measure delegates to the client and returns the value', () => {
    CloseYourIt.init(config)
    expect(CloseYourIt.measure('op', () => 7)).toBe(7)
  })

  it('pre-init measure still runs the body (no-op on the metric)', () => {
    expect(CloseYourIt.measure('op', () => 'ok')).toBe('ok')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('measure with an empty label throws TypeError even pre-init', () => {
    expect(() => CloseYourIt.measure('', () => 1)).toThrow(TypeError)
  })

  it('logger writes to the log batch with warn→warning', async () => {
    CloseYourIt.init(config)
    CloseYourIt.logger.warn('heads up', { area: 'cache' })
    await CloseYourIt.flush()

    const call = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/logs'))
    const batch = JSON.parse((call![1] as RequestInit).body as string)
    expect(batch[0].level).toBe('warning')
    expect(batch[0].message).toBe('heads up')
  })

  it('logger is null-safe pre-init', () => {
    expect(() => CloseYourIt.logger.error('x')).not.toThrow()
  })

  it('setTags sets multiple tags', () => {
    CloseYourIt.init(config)
    CloseYourIt.setTags({ a: '1', b: '2' })
    CloseYourIt.captureMessage('x')
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.tags).toEqual({ a: '1', b: '2' })
  })
})

describe('facade — pageview', () => {
  function pageviewCalls(): unknown[][] {
    return fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/pageviews'))
  }

  it('does not track pageviews by default (trackPageviews false)', () => {
    CloseYourIt.init(config)
    expect(pageviewCalls()).toHaveLength(0)
  })

  it('with trackPageviews:true emits the initial pageview on load', () => {
    CloseYourIt.init({ ...config, trackPageviews: true })

    const calls = pageviewCalls()
    expect(calls).toHaveLength(1)
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(typeof body.hostname).toBe('string')
    expect(typeof body.path).toBe('string')
    expect(body.environment).toBe('production')
    expect(typeof body.event_id).toBe('string')
  })

  it('with trackPageviews:true emits a pageview on every pathname change', () => {
    history.replaceState({}, '', '/uno')
    CloseYourIt.init({ ...config, trackPageviews: true }) // initial
    history.pushState({}, '', '/due')
    expect(pageviewCalls()).toHaveLength(2)
  })

  it('manual capturePageview sends to the pageviews endpoint even without auto-tracking', () => {
    CloseYourIt.init(config)
    CloseYourIt.capturePageview({ path: '/virtuale' })

    const calls = pageviewCalls()
    expect(calls).toHaveLength(1)
    const body = JSON.parse((calls[0]![1] as RequestInit).body as string)
    expect(body.path).toBe('/virtuale')
  })

  it('capturePageview is null-safe pre-init (no send)', () => {
    expect(() => CloseYourIt.capturePageview()).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('facade — close', () => {
  it('after close the APIs go back to no-op', async () => {
    CloseYourIt.init(config)
    await CloseYourIt.close()
    expect(CloseYourIt.isEnabled()).toBe(false)
    expect(CloseYourIt.getStats()).toEqual(emptyStatsSnapshot())
  })
})

describe('facade — diagnostics (CYJS-9)', () => {
  it('getStats distinguishes the drop reasons (sampling and beforeSend)', async () => {
    CloseYourIt.init({ ...config, sampleRate: 0 })
    CloseYourIt.captureException(new Error('discarded by sampling'))
    expect(CloseYourIt.getStats().reasons.sample_rate).toBe(1)
    expect(CloseYourIt.getStats().dropped).toBe(1)
    await CloseYourIt.close()

    CloseYourIt.init({ ...config, beforeSend: () => null })
    CloseYourIt.captureException(new Error('discarded by beforeSend'))
    const stats = CloseYourIt.getStats()
    expect(stats.reasons.before_send).toBe(1)
    expect(stats.reasons.sample_rate).toBe(0)
    expect(stats.dropped).toBe(1)
  })

  it('notifies enqueue and then send along the happy path', async () => {
    const events: string[] = []
    CloseYourIt.init({ ...config, onDiagnostic: (event) => events.push(event) })
    CloseYourIt.captureException(new Error('boom'))
    await CloseYourIt.flush()
    expect(events).toContain('enqueue')
    expect(events).toContain('send')
  })

  it('notifies the drop with the reason when beforeSend returns null', () => {
    const details: unknown[] = []
    CloseYourIt.init({
      ...config,
      beforeSend: () => null,
      onDiagnostic: (event, d) => {
        if (event === 'drop') details.push(d)
      },
    })
    CloseYourIt.captureException(new Error('boom'))
    expect(details).toEqual([{ reason: 'before_send' }])
  })

  it('diagnostics do not generate additional CloseYourIt events (not recursive)', async () => {
    // The callback tries to generate telemetry: it must be suppressed, so
    // consulting diagnostics does not produce new sends (CYJS-9 scenario).
    CloseYourIt.init({
      ...config,
      onDiagnostic: () => {
        CloseYourIt.captureException(new Error('from the callback'))
        CloseYourIt.captureMessage('from the callback')
        CloseYourIt.log('error', 'from the callback')
      },
    })
    CloseYourIt.captureException(new Error('real event'))
    await CloseYourIt.flush()
    // A single send: the real event. The callback did not enqueue any others.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(CloseYourIt.getStats().enqueued).toBe(1)
  })

  it('notifies shutdown last, with the final snapshot after the drain', async () => {
    const events: string[] = []
    let snapshot: { enqueued: number; sent: number } | undefined
    CloseYourIt.init({
      ...config,
      onDiagnostic: (event, d) => {
        events.push(event)
        if (event === 'shutdown') snapshot = d.stats
      },
    })
    CloseYourIt.captureException(new Error('boom'))
    await CloseYourIt.close()
    // The snapshot also reflects the send completed during the drain (sent: 1),
    // not just the enqueue: shutdown is emitted AFTER flush.
    expect(snapshot).toMatchObject({ enqueued: 1, sent: 1 })
    // shutdown is the last event: no diagnostic follows it.
    expect(events).toContain('send')
    expect(events[events.length - 1]).toBe('shutdown')
  })
})
