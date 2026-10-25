// Unified browser HTTP instrumentation: ONE single patch of `fetch` and
// `XMLHttpRequest` feeds two independent consumers:
//   1. `http` breadcrumbs (if `breadcrumbs` + `autoBreadcrumbs.http`);
//   2. `slow_external_http` / `repeated_http` performance verdicts
//      (if `detectPerformanceIssues` + `captureExternalHttp` — gate in the client).
// Requests to the CloseYourIt endpoint are excluded from both (no telemetry
// loop). Every URL is stripped of query string and hash (PII).

import type { BreadcrumbInput } from '../../breadcrumbs'
import type { Client } from '../../client'
import { templatizePath } from '../../templatize'
import { stripUrl } from './breadcrumbs'

/// Count of identical requests (host + templatized path) in a
/// sliding window: the client's N+1. Pure and with an injected clock (tests).
export class RepeatedHttpTracker {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /// Records a hit for [key] and returns the count in the current window.
  record(key: string): number {
    const current = this.now()
    const cutoff = current - this.windowMs
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    timestamps.push(current)
    this.hits.set(key, timestamps)
    return timestamps.length
  }
}

/// Installs the fetch+XHR patch. Returns the uninstall function.
export function installHttpInstrumentation(client: Client): () => void {
  const tracker = new RepeatedHttpTracker(
    client.options.repeatedHttpWindowMs,
    client.nowMs,
  )
  const uninstalls = [installFetch(client, tracker), installXhr(client, tracker)]
  return () => uninstalls.forEach((fn) => fn())
}

function installFetch(client: Client, tracker: RepeatedHttpTracker): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return () => {}
  }
  const originalFetch = window.fetch

  window.fetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const method = methodOf(input, init)
    const url = urlOf(input)
    const start = client.nowMs()

    return originalFetch
      .call(window, input, init)
      .then((response) => {
        handleCompleted(client, tracker, method, url, response.status, start)
        return response
      })
      .catch((error: unknown) => {
        handleCompleted(client, tracker, method, url, 0, start)
        throw error
      })
  }

  return () => {
    window.fetch = originalFetch
  }
}

function installXhr(client: Client, tracker: RepeatedHttpTracker): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {}

  const proto = XMLHttpRequest.prototype
  const originalOpen = proto.open
  const originalSend = proto.send

  interface Tracked {
    __cyiMethod?: string
    __cyiUrl?: string
    __cyiStart?: number
  }

  proto.open = function patchedOpen(
    this: XMLHttpRequest & Tracked,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    this.__cyiMethod = method.toUpperCase()
    this.__cyiUrl = typeof url === 'string' ? url : url.toString()
    // @ts-expect-error original variadic signature
    return originalOpen.call(this, method, url, ...rest)
  }

  proto.send = function patchedSend(
    this: XMLHttpRequest & Tracked,
    ...args: Parameters<XMLHttpRequest['send']>
  ): void {
    this.__cyiStart = client.nowMs()
    this.addEventListener('loadend', () => {
      handleCompleted(
        client,
        tracker,
        this.__cyiMethod ?? 'GET',
        this.__cyiUrl ?? '',
        this.status,
        this.__cyiStart ?? client.nowMs(),
      )
    })
    return originalSend.apply(this, args)
  }

  return () => {
    proto.open = originalOpen
    proto.send = originalSend
  }
}

// Request completed (or failed at network level): breadcrumb + performance verdicts.
function handleCompleted(
  client: Client,
  tracker: RepeatedHttpTracker,
  method: string,
  rawUrl: string,
  status: number,
  startMs: number,
): void {
  const durationMs = client.nowMs() - startMs
  const url = stripUrl(rawUrl)
  const host = hostOf(url)
  if (host && host === client.endpointHost) return

  const options = client.options
  const pageHost = typeof location !== 'undefined' ? location.host : undefined
  const external = isExternalHost(host, client.endpointHost, pageHost)

  if (options.breadcrumbs && options.autoBreadcrumbs.http) {
    const crumb = httpBreadcrumb({
      method,
      url,
      status,
      durationMs,
      external,
      slowThresholdMs: options.slowExternalThresholdMs,
    })
    client.addBreadcrumb(crumb)
  }

  if (external && host) {
    const path = templatizePath(pathnameOf(url))
    // The detect/captureExternalHttp gate and the slow threshold live in the client.
    client.recordExternalHttp(host, path, durationMs)
    const count = tracker.record(`${host}\n${path}`)
    if (count === options.repeatedHttpThreshold) {
      client.recordRepeatedHttp(host, path, count)
    }
  }
}

interface HttpBreadcrumbContext {
  method: string
  url: string
  status: number
  durationMs: number
  external: boolean
  /// Threshold beyond which `slow_external_http` is marked; `0` disables the marking.
  slowThresholdMs: number
}

/// `http` breadcrumb for a request (URL already without query). Marks
/// `slow_external_http` (and `level: warning`) when the duration exceeds the threshold
/// and the host is external. Pure helper for tests.
export function httpBreadcrumb(ctx: HttpBreadcrumbContext): BreadcrumbInput {
  const data: Record<string, unknown> = {
    method: ctx.method,
    url: ctx.url,
    status: ctx.status,
    duration_ms: Math.round(ctx.durationMs),
  }
  const slow =
    ctx.slowThresholdMs > 0 && ctx.durationMs >= ctx.slowThresholdMs && ctx.external

  const crumb: BreadcrumbInput = { category: 'http', type: 'http', data }
  if (slow) {
    data['slow_external_http'] = true
    crumb.level = 'warning'
  }
  return crumb
}

// External = host present, different from the CloseYourIt endpoint and from the page origin.
function isExternalHost(
  host: string | undefined,
  endpointHost: string | undefined,
  pageHost: string | undefined,
): boolean {
  if (!host) return false
  if (host === endpointHost) return false
  if (pageHost && host === pageHost) return false
  return true
}

/// Extracts the URL from a fetch argument (`string`, `URL` or `Request`).
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof input === 'object' && 'method' in input && input.method) {
    return input.method.toUpperCase()
  }
  return 'GET'
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
