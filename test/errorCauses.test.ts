import { describe, expect, it } from 'vitest'
import { buildErrorEvent, normalizeError } from '../src/events'
import { capEvent, MAX_PAYLOAD_BYTES } from '../src/budget'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { EventPayload } from '../src/types'

function error(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), {
    cause,
    stack: `Error: ${message}\n    at work (https://app.test/${message}.js:7:2)`,
  })
}

function event(input: unknown, handled = true): EventPayload {
  return buildErrorEvent({
    error: normalizeError(input),
    environment: 'test',
    release: '1.2.3',
    handled,
    level: 'error',
    scopeHash: {},
  })
}

interface Exception {
  type: string
  value: string
  stacktrace: { frames: Array<{ filename: string }> }
  mechanism: { type: string; handled: boolean }
}
function values(payload: EventPayload): Exception[] {
  return (payload['exception'] as { values: Exception[] }).values
}

function chain(length: number): Error {
  let current = error('root')
  for (let index = 1; index < length; index++)
    current = error(`wrapper-${index}`, current)
  return current
}

describe('error cause chains', () => {
  it('keeps zero, one and multiple causes in oldest-first order with the outer error last', () => {
    expect(values(event(error('outer'))).map((item) => item.value)).toEqual(['outer'])
    expect(
      values(event(error('outer', error('inner')))).map((item) => item.value),
    ).toEqual(['inner', 'outer'])
    const payload = event(error('outer', error('middle', error('root'))), false)
    expect(values(payload).map((item) => item.value)).toEqual([
      'root',
      'middle',
      'outer',
    ])
    expect(values(payload).map((item) => item.stacktrace.frames[0]?.filename)).toEqual([
      'root.js',
      'middle.js',
      'outer.js',
    ])
    for (const item of values(payload))
      expect(item.mechanism).toEqual({ type: 'javascript', handled: false })
    expect(payload).toMatchObject({ environment: 'test', release: '1.2.3' })
    expect(payload).not.toHaveProperty('truncated')
  })

  it('reads the non-enumerable cause installed by the native Error constructor', () => {
    const native = Reflect.construct(Error, [
      'outer',
      { cause: new TypeError('inner') },
    ])
    expect(Object.keys(native)).not.toContain('cause')
    expect(values(event(native)).map((item) => [item.type, item.value])).toEqual([
      ['TypeError', 'inner'],
      ['Error', 'outer'],
    ])
  })

  it('normalizes string and error-like causes, and treats null as the end of the chain', () => {
    expect(
      values(
        event(error('outer', { name: 'CustomError', message: 'inner', cause: 'root' })),
      ).map((item) => [item.type, item.value]),
    ).toEqual([
      ['Error', 'root'],
      ['CustomError', 'inner'],
      ['Error', 'outer'],
    ])
    expect(values(event(error('outer', null)))).toHaveLength(1)
    expect(values(event(error('outer', 0)))[0]?.value).toBe('0')
  })

  it.each([9, 10, 11])(
    'caps a chain of %i exceptions at ten, keeping the outer and nearest causes',
    (length) => {
      const payload = event(chain(length))
      expect(values(payload)).toHaveLength(Math.min(length, 10))
      expect(values(payload)[values(payload).length - 1]?.value).toBe(
        `wrapper-${length - 1}`,
      )
      expect(values(payload)[0]?.value).toBe(length === 11 ? 'wrapper-1' : 'root')
      expect(payload['truncated']).toBe(length > 10 ? true : undefined)
    },
  )

  it('bounds self-cycles, indirect cycles and fresh-object cause getters', () => {
    const self = error('self')
    Object.assign(self, { cause: self })
    expect(values(event(self))).toHaveLength(1)
    expect(event(self)['truncated']).toBe(true)
    const outer = error('outer')
    Object.assign(outer, { cause: error('inner', outer) })
    expect(values(event(outer)).map((item) => item.value)).toEqual(['inner', 'outer'])
    expect(event(outer)['truncated']).toBe(true)
    let reads = 0
    function fresh(): object {
      return {
        message: 'fresh',
        get cause() {
          reads++
          return fresh()
        },
      }
    }
    expect(values(event(fresh()))).toHaveLength(10)
    expect(reads).toBe(10)
  })

  it('contains throwing getters and revoked proxies without losing the outer error', () => {
    const outer = error('outer')
    Object.defineProperty(outer, 'cause', {
      get() {
        throw new Error('private getter content')
      },
    })
    expect(values(event(outer)).map((item) => item.value)).toEqual(['outer'])
    expect(event(outer)['truncated']).toBe(true)
    const hostile = Object.defineProperties(
      {},
      {
        message: {
          get() {
            throw new Error('private getter content')
          },
        },
        stack: {
          get() {
            throw new Error('private stack content')
          },
        },
      },
    )
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    for (const cause of [hostile, revocable.proxy]) {
      const payload = event(error('outer', cause))
      expect(values(payload)[values(payload).length - 1]?.value).toBe('outer')
      expect(JSON.stringify(payload)).not.toContain('private')
    }
  })

  it('scrubs every cause message and structured fallback without serializing the cause graph', () => {
    const inner = Object.assign(
      error('password=inner-secret', {
        password: 'object-secret',
        detail: 'public',
        cause: { message: 'email=user@example.com' },
      }),
      {
        stack:
          'Error: password=inner-secret\n    at inner (https://app.test/inner.js:7:2)',
      },
    )
    const outer = Object.assign(error('token=outer-secret', inner), {
      stack: 'Error: token=outer-secret\n    at outer (https://app.test/outer.js:7:2)',
    })
    const payload = event(outer)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toMatch(
      /outer-secret|inner-secret|object-secret|user@example.com/,
    )
    expect(serialized).toContain('[FILTERED]')
    expect(values(payload)[1]?.value).toContain('public')
    expect(values(payload)[1]?.value).not.toContain('cause')
  })

  it('never invokes JSON serialization hooks in structured causes', () => {
    let calls = 0
    const cause = {
      detail: {
        toJSON() {
          calls++
          return { password: 'hook-secret' }
        },
      },
    }
    const payload = event(error('outer', cause))
    expect(calls).toBe(0)
    expect(JSON.stringify(payload)).not.toContain('hook-secret')
  })

  it('contains cyclic, deeply nested and unserializable fallback details', () => {
    const circular: Record<string, unknown> = { password: 'hidden' }
    circular['self'] = circular
    expect(values(event(error('outer', circular)))[0]?.value).toContain('[Circular]')
    let deep: unknown = {}
    for (let index = 0; index < 11; index++) deep = { nested: deep }
    const withGetter = {
      get detail() {
        throw new Error('getter-secret')
      },
    }
    for (const cause of [deep, withGetter, { large: BigInt(1) }, function named() {}]) {
      const payload = event(error('outer', cause))
      expect(values(payload)[0]?.value).toBe('[Unserializable error]')
      expect(payload['truncated']).toBe(true)
    }
    expect(
      values(event(error('outer', { detail: ['safe', { token: 'hidden' }] })))[0]
        ?.value,
    ).not.toContain('hidden')
    expect(values(event(new Error('')))[0]?.value).toBe('Error')
    const emptyName = Object.assign(new Error('message'), { name: '' })
    expect(values(event(emptyName))[0]?.type).toBe('Error')
  })

  it('keeps all ten identities within the existing UTF-8 payload budget', () => {
    let cause: unknown
    for (let index = 0; index < 10; index++)
      cause = Object.assign(error('safe', cause), {
        message: '😀'.repeat(30000),
        name: `Error${index}`,
      })
    const payload = capEvent(event(cause), MAX_PAYLOAD_BYTES)
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    expect(values(payload).map((item) => item.type)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Error${index}`),
    )
    expect(payload['truncated']).toBe(true)
  })

  it('preserves outer-based deduplication and allows capturing a cause independently', () => {
    const sent: EventPayload[] = []
    const transport = {
      send(payload: EventPayload) {
        sent.push(payload)
        return true
      },
      async flush() {},
    } as unknown as Transport
    const client = new Client(
      {
        endpointUrl: 'https://www.closeyour.it',
        publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        projectId: 'p',
        environment: 'test',
      },
      { transport, random: () => 0 },
    )
    const inner = error('inner')
    const outer = error('outer', inner)
    client.captureException(outer)
    client.captureException(outer)
    client.captureException(error('outer', error('different cause')))
    client.captureException(inner)
    expect(sent).toHaveLength(2)
    expect(values(sent[0]!).map((item) => item.value)).toEqual(['inner', 'outer'])
    expect(values(sent[1]!).map((item) => item.value)).toEqual(['inner'])
  })
})
