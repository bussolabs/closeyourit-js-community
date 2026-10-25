// @vitest-environment node
import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Controller,
  Get,
  Module,
  Req,
  Catch,
  UseGuards,
  type ArgumentsHost,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ExpressAdapter } from '@nestjs/platform-express'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Observable } from 'rxjs'
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node'
import { Client } from '../src/client'
import { createExpressMonitoring } from '../src/express'
import { createFastifyMonitoring } from '../src/fastify'
import { createNestMonitoring } from '../src/nest'
import type { EventPayload } from '../src/types'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
describe('real Nest HTTP adapters and exception composition', () => {
  for (const frozen of [false, true]) {
    for (const platform of ['express', 'fastify'] as const) {
      it(`preserves ${platform} responses and ${frozen ? 'frozen' : 'mutable'} filter ownership`, async () => {
        const events: EventPayload[] = []
        const exporter = new InMemorySpanExporter()
        const provider = new NodeTracerProvider({
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        })
        const client = new Client({
          endpointUrl: 'http://127.0.0.1:1',
          token: 'cyi_' + 'a'.repeat(40),
          projectId: 'nest-proof',
          autoInstall: false,
          environment: 'certification',
          beforeSend(event) {
            events.push(event)
            return null
          },
        })
        cleanup.push(
          () => provider.shutdown(),
          () => client.close(),
        )
        const options = { tracer: provider.getTracer('nest-proof') }
        const http =
          platform === 'express'
            ? createExpressMonitoring(client, options)
            : createFastifyMonitoring(client, options)
        const observed = createNestMonitoring(http.context)
        let subscribed = 0
        let tornDown = 0
        class WorkController {
          work(request: { params: { id: string } }) {
            return new Observable((subscriber) => {
              subscribed++
              const timer = setTimeout(
                () => subscriber.error(new Error('Nest work ' + request.params.id)),
                5,
              )
              return () => {
                clearTimeout(timer)
                tornDown++
              }
            })
          }
          guarded() {
            return 'unreachable'
          }
        }
        Controller('work')(WorkController)
        Get(':id')(
          WorkController.prototype,
          'work',
          Object.getOwnPropertyDescriptor(WorkController.prototype, 'work')!,
        )
        Req()(WorkController.prototype, 'work', 0)
        Get()(
          WorkController.prototype,
          'guarded',
          Object.getOwnPropertyDescriptor(WorkController.prototype, 'guarded')!,
        )
        UseGuards({
          canActivate() {
            throw new Error('Guard failure')
          },
        })(
          WorkController.prototype,
          'guarded',
          Object.getOwnPropertyDescriptor(WorkController.prototype, 'guarded')!,
        )
        class ApplicationFilter {
          #marker = 'preserved'
          get marker() {
            return this.#marker
          }
          set marker(value: string) {
            this.#marker = value
          }
          readMarker() {
            return this.#marker
          }
          catch(_error: unknown, host: ArgumentsHost) {
            const response = host.switchToHttp().getResponse()
            response.status(502).send({ application: this.marker })
          }
        }
        Catch()(ApplicationFilter)
        const filter = new ApplicationFilter()
        if (frozen) {
          for (const key of ['catch', 'readMarker'] as const)
            Object.defineProperty(filter, key, {
              value: filter[key],
              writable: false,
              configurable: false,
            })
          Object.freeze(filter)
        }
        const wrapped = observed.wrapFilter(filter)
        expect(wrapped).toBeInstanceOf(ApplicationFilter)
        expect(() => wrapped.catch).not.toThrow()
        expect(wrapped.constructor).toBe(ApplicationFilter)
        expect(wrapped.marker).toBe('preserved')
        wrapped.marker = 'temporary'
        expect(filter.marker).toBe('temporary')
        wrapped.marker = 'preserved'
        expect(wrapped.readMarker()).toBe('preserved')
        class ApplicationModule {}
        Module({ controllers: [WorkController] })(ApplicationModule)
        const adapter =
          platform === 'express'
            ? new ExpressAdapter()
            : new FastifyAdapter({ logger: false })
        const app = await NestFactory.create(ApplicationModule, adapter, {
          logger: false,
          abortOnError: false,
        })
        cleanup.push(() => app.close())
        if ('middleware' in http) app.use(http.middleware)
        else http.install(adapter.getInstance())
        app.useGlobalInterceptors(observed.interceptor)
        app.useGlobalFilters(wrapped)
        await app.listen(0, '127.0.0.1')
        const endpoint = await app.getUrl()
        const responses = await Promise.all(
          ['one', 'two', 'three'].map((id) => fetch(endpoint + '/work/' + id)),
        )
        expect(responses.map((response) => response.status)).toEqual([502, 502, 502])
        expect(await responses[0]!.json()).toEqual({ application: 'preserved' })
        expect(subscribed).toBe(3)
        expect(tornDown).toBe(3)
        await provider.forceFlush()
        expect(
          events,
          JSON.stringify({
            stats: client.stats.toObject(),
            spans: exporter.getFinishedSpans().length,
          }),
        ).toHaveLength(3)
        expect(exporter.getFinishedSpans()).toHaveLength(3)
        for (const event of events)
          expect(
            exporter
              .getFinishedSpans()
              .filter((span) => span.spanContext().traceId === event.trace_id),
          ).toHaveLength(1)
        expect((await fetch(endpoint + '/work')).status).toBe(502)
        expect(events).toHaveLength(4)
        expect(events[3]!.exception?.values?.at(-1)?.mechanism?.handled).toBe(true)
        observed.uninstall()
        http.uninstall()
        expect((await fetch(endpoint + '/work/removed')).status).toBe(502)
        expect(events).toHaveLength(4)
        expect(subscribed).toBe(4)
        expect(tornDown).toBe(4)
        expect(filter.marker).toBe('preserved')
      })
    }
  }
})
