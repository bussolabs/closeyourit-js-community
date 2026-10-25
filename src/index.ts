// Public facade of the CloseYourIt SDK, isomorphic browser/Node. Holds a
// singleton [Client]; every method is a no-op until [init] is called and none
// of them throws. In the IIFE (`globalName: CloseYourIt`) these exports become
// the methods of `window.CloseYourIt`. The installed integrations depend on
// the platform: window handlers/breadcrumb/http/jank and, when requested, web
// vitals and resource/CSP failures in the browser; process handlers +
// lifecycle on Node.

import { Client } from './client'
import { installBreadcrumbs } from './integrations/browser/breadcrumbs'
import { installGlobalHandlers } from './integrations/browser/globalHandlers'
import { installHttpInstrumentation } from './integrations/browser/http'
import { installJankDetection } from './integrations/browser/jank'
import { installPageviews } from './integrations/browser/pageviews'
import { installReplay } from './integrations/browser/replay'
import { installResourceErrors } from './integrations/browser/resourceErrors'
import { installWebVitals } from './integrations/browser/webVitals'
import { installNodeLifecycle } from './integrations/node/lifecycle'
import { installProcessHandlers } from './integrations/node/processHandlers'
import { CloseYourItLogger } from './logger'
import { isSecretToken, resolveOptions, resolvedOptionsEqual } from './options'
import { isBrowser, isNode } from './runtime'
import { Scope } from './scope'
import type {
  CaptureHint,
  CloseYourItOptions,
  EventLevel,
  LogLevel,
  TraceCarrier,
  UserContext,
} from './types'
import { emptyStatsSnapshot } from './stats'
import type { StatsSnapshot } from './stats'
import type { UsageKind } from './usage'

let currentClient: Client | null = null

/** Returns the facade's client without initializing or changing its ownership. */
export function getClient(): Client | null {
  return currentClient
}

let uninstallHandlers: (() => void) | null = null
let uninstallBreadcrumbs: (() => void) | null = null
let uninstallHttp: (() => void) | null = null
let uninstallJank: (() => void) | null = null
let uninstallPageviews: (() => void) | null = null
let uninstallReplay: (() => void) | null = null
let uninstallWebVitals: (() => void) | null = null
let uninstallResourceErrors: (() => void) | null = null
let uninstallLifecycle: (() => void) | null = null

// Closes of the clients replaced by a re-init, still in flight (CYJS-8). `init`
// stays synchronous and does not await them, but `flush()`/`close()` do: this way the
// events already queued by the old client are not lost if the process exits right
// after the switch.
const pendingTeardowns = new Set<Promise<void>>()

function trackTeardown(closing: Promise<void>): void {
  const settled = closing
    .catch(() => {})
    .finally(() => {
      pendingTeardowns.delete(settled)
    })
  pendingTeardowns.add(settled)
}

/// Initializes the SDK. **Idempotent for equivalent options**: with the same
/// resolved configuration it returns the existing client without reinstalling the
/// handlers, even when disabled by misconfig (it does not close and recreate it for
/// nothing). With **different options it reconfigures live** (CYJS-8): it tears down
/// the previous client's handlers and starts its flush+close in the background — the
/// events already queued go to the configuration they were queued with (awaitable via
/// `flush()`/`close()`) — transfers the current scope (trace_id, user, tags,
/// breadcrumbs) to the new client and puts the new config in use, with no need for a
/// manual `close()`. With an incomplete config it stays a no-op (does not throw) and
/// can be superseded by a valid `init`.
export function init(options: CloseYourItOptions): Client {
  // Idempotency for equivalent options: same resolved configuration → no-op,
  // whatever the state (active or disabled). The handlers are neither torn down nor
  // reinstalled (no duplicate listener) and a disabled client is not closed and
  // recreated on every identical init.
  if (
    currentClient &&
    resolvedOptionsEqual(currentClient.options, resolveOptions(options))
  ) {
    return currentClient
  }

  // Re-init (or first init, or superseding a client disabled by misconfig):
  // tears down the previous client's listeners and starts its flush+close WITHOUT
  // blocking init (which stays synchronous). The close is tracked so a later
  // flush()/close() awaits it: the old client's queued events are not lost when the
  // process exits. The current scope is transferred to the new client, so changing
  // only the config does not reset the application state (user, tags, trace).
  const previous = currentClient
  teardown()
  const client = new Client(options, previous ? { scope: previous.scope } : {})
  currentClient = client
  if (previous) trackTeardown(previous.close())

  // Without this warning a misconfig (e.g. missing token/projectId) turns the SDK into a
  // completely silent no-op: no event sent and no signal to the dev, not even with debug:true.
  // It does not warn when the disabling is intended (options.enabled: false).
  if (!client.enabled && client.options.enabled) {
    console.warn(
      `[closeyourit] SDK disabled: ${client.disabledReason}; no event will be sent`,
    )
  }

  // In the browser the secret bearer (cyi_) must not even appear in the bundle:
  // the SDK never sends it, but if it is present in client code it must be removed.
  if (isBrowser() && isSecretToken(client.options.token)) {
    console.warn(
      '[closeyourit] secret bearer (cyi_…) found in browser code: it is SERVER-ONLY and will never be sent. Remove it from the bundle and use `publicKey` (DSN public key).',
    )
  }

  // Usage telemetry goes through a channel authenticated with the secret bearer: in
  // the browser it is never eligible, and on Node it is not with only `publicKey`.
  // In both cases the registry stays off; without a warning the dev would see the
  // usage page empty with no signal of why.
  const usageReason = client.usageUnavailableReason
  if (usageReason) {
    console.warn(`[closeyourit] ${usageReason}`)
  }

  if (client.enabled && client.options.autoInstall) {
    if (isBrowser()) {
      // First: whoever flushes on `pagehide` (replay) must find the page-leaving
      // signal already raised, otherwise that send does not use the beacon.
      uninstallLifecycle = installLifecycle(client)
      uninstallHandlers = installGlobalHandlers(client)
      if (client.options.breadcrumbs) {
        uninstallBreadcrumbs = installBreadcrumbs(client)
      }
      // The http patch serves two consumers: http breadcrumbs and/or performance
      // verdicts. It is installed if at least one is active.
      const wantsHttp =
        (client.options.breadcrumbs && client.options.autoBreadcrumbs.http) ||
        (client.options.detectPerformanceIssues && client.options.captureExternalHttp)
      if (wantsHttp) {
        uninstallHttp = installHttpInstrumentation(client)
      }
      if (client.options.detectPerformanceIssues && client.options.detectJank) {
        uninstallJank = installJankDetection(client)
      }
      if (client.options.trackPageviews) {
        uninstallPageviews = installPageviews(client)
      }
      if (client.options.replay) {
        uninstallReplay = installReplay(client)
      }
      // After the lifecycle, like the replay: the measurements go out when the page
      // is leaving and must find the beacon already in use (CYJS-29).
      if (client.options.trackWebVitals) {
        uninstallWebVitals = installWebVitals(client)
      }
      if (client.options.captureResourceErrors) {
        uninstallResourceErrors = installResourceErrors(client)
      }
    } else if (isNode()) {
      uninstallHandlers = installProcessHandlers(client)
      uninstallLifecycle = installNodeLifecycle(client)
    }
  }

  return client
}

/// Captures an exception or arbitrary value.
export function captureException(error: unknown, hint?: CaptureHint): void {
  currentClient?.captureException(error, hint)
}

/// Captures a diagnostic message.
export function captureMessage(message: string, level: EventLevel = 'info'): void {
  currentClient?.captureMessage(message, level)
}

/// Buffers a structured log (sent in batches).
export function log(
  level: LogLevel,
  message: string,
  attributes?: Record<string, unknown>,
  loggerName?: string,
): void {
  currentClient?.log(level, message, attributes, loggerName)
}

/// Application logger with per-level methods (`logger.warn('…')`), null-safe.
/// `logger.named('payments')` creates a named child logger.
export const logger = new CloseYourItLogger(() => currentClient)

/// Measures [body] and sends a `slow_method` metric above the threshold. Preserves
/// the body's synchronicity. Pre-init it still runs the body without measuring.
/// Empty label → TypeError (always, even pre-init: programmer error).
export function measure<T>(
  label: string,
  body: () => T,
  opts?: { args?: Record<string, unknown> },
): T {
  if (currentClient) return currentClient.measure(label, body, opts)
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new TypeError(
      'closeyourit: measure(label) requires a non-empty label (it is the metric fingerprint)',
    )
  }
  return body()
}

/// Captures a pageview (web analytics). No-op outside the browser or pre-init.
/// [overrides.path] forces the path (default `location.pathname`). With
/// `trackPageviews: true` auto-tracking calls it on load and on every pathname
/// change; call it by hand for SPAs with custom routing or virtual events.
export function capturePageview(overrides?: { path?: string }): void {
  currentClient?.capturePageview(overrides)
}

/// Captures a custom event (goal/conversion). [name] is the event name
/// (e.g. "Signup"); no-op outside the browser or pre-init.
export function captureEvent(name: string, overrides?: { path?: string }): void {
  currentClient?.captureEvent(name, overrides)
}

/// Declares that a piece of code was EXECUTED, so the usage page and the
/// command line know what is alive. [key] must be a LITERAL string (never
/// interpolated with data): no URLs, ids, emails. No-op pre-init, with
/// `usageEnabled` off (default) or in the browser (server-only channel, CYJS-31).
export function used(key: string): void {
  currentClient?.used(key)
}

/// Like [used] but declaring the symbol kind: `route` (handler name, NEVER the
/// called URL), `job` (job class) or `custom`. It is the hook point for
/// framework adapters (routing middleware, queue runners).
export function recordUsage(kind: UsageKind, symbol: string): void {
  currentClient?.recordUsage(kind, symbol)
}

/// Sets the current user (`null` to remove it).
export function setUser(user: UserContext | null): void {
  currentClient?.setUser(user)
}

/// Sets a tag.
export function setTag(key: string, value: string): void {
  currentClient?.setTag(key, value)
}

/// Sets several tags at once.
export function setTags(tags: Record<string, string>): void {
  currentClient?.setTags(tags)
}

/// Sets an extra value.
export function setExtra(key: string, value: unknown): void {
  currentClient?.setExtra(key, value)
}

/// Sets a named context.
export function setContext(key: string, value: Record<string, unknown>): void {
  currentClient?.setContext(key, value)
}

/// Sets the correlation ID (default: generated per page).
export function setTraceId(id: string | undefined): void {
  currentClient?.setTraceId(id)
}

/// Current correlation ID, or `undefined` if not initialized.
export function getTraceId(): string | undefined {
  return currentClient?.scope.traceId
}

/// Adopts an incoming W3C trace context from [carrier] (server/SSR request
/// headers, a `Headers`, or a getter): a valid `traceparent` becomes the
/// correlation `trace_id` and hooks errors/logs to the distributed trace.
/// No-op pre-init or on a missing/malformed header.
export function continueTrace(carrier: TraceCarrier): void {
  currentClient?.continueTrace(carrier)
}

/// W3C Trace Context headers (`traceparent`, plus `tracestate`/`baggage` if
/// adopted) to inject into an outgoing request towards [target]. `{}` if
/// pre-init/disabled or if [target] is not trusted (`tracePropagationTargets` or
/// same-origin): the internal trace and baggage never reach untrusted hosts. Without
/// [target] the destination is first-party and propagation is allowed.
export function getTraceHeaders(target?: string): Record<string, string> {
  return currentClient?.getTraceHeaders(target) ?? {}
}

/// ID of the replay session in progress, or `undefined` if the replay is not active.
export function getReplaySessionId(): string | undefined {
  return currentClient?.scope.replaySessionId
}

/// Adds a manual breadcrumb.
export function addBreadcrumb(input: {
  message?: string
  category?: string
  type?: string
  level?: string
  data?: Record<string, unknown>
}): void {
  currentClient?.addBreadcrumb(input)
}

/// Clears the scope (user/tags/extra/context/breadcrumbs), except the trace_id.
export function clearScope(): void {
  currentClient?.clearScope()
}

/// Runs [fn] in a scope isolated for the whole async flow: new trace_id
/// (per-request correlation) and its own breadcrumbs. On Node it keeps the data of
/// concurrent requests apart (AsyncLocalStorage); in the browser (single-thread) it
/// isolates for the synchronous duration of [fn]. Wrap it around the request handler
/// (e.g. server middleware) so user/tags/request/breadcrumbs do not cross the
/// boundary between requests (CYJS-7). Pre-init it runs [fn] without isolation.
/// Returns the value of [fn] (a Promise is propagated: the isolation covers the await).
export function runWithScope<T>(fn: (scope: Scope) => T): T {
  if (currentClient) return currentClient.runWithScope(fn)
  return fn(new Scope())
}

/// Runs [fn] with a temporary scope forked from the current one (trace_id and
/// breadcrumbs inherited): the changes made inside do not leak out. Useful for a
/// capture with additional context without dirtying the shared scope. Pre-init
/// it runs [fn] without isolation.
export function withScope<T>(fn: (scope: Scope) => T): T {
  if (currentClient) return currentClient.withScope(fn)
  return fn(new Scope())
}

/// Snapshot of the diagnostic counters: aggregates (`enqueued`, `sent`, `dropped`,
/// `failed`, `timeout`) plus `reasons`, the breakdown of drops and failures by
/// reason (`sample_rate`, `before_send`, `error`, `queue_full`, `response`,
/// `network`). Pure in-memory read: it never sends telemetry (CYJS-9).
export function getStats(): StatsSnapshot {
  return currentClient?.stats.toObject() ?? emptyStatsSnapshot()
}

/// `true` if initialized and the configuration allows sending.
export function isEnabled(): boolean {
  return currentClient?.enabled ?? false
}

/// Drains the buffered logs and awaits the in-flight sends, including the closes of
/// clients replaced by a re-init still in progress (CYJS-8).
export function flush(): Promise<void> {
  return Promise.all([
    currentClient?.flush() ?? Promise.resolve(),
    ...pendingTeardowns,
  ]).then(() => undefined)
}

/// Shuts the SDK down, restores the global patches and frees the resources.
/// `currentClient` is cleared IMMEDIATELY (before the await): a concurrent `init`
/// during the close installs the new client without this `close()` clearing it when
/// it finishes (CYJS-8).
export async function close(): Promise<void> {
  const client = currentClient
  teardown()
  currentClient = null
  await Promise.all([client?.close() ?? Promise.resolve(), ...pendingTeardowns])
}

function teardown(): void {
  uninstallHandlers?.()
  uninstallBreadcrumbs?.()
  uninstallHttp?.()
  uninstallJank?.()
  uninstallPageviews?.()
  uninstallReplay?.()
  uninstallWebVitals?.()
  uninstallResourceErrors?.()
  uninstallLifecycle?.()
  uninstallHandlers = null
  uninstallBreadcrumbs = null
  uninstallHttp = null
  uninstallJank = null
  uninstallPageviews = null
  uninstallReplay = null
  uninstallWebVitals = null
  uninstallResourceErrors = null
  uninstallLifecycle = null
}

// On `pagehide`/`visibilitychange(hidden)` it tells the client that the page is
// leaving the stage and drains the logs. The signal comes BEFORE the flush because
// from then on the sends go through the beacon: `fetch(keepalive)` does not survive
// closing the tab on iOS Safari (CYJS-29). `pageshow` (return from bfcache) and
// coming back to the foreground put fetch back in use, which on a live page gives the
// response the diagnostics rely on.
//
// It must be installed FIRST among the browser handlers: the `pagehide` listeners
// run in registration order, and those of the other integrations (replay) must find
// the signal already raised so they too go out with the beacon.
function installLifecycle(client: Client): () => void {
  if (typeof window === 'undefined') return () => {}

  const onHide = (): void => {
    client.notifyPageHiding(true)
    void client.flush()
  }
  const onShow = (): void => {
    client.notifyPageHiding(false)
  }
  const onVisibility = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') onHide()
    else onShow()
  }

  window.addEventListener('pagehide', onHide)
  window.addEventListener('pageshow', onShow)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  return () => {
    window.removeEventListener('pagehide', onHide)
    window.removeEventListener('pageshow', onShow)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

export { Client } from './client'
export { CloseYourItLogger } from './logger'
export { Scope } from './scope'
export { SDK_NAME, SDK_VERSION } from './version'
export { UsageRegistry } from './usage'
export type { StatsSnapshot } from './stats'
export type { UsageKind, UsageSymbol, UsageWindow } from './usage'
export type {
  AutoBreadcrumbsOptions,
  BeforeSend,
  CaptureHint,
  CloseYourItOptions,
  DiagnosticDetails,
  DiagnosticEvent,
  DropReason,
  EventLevel,
  EventPayload,
  LogLevel,
  OnDiagnostic,
  TraceCarrier,
  TracePropagationTarget,
  UserContext,
} from './types'
