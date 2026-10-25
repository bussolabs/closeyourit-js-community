// Sending on page close (CYJS-29). When the tab closes `fetch(keepalive)`
// is not enough — on iOS Safari the last measurement is left behind — and the only send the
// browser completes is `navigator.sendBeacon`. Usable only in `dsn` mode
// (the auth is the public key in the query: no header to set) and with the body as
// `text/plain`: with `application/json` the request would not be CORS-simple and
// would trigger a preflight that a page-close send does not survive.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import * as CloseYourIt from '../src/index'
import { Stats } from '../src/stats'
import { Transport, type TransportOptions } from '../src/transport'

const METRICS_URL = 'https://www.closeyour.it/api/v1/projects/p/metrics'
// The `Blob` constructor lowercases the MIME (File API spec): the type
// that ends up on the wire is this one, and it stays `text/plain` — CORS-simple, no
// preflight (the Content-Type match is case-insensitive).
const TEXT_PLAIN = 'text/plain;charset=utf-8'

function ok(status: number): () => Promise<Response> {
  return () => Promise.resolve({ status } as Response)
}

function makeTransport(overrides: Partial<TransportOptions> = {}): {
  transport: Transport
  stats: Stats
} {
  const stats = new Stats()
  const transport = new Transport({
    auth: { kind: 'dsn', publicKey: 'deadbeef' },
    stats,
    fetchImpl: vi.fn(ok(202)),
    timeoutMs: 0,
    ...overrides,
  })
  return { transport, stats }
}

// The Blob content is read with FileReader: `Blob.text()` does not exist in jsdom.
function beaconBody(payload: unknown): Promise<string> {
  if (!(payload instanceof Blob)) return Promise.resolve(String(payload))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(payload)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Transport — sending on page close (CYJS-29)', () => {
  it('with the page leaving it sends with the beacon, not with fetch', async () => {
    const beaconImpl = vi.fn(() => true)
    const fetchImpl = vi.fn(ok(202))
    const { transport, stats } = makeTransport({ beaconImpl, fetchImpl })

    transport.setPageHiding(true)
    expect(transport.send({ kind: 'slow_method' }, METRICS_URL)).toBe(true)
    await transport.flush()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(beaconImpl).toHaveBeenCalledTimes(1)
    expect(beaconImpl.mock.calls[0]![0]).toBe(`${METRICS_URL}?sentry_key=deadbeef`)
    // The beacon has no response: `sent` here means "queued by the browser".
    expect(stats.get('sent')).toBe(1)
  })

  it('sends the body as text/plain, never application/json (no CORS preflight)', async () => {
    const beaconImpl = vi.fn(() => true)
    const { transport } = makeTransport({ beaconImpl })

    transport.setPageHiding(true)
    transport.send({ label: 'checkout', duration_ms: 12 }, METRICS_URL)

    const payload = beaconImpl.mock.calls[0]![1]
    expect(payload).toBeInstanceOf(Blob)
    expect((payload as Blob).type).toBe(TEXT_PLAIN)
    expect(await beaconBody(payload)).toBe('{"label":"checkout","duration_ms":12}')
  })

  it('without Blob in the environment it sends the string (which per spec travels as text/plain)', () => {
    vi.stubGlobal('Blob', undefined)
    const beaconImpl = vi.fn(() => true)
    const { transport } = makeTransport({ beaconImpl })

    transport.setPageHiding(true)
    transport.send({ a: 1 }, METRICS_URL)

    expect(beaconImpl.mock.calls[0]![1]).toBe('{"a":1}')
  })

  it('with a visible page it stays on fetch keepalive (the response feeds the diagnostics)', async () => {
    const beaconImpl = vi.fn(() => true)
    const fetchImpl = vi.fn(ok(202))
    const { transport, stats } = makeTransport({ beaconImpl, fetchImpl })

    transport.send({ a: 1 }, METRICS_URL)
    await transport.flush()

    expect(beaconImpl).not.toHaveBeenCalled()
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).keepalive).toBe(true)
    expect(stats.get('sent')).toBe(1)
  })

  it('returning to the foreground (bfcache) puts fetch back in use', async () => {
    const beaconImpl = vi.fn(() => true)
    const fetchImpl = vi.fn(ok(202))
    const { transport } = makeTransport({ beaconImpl, fetchImpl })

    transport.setPageHiding(true)
    transport.setPageHiding(false)
    transport.send({ a: 1 }, METRICS_URL)
    await transport.flush()

    expect(beaconImpl).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses the beacon even with the page already hidden without an event (visibilityState hidden)', () => {
    const beaconImpl = vi.fn(() => true)
    const fetchImpl = vi.fn(ok(202))
    const { transport } = makeTransport({ beaconImpl, fetchImpl })
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')

    transport.send({ a: 1 }, METRICS_URL)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(beaconImpl).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })

  it('in bearer mode it never uses the beacon (it would leave without a credential)', async () => {
    const beaconImpl = vi.fn(() => true)
    const fetchImpl = vi.fn(ok(202))
    const { transport } = makeTransport({
      auth: { kind: 'bearer', secret: 'cyi_x' },
      beaconImpl,
      fetchImpl,
    })

    transport.setPageHiding(true)
    transport.send({ a: 1 }, METRICS_URL)
    await transport.flush()

    expect(beaconImpl).not.toHaveBeenCalled()
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(headers['Authorization']).toBe('Bearer cyi_x')
  })

  it('without sendBeacon in the environment it falls back to fetch keepalive', async () => {
    const fetchImpl = vi.fn(ok(202))
    const { transport, stats } = makeTransport({ fetchImpl })

    transport.setPageHiding(true)
    expect(transport.send({ a: 1 }, METRICS_URL)).toBe(true)
    await transport.flush()

    expect((fetchImpl.mock.calls[0]![1] as RequestInit).keepalive).toBe(true)
    expect(stats.get('sent')).toBe(1)
  })

  it('if the beacon refuses the payload (quota exceeded) it falls back to fetch, without counting twice', async () => {
    const beaconImpl = vi.fn(() => false)
    const fetchImpl = vi.fn(ok(202))
    const { transport, stats } = makeTransport({ beaconImpl, fetchImpl })

    transport.setPageHiding(true)
    expect(transport.send({ a: 1 }, METRICS_URL)).toBe(true)
    await transport.flush()

    expect(beaconImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('sent')).toBe(1)
  })

  it('a beacon that throws does not propagate: the send falls back to fetch', async () => {
    const beaconImpl = vi.fn(() => {
      throw new TypeError('beacon ko')
    })
    const fetchImpl = vi.fn(ok(202))
    const debug = vi.fn()
    const { transport, stats } = makeTransport({ beaconImpl, fetchImpl, debug })

    transport.setPageHiding(true)
    expect(() => transport.send({ a: 1 }, METRICS_URL)).not.toThrow()
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('sent')).toBe(1)
    expect(debug).toHaveBeenCalled()
  })

  it('without fetch in the environment the beacon is enough on its own', async () => {
    const beaconImpl = vi.fn(() => true)
    const { transport, stats } = makeTransport({ beaconImpl, fetchImpl: undefined })

    transport.setPageHiding(true)
    expect(transport.send({ a: 1 }, METRICS_URL)).toBe(true)
    await transport.flush()

    expect(beaconImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('sent')).toBe(1)
    expect(stats.get('failed')).toBe(0)
  })

  it('notifies send with the beacon too, without status (the browser does not respond)', async () => {
    const diagnostic = vi.fn()
    const { transport } = makeTransport({ beaconImpl: vi.fn(() => true), diagnostic })

    transport.setPageHiding(true)
    transport.send({ a: 1 }, METRICS_URL)
    await transport.flush()

    expect(diagnostic).toHaveBeenCalledWith('send', {})
  })

  it('accounts for the beacon outcome at the end of the tick, not inside send', async () => {
    // The send is already handed to the browser when `send` returns, but `sent` and the
    // notification come later: whoever called `send` must be able to record
    // the enqueue first (order `enqueue` → `send`, as in the fetch branch).
    const diagnostic = vi.fn()
    const { transport, stats } = makeTransport({
      beaconImpl: vi.fn(() => true),
      diagnostic,
    })

    transport.setPageHiding(true)
    expect(transport.send({ a: 1 }, METRICS_URL)).toBe(true)
    expect(stats.get('sent')).toBe(0)
    expect(diagnostic).not.toHaveBeenCalled()

    await transport.flush()
    expect(stats.get('sent')).toBe(1)
  })

  it('with the beacon the in-flight queue does not fill up (synchronous send)', () => {
    const beaconImpl = vi.fn(() => true)
    const { transport } = makeTransport({
      beaconImpl,
      // fetch that never resolves: if the send went through there, the queue (1) would
      // saturate at the first event.
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      maxQueue: 1,
    })

    transport.setPageHiding(true)
    expect(transport.send({ a: 1 }, METRICS_URL)).toBe(true)
    expect(transport.send({ a: 2 }, METRICS_URL)).toBe(true)
    expect(beaconImpl).toHaveBeenCalledTimes(2)
  })
})

describe('SDK — closing the tab does not lose the last measurement (CYJS-29)', () => {
  const config = {
    endpointUrl: 'https://www.closeyour.it',
    publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    projectId: 'p',
    environment: 'production',
  }

  let beacon: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    beacon = vi.fn(() => true)
    fetchMock = vi.fn(ok(202))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beacon,
      configurable: true,
      writable: true,
    })
  })

  afterEach(async () => {
    await CloseYourIt.close()
    Reflect.deleteProperty(navigator, 'sendBeacon')
    vi.unstubAllGlobals()
  })

  it('the measurement recorded while the tab is closing leaves with the beacon on /metrics', async () => {
    let clock = 0
    const client = new Client(
      { ...config, slowMethodThresholdMs: 10 },
      { nowMs: () => (clock += 500) },
    )

    client.notifyPageHiding(true)
    client.measure('checkout', () => 'ok')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, payload] = beacon.mock.calls[0]!
    expect(url).toBe(
      `${config.endpointUrl}/api/v1/projects/p/metrics?sentry_key=${config.publicKey}`,
    )
    expect((payload as Blob).type).toBe(TEXT_PLAIN)
    expect(await beaconBody(payload)).toContain('"label":"checkout"')
    await client.close()
  })

  it('with the beacon the diagnostic cycle stays in the enqueue → send order', async () => {
    const events: string[] = []
    let clock = 0
    const client = new Client(
      {
        ...config,
        slowMethodThresholdMs: 10,
        onDiagnostic: (event) => events.push(event),
      },
      { nowMs: () => (clock += 500) },
    )

    client.notifyPageHiding(true)
    client.measure('checkout', () => 'ok')
    await client.flush()

    expect(events).toEqual(['enqueue', 'send'])
    // No intermediate snapshot with more sent than enqueued.
    expect(client.stats.get('sent')).toBeLessThanOrEqual(client.stats.get('enqueued'))
    await client.close()
  })

  it('on pagehide the closing flush leaves with the beacon', () => {
    CloseYourIt.init(config)
    CloseYourIt.log('info', 'last breath')

    window.dispatchEvent(new Event('pagehide'))

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(beacon.mock.calls[0]![0]).toContain('/api/v1/projects/p/logs?sentry_key=')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('after returning from bfcache (pageshow) it goes back to fetch', async () => {
    CloseYourIt.init(config)

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pageshow'))
    CloseYourIt.log('info', 'back here')
    await CloseYourIt.flush()

    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
