// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Client } from '../src/client'
import { createNextInstrumentation } from '../src/next/server'
import type { EventPayload } from '../src/types'

function setup() {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'https://localhost.invalid',
    projectId: 'next-proof',
    token: 'cyi_' + 'a'.repeat(40),
    autoInstall: false,
    beforeSend: (event) => {
      events.push(event)
      return null
    },
  })
  return { client, events, integration: createNextInstrumentation(client) }
}
const context = {
  routerKind: 'App Router',
  routePath: '/items/[id]',
  routeType: 'route',
} as const
const request = {
  method: 'POST',
  headers: { authorization: 'private-header' },
  path: '/items/private?token=private-query',
}

describe('Next Node integration', () => {
  it('shares one adapter per client across framework entry points and releases only its ownership', async () => {
    const { client, integration } = setup()
    expect(createNextInstrumentation(client)).toBe(integration)
    integration.uninstall()
    const replacement = createNextInstrumentation(client)
    expect(replacement).not.toBe(integration)
    integration.uninstall()
    expect(createNextInstrumentation(client)).toBe(replacement)
    replacement.uninstall()
    await client.close()
  })
  it('measures only the handler and retains its configured release', async () => {
    const events: EventPayload[] = []
    const client = new Client({
      endpointUrl: 'https://localhost.invalid',
      projectId: 'p',
      token: 'cyi_' + 'a'.repeat(40),
      autoInstall: false,
      slowMethodThresholdMs: 1,
      release: 'web@964',
      beforeSend: (event) => {
        events.push(event)
        return null
      },
    })
    const integration = createNextInstrumentation(client)
    await integration.withRequest(request, context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'result'
    })
    await integration.onRequestError(new Error('After headers'), request, context)
    const metrics = events.filter((event) => event['kind'] === 'slow_method')
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({
      release: 'web@964',
      label: 'next.route POST /items/[id]',
    })
    await client.close()
  })
  it('uses isolated concurrent contexts and only the standard traceparent', async () => {
    const { client, events, integration } = setup()
    await Promise.all(
      ['1', '2', '3'].map(async (digit) => {
        const headers = {
          ...request.headers,
          traceparent: `00-${digit.repeat(32)}-${digit.repeat(16)}-01`,
          baggage: 'email=private@example.invalid',
        }
        return integration.withRequest({ ...request, headers }, context, async () => {
          client.setTag('request', digit)
          await new Promise((resolve) => setTimeout(resolve, 3))
          client.captureException(new Error(`Request ${digit}`))
          expect(client.scope.traceBaggage).toBeUndefined()
        })
      }),
    )
    expect(events).toHaveLength(3)
    for (const digit of ['1', '2', '3'])
      expect(events.find((e) => e['trace_id'] === digit.repeat(32))).toMatchObject({
        tags: { request: digit },
      })
    expect(JSON.stringify(events)).not.toMatch(
      /private-header|private-query|private@example/,
    )
    expect(client.scope.toEventHash()).not.toHaveProperty('tags.request')
    await client.close()
  })

  it('keeps the response and body stream untouched, including deferred cancellation', async () => {
    const { client, integration } = setup()
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream(
      {
        pull() {
          pulled++
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const response = new Response(stream)
    expect(await integration.withRequest(request, context, async () => response)).toBe(
      response,
    )
    expect(response.bodyUsed).toBe(false)
    expect(pulled).toBe(0)
    await response.body?.cancel()
    expect(cancelled).toBe(true)
    await client.close()
  })

  it('leaves business exceptions intact and captures through the framework hook once', async () => {
    const { client, events, integration } = setup()
    const error = new Error('Business failure')
    await expect(
      integration.withRequest(request, context, async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(events).toHaveLength(0)
    await integration.onRequestError(error, request, context)
    await integration.onRequestError(error, request, context)
    expect(events).toHaveLength(1)
    integration.uninstall()
    await integration.onRequestError(new Error('After uninstall'), request, context)
    expect(events).toHaveLength(1)
    client.captureException(new Error('Client is still owned by the application'))
    expect(events).toHaveLength(2)
    await client.close()
  })

  it('correlates a wrapper rejection with a later hook by error identity without a carrier', async () => {
    const { client, events, integration } = setup()
    const origins = new Map<Error, string | undefined>()
    const errors = [
      new Error('First request failed'),
      new Error('Second request failed'),
    ]
    await Promise.all(
      errors.map(async (error) => {
        await expect(
          integration.withRequest(request, context, async () => {
            origins.set(error, client.scope.traceId)
            await new Promise((resolve) => setTimeout(resolve, 3))
            throw error
          }),
        ).rejects.toBe(error)
      }),
    )
    for (const error of errors.reverse())
      await integration.onRequestError(error, request, context)
    expect(events.map((event) => event['trace_id'])).toEqual(
      errors.map((error) => origins.get(error)),
    )
    await client.close()
  })

  it('does not assign a shared error to an arbitrary concurrent request', async () => {
    const { client, events, integration } = setup()
    const origins: (string | undefined)[] = []
    const shared = new Error('Shared object')
    for (let n = 0; n < 2; n++) {
      expect(() =>
        integration.withRequest(request, context, () => {
          origins.push(client.scope.traceId)
          throw shared
        }),
      ).toThrow(shared)
    }
    await integration.onRequestError(shared, request, context)
    expect(origins).not.toContain(events[0]?.['trace_id'])
    await client.close()
  })

  it('retains request scope in deferred work created before a streaming response returns', async () => {
    const { client, events, integration } = setup()
    const trace = 'a'.repeat(32)
    const response = integration.withRequest(
      { ...request, headers: { traceparent: `00-${trace}-${'b'.repeat(16)}-01` } },
      context,
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 5))
              client.captureException(new Error('Deferred stream failure'))
              controller.error(new Error('Stream transport failed'))
            },
          }),
        ),
    )
    await expect(response.text()).rejects.toThrow('Stream transport failed')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ trace_id: trace })
    expect(client.scope.traceId).not.toBe(trace)
    await client.close()
  })

  it('keeps a concurrent application client alive when instrumentation is uninstalled', async () => {
    const { client, events, integration } = setup()
    const work = integration.withRequest(request, context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      client.captureException(new Error('In-flight application work'))
      return 42
    })
    integration.uninstall()
    expect(await work).toBe(42)
    expect(integration.withRequest(request, context, () => 7)).toBe(7)
    expect(events).toHaveLength(1)
    await client.close()
  })

  it('does not let reporting failures replace the framework error response', async () => {
    const { client, integration } = setup()
    const brokenHeaders = () => {
      throw new Error('Header unavailable')
    }
    expect(
      integration.withRequest(
        { ...request, headers: brokenHeaders },
        context,
        () => 'preserved',
      ),
    ).toBe('preserved')
    const error = Object.defineProperty(new Error('Unreadable digest'), 'digest', {
      get() {
        throw new Error('Digest unavailable')
      },
    })
    await expect(
      integration.onRequestError(error, request, context),
    ).resolves.toBeUndefined()
    await client.close()
  })

  it('does not report Next control-flow errors or trust request paths as route templates', async () => {
    const { client, events, integration } = setup()
    for (const digest of [
      'NEXT_REDIRECT;replace;/target;307;',
      'NEXT_HTTP_ERROR_FALLBACK;404',
    ]) {
      await integration.onRequestError(
        Object.assign(new Error('Control flow'), { digest }),
        request,
        context,
      )
    }
    expect(events).toHaveLength(0)
    await integration.onRequestError(new Error('Actual failure'), request, {
      ...context,
      routePath: '/route?secret=private',
    })
    expect(JSON.stringify(events)).not.toContain('secret=private')
    await client.close()
  })
})
