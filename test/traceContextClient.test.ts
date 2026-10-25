import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { parseTraceparent } from '../src/traceContext'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'

// Client-side W3C Trace Context propagation (CYJS-13). jsdom environment: the own
// origin (same-origin) is always trusted; the other destinations go through
// the `tracePropagationTargets` allowlist.

const PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: PUBLIC_KEY,
  projectId: 'p',
  environment: 'production',
}
const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const RECEIVED_PARENT = '00f067aa0ba902b7'

function noopTransport(): Transport {
  return {
    send: vi.fn(() => true),
    flush: vi.fn(async () => {}),
  } as unknown as Transport
}

function makeClient(options: Partial<CloseYourItOptions> = {}): Client {
  return new Client({ ...base, ...options }, { transport: noopTransport() })
}

describe('Client.continueTrace — adopting the incoming trace context', () => {
  it('adopts the W3C trace-id as the correlation trace_id (1:1 mapping)', () => {
    const client = makeClient()
    client.continueTrace({ traceparent: VALID })
    expect(client.scope.traceId).toBe(TRACE)
  })

  it('reads the carrier from an object, Headers and a getter (case-insensitive)', () => {
    expect(run((c) => c.continueTrace({ TraceParent: VALID })).scope.traceId).toBe(
      TRACE,
    )
    expect(
      run((c) => c.continueTrace(new Headers({ traceparent: VALID }))).scope.traceId,
    ).toBe(TRACE)
    expect(
      run((c) =>
        c.continueTrace((name) =>
          name.toLowerCase() === 'traceparent' ? VALID : null,
        ),
      ).scope.traceId,
    ).toBe(TRACE)
  })

  it('a malformed traceparent is not adopted: keeps the page trace', () => {
    const client = makeClient()
    const generated = client.scope.traceId
    client.continueTrace({ traceparent: 'garbage' })
    expect(client.scope.traceId).toBe(generated)
    expect(client.scope.traceId).not.toBe(TRACE)
  })

  it('is a no-op if the SDK is disabled', () => {
    const client = makeClient({ publicKey: '' })
    client.continueTrace({ traceparent: VALID })
    expect(client.scope.traceId).not.toBe(TRACE)
  })
})

describe('Client.getTraceHeaders — propagation towards trusted destinations', () => {
  it('keeps trace-id and parent in standard format towards an allowed target', () => {
    const client = makeClient({ tracePropagationTargets: ['api.internal'] })
    client.continueTrace({ traceparent: VALID })
    const headers = client.getTraceHeaders('https://api.internal/v1/orders')
    const tp = parseTraceparent(headers['traceparent'])
    expect(tp?.traceId).toBe(TRACE)
    expect(tp?.parentId).toMatch(/^[0-9a-f]{16}$/)
    // Each hop generates its own span-id: it does not re-propagate the received parent.
    expect(tp?.parentId).not.toBe(RECEIVED_PARENT)
  })

  it('propagates tracestate and baggage only towards trusted destinations', () => {
    const client = makeClient({ tracePropagationTargets: ['api.internal'] })
    client.continueTrace({
      traceparent: VALID,
      tracestate: 'rojo=1',
      baggage: 'userId=alice',
    })
    const trusted = client.getTraceHeaders('https://api.internal/x')
    expect(trusted['tracestate']).toBe('rojo=1')
    expect(trusted['baggage']).toBe('userId=alice')
  })

  it('towards an untrusted host it sends no header (neither internal trace nor PII baggage)', () => {
    const client = makeClient({ tracePropagationTargets: ['api.internal'] })
    client.continueTrace({
      traceparent: VALID,
      tracestate: 'rojo=1',
      baggage: 'userId=alice',
    })
    expect(client.getTraceHeaders('https://evil.example.com/steal')).toEqual({})
  })

  it('same-origin is always trusted (relative URLs and same origin)', () => {
    const client = makeClient()
    expect(client.getTraceHeaders('/api/v1')['traceparent']).toBeDefined()
    expect(
      client.getTraceHeaders(`${location.origin}/api`)['traceparent'],
    ).toBeDefined()
  })

  it('without a target the destination is first-party (allowed)', () => {
    expect(makeClient().getTraceHeaders()['traceparent']).toBeDefined()
  })

  it('re-propagates the received sampling flag', () => {
    const client = makeClient()
    client.continueTrace({ traceparent: VALID.replace('-01', '-00') })
    expect(parseTraceparent(client.getTraceHeaders('/x')['traceparent'])?.sampled).toBe(
      false,
    )
  })

  it('without continueTrace it propagates the page trace_id with default sampled', () => {
    const client = makeClient()
    const tp = parseTraceparent(client.getTraceHeaders('/x')['traceparent'])
    expect(tp?.traceId).toBe(client.scope.traceId)
    expect(tp?.sampled).toBe(true)
  })

  it('normalizes a malformed incoming tracestate (dropped)', () => {
    const client = makeClient()
    client.continueTrace({ traceparent: VALID, tracestate: 'bad,,,' })
    expect(client.getTraceHeaders('/x')['tracestate']).toBeUndefined()
  })

  it('is {} if the SDK is disabled', () => {
    expect(makeClient({ publicKey: '' }).getTraceHeaders('/x')).toEqual({})
  })

  it('propagates stably with a global RegExp target (no lastIndex state)', () => {
    const client = makeClient({ tracePropagationTargets: [/api\.internal/g] })
    expect(
      client.getTraceHeaders('https://api.internal/x')['traceparent'],
    ).toBeDefined()
    expect(
      client.getTraceHeaders('https://api.internal/x')['traceparent'],
    ).toBeDefined()
  })
})

function run(fn: (client: Client) => void): Client {
  const client = makeClient()
  fn(client)
  return client
}
