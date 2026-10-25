import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client } from '../client'
import { expectedResponse } from './response'

export interface NitroEvent {
  method: string
  node: { req: { headers: Record<string, string | string[] | undefined> } }
}
export interface NitroHooks {
  hook(name: 'request', callback: (event: NitroEvent) => void): () => void
  hook(
    name: 'error',
    callback: (error: unknown, context: { event?: NitroEvent }) => Promise<void>,
  ): () => void
}
type NitroClient = Pick<
  Client,
  'captureException' | 'flush' | 'continueTrace' | 'measure'
> & {
  readonly scope: Pick<Client['scope'], 'setRequest' | 'setContext'>
  runWithScope<T>(operation: () => T): T
}
interface RequestState {
  run: ReturnType<typeof AsyncLocalStorage.snapshot>
  route: string
}
export interface NitroInstrumentation {
  withRequest<T>(event: NitroEvent, routeTemplate: string, operation: () => T): T
  onError(error: unknown, context?: { event?: NitroEvent }): Promise<void>
  install(hooks: NitroHooks): () => void
  uninstall(): void
}
const installations = new WeakMap<NitroClient, NitroInstrumentation>()

/** Node-only Nitro 2 hooks. Only withRequest surrounds downstream application work. */
export function createNitroInstrumentation(client: NitroClient): NitroInstrumentation {
  const existing = installations.get(client)
  if (existing) return existing
  let active = true
  const requests = new WeakMap<NitroEvent, RequestState>()
  const hooks = new Map<NitroHooks, () => void>()

  function state(event: NitroEvent): RequestState {
    const previous = requests.get(event)
    if (previous) return previous
    return client.runWithScope(() => {
      try {
        client.continueTrace((name) => {
          const value =
            name === 'traceparent' ? event.node.req.headers.traceparent : undefined
          return typeof value === 'string' && value.length <= 512 ? value : undefined
        })
      } catch {
        // Broken optional metadata does not change the application request.
      }
      const current = { run: AsyncLocalStorage.snapshot(), route: '/unknown' }
      requests.set(event, current)
      return current
    })
  }

  function context(event: NitroEvent | undefined, route: string): void {
    client.scope.setRequest({ method: method(event?.method), url: route })
    client.scope.setContext('nuxt', { runtime: 'nitro', route, phase: 'request' })
  }

  function withRequest<T>(event: NitroEvent, route: string, operation: () => T): T {
    if (!active) return operation()
    // Setup precedes invocation: a reporting failure can never execute the handler twice.
    let current: RequestState
    try {
      current = state(event)
    } catch {
      return operation()
    }
    current.route = template(route)
    return current.run(() => {
      try {
        context(event, current.route)
      } catch {
        /* Optional context only. */
      }
      return client.measure(
        `nuxt.route ${method(event.method)} ${current.route}`,
        operation,
      )
    })
  }

  async function onError(
    error: unknown,
    options: { event?: NitroEvent } = {},
  ): Promise<void> {
    if (!active || expectedResponse(error)) return
    try {
      const report = async () => {
        context(options.event, options.event ? state(options.event).route : '/unknown')
        client.captureException(error, { handled: false })
        await client.flush()
      }
      if (options.event) await state(options.event).run(report)
      else await client.runWithScope(report)
    } catch {
      // Nitro error hooks must not replace the application's response.
    }
  }

  const integration: NitroInstrumentation = {
    withRequest,
    onError,
    install(target): () => void {
      const existing = hooks.get(target)
      if (existing) return existing
      if (!active) throw new Error('Nitro instrumentation was uninstalled')
      const removers: Array<() => void> = []
      const remove = () => {
        for (const unhook of removers.splice(0)) unhook()
        hooks.delete(target)
      }
      try {
        removers.push(
          target.hook('request', (event) => {
            if (!active) return
            try {
              state(event)
            } catch {
              /* Hook failure cannot affect request dispatch. */
            }
          }),
        )
        removers.push(target.hook('error', onError))
      } catch (error) {
        remove()
        throw error
      }
      hooks.set(target, remove)
      return remove
    },
    uninstall(): void {
      active = false
      for (const remove of hooks.values()) remove()
      if (installations.get(client) === integration) installations.delete(client)
    },
  }
  installations.set(client, integration)
  return integration
}

function method(value: string | undefined): string {
  return value && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value)
    ? value
    : 'OTHER'
}
function template(value: string): string {
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./\[\]():@+*?\\-]*$/.test(value)
    ? value
    : '/unknown'
}
