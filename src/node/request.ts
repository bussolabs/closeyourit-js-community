import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { Context, Span, Tracer } from '@opentelemetry/api'
import type { Client } from '../client'
import { parseTraceparent } from '../traceContext'

export interface NodeHttpOptions {
  tracer?: Tracer
  /** Create owned spans, reuse an application's active span, or collect native signals only. */
  spanMode?: 'create' | 'existing' | 'none'
  propagationTargets?: readonly string[]
  captureExpectedErrors?: boolean
}
export type NodeHttpClient = Pick<
  Client,
  'enabled' | 'captureException' | 'continueTrace'
> & {
  readonly scope: Pick<Client['scope'], 'setRequest'>
  runWithScope<T>(operation: () => T): T
}

interface RequestState {
  run: ReturnType<typeof AsyncLocalStorage.snapshot>
  otel: Context
  span?: Span
  ownsSpan: boolean
  ended: boolean
  route: () => unknown
  method: string
  errors: WeakSet<object>
}

/** Explicit HTTP observation. The application owns Clients, providers and context registration. */
export class NodeHttpMonitoring {
  private active = true
  private readonly requests = new WeakMap<IncomingMessage, RequestState>()
  private readonly storage = new AsyncLocalStorage<RequestState>()
  private readonly options: Readonly<NodeHttpOptions>

  constructor(
    private readonly client: NodeHttpClient,
    options: NodeHttpOptions = {},
  ) {
    if (options.spanMode && !['create', 'existing', 'none'].includes(options.spanMode))
      throw new Error('Invalid HTTP span ownership mode')
    if ((options.spanMode ?? 'create') === 'create' && !options.tracer)
      throw new Error('HTTP span creation requires an application-owned tracer')
    this.options = {
      ...options,
      propagationTargets: [...(options.propagationTargets ?? [])],
    }
  }

  begin(
    request: IncomingMessage,
    response: ServerResponse,
    route: () => unknown,
  ): void {
    if (!this.enabled() || this.requests.has(request)) return
    let created: Span | undefined
    try {
      this.client.runWithScope(() => {
        const mode = this.options.spanMode ?? 'create'
        const activeContext = context.active()
        const activeSpan = trace.getSpan(activeContext)
        const parent =
          mode === 'existing' && activeSpan ? activeContext : this.parent(request)
        const method = httpMethod(request.method)
        const span =
          mode === 'create'
            ? this.options.tracer!.startSpan(
                `${method} /unknown`,
                {
                  kind: SpanKind.SERVER,
                  attributes: { 'http.request.method': method },
                },
                parent,
              )
            : mode === 'existing'
              ? activeSpan
              : undefined
        if (mode === 'create') created = span
        const otel = span ? trace.setSpan(parent, span) : parent
        const state: RequestState = {
          run: AsyncLocalStorage.snapshot(),
          otel,
          span,
          ownsSpan: mode === 'create',
          ended: false,
          route,
          method,
          errors: new WeakSet(),
        }
        this.storage.run(state, () =>
          context.with(otel, () => {
            this.adopt(span)
            this.metadata(state)
            state.run = AsyncLocalStorage.snapshot()
          }),
        )
        this.requests.set(request, state)
        const finish = () => {
          if (state.ended) return
          state.ended = true
          response.removeListener('finish', finish)
          response.removeListener('close', finish)
          try {
            state.run(() => {
              this.metadata(state)
              if (state.ownsSpan) {
                state.span?.setAttribute(
                  'http.response.status_code',
                  response.statusCode,
                )
                if (!response.writableFinished)
                  state.span?.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: 'response_closed',
                  })
                else if (response.statusCode >= 500)
                  state.span?.setStatus({ code: SpanStatusCode.ERROR })
              }
            })
          } catch {
            // Telemetry failure cannot alter the response lifecycle.
          } finally {
            if (state.ownsSpan)
              try {
                state.span?.end()
              } catch {
                /* Application-owned exporter failure. */
              }
          }
        }
        response.once('finish', finish)
        response.once('close', finish)
      })
    } catch {
      try {
        created?.end()
      } catch {
        /* No orphan span after failed setup. */
      }
      // An unavailable monitoring context never prevents business dispatch.
    }
  }

  run<T>(request: IncomingMessage, operation: () => T): T {
    const state = this.requests.get(request)
    if (!this.enabled() || !state || state.ended) return operation()
    let invoked = false
    try {
      return state.run(() => {
        invoked = true
        return operation()
      })
    } catch (error) {
      if (invoked) throw error
      return operation()
    }
  }

  capture(
    request: IncomingMessage,
    error: unknown,
    framework: string,
    handled = false,
  ): void {
    if (!this.enabled()) return
    const state = this.requests.get(request)
    if (!state || state.ended) return
    try {
      state.run(() => {
        const status = errorStatus(error)
        if (
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          !this.options.captureExpectedErrors
        )
          return
        if (typeof error === 'object' && error !== null) {
          if (state.errors.has(error)) return
          state.errors.add(error)
        }
        const route = this.metadata(state)
        // Expected HTTP errors may contain validation details or arbitrary response bodies.
        const safe =
          status !== undefined && status >= 400 && status < 500
            ? new Error(`HTTP ${status}`)
            : error
        this.client.captureException(safe, {
          handled,
          contexts: { node_http: { framework, route, phase: 'request' } },
        })
        if (state.ownsSpan) state.span?.setStatus({ code: SpanStatusCode.ERROR })
      })
    } catch {
      // Preserve the application's original error and chosen error policy.
    }
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (!this.enabled()) return globalThis.fetch(input, init)
    const current = this.storage.getStore()
    let span: Span | undefined
    let prepared: Request | undefined
    try {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      // Only explicit origins receive a carrier. No URL, headers or body are recorded.
      const allowed =
        !target.username &&
        !target.password &&
        this.options.propagationTargets!.some(
          (entry) => new URL(entry).origin === target.origin,
        )
      if (!allowed) return globalThis.fetch(input, init)
      const original = new Request(input, init)
      // Request construction transfers body ownership, so every later path uses this Request.
      prepared = original
      const activeContext = context.active()
      const parent = trace.getSpan(activeContext)
        ? activeContext
        : (current?.otel ?? activeContext)
      span =
        this.options.spanMode === 'none'
          ? undefined
          : this.options.tracer?.startSpan(
              `HTTP ${httpMethod(original.method)}`,
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  'http.request.method': httpMethod(original.method),
                  'server.address': target.hostname,
                  'server.port': Number(
                    target.port || (target.protocol === 'https:' ? 443 : 80),
                  ),
                },
              },
              parent,
            )
      // Automatic redirects can forward custom headers beyond the allowed origin.
      if (
        span &&
        original.redirect !== 'follow' &&
        !original.headers.has('traceparent')
      ) {
        const headers = new Headers(original.headers)
        const id = span.spanContext()
        headers.set(
          'traceparent',
          `00-${id.traceId}-${id.spanId}-${id.traceFlags & 1 ? '01' : '00'}`,
        )
        prepared = new Request(original, { headers })
      }
    } catch {
      // Construction or instrumentation faults leave the original fetch call authoritative.
    }
    try {
      const response = prepared
        ? await globalThis.fetch(prepared)
        : await globalThis.fetch(input, init)
      try {
        span?.setAttribute('http.response.status_code', response.status)
        if (response.status >= 400) span?.setStatus({ code: SpanStatusCode.ERROR })
      } catch {
        /* Preserve the actual response. */
      }
      return response
    } catch (error) {
      try {
        span?.setStatus({ code: SpanStatusCode.ERROR, message: 'request_failed' })
      } catch {
        /* Preserve the actual rejection. */
      }
      throw error
    } finally {
      try {
        span?.end()
      } catch {
        /* Exporter lifetime belongs to the application. */
      }
    }
  }

  uninstall(): void {
    this.active = false
  }

  private enabled(): boolean {
    return this.active && this.client.enabled
  }

  private parent(request: IncomingMessage): Context {
    // Preserve application context keys without implicitly reusing another HTTP span.
    const base = trace.deleteSpan(context.active())
    const header = request.headers.traceparent
    const parsed =
      typeof header === 'string' && header.length <= 512
        ? parseTraceparent(header)
        : null
    if (!parsed) return base
    this.client.continueTrace((name) =>
      name === 'traceparent' ? (header as string) : undefined,
    )
    return trace.setSpanContext(base, {
      traceId: parsed.traceId,
      spanId: parsed.parentId,
      traceFlags: parsed.sampled ? 1 : 0,
      isRemote: true,
    })
  }

  private adopt(span?: Span): void {
    if (!span) return
    const id = span.spanContext()
    this.client.continueTrace((name) =>
      name === 'traceparent'
        ? `00-${id.traceId}-${id.spanId}-${id.traceFlags & 1 ? '01' : '00'}`
        : undefined,
    )
  }

  private metadata(state: RequestState): string {
    let route = '/unknown'
    try {
      route = routeTemplate(state.route())
    } catch {
      /* Optional template lookup. */
    }
    try {
      this.client.scope.setRequest({ method: state.method, url: route })
    } catch {
      /* Optional native metadata. */
    }
    try {
      if (state.ownsSpan) {
        state.span?.updateName(`${state.method} ${route}`)
        state.span?.setAttribute('http.route', route)
      }
    } catch {
      /* Optional span metadata. */
    }
    return route
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value =
    'statusCode' in error
      ? error.statusCode
      : 'status' in error
        ? error.status
        : undefined
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}
export function routeTemplate(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_/:.\-*{}()[\]?+]*$/.test(value)
    ? value
    : '/unknown'
}
function httpMethod(value?: string): string {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value ?? '')
    ? value!
    : 'OTHER'
}
