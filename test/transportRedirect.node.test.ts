// @vitest-environment node
// POST redirects on Node: fetch is called with redirect:'manual' and 3xx are
// followed by hand (max 2) by re-POSTing the same body — a 301 apex→www with
// redirect:'follow' would degrade the POST into a GET (ruby/dart Transport parity).
import { describe, expect, it, vi } from 'vitest'
import { Stats } from '../src/stats'
import { Transport } from '../src/transport'
import { SDK_NAME, SDK_VERSION } from '../src/version'

const URL_START = 'https://closeyour.it/api/v1/projects/p/events'

function res(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response
}

describe('Transport on Node', () => {
  it('sets User-Agent and manual redirect', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() => Promise.resolve(res(202)))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({ a: 1 }, URL_START)
    await transport.flush()

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe(`${SDK_NAME}/${SDK_VERSION}`)
    expect(init.redirect).toBe('manual')
    expect(init.keepalive).toBeUndefined()
  })

  it('follows a 301 re-POSTing the same body to the absolute Location URL', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(301, { location: 'https://www.closeyour.it/api/v1/projects/p/events' }),
      )
      .mockResolvedValueOnce(res(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({ a: 1 }, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [secondUrl, secondInit] = fetchImpl.mock.calls[1]!
    expect(secondUrl).toBe('https://www.closeyour.it/api/v1/projects/p/events')
    expect((secondInit as RequestInit).method).toBe('POST')
    expect((secondInit as RequestInit).body).toBe('{"a":1}')
    expect(stats.get('sent')).toBe(1)
  })

  it('resolves relative Locations against the current URL', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(308, { location: '/api/v2/ingest' }))
      .mockResolvedValueOnce(res(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl.mock.calls[1]![0]).toBe('https://closeyour.it/api/v2/ingest')
    expect(stats.get('sent')).toBe(1)
  })

  it('stops after 2 redirects (loop → failed)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() => Promise.resolve(res(301, { location: URL_START })))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(3) // original + 2 follows
    expect(stats.get('failed')).toBe(1)
    expect(stats.get('sent')).toBe(0)
  })

  it('does NOT follow a redirect towards a foreign host (the Bearer must not leave)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() =>
      Promise.resolve(res(301, { location: 'https://evil.example.com/collect' })),
    )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
  })

  it('a 3xx without Location counts as failed', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() => Promise.resolve(res(302)))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
  })
})

// CYJS-37: the follow guard compares the target with the STARTING ADDRESS
// (protocol + host), not with the previous step. Two distinct checks:
// the HTTPS→HTTP downgrade would send credential and payload over a cleartext
// channel even while staying on the same host; and a chain of bounces each
// "close" to the previous one would still lead far away from the origin.
describe('Transport on Node — redirect follow guard (CYJS-37)', () => {
  it('does NOT follow an HTTPS→HTTP downgrade on the same host (bearer)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        res(307, { location: 'http://closeyour.it/api/v1/projects/p/events' }),
      ),
    )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
    expect(stats.get('sent')).toBe(0)
  })

  it('does NOT follow an HTTPS→HTTP downgrade even in dsn mode (public key in query)', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        res(301, { location: 'http://www.closeyour.it/api/v1/projects/p/events' }),
      ),
    )
    const transport = new Transport({
      auth: { kind: 'dsn', publicKey: 'pk-test' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
  })

  it('does NOT follow a downgrade that arrives at the second bounce', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(301, { location: 'https://www.closeyour.it/api/v1/projects/p/events' }),
      )
      .mockResolvedValueOnce(
        res(308, { location: 'http://www.closeyour.it/api/v1/projects/p/events' }),
      )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://www.closeyour.it/api/v1/projects/p/events',
    )
    expect(stats.get('failed')).toBe(1)
  })

  it('does NOT drift away in small steps: the www-swap is measured on the starting address', async () => {
    // Each step is a valid www-swap relative to the previous one, but www.www is a
    // host different from the origin: the chain must stop at the second bounce.
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(301, { location: 'https://www.closeyour.it/api/v1/projects/p/events' }),
      )
      .mockResolvedValueOnce(
        res(301, {
          location: 'https://www.www.closeyour.it/api/v1/projects/p/events',
        }),
      )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(stats.get('failed')).toBe(1)
  })

  it('does NOT follow a redirect towards a different port of the same host name', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        res(307, { location: 'https://closeyour.it:8443/api/v1/projects/p/events' }),
      ),
    )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
  })

  it('does NOT follow a redirect towards a scheme that is not http/https', async () => {
    const stats = new Stats()
    const fetchImpl = vi.fn(() =>
      Promise.resolve(res(302, { location: 'ftp://closeyour.it/api/v1/ingest' })),
    )
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(stats.get('failed')).toBe(1)
  })

  it('follows an http→http redirect when the start is already cleartext (local ingest)', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(308, { location: '/api/v2/ingest' }))
      .mockResolvedValueOnce(res(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, 'http://localhost:3000/api/v1/projects/p/events')
    await transport.flush()

    expect(fetchImpl.mock.calls[1]![0]).toBe('http://localhost:3000/api/v2/ingest')
    expect(stats.get('sent')).toBe(1)
  })

  it('follows an HTTP→HTTPS upgrade on the same host', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(301, { location: 'https://closeyour.it/api/v1/projects/p/events' }),
      )
      .mockResolvedValueOnce(res(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, 'http://closeyour.it/api/v1/projects/p/events')
    await transport.flush()

    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://closeyour.it/api/v1/projects/p/events',
    )
    expect(stats.get('sent')).toBe(1)
  })

  it('follows two consecutive bounces within the starting origin', async () => {
    const stats = new Stats()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(301, { location: 'https://www.closeyour.it/api/v1/projects/p/events' }),
      )
      .mockResolvedValueOnce(res(308, { location: '/api/v2/ingest' }))
      .mockResolvedValueOnce(res(202))
    const transport = new Transport({
      auth: { kind: 'bearer', secret: 't' },
      stats,
      fetchImpl,
      timeoutMs: 0,
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[2]![0]).toBe('https://www.closeyour.it/api/v2/ingest')
    expect(stats.get('sent')).toBe(1)
  })

  it('does not write the credential into the diagnostic log of the rejected redirect', async () => {
    const stats = new Stats()
    const messages: string[] = []
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        res(307, { location: 'http://closeyour.it/api/v1/projects/p/events' }),
      ),
    )
    const transport = new Transport({
      auth: { kind: 'dsn', publicKey: 'pk-test' },
      stats,
      fetchImpl,
      timeoutMs: 0,
      debug: (message) => messages.push(message),
    })

    transport.send({}, URL_START)
    await transport.flush()

    expect(messages.some((m) => m.includes('redirect'))).toBe(true)
    for (const message of messages) {
      expect(message).not.toContain('pk-test')
      expect(message).not.toContain('sentry_key')
    }
  })
})
