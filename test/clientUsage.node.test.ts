// @vitest-environment node
// Client-side usage telemetry (CYJS-31): the `…/usages` channel is authenticated ONLY
// with the bearer, so it lives on server runtimes. This verifies the batched flush,
// the window payload and the gating (opt-in, disabled client, shutdown).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import * as CloseYourIt from '../src/index'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'
import { SDK_NAME, SDK_VERSION } from '../src/version'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_secret',
  projectId: 'proj-1',
  environment: 'production',
  usageEnabled: true,
}

const USAGES_URL = 'https://www.closeyour.it/api/v1/projects/proj-1/usages'

interface UsageBody {
  environment: string
  release?: string
  sdk: { name: string; version: string }
  window_started_at: string
  window_ended_at: string
  truncated: boolean
  symbols: Array<{ kind: string; symbol: string; count: number; last_seen_at: string }>
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
    setPageHiding: vi.fn(),
  }
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport },
  )
  return { client, calls }
}

const usageCalls = (calls: Array<{ payload: unknown; url: string }>): UsageBody[] =>
  calls.filter((c) => c.url === USAGES_URL).map((c) => c.payload as UsageBody)

describe('Client — usage telemetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes the seen symbols to …/usages with the window payload', async () => {
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    const { client, calls } = harness({ release: '1.4.2' })

    client.recordUsage('route', 'users#index')
    client.recordUsage('route', 'users#index')
    client.recordUsage('job', 'CleanupJob')
    vi.setSystemTime(new Date('2026-09-01T10:05:00.000Z'))
    await client.flush()

    const bodies = usageCalls(calls)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      environment: 'production',
      release: '1.4.2',
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      window_started_at: '2026-09-01T10:00:00.000Z',
      window_ended_at: '2026-09-01T10:05:00.000Z',
      truncated: false,
    })
    expect(bodies[0]!.symbols).toEqual([
      {
        kind: 'route',
        symbol: 'users#index',
        count: 2,
        last_seen_at: '2026-09-01T10:00:00.000Z',
      },
      {
        kind: 'job',
        symbol: 'CleanupJob',
        count: 1,
        last_seen_at: '2026-09-01T10:00:00.000Z',
      },
    ])
  })

  it('used records a custom key', async () => {
    const { client, calls } = harness()

    client.used('checkout.completed')
    await client.flush()

    expect(usageCalls(calls)[0]!.symbols).toEqual([
      expect.objectContaining({ kind: 'custom', symbol: 'checkout.completed' }),
    ])
  })

  it('omits release when it is not known', async () => {
    const { client, calls } = harness({ release: undefined })

    client.used('a')
    await client.flush()

    expect(usageCalls(calls)[0]).not.toHaveProperty('release')
  })

  it('sends nothing without usageEnabled (opt-in)', async () => {
    const { client, calls } = harness({ usageEnabled: false })

    client.used('a')
    client.recordUsage('route', 'users#index')
    await client.flush()

    expect(usageCalls(calls)).toHaveLength(0)
  })

  it('is a no-op with a disabled client', async () => {
    const { client, calls } = harness({ enabled: false })

    client.used('a')
    await client.flush()

    expect(usageCalls(calls)).toHaveLength(0)
  })

  it('flushes on its own when the interval expires', () => {
    const { client, calls } = harness({ usageFlushIntervalMs: 300_000 })

    client.used('a')
    expect(usageCalls(calls)).toHaveLength(0)
    vi.advanceTimersByTime(300_000)

    expect(usageCalls(calls)).toHaveLength(1)
  })

  it('close sends the last window before shutting down', async () => {
    const { client, calls } = harness()

    client.used('a')
    await client.close()

    expect(usageCalls(calls)).toHaveLength(1)
  })

  it('counts the send in the stats and notifies diagnostics', async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> = []
    const { client } = harness({
      onDiagnostic: (event, details) => events.push({ event, details }),
    })

    client.used('a')
    client.used('b')
    await client.flush()

    expect(client.stats.toObject().enqueued).toBe(1)
    expect(events).toContainEqual({
      event: 'enqueue',
      details: { path: '/api/v1/projects/proj-1/usages', batch: 2 },
    })
  })

  it('beyond usageMaxSymbols it declares truncated', async () => {
    const { client, calls } = harness({ usageMaxSymbols: 1 })

    client.used('a')
    client.used('b')
    await client.flush()

    const body = usageCalls(calls)[0]!
    expect(body.truncated).toBe(true)
    expect(body.symbols).toHaveLength(1)
  })

  it('does not go through beforeSend: the usage payload is not an event', async () => {
    const beforeSend = vi.fn(() => null)
    const { client, calls } = harness({ beforeSend })

    client.used('a')
    await client.flush()

    expect(usageCalls(calls)).toHaveLength(1)
    expect(beforeSend).not.toHaveBeenCalled()
  })

  it('a symbol outside the contract is not sent', async () => {
    const { client, calls } = harness()

    client.used('checkout with space')

    await client.flush()

    expect(usageCalls(calls)).toHaveLength(0)
  })
})

describe('facade on Node — usage telemetry', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ status: 202 } as Response))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await CloseYourIt.close()
    vi.unstubAllGlobals()
  })

  it('used and recordUsage reach the usages channel', async () => {
    CloseYourIt.init(base)
    CloseYourIt.recordUsage('route', 'users#index')
    CloseYourIt.used('checkout.completed')
    await CloseYourIt.flush()

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.filter((url) => url.startsWith(USAGES_URL))).toHaveLength(1)
  })

  it('warns when usage telemetry is on with only the publicKey', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    CloseYourIt.init({
      ...base,
      token: undefined,
      publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('accepts only the secret bearer'),
    )
    warn.mockRestore()
  })

  it('does not warn when the bearer is there: the registry is alive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    CloseYourIt.init(base)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('without usageEnabled no usages request is sent', async () => {
    CloseYourIt.init({ ...base, usageEnabled: false })
    CloseYourIt.used('checkout.completed')
    await CloseYourIt.flush()

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.filter((url) => url.startsWith(USAGES_URL))).toHaveLength(0)
  })
})
