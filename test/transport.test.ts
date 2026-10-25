import { afterEach, describe, expect, it, vi } from 'vitest'
import { Stats } from '../src/stats'
import { Transport } from '../src/transport'

const URL = 'https://www.closeyour.it/api/v1/projects/p/events'

function ok(status: number): () => Promise<Response> {
  return () => Promise.resolve({ status } as Response)
}

function failWithBody(status: number, body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve({
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response)
}

afterEach(() => vi.unstubAllGlobals())

describe('Transport', () => {
  it('counts a 2xx response as sent and sends header + body', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 'cyi_x' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    expect(transport.send({ a: 1 }, URL)).toBe(true)
    await transport.flush()

    expect(stats.get('sent')).toBe(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(URL)
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer cyi_x')
    expect(headers['Content-Type']).toBe('application/json')
    expect((init as RequestInit).keepalive).toBe(true)
    expect((init as RequestInit).body).toBe('{"a":1}')
  })

  it('counts a non-2xx response as failed', async () => {
    const stats = new Stats()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(ok(500)),
      timeoutMs: 0,
    })
    transport.send({}, URL)
    await transport.flush()
    expect(stats.get('failed')).toBe(1)
    expect(stats.get('sent')).toBe(0)
  })

  it('logs the R- code + message from the body on non-2xx (diagnostic debug)', async () => {
    const stats = new Stats()
    const debug = vi.fn()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      timeoutMs: 0,
      debug,
      fetchImpl: vi.fn(
        failWithBody(422, {
          error: { code: 'R422-INGEST-001', message: 'Malformed event' },
        }),
      ),
    })
    transport.send({}, URL)
    await transport.flush()
    expect(stats.get('failed')).toBe(1)
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('R422-INGEST-001: Malformed event'),
    )
  })

  it('counts a network error as failed', async () => {
    const stats = new Stats()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(() => Promise.reject(new Error('network'))),
      timeoutMs: 0,
    })
    transport.send({}, URL)
    await transport.flush()
    expect(stats.get('failed')).toBe(1)
  })

  it('drops when the queue is full (maxQueue)', () => {
    const stats = new Stats()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      // fetch that never resolves → the send stays in flight.
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      maxQueue: 1,
      timeoutMs: 0,
    })
    expect(transport.send({}, URL)).toBe(true)
    expect(transport.send({}, URL)).toBe(false)
    expect(stats.get('dropped')).toBe(1)
    expect(stats.get('enqueued')).toBe(0) // enqueued is counted by the client
  })

  it('without an available fetch it counts failed and returns false', () => {
    vi.stubGlobal('fetch', undefined)
    const stats = new Stats()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: undefined,
    })
    expect(transport.send({}, URL)).toBe(false)
    expect(stats.get('failed')).toBe(1)
  })

  it('in the browser it does not use keepalive for a body over the quota (64KB Chrome)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({ big: 'x'.repeat(70_000) }, URL)
    await transport.flush()

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(init.keepalive).toBeUndefined()
  })

  it('in the browser it does not set User-Agent (forbidden by the fetch spec)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })
    transport.send({}, URL)
    await transport.flush()
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(headers['User-Agent']).toBeUndefined()
  })

  it('in dsn mode it appends ?sentry_key= and does NOT send Authorization', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(200))
    const transport = new Transport({
      auth: { kind: 'dsn', publicKey: 'deadbeef' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({ a: 1 }, URL)
    await transport.flush()

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`${URL}?sentry_key=deadbeef`)
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('in dsn mode it uses & if the URL already has a query', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(200))
    const transport = new Transport({
      auth: { kind: 'dsn', publicKey: 'deadbeef' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, `${URL}?x=1`)
    await transport.flush()
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${URL}?x=1&sentry_key=deadbeef`)
  })

  it('in dsn mode it does not double sentry_key if already present (idempotent)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(ok(200))
    const transport = new Transport({
      auth: { kind: 'dsn', publicKey: 'deadbeef' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, `${URL}?sentry_key=old`)
    await transport.flush()
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${URL}?sentry_key=old`)
  })

  it('notifies send with the status on a 2xx response', async () => {
    const stats = new Stats()
    const diagnostic = vi.fn()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(ok(202)),
      timeoutMs: 0,
      diagnostic,
    })
    transport.send({}, URL)
    await transport.flush()
    expect(diagnostic).toHaveBeenCalledWith('send', { status: 202 })
  })

  it('non-2xx records the response reason and notifies drop with the status (4xx/429/5xx)', async () => {
    for (const status of [404, 429, 503]) {
      const stats = new Stats()
      const diagnostic = vi.fn()
      const transport = new Transport({
        auth: { kind: 'bearer', secret: 't' },
        stats,
        fetchImpl: vi.fn(ok(status)),
        timeoutMs: 0,
        diagnostic,
      })
      transport.send({}, URL)
      await transport.flush()
      expect(stats.toObject().reasons.response).toBe(1)
      expect(stats.get('dropped')).toBe(0)
      expect(diagnostic).toHaveBeenCalledWith('drop', { reason: 'response', status })
    }
  })

  it('a network error records the network reason and notifies drop with the error name', async () => {
    const stats = new Stats()
    const diagnostic = vi.fn()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(() => Promise.reject(new TypeError('failed to fetch'))),
      timeoutMs: 0,
      diagnostic,
    })
    transport.send({}, URL)
    await transport.flush()
    expect(stats.toObject().reasons.network).toBe(1)
    expect(stats.get('failed')).toBe(1)
    expect(stats.get('timeout')).toBe(0)
    // Only the class NAME, never the message (no PII).
    expect(diagnostic).toHaveBeenCalledWith('drop', {
      reason: 'network',
      error: 'TypeError',
    })
  })

  it('a signal abort counts timeout and notifies the timeout event', async () => {
    const stats = new Stats()
    const diagnostic = vi.fn()
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(() => Promise.reject(abortError)),
      timeoutMs: 0,
      diagnostic,
    })
    transport.send({}, URL)
    await transport.flush()
    expect(stats.get('timeout')).toBe(1)
    expect(stats.get('failed')).toBe(1)
    expect(diagnostic).toHaveBeenCalledWith('timeout', { error: 'AbortError' })
  })

  it('a full queue records queue_full and notifies drop', () => {
    const stats = new Stats()
    const diagnostic = vi.fn()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      maxQueue: 1,
      timeoutMs: 0,
      diagnostic,
    })
    transport.send({}, URL)
    expect(transport.send({}, URL)).toBe(false)
    expect(stats.toObject().reasons.queue_full).toBe(1)
    expect(diagnostic).toHaveBeenCalledWith('drop', { reason: 'queue_full' })
  })

  it('without fetch it records network and notifies drop', () => {
    vi.stubGlobal('fetch', undefined)
    const stats = new Stats()
    const diagnostic = vi.fn()
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: undefined,
      diagnostic,
    })
    expect(transport.send({}, URL)).toBe(false)
    expect(stats.toObject().reasons.network).toBe(1)
    expect(stats.get('failed')).toBe(1)
    expect(diagnostic).toHaveBeenCalledWith('drop', { reason: 'network' })
  })

  it('flush waits for the in-flight sends', async () => {
    const stats = new Stats()
    let resolve!: (r: Response) => void
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl: vi.fn(() => new Promise<Response>((r) => (resolve = r))),
      timeoutMs: 0,
    })
    transport.send({}, URL)
    const flushed = transport.flush()
    resolve({ status: 202 } as Response)
    await flushed
    expect(stats.get('sent')).toBe(1)
  })
})
