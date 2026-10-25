// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '../src/client'
import type { EventPayload } from '../src/types'
import { createSvelteKitServer } from '../src/sveltekit/server'
import { createSvelteKitClient } from '../src/sveltekit/client'
import { createSvelteBoundaryHandler } from '../src/svelte'

const clients: Client[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})
function setup(version: 2 | 3 = 3, enabled = true) {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'http://127.0.0.1:1',
    projectId: 'svelte-proof',
    token: 'cyi_' + 'a'.repeat(40),
    autoInstall: false,
    enabled,
    slowMethodThresholdMs: 1,
    release: 'svelte-proof',
    environment: 'certification',
    beforeSend(event) {
      events.push(event)
      return null
    },
    tracePropagationTargets: ['http://127.0.0.1:39591'],
  })
  clients.push(client)
  return { client, events, integration: createSvelteKitServer(client, { version }) }
}
function event(id = 'one') {
  return {
    request: new Request(`http://127.0.0.1:39591/work/${id}?private=query`, {
      method: 'POST',
      body: 'private-body',
      headers: { cookie: 'private-cookie' },
    }),
    route: { id: '/work/[id]' },
  }
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('SvelteKit adapters with actual SDK scopes and Web API objects', () => {
  it('isolates three requests and restores each scope for errors outside handle', async () => {
    const { client, events, integration } = setup()
    const requests = ['one', 'two', 'three'].map(event)
    const handler = integration.wrapHandle(async ({ event: input }) => {
      client.scope.setTag(
        'request',
        input.request.url.split('/').at(-1)!.split('?')[0]!,
      )
      await delay()
      client.captureMessage('Request log')
      return new Response('body', { status: 202 })
    })
    const responses = await Promise.all(
      requests.map((input) =>
        handler({ event: input, resolve: async () => new Response() }),
      ),
    )
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'body',
      'body',
      'body',
    ])
    const errorHandler = integration.wrapHandleError((input) => ({
      message: 'Safe response',
      status: input.kind === 'unknown' ? 500 : 400,
    }))
    for (const input of requests)
      expect(
        errorHandler({
          event: { ...input },
          kind: 'unknown',
          error: new Error('Failure ' + requests.indexOf(input)),
        }),
      ).toEqual({ message: 'Safe response', status: 500 })
    const errors = events.filter((item) => item.exception)
    const metrics = events.filter((item) => item.kind === 'slow_method')
    expect(errors).toHaveLength(3)
    expect(metrics).toHaveLength(3)
    expect(new Set(errors.map((item) => item.trace_id)).size).toBe(3)
    for (const error of errors)
      expect(metrics.filter((item) => item.trace_id === error.trace_id)).toHaveLength(1)
    expect(errors.map((item) => item.tags?.request)).toEqual(['one', 'two', 'three'])
    expect(client.scope.toEventHash().tags?.request).toBeUndefined()
    expect(JSON.stringify(events)).not.toMatch(/private-(query|body|cookie)/)
  })
  it('does not consume streams or replace redirects and preserves thrown business errors', async () => {
    const { integration, events } = setup()
    let pulled = 0
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulled++
            controller.enqueue(new TextEncoder().encode('exact'))
            controller.close()
          },
        },
        { highWaterMark: 0 },
      ),
    )
    const wrapped = integration.wrapHandle(async () => {
      await delay()
      return response
    })
    const input = { event: event(), resolve: async () => response }
    expect(await wrapped(input)).toBe(response)
    expect(pulled).toBe(0)
    expect(await response.text()).toBe('exact')
    expect(pulled).toBe(1)
    const redirect = Response.redirect('https://example.invalid/path', 307)
    expect(await integration.wrapHandle(async () => redirect)(input)).toBe(redirect)
    const failure = new Error('Business failure')
    let calls = 0
    await expect(
      integration.wrapHandle(async () => {
        calls++
        throw failure
      })(input),
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
    expect(events.filter((item) => item.exception)).toHaveLength(0)
  })
  it('filters expected Kit 3 categories and preserves custom return and throw behavior', () => {
    const { integration, events } = setup()
    const result = { status: 418, message: 'Custom policy' }
    const wrapped = integration.wrapHandleError(() => result)
    for (const kind of ['app', 'framework', 'validation'])
      expect(
        wrapped({ event: event(), kind, error: { message: 'private-body' } }),
      ).toBe(result)
    expect(events).toHaveLength(0)
    const error = new Error('Unexpected')
    expect(wrapped({ event: event(), kind: 'unknown', error })).toBe(result)
    expect(wrapped({ event: event(), kind: 'unknown', error })).toBe(result)
    expect(events).toHaveLength(1)
    const policyFailure = new Error('Policy failure')
    expect(() =>
      integration.wrapHandleError(() => {
        throw policyFailure
      })({ event: event(), kind: 'framework', error }),
    ).toThrow(policyFailure)
  })
  it('filters Kit 2 expected statuses and does not collect invalid hook shapes', () => {
    const { integration, events } = setup(2)
    const wrapped = integration.wrapHandleError(() => undefined)
    for (const status of [400, 404, 499, undefined, NaN])
      wrapped({ event: event(), status, error: new Error('Expected') })
    wrapped({ event: event(), status: 500, error: new Error('Unexpected') })
    expect(events).toHaveLength(1)
  })
  it('continues only traceparent and leaves existing propagation and request bodies unchanged', async () => {
    const { client, integration } = setup()
    const input = event()
    input.request.headers.set(
      'traceparent',
      '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01',
    )
    input.request.headers.set('baggage', 'private=baggage')
    let outgoing: Request | undefined
    const fetchHook = integration.wrapHandleFetch(async ({ request }) => {
      outgoing = request
      return new Response('ok')
    })
    await integration.wrapHandle(async ({ event: current }) => {
      expect(client.scope.traceId).toBe('a'.repeat(32))
      return fetchHook({
        event: current,
        request: new Request('http://127.0.0.1:39591/target', {
          method: 'POST',
          body: 'exact-body',
        }),
        fetch,
      })
    })({ event: input, resolve: async () => new Response() })
    expect(outgoing!.headers.get('traceparent')).toContain('a'.repeat(32))
    expect(outgoing!.headers.get('baggage')).toBeNull()
    expect(await outgoing!.text()).toBe('exact-body')
    const foreign = new Request('http://127.0.0.1:39591/target', {
      headers: { traceparent: 'application-owned' },
    })
    await fetchHook({ event: input, request: foreign, fetch })
    expect(outgoing).toBe(foreign)
    const untrusted = new Request('https://example.invalid/target')
    await fetchHook({ event: input, request: untrusted, fetch })
    expect(outgoing).toBe(untrusted)
  })
  it('disables observations after uninstall and never closes the injected client', async () => {
    const { client, integration, events } = setup()
    const input = event()
    integration.uninstall()
    integration.uninstall()
    await integration.wrapHandle(async () => {
      await delay()
      return new Response('usable')
    })({ event: input, resolve: async () => new Response() })
    integration.wrapHandleError(() => undefined)({
      event: input,
      kind: 'unknown',
      error: new Error('Uninstalled'),
    })
    expect(events).toHaveLength(0)
    client.captureMessage('Still owned by application')
    expect(events).toHaveLength(1)
  })
  it('honors the SDK kill switch', async () => {
    const { integration, events } = setup(3, false)
    await integration.wrapHandle(async () => {
      await delay()
      return new Response()
    })({ event: event(), resolve: async () => new Response() })
    integration.wrapHandleError(() => undefined)({
      event: event(),
      kind: 'unknown',
      error: new Error('Disabled'),
    })
    expect(events).toHaveLength(0)
  })
  it('contains reporting failures before and after invoking business work exactly once', async () => {
    for (const phase of ['before', 'after', 'async']) {
      const { client, integration } = setup()
      client.measure = ((_label: string, operation: () => Promise<Response>) => {
        if (phase === 'before') throw new Error('Instrumentation failed')
        const result = operation()
        if (phase === 'after') throw new Error('Instrumentation failed')
        return result.then(() => {
          throw new Error('Instrumentation failed')
        })
      }) as Client['measure']
      let calls = 0
      const response = new Response('unchanged')
      const wrapped = integration.wrapHandle(async () => {
        calls++
        return response
      })
      expect(await wrapped({ event: event() })).toBe(response)
      expect(calls).toBe(1)
    }
  })
  it('contains scope and capture failures without replacing application callbacks', async () => {
    const { client, integration } = setup()
    client.runWithScope = () => {
      throw new Error('Scope unavailable')
    }
    let calls = 0
    const wrapped = integration.wrapHandle(async () => {
      calls++
      return new Response('business')
    })
    expect(await (await wrapped({ event: event() })).text()).toBe('business')
    expect(calls).toBe(1)
    const value = { message: 'custom' }
    expect(
      integration.wrapHandleError(() => value)({
        event: event(),
        kind: 'unknown',
        error: new Error('original'),
      }),
    ).toBe(value)
    const browser = createSvelteKitClient(client, { version: 3 })
    client.captureException = () => {
      throw new Error('Capture unavailable')
    }
    client.addBreadcrumb = () => {
      throw new Error('Breadcrumb unavailable')
    }
    browser.afterNavigate({ from: null, to: null })
    expect(
      browser.wrapHandleError(() => value)({
        event: { route: { id: null } },
        kind: 'unknown',
        error: new Error('original'),
      }),
    ).toBe(value)
    const error = new Error('Application policy failure')
    const boundary = createSvelteBoundaryHandler(client, () => {
      throw error
    })
    expect(() => boundary.onError(new Error('original'), () => undefined)).toThrow(
      error,
    )
  })
  it('bounds route metadata and keeps existing SDK burst deduplication', () => {
    const { client, events } = setup()
    const browser = createSvelteKitClient(client, { version: 3 })
    browser.afterNavigate({
      from: { route: { id: '/private?query=secret' } },
      to: { route: { id: '/' + 'a'.repeat(256) } },
    })
    const capture = browser.wrapHandleError(() => undefined)
    for (let index = 0; index < 2; index++)
      capture({
        event: { route: { id: null } },
        kind: 'unknown',
        error: new Error('Repeated burst'),
      })
    expect(events).toHaveLength(1)
    expect(
      (events[0]!.breadcrumbs as { values: Array<{ data: unknown }> }).values.at(-1)
        ?.data,
    ).toEqual({ from: '/unknown', to: '/unknown' })
    expect(events[0]!.contexts?.sveltekit).toMatchObject({ route: '/unknown' })
  })
  it('records only route templates and supports client hook uninstall', () => {
    const { client, events } = setup()
    const integration = createSvelteKitClient(client, { version: 3 })
    integration.afterNavigate({
      from: {
        route: { id: '/items/[id]' },
        url: new URL('https://example.invalid/private'),
      },
      to: { route: { id: '/' } },
    })
    integration.wrapHandleError(() => undefined)({
      event: { route: { id: '/' } },
      kind: 'unknown',
      error: new Error('Client'),
    })
    expect(
      (events[0]!.breadcrumbs as { values: Array<{ data: unknown }> }).values.at(-1)
        ?.data,
    ).toEqual({ from: '/items/[id]', to: '/' })
    integration.uninstall()
    integration.afterNavigate({ from: null, to: null })
    integration.wrapHandleError(() => undefined)({
      event: { route: { id: '/' } },
      kind: 'unknown',
      error: new Error('After uninstall'),
    })
    expect(events).toHaveLength(1)
  })
  it('preserves the explicit boundary policy, reset identity, receiver, and deduplication', () => {
    const { client, events } = setup()
    const reset = () => undefined
    const receiver = { name: 'application' }
    const failure = new Error('Render')
    const integration = createSvelteBoundaryHandler(
      client,
      function (this: unknown, error, originalReset) {
        expect(this).toBe(receiver)
        expect(error).toBe(failure)
        expect(originalReset).toBe(reset)
        return 42
      },
    )
    expect(integration.onError.call(receiver, failure, reset)).toBe(42)
    client.captureException(failure)
    expect(events).toHaveLength(1)
    expect(events[0]!.contexts?.svelte).toEqual({ phase: 'boundary' })
    integration.uninstall()
    expect(integration.onError.call(receiver, failure, reset)).toBe(42)
    expect(events).toHaveLength(1)
  })
})
