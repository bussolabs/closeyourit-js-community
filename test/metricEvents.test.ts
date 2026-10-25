import { describe, expect, it } from 'vitest'
import { buildPerformanceIssueEvent, buildSlowMethodEvent } from '../src/metricEvents'
import { FILTERED } from '../src/scrubber'
import { SDK_NAME, SDK_VERSION } from '../src/version'

const UUID_WITH_DASHES =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('buildSlowMethodEvent', () => {
  it('preserves a configured release without exposing embedded credentials', () => {
    const base = { label: 'next.route GET /items', durationMs: 1, environment: 'test' }
    expect(buildSlowMethodEvent(base)).not.toHaveProperty('release')
    expect(buildSlowMethodEvent({ ...base, release: 'web@964' })).toHaveProperty(
      'release',
      'web@964',
    )
    expect(
      JSON.stringify(buildSlowMethodEvent({ ...base, release: 'token=private-value' })),
    ).not.toContain('private-value')
  })
  it('produces the kind=slow_method payload with a sample_id WITH dashes', () => {
    const payload = buildSlowMethodEvent({
      label: 'checkout.total',
      durationMs: 512.4567,
      environment: 'production',
      traceId: 't-1',
    })

    expect(payload['kind']).toBe('slow_method')
    expect(String(payload['sample_id'])).toMatch(UUID_WITH_DASHES)
    expect(payload['duration_ms']).toBe(512.46)
    expect(typeof payload['occurred_at']).toBe('string')
    expect(payload['environment']).toBe('production')
    expect(payload['label']).toBe('checkout.total')
    expect(payload['trace_id']).toBe('t-1')
    expect(payload['sdk']).toEqual({ name: SDK_NAME, version: SDK_VERSION })
    expect(payload).not.toHaveProperty('arguments')
    expect(payload).not.toHaveProperty('file')
  })

  it('empty or blank label → TypeError (programmer error)', () => {
    expect(() =>
      buildSlowMethodEvent({ label: '', durationMs: 1, environment: 'x' }),
    ).toThrow(TypeError)
    expect(() =>
      buildSlowMethodEvent({ label: '   ', durationMs: 1, environment: 'x' }),
    ).toThrow(TypeError)
  })

  it('arguments scrubbed and stringified only when present', () => {
    const payload = buildSlowMethodEvent({
      label: 'pay',
      durationMs: 300,
      environment: 'production',
      args: { order_id: 42, password: 'secret' },
    })
    expect(payload['arguments']).toEqual([
      { name: 'order_id', value: '42' },
      { name: 'password', value: FILTERED },
    ])
  })

  it('truncates argument values to 120 characters', () => {
    const payload = buildSlowMethodEvent({
      label: 'x',
      durationMs: 1,
      environment: 'p',
      args: { blob: 'a'.repeat(500) },
    })
    const args = payload['arguments'] as Array<{ value: string }>
    expect(args[0]!.value.length).toBeLessThanOrEqual(121) // 120 + ellipsis
  })
})

describe('buildPerformanceIssueEvent', () => {
  it('slow_external_http carries http_host/http_url and not route', () => {
    const payload = buildPerformanceIssueEvent({
      subtype: 'slow_external_http',
      durationMs: 1500.129,
      environment: 'production',
      httpHost: 'api.stripe.com',
      httpUrl: '/v1/charges/<n>',
      traceId: 't-1',
    })
    expect(payload['kind']).toBe('performance_issue')
    expect(payload['subtype']).toBe('slow_external_http')
    expect(payload['duration_ms']).toBe(1500.13)
    expect(payload['http_host']).toBe('api.stripe.com')
    expect(payload['http_url']).toBe('/v1/charges/<n>')
    expect(String(payload['sample_id'])).toMatch(UUID_WITH_DASHES)
    expect(payload).not.toHaveProperty('route')
    expect(payload).not.toHaveProperty('query_count')
  })

  it('repeated_http carries query_count (wire parity with dart/ruby)', () => {
    const payload = buildPerformanceIssueEvent({
      subtype: 'repeated_http',
      environment: 'production',
      httpHost: 'api.x.com',
      httpUrl: '/v1/items/<n>',
      queryCount: 5,
    })
    expect(payload['query_count']).toBe(5)
    // A single cross-SDK wire field name: never again the old count_in_request.
    expect(payload).not.toHaveProperty('count_in_request')
    expect(payload).not.toHaveProperty('duration_ms')
  })

  it('jank carries route', () => {
    const payload = buildPerformanceIssueEvent({
      subtype: 'jank',
      durationMs: 240,
      environment: 'production',
      route: '/orders/<n>',
    })
    expect(payload['route']).toBe('/orders/<n>')
    expect(payload).not.toHaveProperty('http_host')
  })
})
