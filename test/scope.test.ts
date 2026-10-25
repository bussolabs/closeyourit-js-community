import { describe, expect, it } from 'vitest'
import { FILTERED } from '../src/scrubber'
import { Scope } from '../src/scope'

describe('Scope', () => {
  it('is empty by default', () => {
    expect(new Scope().toEventHash()).toEqual({})
  })

  it('serializes populated user/tags/extra/contexts', () => {
    const scope = new Scope()
    scope.setUser({ id: 'acc_1' })
    scope.setTag('tenant', 'acme')
    scope.setExtra('plan', 'pro')
    scope.setContext('billing', { seats: 5 })

    const hash = scope.toEventHash()
    expect(hash['user']).toEqual({ id: 'acc_1' })
    expect(hash['tags']).toEqual({ tenant: 'acme' })
    expect(hash['extra']).toEqual({ plan: 'pro' })
    expect(hash['contexts']).toEqual({ billing: { seats: 5 } })
  })

  it('scrubs accidental PII in the scope (extra) and reduces user to {id}', () => {
    const scope = new Scope()
    scope.setUser({ id: '1', email: 'a@b.com' })
    scope.setExtra('token', 'abc')
    const hash = scope.toEventHash()
    expect(hash['user']).toEqual({ id: '1' })
    expect(hash['extra']).toEqual({ token: FILTERED })
  })

  it('without sendPii user is reduced to {id} (backend parity)', () => {
    const scope = new Scope()
    scope.setUser({ id: 'acc_1', email: 'a@b.com', username: 'alice', plan: 'pro' })
    expect(scope.toEventHash({ sendPii: false })['user']).toEqual({ id: 'acc_1' })
  })

  it('with sendPii user travels whole (still scrubbed by key)', () => {
    const scope = new Scope()
    scope.setUser({ id: 'acc_1', email: 'a@b.com', username: 'alice' })
    expect(scope.toEventHash({ sendPii: true })['user']).toEqual({
      id: 'acc_1',
      email: 'a@b.com',
      username: 'alice',
    })
  })

  it('setTags sets several tags at once', () => {
    const scope = new Scope()
    scope.setTags({ tenant: 'acme', tier: 'gold' })
    scope.setTag('area', 'checkout')
    expect(scope.toEventHash()['tags']).toEqual({
      tenant: 'acme',
      tier: 'gold',
      area: 'checkout',
    })
  })

  it('setRequest enters the hash (and wins over the automatic event request)', () => {
    const scope = new Scope()
    scope.setRequest({ url: 'https://manual', method: 'GET' })
    expect(scope.toEventHash()['request']).toEqual({
      url: 'https://manual',
      method: 'GET',
    })
    scope.setRequest(null)
    expect(scope.toEventHash()).not.toHaveProperty('request')
  })

  it('setUser(null) removes the user', () => {
    const scope = new Scope()
    scope.setUser({ id: '1' })
    scope.setUser(null)
    expect(scope.toEventHash()).not.toHaveProperty('user')
  })

  it('includes the breadcrumbs as {values:[...]}', () => {
    const scope = new Scope()
    scope.addBreadcrumb({ message: 'click' })
    const hash = scope.toEventHash() as { breadcrumbs: { values: unknown[] } }
    expect(hash.breadcrumbs.values).toHaveLength(1)
  })

  it('clear resets everything except what can be rebuilt', () => {
    const scope = new Scope()
    scope.setUser({ id: '1' })
    scope.setTraceId('t')
    scope.setRequest({ url: 'x' })
    scope.addBreadcrumb({ message: 'x' })
    scope.clear()
    expect(scope.toEventHash()).toEqual({})
    expect(scope.traceId).toBeUndefined()
  })
})

describe('Scope.fork (per-flow isolation, CYJS-7)', () => {
  it('copies user/tags/extra/contexts/request into the fork', () => {
    const scope = new Scope()
    scope.setUser({ id: '1' })
    scope.setTag('tenant', 'acme')
    scope.setExtra('plan', 'pro')
    scope.setContext('billing', { seats: 5 })
    scope.setRequest({ url: 'https://a', method: 'GET' })
    expect(scope.fork().toEventHash()).toEqual(scope.toEventHash())
  })

  it('isolates mutations: writing to the fork does not touch the original (nor vice versa)', () => {
    const scope = new Scope()
    scope.setUser({ id: 'base' })
    scope.setTag('a', '1')
    const fork = scope.fork()
    fork.setUser({ id: 'fork' })
    fork.setTag('a', '2')
    fork.setTag('b', '3')
    expect(scope.toEventHash()['user']).toEqual({ id: 'base' })
    expect(scope.toEventHash()['tags']).toEqual({ a: '1' })
    expect(fork.toEventHash()['user']).toEqual({ id: 'fork' })
    expect(fork.toEventHash()['tags']).toEqual({ a: '2', b: '3' })
  })

  it('isolates nested contexts (replacing a key in the fork does not mutate the original)', () => {
    const scope = new Scope()
    scope.setContext('billing', { seats: 5 })
    const fork = scope.fork()
    fork.setContext('billing', { seats: 9 })
    expect(scope.toEventHash()['contexts']).toEqual({ billing: { seats: 5 } })
    expect(fork.toEventHash()['contexts']).toEqual({ billing: { seats: 9 } })
  })

  it('fork() inherits the current traceId and breadcrumbs (temporary context)', () => {
    const scope = new Scope()
    scope.setTraceId('trace-1')
    scope.addBreadcrumb({ message: 'a' })
    const fork = scope.fork()
    expect(fork.traceId).toBe('trace-1')
    const hash = fork.toEventHash() as { breadcrumbs: { values: unknown[] } }
    expect(hash.breadcrumbs.values).toHaveLength(1)
  })

  it('breadcrumbs added to the fork do not appear in the original', () => {
    const scope = new Scope()
    scope.addBreadcrumb({ message: 'base' })
    const fork = scope.fork()
    fork.addBreadcrumb({ message: 'fork' })
    const baseHash = scope.toEventHash() as { breadcrumbs: { values: unknown[] } }
    const forkHash = fork.toEventHash() as { breadcrumbs: { values: unknown[] } }
    expect(baseHash.breadcrumbs.values).toHaveLength(1)
    expect(forkHash.breadcrumbs.values).toHaveLength(2)
  })

  it('fork({freshTrace:true}) resets traceId and starts without breadcrumbs (new request)', () => {
    const scope = new Scope()
    scope.setTraceId('trace-1')
    scope.addBreadcrumb({ message: 'a' })
    scope.setUser({ id: '1' })
    const fork = scope.fork({ freshTrace: true })
    expect(fork.traceId).toBeUndefined()
    expect(fork.toEventHash()).not.toHaveProperty('breadcrumbs')
    // the scope data (user) is still copied as the base of the request
    expect(fork.toEventHash()['user']).toEqual({ id: '1' })
  })

  it('preserves the maxBreadcrumbs limit in the fork', () => {
    const scope = new Scope(1)
    scope.addBreadcrumb({ message: 'a' })
    const fork = scope.fork()
    fork.addBreadcrumb({ message: 'b' })
    const hash = fork.toEventHash() as {
      breadcrumbs: { values: Array<{ message: string }> }
    }
    expect(hash.breadcrumbs.values).toHaveLength(1)
    expect(hash.breadcrumbs.values[0]!.message).toBe('b')
  })
})

describe('Scope — trace context W3C (CYJS-13)', () => {
  const ctx = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentId: '00f067aa0ba902b7',
    sampled: true,
    tracestate: 'rojo=1',
    baggage: 'userId=alice',
  }

  it('continueTrace adopts trace-id, parent, sampling, tracestate and baggage', () => {
    const scope = new Scope()
    scope.continueTrace(ctx)
    expect(scope.traceId).toBe(ctx.traceId)
    expect(scope.traceParentId).toBe(ctx.parentId)
    expect(scope.traceSampled).toBe(true)
    expect(scope.traceState).toBe('rojo=1')
    expect(scope.traceBaggage).toBe('userId=alice')
  })

  it('the baggage (potential PII) never ends up in the events', () => {
    const scope = new Scope()
    scope.continueTrace(ctx)
    expect(JSON.stringify(scope.toEventHash())).not.toContain('userId=alice')
  })

  it('fork() inherits the W3C trace context (same correlation unit)', () => {
    const scope = new Scope()
    scope.continueTrace(ctx)
    const fork = scope.fork()
    expect(fork.traceParentId).toBe(ctx.parentId)
    expect(fork.traceSampled).toBe(true)
    expect(fork.traceState).toBe('rojo=1')
    expect(fork.traceBaggage).toBe('userId=alice')
  })

  it('fork({freshTrace:true}) resets the W3C trace context (new request)', () => {
    const scope = new Scope()
    scope.continueTrace(ctx)
    const fork = scope.fork({ freshTrace: true })
    expect(fork.traceParentId).toBeUndefined()
    expect(fork.traceSampled).toBeUndefined()
    expect(fork.traceState).toBeUndefined()
    expect(fork.traceBaggage).toBeUndefined()
  })

  it('clear also resets the W3C trace context', () => {
    const scope = new Scope()
    scope.continueTrace(ctx)
    scope.clear()
    expect(scope.traceParentId).toBeUndefined()
    expect(scope.traceSampled).toBeUndefined()
    expect(scope.traceState).toBeUndefined()
    expect(scope.traceBaggage).toBeUndefined()
  })
})
