// In the browser (jsdom) AsyncLocalStorage does not exist: withScope/runWithScope
// isolate the scope only for the synchronous duration of the callback (the browser is
// single-threaded, no concurrent requests) and the global scope stays the
// default outside the block. Behaviour unchanged from before (CYJS-7).

import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

function makeClient(): Client {
  const transport = {
    send: vi.fn(() => true),
    flush: vi.fn(async () => {}),
  }
  return new Client(base, {
    transport: transport as unknown as Transport,
    random: () => 0,
  })
}

describe('scope in the browser (fallback without AsyncLocalStorage, CYJS-7)', () => {
  it('runWithScope isolates during synchronous execution and restores afterwards', () => {
    const client = makeClient()
    client.setUser({ id: 'root' })
    client.runWithScope(() => {
      client.setUser({ id: 'temp' })
      expect(client.scope.userId).toBe('temp')
    })
    expect(client.scope.userId).toBe('root')
  })

  it('the global scope stays the default outside withScope (behaviour unchanged)', () => {
    const client = makeClient()
    client.setUser({ id: 'u1' })
    client.setTag('a', '1')
    expect(client.scope.userId).toBe('u1')
    expect(client.scope.toEventHash()['tags']).toEqual({ a: '1' })
  })

  it('withScope isolates mutations and nests them', () => {
    const client = makeClient()
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

  it('an exception restores the scope (cleanup)', () => {
    const client = makeClient()
    client.setUser({ id: 'root' })
    expect(() =>
      client.runWithScope(() => {
        client.setUser({ id: 't' })
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(client.scope.userId).toBe('root')
  })

  it('runWithScope returns the value of fn', () => {
    const client = makeClient()
    expect(client.runWithScope(() => 7)).toBe(7)
  })
})
