import 'reflect-metadata'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { Client } from '@bussolabs/closeyourit-js'
import { createExpressMonitoring } from '@bussolabs/closeyourit-js/express'
import { createFastifyMonitoring } from '@bussolabs/closeyourit-js/fastify'
import { createNestMonitoring } from '@bussolabs/closeyourit-js/nest'
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import express from 'express'
import Fastify from 'fastify'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Catch, Controller, Get, Post, Module, Req, Res } from '@nestjs/common'
import { Observable } from 'rxjs'

const profile = process.env.CYI_PROOF_PROFILE
const versions = {
  express: '5.2.1',
  fastify: '5.12.5',
  'nest-express': '12.1.2',
  'nest-fastify': '12.1.2',
}
if (!Object.hasOwn(versions, profile))
  throw new Error('A supported proof profile is required')
const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('A valid proof port is required')
const origin = `http://127.0.0.1:${port}`
const constructionOnly = process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1'
const enabled = process.env.CYI_PROOF_ENABLED === '1'
if (!constructionOnly && enabled && !process.env.CYI_PROOF_OTLP_ENDPOINT)
  throw new Error('An OTLP endpoint is required for delivery proof')
const observations = []
const enqueueBatches = []
const spans = []
const unixNanos = ([seconds, nanos]) =>
  (BigInt(Math.trunc(seconds)) * 1_000_000_000n + BigInt(Math.trunc(nanos))).toString()
let subscriptions = 0
let teardowns = 0
let spanFlushFailed = false
const exporter =
  !constructionOnly && enabled
    ? new OTLPTraceExporter({
        url: process.env.CYI_PROOF_OTLP_ENDPOINT,
        headers: { authorization: `Bearer ${process.env.CYI_PROOF_TOKEN}` },
        timeoutMillis: 1500,
      })
    : undefined
const spanTransport = { attempted: 0, sent: 0, failed: 0 }
const delivery = exporter
  ? new SimpleSpanProcessor({
      export(batch, done) {
        spanTransport.attempted += batch.length
        exporter.export(batch, (result) => {
          spanTransport[result.code === 0 ? 'sent' : 'failed'] += batch.length
          done(result)
        })
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush(),
    })
  : undefined
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    'service.name': `node-${profile}`,
    'service.version': process.env.CYI_PROOF_RELEASE || `node-${profile}`,
    'deployment.environment.name': 'certification',
  }),
  spanProcessors: [
    {
      onStart(span, parent) {
        delivery?.onStart(span, parent)
      },
      onEnd(span) {
        if (spans.length < 1000)
          spans.push({
            trace_id: span.spanContext().traceId,
            span_id: span.spanContext().spanId,
            parent_span_id: span.parentSpanContext?.spanId,
            name: span.name,
            kind: span.kind,
            start_time_unix_nano: unixNanos(span.startTime),
            end_time_unix_nano: unixNanos(span.endTime),
            attributes: span.attributes,
            status: span.status,
          })
        delivery?.onEnd(span)
      },
      async forceFlush() {
        await delivery?.forceFlush()
      },
      async shutdown() {
        await delivery?.shutdown()
      },
    },
  ],
})
const client = new Client({
  endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
  projectId: process.env.CYI_PROOF_PROJECT,
  token: process.env.CYI_PROOF_TOKEN,
  environment: 'certification',
  release: process.env.CYI_PROOF_RELEASE || `node-${profile}`,
  enabled,
  autoInstall: false,
  logsFlushIntervalMs: 100,
  onDiagnostic(event, details) {
    if (event === 'enqueue' && enqueueBatches.length < 1000)
      enqueueBatches.push(details.batch ?? 1)
  },
  beforeSend(payload) {
    if (observations.length < 1000)
      observations.push({
        event_id: payload.event_id,
        sample_id: payload.sample_id,
        trace_id: payload.trace_id,
        kind: payload.kind ?? (payload.exception ? 'error' : 'log'),
        release: payload.release,
      })
    return constructionOnly ? null : payload
  },
})
const options = {
  tracer: provider.getTracer(`proof-${profile}`, versions[profile]),
  propagationTargets: [origin],
}
const fastify = profile.endsWith('fastify')
const monitor = fastify
  ? createFastifyMonitoring(client, options)
  : createExpressMonitoring(client, options)
const nest = createNestMonitoring(monitor.context)
if (process.env.CYI_PROOF_UNINSTALL === '1') {
  monitor.uninstall()
  nest.uninstall()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function work(id, body) {
  await sleep(5)
  client.log('info', 'Node framework work', { workload: 'work' })
  if (id === 'error')
    throw new Error('Node framework outer failure', {
      cause: new TypeError('Node framework inner failure'),
    })
  return { body_unchanged: body === 'private-body', trace_id: client.scope.traceId }
}
function stream() {
  return Readable.from(
    (async function* () {
      yield 'first\n'
      await sleep(20)
      yield 'second\n'
      await sleep(20)
      yield 'third\n'
    })(),
  )
}
async function status() {
  await client.flush()
  try {
    await provider.forceFlush()
  } catch {
    spanFlushFailed = true
  }
  return {
    profile,
    version: versions[profile],
    node: process.version,
    construction_only: constructionOnly,
    enabled: client.enabled,
    observations,
    enqueue_batches: enqueueBatches,
    spans,
    span_transport: spanTransport,
    span_flush_failed: spanFlushFailed,
    stats: client.stats.toObject(),
    subscriptions,
    teardowns,
  }
}
async function forward() {
  const response = await monitor.fetch(origin + '/echo', {
    redirect: 'error',
    method: 'POST',
    body: 'private-body',
    headers: { 'x-proof': 'preserved' },
  })
  return response.json()
}
let close
if (!profile.startsWith('nest')) {
  if (fastify) {
    const app = Fastify({ logger: false, forceCloseConnections: true })
    app.get('/proof-status', status)
    app.register(async (routes) => {
      monitor.install(routes)
      routes.setErrorHandler((_error, _request, reply) =>
        reply.code(503).send({ application: 'preserved' }),
      )
      routes.post('/work/:id', (request) => work(request.params.id, request.body))
      routes.post('/echo', async (request) => ({
        body_unchanged: request.body === 'private-body',
        traceparent: request.headers.traceparent,
        custom: request.headers['x-proof'],
      }))
      routes.get('/fetch', forward)
      routes.get('/stream', (_request, reply) =>
        reply.type('text/plain').send(stream()),
      )
    })
    await app.listen({ host: '127.0.0.1', port })
    close = () => app.close()
  } else {
    const app = express()
    app.get('/proof-status', async (_request, response) =>
      response.json(await status()),
    )
    app.use(monitor.middleware, express.text())
    app.post('/work/:id', async (request, response) =>
      response.json(await work(request.params.id, request.body)),
    )
    app.post('/echo', (request, response) =>
      response.json({
        body_unchanged: request.body === 'private-body',
        traceparent: request.headers.traceparent,
        custom: request.headers['x-proof'],
      }),
    )
    app.get('/fetch', async (_request, response) => response.json(await forward()))
    app.get('/stream', (_request, response) => stream().pipe(response))
    app.use(
      monitor.wrapErrorHandler((_error, _request, response, _next) =>
        response.status(503).json({ application: 'preserved' }),
      ),
    )
    const server = createServer(app)
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    close = () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  }
} else {
  class WorkController {
    work(request) {
      return new Observable((subscriber) => {
        subscriptions++
        work(request.params.id, request.body).then(
          (value) => {
            subscriber.next(value)
            subscriber.complete()
          },
          (error) => subscriber.error(error),
        )
        return () => {
          teardowns++
        }
      })
    }
    echo(request) {
      return {
        body_unchanged: request.body === 'private-body',
        traceparent: request.headers.traceparent,
        custom: request.headers['x-proof'],
      }
    }
    fetch() {
      return forward()
    }
    stream(response) {
      if (fastify) return response.type('text/plain').send(stream())
      stream().pipe(response)
    }
    status() {
      return status()
    }
  }
  Controller()(WorkController)
  for (const [method, decorator, path, parameter] of [
    ['work', Post, 'work/:id', Req],
    ['echo', Post, 'echo', Req],
    ['fetch', Get, 'fetch'],
    ['stream', Get, 'stream', Res],
    ['status', Get, 'proof-status'],
  ]) {
    decorator(path)(
      WorkController.prototype,
      method,
      Object.getOwnPropertyDescriptor(WorkController.prototype, method),
    )
    parameter?.()(WorkController.prototype, method, 0)
  }
  class ApplicationFilter {
    catch(_error, host) {
      host.switchToHttp().getResponse().status(503).send({ application: 'preserved' })
    }
  }
  Catch()(ApplicationFilter)
  class ApplicationModule {}
  Module({ controllers: [WorkController] })(ApplicationModule)
  const adapter = fastify
    ? new FastifyAdapter({ logger: false, forceCloseConnections: true })
    : new ExpressAdapter()
  const app = await NestFactory.create(ApplicationModule, adapter, {
    logger: false,
    abortOnError: false,
  })
  if (fastify) {
    // Keep the public metadata endpoint outside the observed plugin's lifecycle.
    const instance = adapter.getInstance()
    instance.addHook('onRequest', (request, reply, done) => {
      if (request.url !== '/proof-status')
        monitor.context.begin(request.raw, reply.raw, () => request.routeOptions.url)
      monitor.context.run(request.raw, done)
    })
  } else {
    app.use((request, response, next) =>
      request.url === '/proof-status'
        ? next()
        : monitor.middleware(request, response, next),
    )
    app.use(express.text())
  }
  app.useGlobalInterceptors(nest.interceptor)
  app.useGlobalFilters(nest.wrapFilter(new ApplicationFilter()))
  await app.listen(port, '127.0.0.1')
  close = () => {
    app.getHttpServer().closeAllConnections?.()
    return app.close()
  }
}
process.stdout.write('Node framework proof ready\n')
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await close()
  await Promise.allSettled([client.close(), provider.shutdown()])
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () =>
    shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    ),
  )
