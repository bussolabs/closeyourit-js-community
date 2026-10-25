import '@angular/compiler'
import { Component, ErrorHandler } from '@angular/core'
import { provideLocationMocks } from '@angular/common/testing'
import { provideRouter, Router } from '@angular/router'
import { TestBed } from '@angular/core/testing'
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing'
import {
  HttpClient,
  HttpContext,
  HttpEventType,
  HttpErrorResponse,
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http'
import { firstValueFrom, retry, toArray } from 'rxjs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { EventPayload } from '../src/types'
import {
  ANGULAR_HTTP_TEMPLATE,
  createAngularHttpInterceptor,
  instrumentAngularErrorHandler,
  instrumentAngularRouter,
} from '../src/angular'

const cleanup: Array<() => unknown> = []
beforeAll(() =>
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()),
)
afterEach(async () => {
  TestBed.resetTestingModule()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

describe('Angular router with actual route recognition', () => {
  it('records declared nested templates without private parameters and ignores rejected navigation', async () => {
    class Page {}
    Component({ template: '', standalone: true })(Page)
    TestBed.configureTestingModule({
      providers: [
        provideLocationMocks(),
        provideRouter([
          { path: '', component: Page },
          { path: 'teams/:team', children: [{ path: 'items/:id', component: Page }] },
          { path: 'denied', component: Page, canActivate: [() => false] },
          { path: 'alias/:id', redirectTo: 'teams/fixed/items/:id' },
        ]),
      ],
    })
    const router = TestBed.inject(Router)
    const { client, events } = setup()
    const integration = instrumentAngularRouter(router, client)
    cleanup.push(integration.uninstall)
    expect(instrumentAngularRouter(router, client)).toBe(integration)
    await router.navigateByUrl('/')
    await router.navigateByUrl(
      '/teams/private-team/items/private-item?password=private-query',
    )
    expect(await router.navigateByUrl('/denied')).toBe(false)
    client.captureMessage('Navigation proof')
    const serialized = JSON.stringify(events)
    expect(serialized).toContain('/teams/:team/items/:id')
    expect(serialized).not.toMatch(/private-team|private-item|private-query|denied/)
    const breadcrumbs = client.scope.breadcrumbs.toList()
    integration.uninstall()
    await router.navigateByUrl('/')
    expect(client.scope.breadcrumbs.toList()).toEqual(breadcrumbs)
  })
})

function setup(enabled = true) {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'https://localhost.invalid',
    publicKey: '0123456789abcdef0123456789abcdef',
    projectId: 'angular-proof',
    autoInstall: false,
    enabled,
    slowMethodThresholdMs: 1,
    captureMethodArguments: true,
    tracePropagationTargets: [/^http:\/\/127\.0\.0\.1:/],
    beforeSend(payload) {
      events.push(payload)
      return null
    },
  })
  cleanup.push(() => client.close())
  return { client, events }
}

describe('Angular error handler ownership', () => {
  it('does not change application policy when reporting fails or is disabled', () => {
    const failure = new Error('Application failure')
    const handler = {
      handleError(error: unknown) {
        throw error
      },
    }
    const broken = {
      captureException() {
        throw new Error('Reporting unavailable')
      },
    }
    const integration = instrumentAngularErrorHandler(handler, broken)
    expect(() => handler.handleError(failure)).toThrow(failure)
    expect(() => instrumentAngularErrorHandler(handler, setup().client)).toThrow(
      'conflicts',
    )
    integration.uninstall()
    const { client, events } = setup(false)
    instrumentAngularErrorHandler(handler, client)
    expect(() => handler.handleError(failure)).toThrow(failure)
    expect(events).toEqual([])
  })
  it('preserves the actual default ErrorHandler and deduplicates the same Error', () => {
    const { client, events } = setup()
    const handler = new ErrorHandler()
    const original = handler.handleError
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const integration = instrumentAngularErrorHandler(handler, client)
    const error = new Error('Angular unhandled proof')
    handler.handleError(error)
    client.captureException(error)
    expect(logged).toHaveBeenCalledWith('ERROR', error)
    expect(events).toHaveLength(1)
    expect(instrumentAngularErrorHandler(handler, client)).toBe(integration)
    integration.uninstall()
    expect(handler.handleError).toBe(original)
  })

  it('preserves custom receiver, returned value and thrown business error', () => {
    const { client, events } = setup()
    const business = new Error('Policy rethrow')
    const handler = {
      calls: 0,
      handleError(error: unknown) {
        this.calls++
        if (error === business) throw error
        return 42
      },
    }
    const integration = instrumentAngularErrorHandler(handler, client)
    expect(handler.handleError(new Error('First'))).toBe(42)
    expect(() => handler.handleError(business)).toThrow(business)
    expect(handler.calls).toBe(2)
    expect(events).toHaveLength(2)
    const replacement = () => 99
    handler.handleError = replacement
    integration.uninstall()
    expect(handler.handleError).toBe(replacement)
    expect(client.enabled).toBe(true)
  })

  it('does not inspect an HTTP response body or dynamic URL when an HTTP error escapes', () => {
    const { client, events } = setup()
    const error = new HttpErrorResponse({
      status: 500,
      url: 'https://private.invalid/users/private-user?secret=value',
      error: { body: 'private-body' },
    })
    const seen: unknown[] = []
    Object.defineProperty(error, 'error', {
      get() {
        throw new Error('Response body must not be inspected')
      },
    })
    Object.defineProperty(error, 'url', {
      get() {
        throw new Error('Dynamic URL must not be inspected')
      },
    })
    const handler = {
      handleError(value: unknown) {
        seen.push(value)
      },
    }
    instrumentAngularErrorHandler(handler, client)
    handler.handleError(error)
    handler.handleError(error)
    expect(seen).toEqual([error, error])
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toMatch(/private-body|private-user|secret=value/)
    expect(events[0]).toMatchObject({
      exception: {
        values: [
          {
            type: 'HttpErrorResponse',
            value: 'Angular HTTP request failed (status 500)',
          },
        ],
      },
    })
  })
})

describe('Angular HttpClient with a real HTTP server', () => {
  async function app(enabled = true) {
    let calls = 0
    const requests: Array<{ url?: string; carrier?: string; baggage?: string }> = []
    const server = createServer((req, res) => {
      calls++
      requests.push({
        url: req.url,
        carrier: req.headers.traceparent as string | undefined,
        baggage: req.headers.baggage as string | undefined,
      })
      setTimeout(
        () => {
          res.writeHead(req.url?.startsWith('/retry') && calls === 1 ? 503 : 200, {
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({ ok: true, private: 'private-response' }))
        },
        req.url === '/cancel' ? 100 : 5,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const { client, events } = setup(enabled)
    const integration = createAngularHttpInterceptor(client)
    cleanup.push(integration.uninstall)
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withFetch(), withInterceptors([integration.interceptor])),
      ],
    })
    return {
      http: TestBed.inject(HttpClient),
      client,
      events,
      integration,
      origin,
      requests,
    }
  }

  it('preserves the response and reports one duration per subscription without body or query', async () => {
    const { http, client, events, origin, requests } = await app()
    client.scope.traceBaggage = 'private=baggage'
    const context = new HttpContext().set(ANGULAR_HTTP_TEMPLATE, '/api/items/:id')
    const response = await firstValueFrom(
      http.post(
        origin + '/items/private-user?password=private-query',
        { password: 'private-body' },
        { context },
      ),
    )
    await client.flush()
    expect(response).toEqual({ ok: true, private: 'private-response' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'slow_method',
      label: 'angular.http POST /api/items/:id',
    })
    expect(JSON.stringify(events)).not.toMatch(
      /private-user|private-query|private-body|private-response/,
    )
    expect(requests[0]?.carrier).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
    expect(requests[0]?.baggage).toBeUndefined()
  })

  it('preserves RxJS retries and records attempts without promoting handled HTTP errors', async () => {
    const { http, client, events, origin, requests } = await app()
    await firstValueFrom(
      http
        .get(origin + '/retry', {
          context: new HttpContext().set(ANGULAR_HTTP_TEMPLATE, '/retry'),
        })
        .pipe(retry(1)),
    )
    await client.flush()
    expect(requests).toHaveLength(2)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.kind === 'slow_method')).toBe(true)
    expect(events.map((event) => event.arguments)).toEqual([
      [
        { name: 'outcome', value: 'error' },
        { name: 'status', value: '503' },
      ],
      [
        { name: 'outcome', value: 'success' },
        { name: 'status', value: '200' },
      ],
    ])
  })

  it('preserves the actual HttpClient event sequence before and after uninstall', async () => {
    const { http, origin, integration } = await app()
    const observed = () =>
      firstValueFrom(
        http
          .get(origin + '/ok', { observe: 'events', reportProgress: true })
          .pipe(toArray()),
      )
    const instrumented = await observed()
    integration.uninstall()
    const original = await observed()
    expect(instrumented.map((event) => event.type)).toEqual(
      original.map((event) => event.type),
    )
    expect(instrumented.map((event) => event.type)).toContain(HttpEventType.Sent)
    expect(instrumented.at(-1)).toMatchObject({
      type: HttpEventType.Response,
      body: { ok: true, private: 'private-response' },
    })
  })

  it('keeps subscriptions cold and cancellation prevents response delivery', async () => {
    const { http, client, events, origin, requests } = await app()
    const observed = http.get(origin + '/cancel')
    expect(requests).toHaveLength(0)
    const received: unknown[] = []
    const subscription = observed.subscribe({
      next: (value) => received.push(value),
      error: (error) => received.push(error),
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    subscription.unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await client.flush()
    expect(received).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'slow_method',
      arguments: [{ name: 'outcome', value: 'cancelled' }],
    })
  })

  it('preserves caller trace headers and measures independent subscriptions', async () => {
    const { http, client, events, origin, requests } = await app()
    const carrier = '00-11111111111111111111111111111111-2222222222222222-01'
    const observed = http.get(origin + '/ok', {
      headers: { traceparent: carrier },
      context: new HttpContext().set(
        ANGULAR_HTTP_TEMPLATE,
        '/unsafe?password=private-value',
      ),
    })
    await Promise.all([firstValueFrom(observed), firstValueFrom(observed)])
    await client.flush()
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.carrier === carrier)).toBe(true)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.label === 'angular.http GET /unknown')).toBe(
      true,
    )
    expect(JSON.stringify(events)).not.toContain('private-value')
  })

  it('does not report or propagate when the application client is disabled', async () => {
    const { http, events, origin, requests } = await app(false)
    await firstValueFrom(http.get(origin + '/ok'))
    expect(events).toEqual([])
    expect(requests[0]?.carrier).toBeUndefined()
  })

  it('calls the real HTTP backend exactly once when SDK instrumentation throws', async () => {
    const { http, client, events, origin, requests } = await app()
    vi.spyOn(client, 'getTraceHeaders').mockImplementation(() => {
      throw new Error('Instrumentation unavailable')
    })
    expect(await firstValueFrom(http.get(origin + '/ok'))).toEqual({
      ok: true,
      private: 'private-response',
    })
    expect(requests).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('uninstalls without altering HTTP delivery or closing the application client', async () => {
    const { http, client, events, origin, integration } = await app()
    integration.uninstall()
    await firstValueFrom(http.get(origin + '/ok'))
    await client.flush()
    expect(events).toHaveLength(0)
    expect(client.enabled).toBe(true)
  })
})
