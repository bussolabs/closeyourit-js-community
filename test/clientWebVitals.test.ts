// Sending Web Vitals measurements from the client (CYJS-12): a single batch to
// `…/web_vitals`, sampling per page load, beforeSend per measurement.

import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'
import { buildWebVital } from '../src/webVitals'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'proj-1',
  environment: 'production',
  trackWebVitals: true,
}

function harness(
  options: Partial<CloseYourItOptions> = {},
  deps: { random?: () => number } = {},
): { client: Client; calls: Array<{ payload: unknown; url: string }> } {
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
    { transport: transport as unknown as Transport, ...deps },
  )
  return { client, calls }
}

const LCP = (): EventPayload => buildWebVital({ metric: 'lcp', value: 2400 })
const CLS = (): EventPayload => buildWebVital({ metric: 'cls', value: 0.05 })

describe('Client.captureWebVitals', () => {
  it('sends all measurements in a single request to web_vitals', () => {
    const { client, calls } = harness()

    client.captureWebVitals([LCP(), CLS()])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://www.closeyour.it/api/v1/projects/proj-1/web_vitals',
    )
    const batch = calls[0]!.payload as EventPayload[]
    expect(batch).toHaveLength(2)
    expect(batch.map((m) => m['metric'])).toEqual(['lcp', 'cls'])
  })

  it('adds environment and release to every measurement', () => {
    const { client, calls } = harness({ release: '1.4.2' })

    client.captureWebVitals([LCP(), CLS()])

    const batch = calls[0]!.payload as EventPayload[]
    for (const measure of batch) {
      expect(measure['environment']).toBe('production')
      expect(measure['release']).toBe('1.4.2')
    }
  })

  it('without a configured release the field stays absent', () => {
    const { client, calls } = harness()

    client.captureWebVitals([LCP()])

    expect((calls[0]!.payload as EventPayload[])[0]).not.toHaveProperty('release')
  })

  it('sends nothing without measurements', () => {
    const { client, calls } = harness()

    client.captureWebVitals([])

    expect(calls).toHaveLength(0)
  })

  it('no-op with a disabled SDK', () => {
    const { client, calls } = harness({ enabled: false })

    client.captureWebVitals([LCP()])

    expect(calls).toHaveLength(0)
  })

  it('sampling applies to the whole batch and counts a single drop', () => {
    const { client, calls } = harness(
      { webVitalsSampleRate: 0.5 },
      { random: () => 0.9 },
    )

    client.captureWebVitals([LCP(), CLS()])

    expect(calls).toHaveLength(0)
    expect(client.stats.toObject().reasons.sample_rate).toBe(1)
    expect(client.stats.toObject().dropped).toBe(1)
  })

  it('a sampled page load stays sampled in later sends too', () => {
    // The courtesy flush (CYJS-28) can send a second batch from the
    // same page load. Rolling the dice again there would break the rule "the measurements of
    // a page are sent all or none": the INP percentile would come from a
    // set of pages different from the LCP one, and the two would no longer be
    // comparable.
    const draws = [0.1, 0.9]
    const { client, calls } = harness(
      { webVitalsSampleRate: 0.5 },
      { random: () => draws.shift() ?? 0.9 },
    )

    client.captureWebVitals([LCP()])
    client.captureWebVitals([CLS()])

    expect(calls).toHaveLength(2)
  })

  it('an excluded page load stays excluded even if the next roll would say yes', () => {
    const draws = [0.9, 0.1]
    const { client, calls } = harness(
      { webVitalsSampleRate: 0.5 },
      { random: () => draws.shift() ?? 0.1 },
    )

    client.captureWebVitals([LCP()])
    client.captureWebVitals([CLS()])

    expect(calls).toHaveLength(0)
    expect(client.stats.toObject().reasons.sample_rate).toBe(2)
  })

  it('samples independently of the errors sampleRate', () => {
    const { client, calls } = harness(
      { sampleRate: 0, webVitalsSampleRate: 1 },
      { random: () => 0.9 },
    )

    client.captureWebVitals([LCP()])

    expect(calls).toHaveLength(1)
  })

  it('beforeSend can discard one measurement without stopping the others', () => {
    const { client, calls } = harness({
      beforeSend: (payload) => (payload['metric'] === 'cls' ? null : payload),
    })

    client.captureWebVitals([LCP(), CLS()])

    const batch = calls[0]!.payload as EventPayload[]
    expect(batch).toHaveLength(1)
    expect(batch[0]!['metric']).toBe('lcp')
    expect(client.stats.toObject().reasons.before_send).toBe(1)
  })

  it('a beforeSend that discards everything produces no send', () => {
    const { client, calls } = harness({ beforeSend: () => null })

    client.captureWebVitals([LCP(), CLS()])

    expect(calls).toHaveLength(0)
  })

  it('counts the enqueue with the batch size', () => {
    const seen: Array<{ event: string; batch?: number }> = []
    const { client } = harness({
      onDiagnostic: (event, details) => seen.push({ event, batch: details.batch }),
    })

    client.captureWebVitals([LCP(), CLS()])

    expect(client.stats.toObject().enqueued).toBe(1)
    expect(seen).toContainEqual({ event: 'enqueue', batch: 2 })
  })
})
