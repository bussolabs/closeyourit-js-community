import type { Client } from '../client'
import type { TraceCarrier } from '../types'
import { isNode } from '../runtime'

export type NextClient = Pick<
  Client,
  'captureException' | 'flush' | 'continueTrace' | 'measure'
> & {
  readonly scope: Pick<
    Client['scope'],
    'setRequest' | 'setContext' | 'setTraceId' | 'traceId'
  >
  runWithScope<T>(operation: () => T): T
}

export interface NextRequest {
  method: string
  headers: TraceCarrier
}

export interface NextRequestContext {
  routerKind: 'App Router' | 'Pages Router'
  routePath: string
  routeType: 'render' | 'route' | 'action' | 'proxy' | 'middleware'
}

export interface NextInstrumentation {
  withRequest<T>(
    request: NextRequest,
    context: NextRequestContext,
    operation: () => T,
  ): T
  onRequestError(
    error: unknown,
    request: NextRequest,
    context: NextRequestContext,
  ): Promise<void>
  uninstall(): void
}

const installations = new WeakMap<NextClient, NextInstrumentation>()

/** Explicit Node hooks: no global patches, body reads, stream wrapping or client ownership. */
export function createNextInstrumentation(client: NextClient): NextInstrumentation {
  const existing = installations.get(client)
  if (existing) return existing
  let active = true
  const errorTraces = new WeakMap<object, string | null>()
  const available = (): boolean => active && isNode()

  function remember(error: unknown, trace: string | undefined): void {
    if (typeof error !== 'object' || error === null || !trace) return
    const previous = errorTraces.get(error)
    errorTraces.set(error, previous === undefined || previous === trace ? trace : null)
  }

  function originalTrace(error: unknown): string | undefined {
    const seen = new Set<object>()
    let current = error
    for (
      let depth = 0;
      depth < 10 && typeof current === 'object' && current !== null;
      depth++
    ) {
      if (seen.has(current)) return
      seen.add(current)
      if (errorTraces.has(current)) return errorTraces.get(current) ?? undefined
      try {
        current = 'cause' in current ? current.cause : undefined
      } catch {
        return
      }
    }
  }

  function inRequestScope<T>(
    request: NextRequest,
    context: NextRequestContext,
    operation: () => T,
  ): T {
    if (!available()) return operation()
    return client.runWithScope(() => {
      const scope = client.scope
      const route = routeTemplate(context.routePath)
      try {
        client.continueTrace((name) =>
          name === 'traceparent' ? traceparent(request.headers) : undefined,
        )
        scope.setRequest({ method: method(request.method), url: route })
        scope.setContext('next', {
          router: context.routerKind,
          route,
          type: context.routeType,
        })
      } catch {
        // Malformed metadata must not change the application's request handling.
      }
      return operation()
    })
  }

  function withRequest<T>(
    request: NextRequest,
    context: NextRequestContext,
    operation: () => T,
  ): T {
    return inRequestScope(request, context, () => {
      if (!available()) return operation()
      // Only handler completion is measured. Streaming can continue after this returns.
      const trace = client.scope.traceId
      const tracked = (): T => {
        try {
          const result = operation()
          if (result instanceof Promise) {
            // Observe rejection without replacing or swallowing the application's promise.
            void result.catch((error) => {
              remember(error, trace)
            })
          }
          return result
        } catch (error) {
          remember(error, trace)
          throw error
        }
      }
      return client.measure(
        `next.${context.routeType} ${method(request.method)} ${routeTemplate(context.routePath)}`,
        tracked,
      )
    })
  }

  async function onRequestError(
    error: unknown,
    request: NextRequest,
    context: NextRequestContext,
  ): Promise<void> {
    if (!available() || isControlFlow(error)) return
    try {
      await inRequestScope(request, context, async () => {
        const trace = originalTrace(error)
        if (trace) client.scope.setTraceId(trace)
        client.captureException(error, { handled: false })
        await client.flush()
      })
    } catch {
      // Next awaits this hook; reporting failure must not replace its response.
    }
  }

  const integration = {
    withRequest,
    onRequestError,
    uninstall(): void {
      active = false
      if (installations.get(client) === integration) installations.delete(client)
    },
  }
  installations.set(client, integration)
  return integration
}

function traceparent(headers: TraceCarrier): string | undefined {
  if (typeof headers === 'function') return headers('traceparent') ?? undefined
  if (headers instanceof Headers) return headers.get('traceparent') ?? undefined
  const key = Object.keys(headers).find(
    (value) => value.toLowerCase() === 'traceparent',
  )
  const value = key ? headers[key] : undefined
  return typeof value === 'string' && value.length <= 512 ? value : undefined
}

function routeTemplate(value: string): string {
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./\[\]():@+-]*$/.test(value)
    ? value
    : '/unknown'
}

function method(value: string): string {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value) ? value : 'OTHER'
}

function isControlFlow(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || !('digest' in error))
      return false
    const digest = error.digest
    if (typeof digest !== 'string') return false
    return (
      /^NEXT_REDIRECT;(push|replace);[\s\S]*;(303|307|308);$/.test(digest) ||
      /^NEXT_HTTP_ERROR_FALLBACK;(401|403|404)$/.test(digest)
    )
  } catch {
    return false
  }
}
