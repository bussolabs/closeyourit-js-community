// @vitest-environment node
// Server-side W3C propagation (CYJS-13): on Node there is no `location`, so
// same-origin does not exist — trust goes ONLY through `tracePropagationTargets`.
// Typical SSR case: inside `runWithScope` (per-request) the trace of the incoming
// request is adopted and propagated towards the allowed downstream service.

import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { parseTraceparent } from '../src/traceContext'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_secret',
  projectId: 'p',
  environment: 'production',
}
const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

function noopTransport(): Transport {
  return {
    send: vi.fn(() => true),
    flush: vi.fn(async () => {}),
  } as unknown as Transport
}

function makeClient(options: Partial<CloseYourItOptions> = {}): Client {
  return new Client({ ...base, ...options }, { transport: noopTransport() })
}

describe('W3C propagation on Node (no same-origin)', () => {
  it('without an allowlist an external host is denied ({})', () => {
    expect(makeClient().getTraceHeaders('https://any.com/x')).toEqual({})
  })

  it('without a target the destination stays first-party (allowed)', () => {
    expect(makeClient().getTraceHeaders()['traceparent']).toBeDefined()
  })

  it('propagates only towards the hosts in tracePropagationTargets', () => {
    const client = makeClient({ tracePropagationTargets: [/^https:\/\/api\.internal/] })
    expect(
      client.getTraceHeaders('https://api.internal/x')['traceparent'],
    ).toBeDefined()
    expect(client.getTraceHeaders('https://other.com/x')).toEqual({})
  })

  it('per-request flow: adopts the incoming trace and propagates it downstream', () => {
    const client = makeClient({ tracePropagationTargets: ['api.internal'] })
    client.runWithScope(() => {
      client.continueTrace({ traceparent: VALID })
      const headers = client.getTraceHeaders('https://api.internal/orders')
      expect(parseTraceparent(headers['traceparent'])?.traceId).toBe(TRACE)
      expect(client.getTraceHeaders('https://third-party.com/x')).toEqual({})
    })
  })
})
