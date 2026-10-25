import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client } from '../client'
import { captureError, routeTemplate } from './shared'
import type { KitError, KitOptions, KitRoute } from './shared'

export interface KitRequest extends KitRoute {
  request: Request
}
export interface KitHandleInput {
  event: KitRequest
}
export interface KitFetchInput {
  event: KitRequest
  request: Request
  fetch: typeof fetch
}
type ServerClient = Pick<
  Client,
  'captureException' | 'continueTrace' | 'getTraceHeaders' | 'measure'
> & {
  readonly scope: Pick<Client['scope'], 'setRequest' | 'setContext'>
  runWithScope<T>(operation: () => T): T
}
interface State {
  run: ReturnType<typeof AsyncLocalStorage.snapshot>
}

/** Explicit Node hooks; the application owns installation, building guards and Client shutdown. */
export function createSvelteKitServer(client: ServerClient, options: KitOptions) {
  let active = true
  // SvelteKit copies event objects while retaining the same Web Request.
  const requests = new WeakMap<Request, State>()

  function state(event: KitRequest): State {
    const existing = requests.get(event.request)
    if (existing) return existing
    return client.runWithScope(() => {
      const parent = event.request.headers.get('traceparent')
      client.continueTrace((name) =>
        name === 'traceparent' && parent && parent.length <= 512 ? parent : undefined,
      )
      const current = { run: AsyncLocalStorage.snapshot() }
      requests.set(event.request, current)
      return current
    })
  }

  function context(event: KitRequest): void {
    const route = routeTemplate(event.route.id)
    client.scope.setRequest({ method: method(event.request.method), url: route })
    client.scope.setContext('sveltekit', { runtime: 'node', phase: 'request', route })
  }

  return {
    wrapHandle<I extends KitHandleInput>(
      handler: (input: I) => Response | Promise<Response>,
    ): (input: I) => Promise<Response> {
      return async function (this: unknown, input): Promise<Response> {
        const execute = () => Promise.resolve(handler.call(this, input))
        if (!active) return execute()
        let current: State
        try {
          current = state(input.event)
        } catch {
          return execute()
        }
        return current.run(() => {
          try {
            context(input.event)
          } catch {
            // Optional metadata does not prevent business dispatch.
          }
          let result: Promise<Response> | undefined
          let invoked = false
          const once = () => {
            invoked = true
            result = execute()
            return result
          }
          try {
            return Promise.resolve(
              client.measure(
                `sveltekit.route ${method(input.event.request.method)} ${routeTemplate(input.event.route.id)}`,
                once,
              ),
            ).catch((error: unknown) => {
              if (!invoked) return execute()
              if (result) return result
              throw error
            })
          } catch (error) {
            if (!invoked) return execute()
            if (result) return result
            throw error
          }
        })
      }
    },
    wrapHandleError<I extends KitError & { event: KitRequest }, T>(
      handler: (input: I) => T,
    ): (input: I) => T {
      return function (this: unknown, input): T {
        if (active) {
          try {
            state(input.event).run(() => {
              context(input.event)
              captureError(client, input, options.version, 'node')
            })
          } catch {
            // Preserve custom status, response fields and application error policy.
          }
        }
        return handler.call(this, input)
      }
    },
    wrapHandleFetch<I extends KitFetchInput>(
      handler: (input: I) => Promise<Response>,
    ): (input: I) => Promise<Response> {
      return function (this: unknown, input): Promise<Response> {
        let prepared = input
        if (active) {
          try {
            state(input.event).run(() => {
              if (input.request.headers.has('traceparent')) return
              const trace = client.getTraceHeaders(input.request.url)
              if (!trace.traceparent) return
              const headers = new Headers(input.request.headers)
              headers.set('traceparent', trace.traceparent)
              prepared = { ...input, request: new Request(input.request, { headers }) }
            })
          } catch {
            // Invalid or already-used requests retain the application's fetch behavior.
          }
        }
        return handler.call(this, prepared)
      }
    },
    uninstall(): void {
      active = false
    },
  }
}

function method(value: string): string {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value) ? value : 'OTHER'
}
