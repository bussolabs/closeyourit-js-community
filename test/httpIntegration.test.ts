// Unified browser HTTP instrumentation: a single fetch/XHR patch feeds the
// `http` breadcrumbs AND the performance verdicts (slow_external_http,
// repeated_http). Real client with a fake transport: the wire is asserted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { installHttpInstrumentation } from '../src/integrations/browser/http'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

interface Harness {
  client: Client
  calls: Array<{ payload: unknown; url: string }>
  crumb: () => EventPayload | null
}

function harness(
  options: Partial<CloseYourItOptions> = {},
  nowMs?: () => number,
): Harness {
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
    {
      transport: transport as unknown as Transport,
      ...(nowMs ? { nowMs } : {}),
    },
  )
  return {
    client,
    calls,
    crumb: () => {
      const hash = client.scope.toEventHash() as {
        breadcrumbs?: { values: EventPayload[] }
      }
      const values = hash.breadcrumbs?.values ?? []
      return values.find((v) => v['category'] === 'http') ?? null
    },
  }
}

let uninstall: () => void = () => {}
afterEach(() => {
  uninstall()
  uninstall = () => {}
  ;(window as { fetch?: unknown }).fetch = undefined
  vi.useRealTimers()
})

function stubFetch(status = 200): void {
  window.fetch = vi.fn(() => Promise.resolve({ status } as Response))
}

describe('http — breadcrumb', () => {
  it('records the http breadcrumb with the url without query', async () => {
    stubFetch()
    const h = harness()
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://api.ext/users?secret=1')

    const crumb = h.crumb()
    expect(crumb).not.toBeNull()
    const data = crumb!['data'] as Record<string, unknown>
    expect(data['url']).toBe('https://api.ext/users')
    expect(data['status']).toBe(200)
  })

  it('excludes requests to the CloseYourIt endpoint', async () => {
    stubFetch()
    const h = harness({ detectPerformanceIssues: true })
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://www.closeyour.it/api/v1/projects/p/events')

    expect(h.crumb()).toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  it('autoBreadcrumbs.http:false → no breadcrumb but perf active', async () => {
    stubFetch()
    const h = harness(
      {
        autoBreadcrumbs: { http: false },
        detectPerformanceIssues: true,
        slowExternalThresholdMs: 100,
      },
      steppingClock(500),
    )
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://api.ext/slow')

    expect(h.crumb()).toBeNull()
    expect(h.calls).toHaveLength(1)
    const payload = h.calls[0]!.payload as EventPayload
    expect(payload['subtype']).toBe('slow_external_http')
  })
})

describe('http — slow_external_http', () => {
  it('emits the verdict above the threshold with a templatized path', async () => {
    stubFetch()
    const h = harness(
      { detectPerformanceIssues: true, slowExternalThresholdMs: 100 },
      steppingClock(1500),
    )
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://api.stripe.com/v1/charges/12345?full=1')

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toContain('/metrics')
    const payload = h.calls[0]!.payload as EventPayload
    expect(payload['subtype']).toBe('slow_external_http')
    expect(payload['http_host']).toBe('api.stripe.com')
    expect(payload['http_url']).toBe('/v1/charges/<n>')
  })

  it('detect off → breadcrumb only, no metric', async () => {
    stubFetch()
    const h = harness({ slowExternalThresholdMs: 100 }, steppingClock(1500))
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://api.ext/slow')

    expect(h.crumb()).not.toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  it('same-origin is not external → no verdict', async () => {
    stubFetch()
    const h = harness(
      { detectPerformanceIssues: true, slowExternalThresholdMs: 100 },
      steppingClock(1500),
    )
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch(`${location.origin}/interna`)

    expect(h.calls).toHaveLength(0)
  })
})

describe('http — repeated_http', () => {
  it('emits ONCE at the threshold for identical requests within the window', async () => {
    stubFetch()
    const h = harness({
      detectPerformanceIssues: true,
      slowExternalThresholdMs: 0, // isolates repeated from the slow verdict
      repeatedHttpThreshold: 3,
    })
    uninstall = installHttpInstrumentation(h.client)

    for (let i = 0; i < 5; i += 1) {
      await window.fetch('https://api.ext/v1/items/111')
    }

    const repeated = h.calls.filter(
      (c) => (c.payload as EventPayload)['subtype'] === 'repeated_http',
    )
    expect(repeated).toHaveLength(1)
    const payload = repeated[0]!.payload as EventPayload
    expect(payload['http_url']).toBe('/v1/items/<n>')
    expect(payload['query_count']).toBe(3)
    // The count is readable in the UI (Rails reader occurrence_query_count / dart): never count_in_request.
    expect(payload).not.toHaveProperty('count_in_request')
  })

  it('requests with different ids but the same template count together', async () => {
    stubFetch()
    const h = harness({
      detectPerformanceIssues: true,
      slowExternalThresholdMs: 0,
      repeatedHttpThreshold: 2,
    })
    uninstall = installHttpInstrumentation(h.client)

    await window.fetch('https://api.ext/v1/items/100')
    await window.fetch('https://api.ext/v1/items/200')

    const repeated = h.calls.filter(
      (c) => (c.payload as EventPayload)['subtype'] === 'repeated_http',
    )
    expect(repeated).toHaveLength(1)
  })
})

describe('http — XHR', () => {
  it('also tracks XMLHttpRequest', () => {
    const proto = XMLHttpRequest.prototype
    const realOpen = proto.open
    const realSend = proto.send
    proto.send = vi.fn()

    const h = harness()
    uninstall = installHttpInstrumentation(h.client)

    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', 'https://api.ext/data?token=x')
      xhr.send()
      xhr.dispatchEvent(new Event('loadend'))

      const crumb = h.crumb()
      expect((crumb!['data'] as Record<string, unknown>)['url']).toBe(
        'https://api.ext/data',
      )
    } finally {
      uninstall()
      uninstall = () => {}
      proto.open = realOpen
      proto.send = realSend
    }
  })
})

// Injectable clock that advances by [stepMs] on every read.
function steppingClock(stepMs: number): () => number {
  let t = 0
  return () => {
    const current = t
    t += stepMs
    return current
  }
}
