// @vitest-environment node
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, createRouter, eventHandler, toNodeListener, createError } from 'h3'
import { createHooks } from 'hookable'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '../src/client'
import type { EventPayload } from '../src/types'
import { createNitroInstrumentation } from '../src/nuxt/server'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function setup(enabled = true) {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'http://127.0.0.1:1',
    projectId: 'nitro-proof',
    environment: 'certification',
    token: 'cyi_' + 'a'.repeat(40),
    autoInstall: false,
    enabled,
    slowMethodThresholdMs: 1,
    release: 'nuxt-proof',
    beforeSend(event) {
      events.push(event)
      return null
    },
  })
  cleanup.push(() => client.close())
  return { client, events, integration: createNitroInstrumentation(client) }
}

describe('Nitro Node instrumentation with real H3 dispatch', () => {
  it('isolates three concurrent requests and correlates errors reported outside their scopes', async () => {
    const { client, events, integration } = setup()
    const hooks = createHooks()
    const uninstall = integration.install(hooks)
    cleanup.push(uninstall)
    const app = createApp({
      onRequest: (event) => hooks.callHook('request', event),
      onError: async (error, event) => {
        await hooks.callHook('error', error, { event })
        event.node.res.statusCode = 500
        event.node.res.end('Application failure')
      },
    })
    const router = createRouter()
    router.get(
      '/work/:id',
      eventHandler((event) =>
        integration.withRequest(event, '/work/:id', async () => {
          const id = event.context.params!.id!
          client.scope.setTag('request', id)
          await new Promise((resolve) => setTimeout(resolve, 5 + Number(id)))
          client.captureMessage(`Log ${id}`)
          throw new Error(`Failure ${id}`)
        }),
      ),
    )
    app.use(router)
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address() as { port: number }
    const responses = await Promise.all(
      [1, 2, 3].map((id) =>
        fetch(`http://127.0.0.1:${address.port}/work/${id}?private=query`, {
          headers: {
            authorization: 'private-authorization',
            baggage: 'private=baggage',
          },
        }),
      ),
    )
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array(3).fill('Application failure'),
    )
    const errors = events.filter((event) => 'exception' in event)
    const metrics = events.filter((event) => event.kind === 'slow_method')
    expect(errors).toHaveLength(3)
    expect(metrics).toHaveLength(3)
    expect(new Set(errors.map((event) => event.trace_id)).size).toBe(3)
    for (const error of errors) {
      expect(
        metrics.filter((metric) => metric.trace_id === error.trace_id),
      ).toHaveLength(1)
      expect(error.contexts?.nuxt).toEqual({
        runtime: 'nitro',
        route: '/work/:id',
        phase: 'request',
      })
      const id = (error.exception as { values: Array<{ value: string }> }).values
        .at(-1)!
        .value.slice(-1)
      expect(error.tags?.request).toBe(id)
    }
    for (const value of ['private=query', 'private-authorization', 'private=baggage'])
      expect(JSON.stringify(events)).not.toContain(value)
    expect(client.scope.toEventHash().tags).toBeUndefined()
  })

  it('preserves stream identity, bytes and cancellation with deferred scope', async () => {
    const { client, events, integration } = setup()
    const event = { method: 'GET', node: { req: { headers: {} } } }
    let cancellation: unknown
    let controller: ReadableStreamDefaultController<Uint8Array>
    const response = await integration.withRequest(event, '/stream', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      client.scope.setTag('stream', 'owned')
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          setTimeout(() => {
            client.captureMessage('Deferred stream')
            controller.enqueue(new TextEncoder().encode('first'))
          }, 0)
        },
        cancel(reason) {
          cancellation = reason
        },
      })
      return new Response(stream)
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    await reader.cancel('Application cancellation')
    expect(cancellation).toBe('Application cancellation')
    const log = events.find(
      (entry) =>
        (entry.message as { formatted?: string })?.formatted === 'Deferred stream',
    )
    expect(log?.tags?.stream).toBe('owned')
    expect(log?.trace_id).toBe(
      events.find((entry) => entry.kind === 'slow_method')?.trace_id,
    )
  })

  it('preserves control responses, disabled behavior, uninstallation and event identity', async () => {
    const { client, events, integration } = setup()
    const event = {
      method: 'GET',
      node: {
        req: {
          headers: {
            traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
          },
        },
      },
    }
    await integration.onError(
      createError({ statusCode: 404, message: 'Expected missing' }),
      { event },
    )
    expect(events).toHaveLength(0)
    await integration.onError(new Error('Unhandled'), { event })
    expect(events[0]?.trace_id).toBe('11111111111111111111111111111111')
    expect(events[0]?.request?.url).toBe('/unknown')
    expect(createNitroInstrumentation(client)).toBe(integration)
    integration.uninstall()
    let calls = 0
    expect(integration.withRequest(event, '/work', () => ++calls)).toBe(1)
    await integration.onError(new Error('Not captured'), { event })
    expect(events).toHaveLength(1)
    const disabled = setup(false)
    expect(disabled.integration.withRequest(event, '/work', () => ++calls)).toBe(2)
    await disabled.integration.onError(new Error('Disabled'), { event })
    expect(disabled.events).toHaveLength(0)
    client.captureMessage('Application still owns client')
    expect(events).toHaveLength(2)
  })
})
