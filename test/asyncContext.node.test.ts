// @vitest-environment node
// Context isolation per async flow on real Node: AsyncLocalStorage
// keeps the scope and breadcrumbs of concurrent requests apart (CYJS-7). In the
// browser (single-threaded) isolation is not needed: see asyncContext.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_x',
  projectId: 'p',
  environment: 'production',
}

interface FakeTransport {
  calls: Array<{ payload: EventPayload; url: string }>
  send: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
}

function fakeTransport(): FakeTransport {
  const calls: Array<{ payload: EventPayload; url: string }> = []
  return {
    calls,
    send: vi.fn((payload: EventPayload, url: string) => {
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

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

describe('per async flow isolation on Node (CYJS-7)', () => {
  it('two concurrent requests do not contaminate each other user/request/trace (Scenario 1)', async () => {
    const { client, transport } = makeClient()

    const handle = (userId: string, delayMs: number): Promise<void> =>
      client.runWithScope(async () => {
        client.setUser({ id: userId })
        client.scope.setRequest({ url: `/u/${userId}`, method: 'GET' })
        // yields control: the event loop interleaves the two concurrent flows
        await wait(delayMs)
        client.captureException(new Error(`boom-${userId}`), { handled: true })
      })

    // 'bob' enters after 'alice' but captures first (shorter delay): with a global
    // holder, the error of 'alice' would inherit the user/request of 'bob'.
    await Promise.all([handle('alice', 30), handle('bob', 5)])

    expect(transport.calls).toHaveLength(2)
    const byUser = new Map(
      transport.calls.map((c) => [(c.payload['user'] as { id: string }).id, c.payload]),
    )
    const alice = byUser.get('alice')!
    const bob = byUser.get('bob')!
    expect((alice['request'] as { url: string }).url).toBe('/u/alice')
    expect((bob['request'] as { url: string }).url).toBe('/u/bob')
    // each event has its own correlation (trace_id per request)
    expect(alice['trace_id']).not.toBe(bob['trace_id'])
    expect(typeof alice['trace_id']).toBe('string')
  })

  it('breadcrumbs are isolated per flow (Definition of Done)', async () => {
    const { client, transport } = makeClient()

    const handle = (id: string, delayMs: number): Promise<void> =>
      client.runWithScope(async () => {
        client.addBreadcrumb({ message: `crumb-${id}` })
        await wait(delayMs)
        client.captureException(new Error(id), { handled: true })
      })

    await Promise.all([handle('a', 30), handle('b', 5)])

    for (const call of transport.calls) {
      const crumbs = (
        call.payload['breadcrumbs'] as { values: Array<{ message: string }> }
      ).values
      expect(crumbs).toHaveLength(1)
    }
  })

  it('nested scopes: the inner one isolates from the parent and restores it on return', () => {
    const { client } = makeClient()
    client.setUser({ id: 'root' })

    client.runWithScope(() => {
      client.setUser({ id: 'outer' })
      expect(client.scope.userId).toBe('outer')

      client.runWithScope(() => {
        client.setUser({ id: 'inner' })
        expect(client.scope.userId).toBe('inner')
      })

      expect(client.scope.userId).toBe('outer')
    })

    expect(client.scope.userId).toBe('root')
  })

  it('an exception inside runWithScope propagates and restores the scope (cleanup)', () => {
    const { client } = makeClient()
    client.setUser({ id: 'root' })
    expect(() =>
      client.runWithScope(() => {
        client.setUser({ id: 'temp' })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(client.scope.userId).toBe('root')
  })

  it('after an async runWithScope the scope returns to the base (cleanup)', async () => {
    const { client } = makeClient()
    client.setUser({ id: 'root' })
    await client.runWithScope(async () => {
      client.setUser({ id: 'req' })
      await wait(1)
      expect(client.scope.userId).toBe('req')
    })
    expect(client.scope.userId).toBe('root')
  })

  it('runWithScope generates a new trace_id; withScope inherits the current one', () => {
    const { client } = makeClient()
    const rootTrace = client.scope.traceId

    client.withScope(() => {
      expect(client.scope.traceId).toBe(rootTrace)
    })

    client.runWithScope(() => {
      expect(client.scope.traceId).not.toBe(rootTrace)
      expect(typeof client.scope.traceId).toBe('string')
    })
  })

  it('withScope isolates mutations but does NOT leave the current context', () => {
    const { client } = makeClient()
    client.setTag('env', 'prod')
    client.withScope(() => {
      client.setTag('area', 'checkout')
      expect(client.scope.toEventHash()['tags']).toEqual({
        env: 'prod',
        area: 'checkout',
      })
    })
    expect(client.scope.toEventHash()['tags']).toEqual({ env: 'prod' })
  })

  it('runWithScope returns the value of fn (sync and async)', async () => {
    const { client } = makeClient()
    expect(client.runWithScope(() => 42)).toBe(42)
    await expect(client.runWithScope(async () => 'ok')).resolves.toBe('ok')
  })

  it('passes the isolated scope to the callback', () => {
    const { client } = makeClient()
    client.runWithScope((scope) => {
      scope.setUser({ id: 'via-arg' })
      expect(client.scope.userId).toBe('via-arg')
    })
  })

  it('outside runWithScope the scope is the base one (behaviour unchanged)', () => {
    const { client } = makeClient()
    client.setUser({ id: 'base' })
    expect(client.scope.userId).toBe('base')
  })
})
