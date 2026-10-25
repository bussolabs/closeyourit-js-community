// Public types shared by the SDK. The wire contract (snake_case field names,
// endpoints, Sentry format) is identical to the `closeyourit-ruby` and
// `closeyourit-dart` clients.

/// Canonical backend severity levels (`debug` < `info` < `warning` <
/// `error` < `fatal`).
export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

/// Level of an error/message event (subset used on the events side).
export type EventLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

/// Generic JSON value found in payloads.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/// Payload of an event ready to be sent (arbitrary snake_case map).
export type EventPayload = Record<string, unknown>

/// Hook applied to every payload before sending. Returns the payload
/// (possibly modified) or `null` to drop the event.
export type BeforeSend = (payload: EventPayload) => EventPayload | null

/// Step of an event's lifecycle notified to `onDiagnostic`. Mirror of the Ruby
/// gem's diagnostic events (`CloseYourIt.notify_diagnostic`, CYRB-12):
/// `enqueue` (queued on the transport), `send` (2xx response), `drop` (dropped,
/// see `reason`), `timeout` (network timeout, sub-count of `failed`),
/// `shutdown` (client shutdown with final snapshot).
export type DiagnosticEvent = 'enqueue' | 'send' | 'drop' | 'timeout' | 'shutdown'

/// Reason for a drop/failure (`details.reason` of the `drop` event), also used
/// as the key of the `reasons` counters in `getStats`:
/// - `sample_rate`  — dropped by client-side sampling (never sent).
/// - `before_send`  — `beforeSend` returned `null` (intentional drop).
/// - `error`        — `beforeSend`/serialization threw (absorbed).
/// - `queue_full`   — in-flight send queue full (`maxQueue`).
/// - `response`     — non-2xx HTTP response (4xx / 429 / 5xx: see `status`).
/// - `network`      — non-timeout network error, or `fetch` not available.
export type DropReason =
  'sample_rate' | 'before_send' | 'error' | 'queue_full' | 'response' | 'network'

/// Immutable snapshot of the diagnostic counters, returned by `getStats` and
/// passed to the `shutdown` event. `enqueued`/`sent`/`dropped`/`failed` are the
/// aggregates (`timeout` is a sub-count of `failed`); `reasons` breaks down
/// drops and failures by reason.
export interface StatsSnapshot {
  enqueued: number
  sent: number
  dropped: number
  failed: number
  timeout: number
  reasons: Record<DropReason, number>
}

/// Details of a diagnostic event. They contain only metadata (never payloads,
/// headers or secrets): `error` is the **name** of the error class, never the message.
export interface DiagnosticDetails {
  /// Reason for the drop (only for the `drop` event).
  reason?: DropReason
  /// HTTP code (`send` and `drop`/`response` events).
  status?: number
  /// Name of the error class (`timeout` and `drop`/`network` events), never the message.
  error?: string
  /// Path of the destination endpoint (`enqueue` event), without host or query.
  path?: string
  /// Number of elements in the queued log batch (`enqueue` event).
  batch?: number
  /// Final snapshot of the counters (`shutdown` event).
  stats?: StatsSnapshot
}

/// Opt-in diagnostic hook `(event, details) => void`, invoked process-locally at
/// every step of an event's lifecycle. **Non-recursive**: while it runs, the
/// capture APIs are no-ops and any further diagnostic event is suppressed, so
/// diagnostics never generate new telemetry (CYJS-9). An error thrown by the
/// hook is absorbed.
export type OnDiagnostic = (event: DiagnosticEvent, details: DiagnosticDetails) => void

/// Trusted destination to which the W3C trace context is propagated. A string
/// matches by substring on the URL (Sentry `tracePropagationTargets` style), a
/// RegExp is tested on the full URL. Towards destinations not listed (nor
/// same-origin) the SDK sends neither `traceparent`/`tracestate` nor `baggage`.
export type TracePropagationTarget = string | RegExp

/// Source of the incoming headers from which `continueTrace` extracts the W3C
/// trace context: a `Headers` (fetch), a Node-style header map
/// (`req.headers`), or a `(name) => value` getter. Reading is
/// case-insensitive.
export type TraceCarrier =
  | Headers
  | Record<string, string | string[] | undefined | null>
  | ((name: string) => string | null | undefined)

/// Optional extra context passed to `captureException`.
export interface CaptureHint {
  /// Additional `contexts.*` to merge into the event.
  contexts?: Record<string, unknown>
  /// Signals that the error was handled (mechanism.handled).
  handled?: boolean
  /// Overrides the level (default `error`).
  level?: EventLevel
}

/// Current user. By default the browser SDK carries only `id`; any other key
/// still goes through the PII scrubber.
export interface UserContext {
  id: string | number
  [key: string]: unknown
}

/// Granular switches for automatic breadcrumbs (under the `breadcrumbs` master
/// switch). Default: all enabled.
export interface AutoBreadcrumbsOptions {
  click?: boolean
  navigation?: boolean
  console?: boolean
  http?: boolean
}

/// Initialization options. `endpointUrl` and `projectId` are always required;
/// then ONE valid credential for the environment is needed (`token` on the
/// server, `publicKey` in the browser). If it is missing, the SDK stays a no-op
/// (it never throws).
export interface CloseYourItOptions {
  /// Backend base URL (e.g. `https://app.closeyour.it`), without path.
  endpointUrl: string
  /// Project **secret** bearer (`cyi_…`), sent as `Authorization: Bearer`. It
  /// is a full-power credential (ingest + read): **SERVER-ONLY**. In the browser
  /// it is NEVER sent (it would end up in the bundle) — use `publicKey` there.
  token?: string
  /// DSN **public key** (hex, not secret: by design it travels in client SDKs):
  /// it is the **browser-safe** credential. In the browser the SDK uses it via
  /// `?sentry_key=` on the Sentry drop-in path, never the secret bearer.
  publicKey?: string
  /// UUID of the project on CloseYourIt.
  projectId: string
  /// Environment name (`development`/`staging`/`production`).
  environment?: string
  /// Application version/release.
  release?: string
  /// Probability of sending errors/messages (1.0 = all, 0.0 = none).
  sampleRate?: number
  /// Scrub/drop hook applied to every payload.
  beforeSend?: BeforeSend
  /// Opt-in diagnostic hook `(event, details) => void`: makes sends, enqueues,
  /// drops (with reason), timeouts and shutdown visible without generating new
  /// telemetry. Process-local and non-recursive (see `OnDiagnostic`, CYJS-9).
  onDiagnostic?: OnDiagnostic
  /// Internal diagnostic logs on the console (default `false`).
  debug?: boolean
  /// Installs the global handlers (`error`/`unhandledrejection`) and the
  /// automatic breadcrumbs. Default `true`; can be disabled for tests or SSR.
  autoInstall?: boolean
  /// Captures automatic breadcrumbs (click, navigation, console, fetch/XHR).
  breadcrumbs?: boolean
  /// Granular switches for automatic breadcrumbs (default all enabled).
  autoBreadcrumbs?: AutoBreadcrumbsOptions
  /// Capacity of the breadcrumb ring buffer (default 50).
  maxBreadcrumbs?: number
  /// Sends PII (query strings in URLs, referrer, `user` fields beyond `id`).
  /// Default `false`: only `user.id` and URLs without query travel.
  sendPii?: boolean
  /// Attaches the machine host name (`server_name`) to errors and messages
  /// **on Node** (parity with the Ruby gem). Default `true`. In the browser it
  /// has no effect: the hostname is server-only and the field stays absent.
  sendServerName?: boolean
  /// Maximum number of in-flight HTTP sends before dropping (default 30).
  maxQueue?: number
  /// Error names (`error.name`) never to send (e.g. `"AbortError"`).
  excludedExceptions?: string[]
  /// Attaches the `request` context (page URL, User-Agent) to events (default `true`).
  captureRequest?: boolean
  /// Tracks pageviews (cookieless web analytics, Plausible style). Default
  /// `false`. In the browser with `autoInstall` it emits a pageview on load and on
  /// every `pathname` change (hash and `replaceState` on the same path do not count).
  trackPageviews?: boolean
  /// Records the session (session replay) with rrweb and sends the chunks to `…/replays`.
  /// Default `false` (opt-in, requires consent: recording navigation is PII).
  /// Requires `window.rrweb` (rrweb UMD build loaded by the page). The replay
  /// writes a `cyi_replay` session cookie to correlate server errors.
  replay?: boolean
  /// Masks the content of all `input`s in the replay (default `true`).
  /// Disable it only with full awareness: it would record the typed text.
  replayMaskAllInputs?: boolean
  /// CSS selector of the elements NOT to record at all in the replay (rrweb
  /// `blockSelector`), e.g. `".cyi-block, .sensitive"`.
  replayBlockSelector?: string
  /// CSS selector of the text to mask in the replay (rrweb `maskTextSelector`).
  replayMaskTextSelector?: string
  /// Flush interval (ms) of the replay chunks (default 5000).
  replayFlushIntervalMs?: number
  /// Sending of structured logs (default `true`).
  logsEnabled?: boolean
  /// Probability of sending each log (default 1.0; independent of `sampleRate`).
  logsSampleRate?: number
  /// Number of accumulated logs that forces the batch flush (default 50).
  logsBatchSize?: number
  /// Interval (ms) of the periodic log flush (default 5000).
  logsFlushIntervalMs?: number
  /// Minimum level of sent logs (default `'info'`; below the threshold dropped).
  logsMinLevel?: LogLevel
  /// Threshold (ms) beyond which `measure()` sends the `slow_method` metric (default 200).
  slowMethodThresholdMs?: number
  /// Sends the arguments passed to `measure(..., { args })` (default `false`).
  captureMethodArguments?: boolean
  /// Master switch of the performance verdicts (slow/repeated http, jank). Default `false`.
  detectPerformanceIssues?: boolean
  /// Detects external HTTP requests (effective only with `detectPerformanceIssues`).
  captureExternalHttp?: boolean
  /// Threshold (ms) beyond which a `fetch`/XHR request to an external host
  /// (different from the page origin and the CloseYourIt endpoint) is slow: it marks
  /// the breadcrumb and, with `detectPerformanceIssues`, emits the
  /// `slow_external_http` verdict. Default 1000; `0` disables.
  slowExternalThresholdMs?: number
  /// Number of identical requests in the window that emits `repeated_http` (default 5).
  repeatedHttpThreshold?: number
  /// Width (ms) of the `repeated_http` observation window (default 5000).
  repeatedHttpWindowMs?: number
  /// Detects main thread long tasks (effective only with `detectPerformanceIssues`).
  detectJank?: boolean
  /// Duration (ms) of a long task beyond which `jank` is emitted (default 100).
  jankThresholdMs?: number
  /// Collects Web Vitals (LCP, CLS, INP, plus TTFB and FCP) from the visitors'
  /// browsers, measured by Google's official library, and sends them to
  /// `…/web_vitals` when the page leaves the stage. Default `false` (opt-in):
  /// turning on a measurement on someone else's production site is a decision
  /// they must make. Where the browser cannot measure, the metric simply does
  /// not arrive and the rest keeps working
  /// (CYJS-12, CYJS-28).
  trackWebVitals?: boolean
  /// Probability of sending the Web Vitals measurements (default 1.0; independent of
  /// `sampleRate`). The decision is one per page load: a page's measurements
  /// all go together or none go. Below 1.0 the percentile becomes unreliable on
  /// low-traffic sites, which are the majority.
  webVitalsSampleRate?: number
  /// Captures failures of the page's resources (scripts, stylesheets, images
  /// that do not load) and Content Security Policy violations, as
  /// `level: warning` events. Default `false` (opt-in). URLs always travel
  /// without query string; the number of reports per page is limited and
  /// identical repetitions are deduplicated (CYJS-12).
  captureResourceErrors?: boolean
  /// Usage telemetry: records WHICH routes, jobs and custom keys actually run and
  /// sends them in windows to `…/usages`, so the usage page and the command line
  /// know what is alive and what never runs. Default `false` (opt-in).
  ///
  /// **Server side only**: the channel is authenticated with the secret bearer,
  /// which is never eligible in the browser — with only the DSN public key the
  /// registry stays off and `init` says so on the console (CYJS-31).
  usageEnabled?: boolean
  /// Interval (ms) between two usage telemetry windows (default 300000, i.e.
  /// 5 minutes). A window is sent only if it has seen something.
  usageFlushIntervalMs?: number
  /// Cap of DISTINCT symbols per window (default 2000, maximum 5000 — the
  /// backend limit). Beyond the cap the window declares `truncated`: symbols
  /// already seen keep counting, new ones wait for the next window.
  usageMaxSymbols?: number
  /// Allowlist of the destinations to which `getTraceHeaders(target)` propagates
  /// the W3C trace context (`traceparent`/`tracestate`/`baggage`). Strings
  /// (substring match on the URL) or RegExp. In the browser the page's own origin
  /// is always trusted (same-origin). Towards every other destination propagation
  /// is denied: internal trace and baggage (potential PII) do not reach untrusted
  /// hosts. Default `[]` (same-origin only in the browser).
  tracePropagationTargets?: TracePropagationTarget[]
  /// Master switch: with `false` the SDK is entirely a no-op.
  enabled?: boolean
}
