import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

// In the browser (jsdom) the credential is the DSN public key: events go to the
// /store drop-in and the secret bearer is never used (CYJS-1).
const PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: PUBLIC_KEY,
  projectId: 'p',
  environment: 'production',
}

interface FakeTransport {
  send: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  calls: Array<{ payload: unknown; url: string }>
}

function fakeTransport(): FakeTransport {
  const calls: Array<{ payload: unknown; url: string }> = []
  return {
    calls,
    send: vi.fn((payload: unknown, url: string) => {
      calls.push({ payload, url })
      return true
    }),
    flush: vi.fn(async () => {}),
  }
}

function makeClient(
  options: Partial<CloseYourItOptions> = {},
  random = () => 0,
  nowMs?: () => number,
): { client: Client; transport: FakeTransport } {
  const transport = fakeTransport()
  const client = new Client(
    { ...base, ...options },
    {
      transport: transport as unknown as Transport,
      random,
      ...(nowMs ? { nowMs } : {}),
    },
  )
  return { client, transport }
}

// Injectable clock that advances by [stepMs] on every read (start/end of measure).
function steppingClock(stepMs: number): () => number {
  let t = 0
  return () => {
    const current = t
    t += stepMs
    return current
  }
}

describe('Client — error capture', () => {
  it('is a no-op when disabled (publicKey missing in the browser)', () => {
    const { client, transport } = makeClient({ publicKey: '' })
    client.captureException(new Error('x'))
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('sends an error event to the /store drop-in (browser DSN) and counts enqueued', () => {
    const { client, transport } = makeClient()
    client.captureException(new Error('boom'), { handled: true })

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]!.url).toBe('https://www.closeyour.it/api/p/store')
    const payload = transport.calls[0]!.payload as EventPayload
    const exc = payload['exception'] as { values: Array<{ value: string }> }
    expect(exc.values[0]!.value).toBe('boom')
    expect(typeof payload['trace_id']).toBe('string')
    expect(client.stats.get('enqueued')).toBe(1)
  })

  it('in the browser it does NOT emit server_name (hostname is server-only, CYJS-3)', () => {
    const { client, transport } = makeClient()
    client.captureException(new Error('boom'))
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload).not.toHaveProperty('server_name')
  })

  it('deduplicates identical errors within the window', () => {
    const { client, transport } = makeClient()
    // Same instance captured twice: type, message and crash frame are
    // identical → second capture discarded by the dedup (parity with dart's
    // identity dedup). Two `new Error('same')` on different lines would have
    // different stacks — and therefore keys: they are distinct errors.
    const error = new Error('same')
    client.captureException(error)
    client.captureException(error)
    expect(transport.send).toHaveBeenCalledTimes(1)
  })

  it('respects sampleRate (drop when random >= rate)', () => {
    const { client, transport } = makeClient({ sampleRate: 0.5 }, () => 0.9)
    client.captureException(new Error('x'))
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('sends when random < rate', () => {
    const { client, transport } = makeClient({ sampleRate: 0.5 }, () => 0.1)
    client.captureException(new Error('x'))
    expect(transport.send).toHaveBeenCalledTimes(1)
  })

  it('the same Error object is not sent twice even after the window expired', () => {
    const { client, transport } = makeClient()
    const error = new Error('same')
    client.captureException(error)
    // Simulates time passing beyond the window: the time key
    // would expire, but the object identity stays marked (WeakSet).
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    client.captureException(error)
    vi.useRealTimers()
    expect(transport.send).toHaveBeenCalledTimes(1)
  })

  it('marks the error as captured BEFORE sampling (gem parity)', () => {
    let random = 0.9
    const { client, transport } = makeClient({ sampleRate: 0.5 }, () => random)
    const error = new Error('x')
    client.captureException(error) // sampled out, but marked
    random = 0.1
    client.captureException(error) // already captured → not sent
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('excludedExceptions discards by error.name', () => {
    const { client, transport } = makeClient({
      excludedExceptions: ['AbortError'],
    })
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    client.captureException(aborted)
    expect(transport.send).not.toHaveBeenCalled()

    client.captureException(new TypeError('real'))
    expect(transport.send).toHaveBeenCalledTimes(1)
  })
})

describe('Client — messages and scope', () => {
  it('captureMessage sends message.formatted with the scope', () => {
    const { client, transport } = makeClient()
    client.setUser({ id: 'acc_1' })
    client.setTag('area', 'checkout')
    client.captureMessage('cache miss', 'warning')

    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['message']).toEqual({ formatted: 'cache miss' })
    expect(payload['user']).toEqual({ id: 'acc_1' })
    expect(payload['tags']).toEqual({ area: 'checkout' })
  })

  it('clearScope resets user/tags', () => {
    const { client, transport } = makeClient()
    client.setUser({ id: '1' })
    client.clearScope()
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload).not.toHaveProperty('user')
  })

  it('addBreadcrumb is a no-op when breadcrumbs are disabled', () => {
    const { client, transport } = makeClient({ breadcrumbs: false })
    client.addBreadcrumb({ message: 'click' })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload).not.toHaveProperty('breadcrumbs')
  })
})

describe('Client — PII and request context', () => {
  it('without sendPii user is reduced to {id}', () => {
    const { client, transport } = makeClient()
    client.setUser({ id: 'acc_1', email: 'a@b.com', plan: 'pro' })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['user']).toEqual({ id: 'acc_1' })
  })

  it('with sendPii user travels whole', () => {
    const { client, transport } = makeClient({ sendPii: true })
    client.setUser({ id: 'acc_1', plan: 'pro' })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['user']).toEqual({ id: 'acc_1', plan: 'pro' })
  })

  it('attaches the automatic request context to events (jsdom)', () => {
    const { client, transport } = makeClient()
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    const request = payload['request'] as Record<string, unknown>
    expect(typeof request['url']).toBe('string')
    expect(String(request['url'])).not.toContain('?')
  })

  it('captureRequest:false disables the automatic request', () => {
    const { client, transport } = makeClient({ captureRequest: false })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload).not.toHaveProperty('request')
  })

  it('manual setRequest wins over the automatic provider', () => {
    const { client, transport } = makeClient()
    client.scope.setRequest({ url: 'https://manual' })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['request']).toEqual({ url: 'https://manual' })
  })

  it('setTags delegates to the scope', () => {
    const { client, transport } = makeClient()
    client.setTags({ a: '1', b: '2' })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['tags']).toEqual({ a: '1', b: '2' })
  })
})

describe('Client — logs', () => {
  it('buffers and sends in batches to the logs endpoint as an array', async () => {
    const { client, transport } = makeClient()
    client.log('info', 'order created', { order_id: 1 })
    await client.flush()

    expect(transport.calls[0]!.url).toBe(
      'https://www.closeyour.it/api/v1/projects/p/logs',
    )
    const batch = transport.calls[0]!.payload as EventPayload[]
    expect(Array.isArray(batch)).toBe(true)
    expect(batch[0]!['message']).toBe('order created')
    await client.close()
  })

  it('log is a no-op when disabled', async () => {
    const { client, transport } = makeClient({ enabled: false })
    client.log('info', 'x')
    await client.flush()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('log is a no-op with logsEnabled:false', async () => {
    const { client, transport } = makeClient({ logsEnabled: false })
    client.log('info', 'x')
    await client.flush()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('logsMinLevel filters the levels below the threshold', async () => {
    const { client, transport } = makeClient({ logsMinLevel: 'warning' })
    client.log('info', 'below threshold')
    client.log('error', 'above threshold')
    await client.flush()
    const batch = transport.calls[0]!.payload as EventPayload[]
    expect(batch).toHaveLength(1)
    expect(batch[0]!['message']).toBe('above threshold')
  })

  it('normalizes the log level (warn→warning)', async () => {
    const { client, transport } = makeClient()
    client.log('warn' as never, 'x')
    await client.flush()
    const batch = transport.calls[0]!.payload as EventPayload[]
    expect(batch[0]!['level']).toBe('warning')
  })

  it('respects logsSampleRate (independent of sampleRate)', async () => {
    const { client, transport } = makeClient({ logsSampleRate: 0.5 }, () => 0.9)
    client.log('info', 'dropped')
    await client.flush()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('discards logs with an empty message (the backend would reject them)', async () => {
    const { client, transport } = makeClient()
    client.log('info', '')
    client.log('info', '   ')
    await client.flush()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('automatic flush when logsBatchSize is reached', () => {
    const { client, transport } = makeClient({ logsBatchSize: 2 })
    client.log('info', 'one')
    expect(transport.send).not.toHaveBeenCalled()
    client.log('info', 'two')
    expect(transport.send).toHaveBeenCalledTimes(1)
    const batch = transport.calls[0]!.payload as EventPayload[]
    expect(batch).toHaveLength(2)
  })
})

describe('Client — measure and metrics', () => {
  const METRICS_URL = 'https://www.closeyour.it/api/v1/projects/p/metrics'

  it('sync measure returns the value and sends slow_method above the threshold', () => {
    const { client, transport } = makeClient({}, () => 0, steppingClock(300))
    const result = client.measure('checkout.total', () => 42)
    expect(result).toBe(42)
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]!.url).toBe(METRICS_URL)
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['kind']).toBe('slow_method')
    expect(payload['label']).toBe('checkout.total')
    expect(payload['duration_ms']).toBe(300)
  })

  it('measure below the threshold sends nothing', () => {
    const { client, transport } = makeClient({}, () => 0, steppingClock(50))
    client.measure('fast', () => 'ok')
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('async measure returns the Promise and measures until settle', async () => {
    const { client, transport } = makeClient({}, () => 0, steppingClock(300))
    const result = await client.measure('fetch.orders', async () => 'data')
    expect(result).toBe('data')
    expect(transport.calls[0]!.url).toBe(METRICS_URL)
  })

  it('measure emits the metric even when the body throws (and rethrows)', () => {
    const { client, transport } = makeClient({}, () => 0, steppingClock(300))
    expect(() =>
      client.measure('explodes', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(transport.calls).toHaveLength(1)
  })

  it('measure with an empty label throws TypeError even with a disabled client', () => {
    const { client } = makeClient({ publicKey: '' })
    expect(() => client.measure('', () => 1)).toThrow(TypeError)
  })

  it('measure is NOT sampled by sampleRate', () => {
    const { client, transport } = makeClient(
      { sampleRate: 0 },
      () => 0.99,
      steppingClock(300),
    )
    client.measure('always', () => 1)
    expect(transport.calls).toHaveLength(1)
  })

  it('arguments sent only with captureMethodArguments', () => {
    const withCapture = makeClient(
      { captureMethodArguments: true },
      () => 0,
      steppingClock(300),
    )
    withCapture.client.measure('pay', () => 1, { args: { order_id: 7 } })
    const withPayload = withCapture.transport.calls[0]!.payload as EventPayload
    expect(withPayload['arguments']).toEqual([{ name: 'order_id', value: '7' }])

    const without = makeClient({}, () => 0, steppingClock(300))
    without.client.measure('pay', () => 1, { args: { order_id: 7 } })
    const withoutPayload = without.transport.calls[0]!.payload as EventPayload
    expect(withoutPayload).not.toHaveProperty('arguments')
  })

  it('recordExternalHttp emits only with detectPerformanceIssues and above the threshold', () => {
    const off = makeClient()
    off.client.recordExternalHttp('api.x.com', '/v1/a', 5000)
    expect(off.transport.send).not.toHaveBeenCalled()

    const on = makeClient({ detectPerformanceIssues: true })
    on.client.recordExternalHttp('api.x.com', '/v1/a', 500) // below the 1000 threshold
    expect(on.transport.send).not.toHaveBeenCalled()
    on.client.recordExternalHttp('api.x.com', '/v1/a', 1500)
    const payload = on.transport.calls[0]!.payload as EventPayload
    expect(payload['subtype']).toBe('slow_external_http')
    expect(payload['http_host']).toBe('api.x.com')
  })

  it('recordRepeatedHttp and recordJank respect the gates', () => {
    const { client, transport } = makeClient({ detectPerformanceIssues: true })
    client.recordRepeatedHttp('api.x.com', '/v1/items/<n>', 5)
    client.recordJank(240, '/orders')
    expect(transport.calls.map((c) => (c.payload as EventPayload)['subtype'])).toEqual([
      'repeated_http',
      'jank',
    ])

    // The repetition count reaches the wire as query_count (visible in the UI, dart/ruby parity).
    const repeated = transport.calls[0]!.payload as EventPayload
    expect(repeated['query_count']).toBe(5)
    expect(repeated).not.toHaveProperty('count_in_request')

    const jankOff = makeClient({ detectPerformanceIssues: true, detectJank: false })
    jankOff.client.recordJank(240, '/orders')
    expect(jankOff.transport.send).not.toHaveBeenCalled()
  })
})

describe('Client — beforeSend', () => {
  it('discards the event when beforeSend returns null', () => {
    const { client, transport } = makeClient({ beforeSend: () => null })
    client.captureException(new Error('x'))
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('sends the payload modified by beforeSend', () => {
    const { client, transport } = makeClient({
      beforeSend: (p) => ({ ...p, tagged: true }),
    })
    client.captureMessage('x')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['tagged']).toBe(true)
  })

  it('applies beforeSend to logs too and discards when all are null', async () => {
    const { client, transport } = makeClient({ beforeSend: () => null })
    client.log('info', 'x')
    await client.flush()
    expect(transport.send).not.toHaveBeenCalled()
    await client.close()
  })
})

describe('Client — pageview', () => {
  const PAGEVIEWS_URL = 'https://www.closeyour.it/api/v1/projects/p/pageviews'

  it('capturePageview sends to the pageviews endpoint with environment and counts enqueued', () => {
    history.replaceState({}, '', '/articles/x')
    const { client, transport } = makeClient()
    client.capturePageview()

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]!.url).toBe(PAGEVIEWS_URL)
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['path']).toBe('/articles/x')
    expect(payload['hostname']).toBe(location.hostname)
    expect(payload['environment']).toBe('production')
    expect(typeof payload['event_id']).toBe('string')
    expect(client.stats.get('enqueued')).toBe(1)
  })

  it('capturePageview is a no-op when disabled', () => {
    const { client, transport } = makeClient({ publicKey: '' })
    client.capturePageview()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('capturePageview is NOT sampled by sampleRate', () => {
    const { client, transport } = makeClient({ sampleRate: 0 }, () => 0.99)
    client.capturePageview()
    expect(transport.calls).toHaveLength(1)
  })

  it('overrides.path forces the sent path', () => {
    history.replaceState({}, '', '/real')
    const { client, transport } = makeClient()
    client.capturePageview({ path: '/virtual' })
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['path']).toBe('/virtual')
  })

  it('capturePageview respects beforeSend (drop if null)', () => {
    const { client, transport } = makeClient({ beforeSend: () => null })
    client.capturePageview()
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('captureEvent sends to the pageviews endpoint with the custom event name', () => {
    history.replaceState({}, '', '/checkout')
    const { client, transport } = makeClient()
    client.captureEvent('Signup')

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]!.url).toBe(PAGEVIEWS_URL)
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['name']).toBe('Signup')
    expect(payload['path']).toBe('/checkout')
  })

  it('captureEvent is a no-op without a name or when disabled', () => {
    const { client, transport } = makeClient()
    client.captureEvent('')
    expect(transport.send).not.toHaveBeenCalled()

    const { client: off, transport: t2 } = makeClient({ publicKey: '' })
    off.captureEvent('Signup')
    expect(t2.send).not.toHaveBeenCalled()
  })
})

describe('Client — lifecycle', () => {
  it('flush and close delegate to the transport', async () => {
    const { client, transport } = makeClient()
    await client.flush()
    await client.close()
    expect(transport.flush).toHaveBeenCalled()
  })
})

describe('Client — diagnostics (CYJS-9)', () => {
  it('a throwing beforeSend does not propagate and counts the drop with reason error', () => {
    const events: Array<{ event: string; details: unknown }> = []
    const { client, transport } = makeClient({
      beforeSend: () => {
        throw new TypeError('broken hook')
      },
      onDiagnostic: (event, details) => events.push({ event, details }),
    })
    // Telemetry must never crash the host, not even with a faulty beforeSend.
    expect(() => client.captureException(new Error('x'))).not.toThrow()
    expect(transport.send).not.toHaveBeenCalled()
    expect(client.stats.toObject().reasons.error).toBe(1)
    expect(client.stats.get('dropped')).toBe(1)
    // Only the name of the error class, never the message (no PII).
    expect(events).toContainEqual({
      event: 'drop',
      details: { reason: 'error', error: 'TypeError' },
    })
  })

  it('notifies the before_send drop when beforeSend returns null', () => {
    const events: Array<{ event: string; details: unknown }> = []
    const { client } = makeClient({
      beforeSend: () => null,
      onDiagnostic: (event, details) => events.push({ event, details }),
    })
    client.captureException(new Error('x'))
    expect(client.stats.toObject().reasons.before_send).toBe(1)
    expect(events).toContainEqual({ event: 'drop', details: { reason: 'before_send' } })
  })

  it('notifies enqueue with the endpoint path when the event is sent', () => {
    const events: Array<{ event: string; details: unknown }> = []
    const { client } = makeClient({
      onDiagnostic: (event, details) => events.push({ event, details }),
    })
    client.captureException(new Error('x'))
    expect(events).toContainEqual({
      event: 'enqueue',
      details: { path: '/api/p/store' },
    })
  })

  it('counts the sampling drop with reason sample_rate', () => {
    const { client, transport } = makeClient({ sampleRate: 0.5 }, () => 0.9)
    client.captureException(new Error('x'))
    expect(transport.send).not.toHaveBeenCalled()
    expect(client.stats.toObject().reasons.sample_rate).toBe(1)
    expect(client.stats.get('dropped')).toBe(1)
  })

  it('a dedup or an excluded exception do NOT count as a diagnostic drop', () => {
    const { client } = makeClient({ excludedExceptions: ['AbortError'] })
    const excluded = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    client.captureException(excluded)
    const dup = new Error('same')
    client.captureException(dup)
    client.captureException(dup)
    // Only intentional filters: no drop counted (reason not listed).
    expect(client.stats.get('dropped')).toBe(0)
  })
})
