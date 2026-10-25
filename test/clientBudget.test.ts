import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { MAX_PAYLOAD_BYTES, payloadBytes } from '../src/budget'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

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

function makeClient(options: Partial<CloseYourItOptions> = {}): {
  client: Client
  transport: FakeTransport
} {
  const transport = fakeTransport()
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport, random: () => 0 },
  )
  return { client, transport }
}

describe('Client — byte budget and truncation (CYJS-10)', () => {
  it('truncates an event with a huge extra below MAX_PAYLOAD_BYTES preserving the error', () => {
    const { client, transport } = makeClient()
    client.setExtra('blob', 'x'.repeat(MAX_PAYLOAD_BYTES + 100_000))
    client.captureException(new Error('boom'))

    expect(transport.calls).toHaveLength(1)
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payloadBytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(payload['truncated']).toBe(true)
    const exc = payload['exception'] as {
      values: Array<{ type: string; value: string }>
    }
    expect(exc.values[0]!.type).toBe('Error')
    expect(exc.values[0]!.value).toBe('boom')
  })

  it('a normal event is not touched (no truncated flag)', () => {
    const { client, transport } = makeClient()
    client.captureException(new Error('piccolo'))
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['truncated']).toBeUndefined()
  })

  it('the cap is applied AFTER beforeSend (which can inflate the payload)', () => {
    const { client, transport } = makeClient({
      beforeSend: (event) => ({
        ...event,
        extra: { injected: 'y'.repeat(MAX_PAYLOAD_BYTES) },
      }),
    })
    client.captureException(new Error('boom'))
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payloadBytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(payload['truncated']).toBe(true)
  })

  it('splits a large log batch: every request under budget, no log lost', async () => {
    const { client, transport } = makeClient({ logsBatchSize: 100_000 })
    const count = 80
    for (let i = 0; i < count; i++) client.log('info', `log-${i}-${'m'.repeat(10_000)}`)
    await client.flush()

    const logCalls = transport.calls.filter((c) => c.url.includes('/logs'))
    expect(logCalls.length).toBeGreaterThan(1)
    let total = 0
    for (const call of logCalls) {
      const batch = call.payload as EventPayload[]
      expect(payloadBytes(batch)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
      total += batch.length
    }
    expect(total).toBe(count)
  })

  it('generic cap on metrics: under budget even with an inflating beforeSend', () => {
    const { client, transport } = makeClient({
      detectPerformanceIssues: true,
      detectJank: true,
      // Injected custom object: the safety net removes it entirely.
      beforeSend: (e) => ({ ...e, injected: { blob: 'z'.repeat(MAX_PAYLOAD_BYTES) } }),
    })
    client.recordJank(500, '/dashboard')

    const metricCalls = transport.calls.filter((c) => c.url.includes('/metrics'))
    expect(metricCalls).toHaveLength(1)
    const payload = metricCalls[0]!.payload as EventPayload
    expect(payloadBytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(payload['truncated']).toBe(true)
    expect(payload['injected']).toBeUndefined()
    expect(payload['subtype']).toBe('jank')
  })

  it('generic cap on pageviews: under budget with a huge path', () => {
    const { client, transport } = makeClient()
    client.capturePageview({ path: '/' + 'p'.repeat(MAX_PAYLOAD_BYTES) })

    const pvCalls = transport.calls.filter((c) => c.url.includes('/pageviews'))
    expect(pvCalls).toHaveLength(1)
    const payload = pvCalls[0]!.payload as EventPayload
    expect(payloadBytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(payload['truncated']).toBe(true)
  })

  it('truncates a large replay chunk preserving the session identity', () => {
    const { client, transport } = makeClient()
    client.captureReplayChunk({
      replay_session_id: 'sess-9',
      seq: 2,
      started_at: '2026-07-27T00:00:00.000Z',
      events: Array.from({ length: 400 }, (_, i) => ({ i, blob: 'e'.repeat(2_000) })),
    })

    const payload = transport.calls[0]!.payload as EventPayload
    expect(payloadBytes(payload)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(payload['truncated']).toBe(true)
    expect(payload['replay_session_id']).toBe('sess-9')
    expect(payload['seq']).toBe(2)
    expect((payload['events'] as unknown[]).length).toBeGreaterThan(0)
  })
})
