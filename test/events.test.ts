import { describe, expect, it } from 'vitest'
import {
  buildErrorEvent,
  buildLogEvent,
  buildMessageEvent,
  normalizeError,
} from '../src/events'
import { FILTERED } from '../src/scrubber'
import { SDK_NAME, SDK_VERSION } from '../src/version'

describe('normalizeError', () => {
  it('extracts type/value/stack from an Error', () => {
    const err = new TypeError('x is null')
    const n = normalizeError(err)
    expect(n.type).toBe('TypeError')
    expect(n.value).toBe('x is null')
    expect(n.stack).toContain('TypeError')
  })

  it('handles strings', () => {
    expect(normalizeError('boom')).toEqual({
      type: 'Error',
      value: 'boom',
      stack: undefined,
    })
  })

  it('handles error-like objects', () => {
    const n = normalizeError({ name: 'CustomError', message: 'oops', stack: 's' })
    expect(n).toEqual({ type: 'CustomError', value: 'oops', stack: 's' })
  })

  it('serializes objects without message', () => {
    const n = normalizeError({ foo: 'bar' })
    expect(n.type).toBe('Error')
    expect(n.value).toBe('{"foo":"bar"}')
  })

  it('handles primitive values', () => {
    expect(normalizeError(42).value).toBe('42')
    expect(normalizeError(null).value).toBe('null')
  })
})

describe('buildErrorEvent', () => {
  const err = normalizeError(
    Object.assign(new Error('kaboom'), {
      stack: 'Error: kaboom\n    at fn (https://app/main.js:10:15)',
    }),
  )

  it('produces the Sentry payload with platform javascript', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      release: '1.2.3',
      handled: true,
      level: 'error',
      scopeHash: {},
      traceId: 'trace-1',
    })

    expect(payload['platform']).toBe('javascript')
    expect(payload['level']).toBe('error')
    expect(payload['environment']).toBe('production')
    expect(payload['release']).toBe('1.2.3')
    expect(payload['trace_id']).toBe('trace-1')
    expect(payload['sdk']).toEqual({ name: SDK_NAME, version: SDK_VERSION })
    expect(typeof payload['event_id']).toBe('string')
    expect(typeof payload['timestamp']).toBe('string')

    const exc = payload['exception'] as {
      values: Array<{
        type: string
        value: string
        mechanism: { type: string; handled: boolean }
        stacktrace: { frames: unknown[] }
      }>
    }
    expect(exc.values[0]!.type).toBe('Error')
    expect(exc.values[0]!.value).toBe('kaboom')
    expect(exc.values[0]!.mechanism).toEqual({ type: 'javascript', handled: true })
    expect(exc.values[0]!.stacktrace.frames).toHaveLength(1)

    const contexts = payload['contexts'] as { runtime: { name: string } }
    expect(contexts.runtime.name).toBe('browser')
  })

  it('omits release and trace_id when absent', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'development',
      handled: false,
      level: 'error',
      scopeHash: {},
    })
    expect(payload).not.toHaveProperty('release')
    expect(payload).not.toHaveProperty('trace_id')
  })

  it('merges the scope contexts into contexts (not at the top level)', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: { contexts: { billing: { plan: 'pro' } }, tags: { a: 'b' } },
    })
    const contexts = payload['contexts'] as Record<string, unknown>
    expect(contexts['billing']).toEqual({ plan: 'pro' })
    expect(contexts['runtime']).toBeDefined()
    // tags stays at the top level (spread of the base scope)
    expect(payload['tags']).toEqual({ a: 'b' })
    expect(payload).not.toHaveProperty('contexts.contexts')
  })

  it('scrubs secrets in the exception message', () => {
    const secret = normalizeError(new Error('failed token=abc123'))
    const payload = buildErrorEvent({
      error: secret,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
    })
    const exc = payload['exception'] as { values: Array<{ value: string }> }
    expect(exc.values[0]!.value).toContain(FILTERED)
  })

  it('scrubs the access header inside the exception message (CYJS-38)', () => {
    const leaky = normalizeError(
      new Error('POST /events failed — Authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL'),
    )
    const payload = buildErrorEvent({
      error: leaky,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
    })
    const exc = payload['exception'] as { values: Array<{ value: string }> }
    expect(exc.values[0]!.value).toBe(
      `POST /events failed — Authorization: ${FILTERED}`,
    )
  })

  it('applies the explicit context of the hint', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
      contexts: { custom: { a: 1 } },
    })
    const contexts = payload['contexts'] as Record<string, unknown>
    expect(contexts['custom']).toEqual({ a: 1 })
  })

  it('scrubs the hint contexts (defence in depth)', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
      contexts: { job: { api_key: 'secret', queue: 'default' } },
    })
    const contexts = payload['contexts'] as Record<string, Record<string, unknown>>
    expect(contexts['job']).toEqual({ api_key: FILTERED, queue: 'default' })
  })

  it('uses the injected runtime in contexts.runtime', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
      runtime: { name: 'node', version: 'v24.0.0' },
    })
    const contexts = payload['contexts'] as { runtime: Record<string, unknown> }
    expect(contexts.runtime).toEqual({ name: 'node', version: 'v24.0.0' })
  })

  it('attaches the request context when provided', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
      request: { url: 'https://app/checkout', headers: { 'User-Agent': 'UA' } },
    })
    expect(payload['request']).toEqual({
      url: 'https://app/checkout',
      headers: { 'User-Agent': 'UA' },
    })
  })

  it('the scope request wins over the automatic one', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: { request: { url: 'https://manual' } },
      request: { url: 'https://auto' },
    })
    expect(payload['request']).toEqual({ url: 'https://manual' })
  })

  it('adds server_name at the top level when provided (parity with the gem)', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
      serverName: 'web-1',
    })
    expect(payload['server_name']).toBe('web-1')
  })

  it('omits server_name when absent (browser)', () => {
    const payload = buildErrorEvent({
      error: err,
      environment: 'production',
      handled: false,
      level: 'error',
      scopeHash: {},
    })
    expect(payload).not.toHaveProperty('server_name')
  })
})

describe('buildMessageEvent', () => {
  it('uses message.formatted', () => {
    const payload = buildMessageEvent({
      message: 'cache miss',
      environment: 'production',
      level: 'warning',
      scopeHash: {},
    })
    expect(payload['message']).toEqual({ formatted: 'cache miss' })
    expect(payload['platform']).toBe('javascript')
    expect(payload['level']).toBe('warning')
  })

  it('scrubs the access header in the diagnostic message (CYJS-38)', () => {
    const payload = buildMessageEvent({
      message: 'retry with Authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL',
      environment: 'production',
      level: 'warning',
      scopeHash: {},
    })
    expect(payload['message']).toEqual({
      formatted: `retry with Authorization: ${FILTERED}`,
    })
  })

  it('accepts runtime and request like the error event', () => {
    const payload = buildMessageEvent({
      message: 'ping',
      environment: 'production',
      level: 'info',
      scopeHash: {},
      runtime: { name: 'node', version: 'v24.0.0' },
      request: { url: 'https://app/page' },
    })
    const contexts = payload['contexts'] as { runtime: Record<string, unknown> }
    expect(contexts.runtime).toEqual({ name: 'node', version: 'v24.0.0' })
    expect(payload['request']).toEqual({ url: 'https://app/page' })
  })

  it('adds server_name when provided, omits it otherwise', () => {
    const withHost = buildMessageEvent({
      message: 'ping',
      environment: 'production',
      level: 'info',
      scopeHash: {},
      serverName: 'web-1',
    })
    expect(withHost['server_name']).toBe('web-1')

    const without = buildMessageEvent({
      message: 'ping',
      environment: 'production',
      level: 'info',
      scopeHash: {},
    })
    expect(without).not.toHaveProperty('server_name')
  })
})

describe('buildLogEvent', () => {
  it('produces the log entry (without platform) with scrubbed attributes', () => {
    const payload = buildLogEvent({
      message: 'order created',
      level: 'info',
      environment: 'production',
      release: '1.0.0',
      logger: 'checkout',
      traceId: 't-1',
      attributes: { order_id: 1, password: 'x' },
    })
    expect(payload['level']).toBe('info')
    expect(payload['message']).toBe('order created')
    expect(payload['logger']).toBe('checkout')
    expect(payload['trace_id']).toBe('t-1')
    expect(payload['release']).toBe('1.0.0')
    expect(payload['attributes']).toEqual({ order_id: 1, password: FILTERED })
    expect(payload['sdk']).toEqual({ name: SDK_NAME, version: SDK_VERSION })
    expect(payload).not.toHaveProperty('platform')
  })

  it('omits empty attributes and absent optional fields', () => {
    const payload = buildLogEvent({
      message: 'x',
      level: 'debug',
      environment: 'development',
      attributes: {},
    })
    expect(payload).not.toHaveProperty('attributes')
    expect(payload).not.toHaveProperty('logger')
    expect(payload).not.toHaveProperty('trace_id')
    expect(payload).not.toHaveProperty('release')
  })

  it('scrubs the access header written in the message (CYJS-38)', () => {
    const payload = buildLogEvent({
      message: 'call rejected\nAuthorization: Bearer EXAMPLE_NOT_A_CREDENTIAL',
      level: 'warning',
      environment: 'production',
    })
    expect(payload['message']).toBe(`call rejected\nAuthorization: ${FILTERED}`)
  })

  it('scrubs sensitive assignments in the message (PII as for errors)', () => {
    const payload = buildLogEvent({
      message: 'login failed password=hunter2 for alice',
      level: 'warning',
      environment: 'production',
    })
    expect(payload['message']).toContain(FILTERED)
    expect(payload['message']).not.toContain('hunter2')
  })
})
