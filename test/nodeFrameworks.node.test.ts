// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import Fastify from 'fastify'
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node'
import { context, trace, createContextKey } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { Client } from '../src/client'
import type { EventPayload } from '../src/types'
import { createExpressMonitoring } from '../src/express'
import { createFastifyMonitoring } from '../src/fastify'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('A local address is required')
  return `http://127.0.0.1:${address.port}`
}
function setup() {
  const events: EventPayload[] = []
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const client = new Client({
    endpointUrl: 'http://127.0.0.1:1',
    token: 'cyi_' + 'a'.repeat(40),
    projectId: 'node-proof',
    autoInstall: false,
    environment: 'certification',
    release: 'node-proof',
    beforeSend(event) {
      events.push(event)
      return null
    },
  })
  cleanup.push(
    () => provider.shutdown(),
    () => client.close(),
  )
  return {
    events,
    exporter,
    provider,
    client,
    options: {
      tracer: provider.getTracer('node-proof'),
      propagationTargets: ['http://127.0.0.1'],
    },
  }
}

describe('real Node framework request ownership', () => {
  it('isolates Express requests and preserves custom error responses with real SERVER spans', async () => {
    const { client, options, events, exporter, provider } = setup()
    const monitor = createExpressMonitoring(client, options)
    const app = express()
    app.use(monitor.middleware)
    app.post('/work/:id', async (request) => {
      await delay()
      client.captureMessage('Work ' + request.params.id)
      throw new Error('Failure ' + request.params.id)
    })
    app.use(monitor.errors)
    app.use(
      (
        error: Error,
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => response.status(503).send('application response'),
    )
    const endpoint = await listen(createServer(app))
    const responses = await Promise.all(
      ['one', 'two', 'three'].map((id) =>
        fetch(`${endpoint}/work/${id}?private=private-query`, {
          method: 'POST',
          body: 'private-body',
          headers: { cookie: 'private-cookie', baggage: 'private=private-baggage' },
        }),
      ),
    )
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array(3).fill('application response'),
    )
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503])
    await provider.forceFlush()
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(3)
    expect(spans.map((span) => span.name)).toEqual(Array(3).fill('POST /work/:id'))
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(3)
    for (const span of spans)
      expect(
        events.filter((event) => event.trace_id === span.spanContext().traceId),
      ).toHaveLength(2)
    expect(
      JSON.stringify({ events, attributes: spans.map((span) => span.attributes) }),
    ).not.toMatch(/private-(query|body|cookie|baggage)/)
    expect(client.scope.traceId).not.toBe(spans[0]!.spanContext().traceId)
    monitor.uninstall()
    await fetch(endpoint + '/work/removed', { method: 'POST' })
    await provider.forceFlush()
    expect(exporter.getFinishedSpans()).toHaveLength(3)
    expect(
      events.filter((event) =>
        event.exception?.values?.some((value) => value.value === 'Failure removed'),
      ),
    ).toHaveLength(0)
  })

  it('exports actual CLIENT parent identity and preserves fetch body, existing headers and cancellation', async () => {
    const { client, options, exporter, provider } = setup()
    const downstream = createExpressMonitoring(client, options)
    const target = express()
    target.use(downstream.middleware)
    target.use(express.text())
    target.post('/echo', async (request, response) => {
      if (request.query.delay) await delay(100)
      response.json({
        body: request.body,
        traceparent: request.headers.traceparent,
        custom: request.headers['x-custom'],
      })
    })
    const destination = await listen(createServer(target))
    const upstream = createExpressMonitoring(client, {
      ...options,
      propagationTargets: [destination],
    })
    const app = express()
    app.use(upstream.middleware)
    app.get('/work', async (_request, response) => {
      const result = await upstream.fetch(destination + '/echo', {
        redirect: 'error',
        method: 'POST',
        body: 'exact body',
        headers: { 'x-custom': 'preserved' },
      })
      response.json(await result.json())
    })
    const endpoint = await listen(createServer(app))
    const result = await (await fetch(endpoint + '/work')).json()
    expect(result.body).toBe('exact body')
    expect(result.custom).toBe('preserved')
    await provider.forceFlush()
    const spans = exporter.getFinishedSpans()
    const outer = spans.find((span) => span.name === 'GET /work')!
    const call = spans.find((span) => span.kind === 2)!
    const inner = spans.find((span) => span.name === 'POST /echo')!
    expect(call.parentSpanContext?.spanId).toBe(outer.spanContext().spanId)
    expect(inner.parentSpanContext?.spanId).toBe(call.spanContext().spanId)
    expect(result.traceparent.split('-')[2]).toBe(call.spanContext().spanId)
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1)
    const controller = new AbortController()
    const failure = upstream.fetch(destination + '/echo?delay=1', {
      method: 'POST',
      body: 'exact',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await expect(failure).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps automatic redirects unchanged without leaking an injected carrier across origins', async () => {
    const { client, options } = setup()
    const received: Array<string | undefined> = []
    const destination = await listen(
      createServer((request, response) => {
        received.push(request.headers.traceparent as string | undefined)
        response.end('redirect preserved')
      }),
    )
    const origin = await listen(
      createServer((request, response) => {
        received.push(request.headers.traceparent as string | undefined)
        response.writeHead(302, { location: destination })
        response.end()
      }),
    )
    const monitor = createExpressMonitoring(client, {
      ...options,
      propagationTargets: [origin],
    })
    const response = await monitor.fetch(origin)
    expect(await response.text()).toBe('redirect preserved')
    expect(response.redirected).toBe(true)
    expect(response.url).toBe(destination + '/')
    expect(received).toEqual([undefined, undefined])
  })

  it.each(['manual', 'error'] as const)(
    'injects only at the allowed origin with redirect %s',
    async (redirect) => {
      const { client, options, exporter } = setup()
      let excludedRequests = 0
      const received: Array<string | undefined> = []
      const destination = await listen(
        createServer((_request, response) => {
          excludedRequests++
          response.end('excluded')
        }),
      )
      const origin = await listen(
        createServer((request, response) => {
          received.push(request.headers.traceparent as string | undefined)
          response.writeHead(302, { location: destination })
          response.end('application redirect')
        }),
      )
      const monitor = createExpressMonitoring(client, {
        ...options,
        propagationTargets: [origin],
      })
      const result = monitor.fetch(new Request(origin, { redirect }))
      if (redirect === 'error') {
        await expect(result).rejects.toBeInstanceOf(TypeError)
      } else {
        const response = await result
        expect(response.status).toBe(302)
        expect(response.redirected).toBe(false)
        expect(response.headers.get('location')).toBe(destination)
        expect(await response.text()).toBe('application redirect')
      }
      expect(excludedRequests).toBe(0)
      const outgoing = exporter.getFinishedSpans().find((span) => span.kind === 2)!
      expect(received).toEqual([
        `00-${outgoing.spanContext().traceId}-${outgoing.spanContext().spanId}-01`,
      ])
      expect(outgoing.status.code).toBe(redirect === 'error' ? 2 : 0)
    },
  )

  it.each(['follow', 'manual', 'error'] as const)(
    'preserves application carriers with redirect %s',
    async (redirect) => {
      const { client, options } = setup()
      const carrier = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'
      const origin = await listen(
        createServer((request, response) => {
          response.end(request.headers.traceparent)
        }),
      )
      const monitor = createExpressMonitoring(client, {
        ...options,
        propagationTargets: [origin],
      })
      const response = await monitor.fetch(
        new Request(origin, {
          redirect,
          headers: { traceparent: carrier },
        }),
      )
      expect(await response.text()).toBe(carrier)
    },
  )

  it('observes Fastify hooks without replacing custom handlers or leaking child plugin scope', async () => {
    const { client, options, exporter, provider, events } = setup()
    const monitor = createFastifyMonitoring(client, options)
    const app = Fastify({ logger: false })
    cleanup.push(() => app.close())
    app.register(async (child) => {
      monitor.install(child)
      child.setErrorHandler((_error, _request, reply) =>
        reply.code(502).send({ application: true }),
      )
      child.get('/work/:id', async (request) => {
        await delay()
        throw new Error('Fastify ' + (request.params as { id: string }).id)
      })
    })
    app.get('/outside', async () => ({ outside: true }))
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 })
    const responses = await Promise.all(
      ['one', 'two', 'three'].map((id) => fetch(endpoint + '/work/' + id)),
    )
    expect(responses.map((response) => response.status)).toEqual([502, 502, 502])
    expect(await responses[0]!.json()).toEqual({ application: true })
    await fetch(endpoint + '/outside')
    await provider.forceFlush()
    expect(exporter.getFinishedSpans()).toHaveLength(3)
    expect(events).toHaveLength(3)
    expect(new Set(events.map((event) => event.trace_id)).size).toBe(3)
    monitor.uninstall()
    expect((await fetch(endpoint + '/work/uninstalled')).status).toBe(502)
    expect(events).toHaveLength(3)
  })

  it('does not consume a Request while deciding that its origin is not allowed', async () => {
    const { client, options, exporter } = setup()
    const destination = await listen(
      createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += chunk
        response.end(body)
      }),
    )
    const monitor = createExpressMonitoring(client, {
      ...options,
      propagationTargets: [],
    })
    const request = new Request(destination, { method: 'POST', body: 'original body' })
    const response = await monitor.fetch(request)
    expect(await response.text()).toBe('original body')
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it('keeps a SERVER span open through streaming and ends it once when the reader cancels', async () => {
    const { client, options, exporter } = setup()
    const monitor = createExpressMonitoring(client, options)
    const app = express()
    app.use(monitor.middleware)
    let closed = 0
    app.get('/stream/:id', (_request, response) => {
      response.write('first\n')
      const timer = setInterval(() => response.write('next\n'), 10)
      response.once('close', () => {
        clearInterval(timer)
        closed++
      })
    })
    const endpoint = await listen(createServer(app))
    const response = await fetch(endpoint + '/stream/private-value')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first\n')
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    monitor.uninstall()
    await reader.cancel()
    await delay(30)
    expect(closed).toBe(1)
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe('GET /stream/:id')
    expect(spans[0]!.status).toMatchObject({ code: 2, message: 'response_closed' })
  })

  it('only captures opted-in expected HTTP errors with a stable message and keeps the original handler argument', async () => {
    const { client, options, events } = setup()
    for (const captureExpectedErrors of [false, true]) {
      const monitor = createExpressMonitoring(client, {
        ...options,
        captureExpectedErrors,
      })
      const app = express()
      const original = Object.assign(new Error('private validation body'), {
        status: 422,
      })
      app.use(monitor.middleware)
      app.get('/validate', () => {
        throw original
      })
      app.use(
        monitor.wrapErrorHandler((error, _request, response, _next) => {
          expect(error).toBe(original)
          response.status(422).end('preserved')
        }),
      )
      const endpoint = await listen(createServer(app))
      expect(await (await fetch(endpoint + '/validate')).text()).toBe('preserved')
    }
    expect(events).toHaveLength(1)
    expect(events[0]!.exception?.values?.at(-1)?.value).toBe('HTTP 422')
    expect(events[0]!.exception?.values?.at(-1)?.mechanism?.handled).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private validation body')
  })

  it('reuses an application-owned span without renaming, ending or removing its context manager', async () => {
    const { client, options, exporter, events } = setup()
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    cleanup.push(() => {
      context.disable()
      manager.disable()
    })
    const appSpan = options.tracer.startSpan('Application-owned request')
    const applicationKey = createContextKey('application-owned-key')
    const monitor = createExpressMonitoring(client, { spanMode: 'existing' })
    const app = express()
    app.use((_request, _response, next) =>
      context.with(
        trace.setSpan(context.active().setValue(applicationKey, 'preserved'), appSpan),
        next,
      ),
    )
    app.use(monitor.middleware)
    app.get('/owned', (_request, response) => {
      expect(trace.getSpan(context.active())).toBe(appSpan)
      expect(context.active().getValue(applicationKey)).toBe('preserved')
      client.captureMessage('Owned request')
      response.end('preserved')
    })
    const endpoint = await listen(createServer(app))
    expect(await (await fetch(endpoint + '/owned')).text()).toBe('preserved')
    expect(events[0]!.trace_id).toBe(appSpan.spanContext().traceId)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    monitor.uninstall()
    context.with(trace.setSpan(context.active(), appSpan), () =>
      expect(trace.getSpan(context.active())).toBe(appSpan),
    )
    appSpan.end()
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      'Application-owned request',
    ])
  })

  it('parents explicit fetch under the application active child span and preserves context values', async () => {
    const { client, options, exporter } = setup()
    const manager = new AsyncLocalStorageContextManager().enable()
    expect(context.setGlobalContextManager(manager)).toBe(true)
    cleanup.push(() => {
      context.disable()
      manager.disable()
    })
    const target = await listen(
      createServer((_request, response) => response.end('complete')),
    )
    const monitor = createExpressMonitoring(client, {
      ...options,
      propagationTargets: [target],
    })
    const key = createContextKey('application-key-before-monitor')
    const app = express()
    app.use((_request, _response, next) =>
      context.with(context.active().setValue(key, 'preserved'), next),
    )
    app.use(monitor.middleware)
    app.get('/nested', async (_request, response) => {
      expect(context.active().getValue(key)).toBe('preserved')
      await options.tracer.startActiveSpan('Application child', async (span) => {
        try {
          response.end(await (await monitor.fetch(target)).text())
        } finally {
          span.end()
        }
      })
    })
    const endpoint = await listen(createServer(app))
    expect(await (await fetch(endpoint + '/nested')).text()).toBe('complete')
    const spans = exporter.getFinishedSpans()
    const child = spans.find((span) => span.name === 'Application child')!
    const outgoing = spans.find((span) => span.name === 'HTTP GET')!
    expect(outgoing.parentSpanContext?.spanId).toBe(child.spanContext().spanId)
  })
})
