// Client coordinator: holds configuration, scope, transport, log buffer, stats
// and dedup, and implements the capture/send logic. Mirror of
// `CloseYourIt::Client` (gem) and `CloseYourItClient` (dart). Dependencies are
// injectable for tests. No method throws.

import type { BreadcrumbInput } from './breadcrumbs'
import { Deduplicator, dedupKey } from './dedup'
import {
  buildErrorEvent,
  buildLogEvent,
  buildMessageEvent,
  normalizeError,
} from './events'
import {
  MAX_PAYLOAD_BYTES,
  capEvent,
  capGeneric,
  capReplayChunk,
  chunkLogBatch,
} from './budget'
import { LOGS_MAX_BATCH, LogBuffer } from './logBuffer'
import { meetsMinLevel, normalizeLogLevel } from './logLevel'
import { buildPerformanceIssueEvent, buildSlowMethodEvent } from './metricEvents'
import {
  disabledReason,
  endpointHost,
  eventsUri,
  isEnabled,
  logsUri,
  metricsUri,
  pageviewsUri,
  replayUri,
  resolveOptions,
  resolveTransportAuth,
  storeUri,
  usagesUri,
  webVitalsUri,
} from './options'
import { buildPageview } from './pageviews'
import { autoRequestContext } from './requestContext'
import type { ResolvedOptions, TransportAuth } from './options'
import { isBrowser, serverName as detectServerName } from './runtime'
import { createScopeStorage } from './asyncContext'
import type { ScopeStorage } from './asyncContext'
import { Diagnostics, diagnosticsSuppressed, errorName } from './diagnostics'
import { Scope } from './scope'
import { Stats } from './stats'
import {
  formatTraceparent,
  isSameOrigin,
  matchesPropagationTarget,
  normalizeBaggage,
  parseTraceparent,
  parseTracestate,
  readTraceHeader,
} from './traceContext'
import { Transport } from './transport'
import {
  USAGE_ENVELOPE_BYTES,
  USAGE_MAX_SYMBOLS_PER_FLUSH,
  UsageRegistry,
  chunkUsageSymbols,
} from './usage'
import type { UsageKind, UsageWindow } from './usage'
import type {
  CaptureHint,
  CloseYourItOptions,
  DiagnosticDetails,
  DropReason,
  EventLevel,
  EventPayload,
  LogLevel,
  TraceCarrier,
  UserContext,
} from './types'
import { spanId, uuidV4 } from './uuid'
import { SDK_NAME, SDK_VERSION } from './version'

/// Injectable dependencies (tests).
export interface ClientDeps {
  transport?: Transport
  logBuffer?: LogBuffer
  stats?: Stats
  scope?: Scope
  dedup?: Deduplicator
  random?: () => number
  /// Provider of the automatic request context (default: current page in the browser).
  requestProvider?: () => Record<string, unknown> | undefined
  /// Monotonic clock in ms for `measure` (default `performance.now`).
  nowMs?: () => number
}

export class Client {
  readonly options: ResolvedOptions
  readonly stats: Stats
  /// Process-local diagnostic notifier (`onDiagnostic` hook), non-recursive.
  readonly diagnostics: Diagnostics

  // Root scope: the only holder in the browser (single-thread) and the fallback on
  // Node outside withScope/runWithScope. `scope` (getter) resolves the flow's active copy.
  private readonly baseScope: Scope
  // Per-flow storage on Node (AsyncLocalStorage); `undefined` in the browser (CYJS-7).
  private readonly als: ScopeStorage | undefined
  // Active scope in the synchronous fallback (browser, or Node without AsyncLocalStorage).
  private syncScope: Scope | undefined

  private readonly transport: Transport
  /// Send credential resolved for the environment (server bearer / browser dsn).
  private readonly auth: TransportAuth
  private readonly logBuffer: LogBuffer
  private readonly dedup: Deduplicator
  private readonly random: () => number
  private readonly requestProvider: () => Record<string, unknown> | undefined
  /// Monotonic clock in ms (injectable): used by `measure` and by the integrations.
  readonly nowMs: () => number
  /// Server hostname, resolved once (it does not change within the process):
  /// attached as `server_name` to errors/messages. `undefined` in the browser or
  /// with `sendServerName: false` → the field stays absent (parity with the Ruby gem).
  private readonly serverName: string | undefined
  // The diagnostic `shutdown` is emitted only once per client (a repeated close()
  // does not duplicate it), Ruby gem parity.
  private shutdownNotified = false
  // Outcome of the Web Vitals sampling for THIS client, rolled only once
  // (CYJS-28). In the browser a client is one page load, and its measurements
  // may be sent in several batches: see `captureWebVitals`.
  private webVitalsSampled: boolean | undefined
  // Usage telemetry registry (CYJS-31): `undefined` when the channel is not
  // usable — turned off by configuration, or browser (where the usages ingest
  // does not accept the DSN public key). A missing registry makes `used`/`recordUsage`
  // no-ops at no cost on the hot path.
  private readonly usage: UsageRegistry | undefined

  constructor(rawOptions: CloseYourItOptions, deps: ClientDeps = {}) {
    this.options = resolveOptions(rawOptions)
    this.stats = deps.stats ?? new Stats()
    this.diagnostics = new Diagnostics(this.options.onDiagnostic)
    this.baseScope = deps.scope ?? new Scope(this.options.maxBreadcrumbs)
    this.als = createScopeStorage()
    this.dedup = deps.dedup ?? new Deduplicator()
    this.random = deps.random ?? Math.random
    this.requestProvider =
      deps.requestProvider ?? (() => autoRequestContext(this.options.sendPii))
    this.nowMs = deps.nowMs ?? defaultNowMs
    this.serverName = this.options.sendServerName ? detectServerName() : undefined

    // In the browser only the DSN public key is allowed: the secret bearer is never
    // eligible (harmless fallback to an empty bearer when the SDK is disabled →
    // the transport is never used anyway, the methods gate on `enabled`).
    this.auth = resolveTransportAuth(this.options, isBrowser()) ?? {
      kind: 'bearer',
      secret: '',
    }
    this.transport =
      deps.transport ??
      new Transport({
        auth: this.auth,
        stats: this.stats,
        maxQueue: this.options.maxQueue,
        debug: this.options.debug ? (m, e) => this.debugLog(m, e) : undefined,
        diagnostic: (event, details) => this.diagnostics.notify(event, details),
      })
    this.logBuffer =
      deps.logBuffer ??
      new LogBuffer(
        (batch) => this.flushLogs(batch),
        this.options.logsBatchSize,
        this.options.logsFlushIntervalMs,
      )

    // The usages channel is bearer ONLY: with the DSN public key (browser) the
    // backend would reject it, so the registry does not even turn on — better a
    // declared no-op than a window of symbols shipped into the void.
    this.usage =
      this.options.usageEnabled && this.auth.kind === 'bearer'
        ? new UsageRegistry(
            (window) => this.flushUsage(window),
            this.options.usageMaxSymbols,
            this.options.usageFlushIntervalMs,
          )
        : undefined

    // Page trace_id: correlates errors and logs of the same session/page.
    if (this.scope.traceId === undefined) {
      this.scope.setTraceId(uuidV4().replace(/-/g, ''))
    }
  }

  /// Active scope for the current flow: the isolated copy when inside
  /// withScope/runWithScope (per request on Node via AsyncLocalStorage),
  /// otherwise the shared root scope. All scope APIs and event capture go
  /// through here, so every flow sees only its own data (CYJS-7).
  get scope(): Scope {
    return this.als?.getStore() ?? this.syncScope ?? this.baseScope
  }

  get enabled(): boolean {
    return isEnabled(this.options, isBrowser())
  }

  get disabledReason(): string | null {
    return disabledReason(this.options, isBrowser())
  }

  /// Why the requested usage telemetry (`usageEnabled: true`) is NOT active, or
  /// `null` if the registry is alive — or if nobody asked for it. The channel
  /// accepts only the secret bearer: in the browser it is never eligible, and on
  /// Node it is not if only the `publicKey` was configured. Without this reason
  /// exposed, that configuration would silently lose all usage telemetry (CYJS-31).
  get usageUnavailableReason(): string | null {
    if (!this.options.usageEnabled || this.usage) return null
    return isBrowser()
      ? 'usage telemetry (usageEnabled) on in the browser: its channel needs the SERVER-ONLY bearer, so it stays off. Turn it on in the server process (SSR/backend).'
      : 'usage telemetry (usageEnabled) requested but off: the usages channel accepts only the secret bearer (`token`), not the DSN public key.'
  }

  // Endpoint of error/message events: with the bearer it is the v1 path; with the
  // DSN public key (browser) it is the Sentry drop-in `/store`, which the backend
  // accepts authenticating via `?sentry_key=`.
  private get eventsIngestUri(): string {
    return this.auth.kind === 'dsn' ? storeUri(this.options) : eventsUri(this.options)
  }

  get endpointHost(): string | undefined {
    return endpointHost(this.options)
  }

  get slowExternalThresholdMs(): number {
    return this.options.slowExternalThresholdMs
  }

  // ---------------------------------------------------------------- errors

  /// Captures an exception (or arbitrary value). No-op if disabled, excluded,
  /// already captured, duplicated within the window, or not sampled.
  captureException(error: unknown, hint: CaptureHint = {}): void {
    if (!this.enabled || diagnosticsSuppressed()) return

    const normalized = normalizeError(error)
    if (this.options.excludedExceptions.includes(normalized.type)) return
    if (this.dedup.wasCaptured(error)) return

    const key = dedupKey(
      normalized.type,
      normalized.value,
      topFrameKey(normalized.stack),
    )
    if (this.dedup.isDuplicate(key)) return
    // Marked BEFORE sampling (gem parity): an error dropped by sampling is not
    // re-sent by an outer handler.
    this.dedup.markCaptured(error)
    if (!this.sampled(this.options.sampleRate)) {
      this.noteDrop('sample_rate')
      return
    }

    const payload = buildErrorEvent({
      error: normalized,
      environment: this.options.environment,
      release: this.options.release,
      handled: hint.handled ?? false,
      level: hint.level ?? 'error',
      scopeHash: this.scopeHash(),
      traceId: this.scope.traceId,
      replayId: this.scope.replaySessionId,
      contexts: hint.contexts,
      request: this.autoRequest(),
      serverName: this.serverName,
    })
    this.enqueue(payload, this.eventsIngestUri, capEventToBudget)
  }

  /// Captures a diagnostic message.
  captureMessage(message: string, level: EventLevel = 'info'): void {
    if (!this.enabled || diagnosticsSuppressed()) return
    if (!this.sampled(this.options.sampleRate)) {
      this.noteDrop('sample_rate')
      return
    }

    const payload = buildMessageEvent({
      message,
      environment: this.options.environment,
      release: this.options.release,
      level,
      scopeHash: this.scopeHash(),
      traceId: this.scope.traceId,
      replayId: this.scope.replaySessionId,
      request: this.autoRequest(),
      serverName: this.serverName,
    })
    this.enqueue(payload, this.eventsIngestUri, capEventToBudget)
  }

  // ------------------------------------------------------------------- logs

  /// Buffers a structured log (sent in batches to `/logs`). No-op if logs are
  /// disabled, below `logsMinLevel`, not sampled or with an empty message.
  log(
    level: LogLevel,
    message: string,
    attributes?: Record<string, unknown>,
    logger?: string,
  ): void {
    if (!this.enabled || !this.options.logsEnabled || diagnosticsSuppressed()) return
    const normalized = normalizeLogLevel(level)
    if (!meetsMinLevel(normalized, this.options.logsMinLevel)) return
    if (!this.sampled(this.options.logsSampleRate)) {
      this.noteDrop('sample_rate')
      return
    }
    if (message.trim().length === 0) return

    this.logBuffer.add(
      buildLogEvent({
        message,
        level: normalized,
        environment: this.options.environment,
        release: this.options.release,
        logger,
        traceId: this.scope.traceId,
        attributes,
      }),
    )
  }

  // ---------------------------------------------------------------- metrics

  /** Internal adapter bridge: shared redaction, delivery limits and diagnostics. */
  captureMetric(payload: EventPayload): void {
    if (!this.enabled) return
    this.enqueue(payload, metricsUri(this.options), capGenericToBudget)
  }

  /// Measures [body] and sends a `slow_method` metric if the duration exceeds
  /// `slowMethodThresholdMs`. Preserves synchronicity: a synchronous body
  /// returns the value, an async body returns the Promise (measured on settle).
  /// The metric is sent even if the body throws. NEVER sampled.
  /// Empty label → immediate TypeError even with the client disabled (programmer
  /// error, it must surface deterministically).
  measure<T>(
    label: string,
    body: () => T,
    opts: { args?: Record<string, unknown> } = {},
  ): T {
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new TypeError(
        'closeyourit: measure(label) requires a non-empty label (it is the metric fingerprint)',
      )
    }

    const start = this.nowMs()
    const finish = (): void => {
      const duration = this.nowMs() - start
      this.recordSlowMethod(label, duration, opts.args)
    }

    try {
      const result = body()
      if (isThenable(result)) {
        return (result as Promise<unknown>).then(
          (value) => {
            finish()
            return value
          },
          (error: unknown) => {
            finish()
            throw error
          },
        ) as T
      }
      finish()
      return result
    } catch (error) {
      finish()
      throw error
    }
  }

  /// `slow_external_http` verdict for a completed external request.
  /// No-op below the threshold or without `detectPerformanceIssues`/`captureExternalHttp`.
  recordExternalHttp(host: string, url: string, durationMs: number): void {
    if (!this.perfEnabled() || !this.options.captureExternalHttp) return
    const threshold = this.options.slowExternalThresholdMs
    if (threshold <= 0 || durationMs < threshold) return

    this.enqueue(
      buildPerformanceIssueEvent({
        subtype: 'slow_external_http',
        durationMs,
        environment: this.options.environment,
        httpHost: host,
        httpUrl: url,
        traceId: this.scope.traceId,
      }),
      metricsUri(this.options),
      capGenericToBudget,
    )
  }

  /// `repeated_http` verdict: same request repeated [count] times in the
  /// window (the client's N+1). Tracking the window is up to the integration.
  recordRepeatedHttp(host: string, url: string, count: number): void {
    if (!this.perfEnabled() || !this.options.captureExternalHttp) return

    this.enqueue(
      buildPerformanceIssueEvent({
        subtype: 'repeated_http',
        environment: this.options.environment,
        httpHost: host,
        httpUrl: url,
        queryCount: count,
        traceId: this.scope.traceId,
      }),
      metricsUri(this.options),
      capGenericToBudget,
    )
  }

  /// `jank` verdict: main thread long task over the threshold.
  recordJank(durationMs: number, route: string): void {
    if (!this.perfEnabled() || !this.options.detectJank) return

    this.enqueue(
      buildPerformanceIssueEvent({
        subtype: 'jank',
        durationMs,
        environment: this.options.environment,
        route,
        traceId: this.scope.traceId,
      }),
      metricsUri(this.options),
      capGenericToBudget,
    )
  }

  // --------------------------------------------------------------- pageview

  /// Captures a pageview (cookieless web analytics). No-op if disabled or
  /// outside the browser. NEVER sampled (parity with metrics/logs: analytics
  /// loses meaning with partial data). [overrides.path] forces the path (default
  /// `location.pathname`); `environment` is added here from the resolved environment.
  /// It goes through `enqueue`, so it honours `beforeSend` and the counters like the
  /// other sends.
  capturePageview(overrides: { path?: string } = {}): void {
    if (!this.enabled) return
    if (!isBrowser()) return

    this.enqueue(
      { ...buildPageview(overrides), environment: this.options.environment },
      pageviewsUri(this.options),
      capGenericToBudget,
    )
  }

  /// Captures a custom event (goal/conversion). [name] is the event name
  /// (never "pageview"); no-op if disabled, outside the browser or without a name.
  /// Same location/hostname/UTM as the pageview's current context.
  captureEvent(name: string, overrides: { path?: string } = {}): void {
    if (!this.enabled) return
    if (!isBrowser()) return
    if (!name) return

    this.enqueue(
      { ...buildPageview(overrides), name, environment: this.options.environment },
      pageviewsUri(this.options),
      capGenericToBudget,
    )
  }

  // ------------------------------------------------------------ web vitals

  /// Sends the page's Web Vitals measurements (LCP/CLS/INP/TTFB/FCP) in **a single
  /// send**: the backend accepts an array and a page load produces a handful of
  /// measurements, which are best sent together at the moment the page leaves
  /// the stage. No-op if disabled, outside the browser or without measurements.
  ///
  /// Sampling (`webVitalsSampleRate`) decides on the **whole page load**, not
  /// on the single batch: a page's measurements all go or none do, even when
  /// they arrive in two sends (the courtesy flush, CYJS-28). Rolling the dice
  /// on every batch would build the percentiles of different metrics on
  /// different sets of pages, which are no longer comparable with each other. A
  /// drop counts as a `sample_rate`.
  /// `environment` and `release` are added here (only the client knows them).
  captureWebVitals(measures: EventPayload[]): void {
    if (!this.enabled) return
    if (!isBrowser()) return
    if (measures.length === 0) return
    if (diagnosticsSuppressed()) return
    if (!this.sampledForWebVitals()) {
      this.noteDrop('sample_rate')
      return
    }

    const stamped = measures.map((measure) => ({
      ...measure,
      environment: this.options.environment,
      ...(this.options.release ? { release: this.options.release } : {}),
    }))
    const kept = this.applyBeforeSend(stamped).map(capGenericToBudget)
    if (kept.length === 0) return

    const url = webVitalsUri(this.options)
    if (this.transport.send(kept, url)) {
      this.stats.increment('enqueued')
      this.diagnostics.notify('enqueue', { path: pathOf(url), batch: kept.length })
    }
  }

  // ----------------------------------------------------------------- replay

  /// Sets the current replay session id (puts it on the scope → subsequent
  /// errors carry it in `contexts.replay.replay_id`). Called by the recorder at
  /// startup.
  setReplaySessionId(id: string | undefined): void {
    this.scope.setReplaySessionId(id)
  }

  /// Sends a replay chunk (already built by `buildReplayChunk`). No-op if
  /// disabled or outside the browser. Goes through `enqueue` → honours `beforeSend`
  /// and the counters like the other sends. `environment` added here.
  captureReplayChunk(chunk: EventPayload): void {
    if (!this.enabled) return
    if (!isBrowser()) return

    this.enqueue(
      { ...chunk, environment: this.options.environment },
      replayUri(this.options),
      capReplayChunkToBudget,
    )
  }

  // -------------------------------------------------------- usage telemetry

  /// Declares that a symbol was EXECUTED: [kind] is `route` (the handler name,
  /// NEVER the URL called), `job` (the job class) or `custom` (a literal key).
  /// The symbol must be literal and free of user data: the contract allows only
  /// `[A-Za-z0-9_:#./-]{1,200}`, and whatever does not match the format is
  /// silently discarded.
  ///
  /// No-op if the SDK is disabled, if `usageEnabled` is off (default) or in the
  /// browser, where the channel is not reachable. It is the hook point for
  /// framework adapters (routing middleware, queue runners).
  recordUsage(kind: UsageKind, symbol: string): void {
    if (!this.enabled) return
    // A symbol recorded FROM the diagnostic callback must not produce
    // telemetry: diagnostics are zero-sum (CYJS-9).
    if (diagnosticsSuppressed()) return
    this.usage?.record(kind, symbol)
  }

  /// Declares that a piece of application code was EXECUTED. [key] must be a
  /// LITERAL string (never interpolated with data): it is the only honest way
  /// to answer "is this branch ever taken?". Parity with the Ruby gem's
  /// `CloseYourIt.used`.
  used(key: string): void {
    this.recordUsage('custom', key)
  }

  // ------------------------------------------------------------------ scope

  setUser(user: UserContext | null): void {
    this.scope.setUser(user)
  }

  setTag(key: string, value: string): void {
    this.scope.setTag(key, value)
  }

  setTags(tags: Record<string, string>): void {
    this.scope.setTags(tags)
  }

  setExtra(key: string, value: unknown): void {
    this.scope.setExtra(key, value)
  }

  setContext(key: string, value: Record<string, unknown>): void {
    this.scope.setContext(key, value)
  }

  setTraceId(id: string | undefined): void {
    this.scope.setTraceId(id)
  }

  addBreadcrumb(input: BreadcrumbInput): void {
    if (!this.options.breadcrumbs) return
    this.scope.addBreadcrumb(input)
  }

  clearScope(): void {
    this.scope.clear()
  }

  // --------------------------------------------------------- trace context W3C

  /// Adopts an incoming W3C trace context from [carrier] (server/SSR request
  /// headers, a `Headers`, or a getter): if `traceparent` is valid, its
  /// trace-id becomes the correlation `trace_id` — so errors/logs/metrics hook
  /// onto the distributed trace — and parent/sampling/tracestate/baggage are
  /// kept for re-propagation to trusted hosts. Missing or malformed header:
  /// no-op (the current trace is kept). No-op if disabled.
  /// Inside `runWithScope` it operates on the request's isolated scope.
  continueTrace(carrier: TraceCarrier): void {
    if (!this.enabled) return
    const parsed = parseTraceparent(readTraceHeader(carrier, 'traceparent'))
    if (!parsed) return
    this.scope.continueTrace({
      traceId: parsed.traceId,
      parentId: parsed.parentId,
      sampled: parsed.sampled,
      tracestate: parseTracestate(readTraceHeader(carrier, 'tracestate')),
      baggage: normalizeBaggage(readTraceHeader(carrier, 'baggage')),
    })
  }

  /// W3C Trace Context headers to inject into an outgoing request to
  /// [target]: `traceparent` (current trace-id + new span-id + sampling
  /// flag), plus `tracestate`/`baggage` if adopted. Returns `{}` — no
  /// headers — if the SDK is disabled or if [target] is not trusted
  /// (`tracePropagationTargets` or same-origin in the browser): so the internal
  /// trace and the baggage (potential PII) do not reach untrusted hosts. Without
  /// [target] the destination is considered first-party and propagation is
  /// allowed. Every call generates a new span-id (the current hop).
  getTraceHeaders(target?: string): Record<string, string> {
    if (!this.enabled) return {}
    const traceId = this.scope.traceId
    if (traceId === undefined) return {}
    if (target !== undefined && !this.isPropagationAllowed(target)) return {}

    const headers: Record<string, string> = {
      traceparent: formatTraceparent(
        traceId,
        spanId(),
        this.scope.traceSampled ?? true,
      ),
    }
    if (this.scope.traceState) headers['tracestate'] = this.scope.traceState
    if (this.scope.traceBaggage) headers['baggage'] = this.scope.traceBaggage
    return headers
  }

  // Trusted destination: match in the `tracePropagationTargets` allowlist, or
  // same-origin in the browser (the page's own origin is first-party). On Node
  // `location` is missing: only the allowlist counts.
  private isPropagationAllowed(target: string): boolean {
    if (matchesPropagationTarget(target, this.options.tracePropagationTargets)) {
      return true
    }
    const origin = typeof location !== 'undefined' ? location.origin : undefined
    return origin !== undefined && isSameOrigin(target, origin)
  }

  /// Runs [fn] in an isolated scope for the whole asynchronous flow: new
  /// trace_id (per-request correlation unit), its own breadcrumbs and a copy of
  /// the current user/tags/extra/contexts as a base. On Node the isolation is real
  /// even across concurrent requests (AsyncLocalStorage): what [fn] sets — and
  /// each of its `await` continuations — does not leak into other flows (CYJS-7). In
  /// the browser (single-thread) the fork is active only for [fn]'s synchronous duration.
  /// To be wrapped around the request handler (e.g. server middleware).
  /// Returns [fn]'s value; a Promise is propagated (the isolation covers the await).
  runWithScope<T>(fn: (scope: Scope) => T): T {
    const forked = this.scope.fork({ freshTrace: true })
    forked.setTraceId(uuidV4().replace(/-/g, ''))
    return this.runInScope(forked, fn)
  }

  /// Runs [fn] with a temporary scope forked from the current one (trace_id and
  /// breadcrumbs inherited): changes made inside do not leak out. Useful for a
  /// capture with additional context without dirtying the shared scope.
  withScope<T>(fn: (scope: Scope) => T): T {
    return this.runInScope(this.scope.fork(), fn)
  }

  // Activates [scope] for the duration of [fn]. On Node AsyncLocalStorage propagates
  // the isolation across asynchronous flows and restores the previous context by
  // itself (even in case of an exception). In the synchronous fallback `syncScope` is
  // saved/restored manually — correct because the browser has no real concurrency.
  private runInScope<T>(scope: Scope, fn: (scope: Scope) => T): T {
    const als = this.als
    if (als) return als.run(scope, () => fn(scope))
    const previous = this.syncScope
    this.syncScope = scope
    try {
      return fn(scope)
    } finally {
      this.syncScope = previous
    }
  }

  // ------------------------------------------------------------- lifecycle

  /// Signals to the transport that the page is leaving the stage (`pagehide`,
  /// `visibilitychange(hidden)`) or has come back (`pageshow` from bfcache). While
  /// the page is leaving, browser sends go through the beacon, the only one the
  /// browser completes after the tab closes (CYJS-29). It is called by the
  /// facade's lifecycle, not by the application.
  notifyPageHiding(hiding: boolean): void {
    this.transport.setPageHiding(hiding)
  }

  /// Flushes the buffered logs and the current usage window, then awaits the
  /// in-flight sends.
  async flush(): Promise<void> {
    this.logBuffer.flush()
    this.usage?.flush()
    await this.transport.flush()
  }

  /// Shuts the client down: flushes the logs, awaits the sends, then notifies the
  /// `shutdown` with the counters snapshot so the operator sees the sending
  /// balance. Emitted AFTER the drain (and only once): the snapshot also reflects
  /// the logs of the last flush and the completed sends, and no other diagnostic
  /// event follows it (Ruby gem parity, CYJS-9).
  async close(): Promise<void> {
    this.logBuffer.dispose()
    this.usage?.dispose()
    await this.transport.flush()
    if (!this.shutdownNotified) {
      this.shutdownNotified = true
      this.diagnostics.notify('shutdown', { stats: this.stats.toObject() })
    }
  }

  // -------------------------------------------------------------- internals

  // Records a client-side drop with its reason and notifies the hook: the single
  // point that keeps the counter (`reasons`) and the callback aligned (CYJS-9).
  private noteDrop(reason: DropReason, details: DiagnosticDetails = {}): void {
    this.stats.record(reason)
    this.diagnostics.notify('drop', { reason, ...details })
  }

  // [cap] applies the channel's byte budget (CYJS-10) AFTER `beforeSend`: the hook
  // can inflate the payload, so the cap is the last thing before the wire, so
  // what leaves always honours the service limit.
  private enqueue(
    payload: EventPayload,
    url: string,
    cap?: (payload: EventPayload) => EventPayload,
  ): void {
    // An event generated FROM the diagnostic callback must not produce telemetry
    // (nor touch the counters): diagnostics are zero-sum (CYJS-9).
    if (diagnosticsSuppressed()) return

    const hook = this.options.beforeSend
    let body: EventPayload = payload
    if (hook) {
      let result: EventPayload | null
      try {
        result = hook(payload)
      } catch (error) {
        // beforeSend must never crash the host: absorbed and made visible as a
        // drop with reason `error` (Ruby gem parity).
        this.noteDrop('error', { error: errorName(error) })
        this.debugLog('beforeSend threw, event dropped', error)
        return
      }
      if (result === null) {
        this.noteDrop('before_send')
        return
      }
      body = result
    }
    if (cap) body = cap(body)
    if (this.transport.send(body, url)) {
      this.stats.increment('enqueued')
      this.diagnostics.notify('enqueue', { path: pathOf(url) })
    }
  }

  // `beforeSend` applied to every element of a batch: a dropped entry (or one
  // that makes the hook throw) does not take the others with it, and is counted
  // with its reason. Without a hook the batch passes intact. Shared by logs and
  // web vitals: they are the only two channels that ship several payloads in a
  // single request.
  private applyBeforeSend(batch: EventPayload[]): EventPayload[] {
    const hook = this.options.beforeSend
    if (!hook) return batch

    const kept: EventPayload[] = []
    for (const event of batch) {
      let result: EventPayload | null
      try {
        result = hook(event)
      } catch (error) {
        this.noteDrop('error', { error: errorName(error) })
        continue
      }
      if (result === null) {
        this.noteDrop('before_send')
        continue
      }
      kept.push(result)
    }
    return kept
  }

  private flushLogs(batch: EventPayload[]): void {
    if (batch.length === 0) return
    const payloads = this.applyBeforeSend(batch)
    if (payloads.length === 0) return
    // The backend rejects batches beyond LOGS_MAX_BATCH (413) and oversized
    // payloads: chunkLogBatch splits both by count and by bytes, truncating the
    // single giant logs, without ever losing an entry (CYJS-10).
    const url = logsUri(this.options)
    for (const chunk of chunkLogBatch(payloads, MAX_PAYLOAD_BYTES, LOGS_MAX_BATCH)) {
      if (this.transport.send(chunk, url)) {
        this.stats.increment('enqueued')
        this.diagnostics.notify('enqueue', { path: pathOf(url), batch: chunk.length })
      }
    }
  }

  // Sending of a usage window (CYJS-31): ONE request per window, or more if the
  // symbols exceed the backend's per-request cap — a single 413 would take away
  // the whole window. The payload does NOT go through `beforeSend`: it is not an
  // event and contains no user data by construction (the symbol format excludes
  // them), exactly as in the Ruby gem.
  private flushUsage(window: UsageWindow): void {
    const url = usagesUri(this.options)
    const envelope = {
      environment: this.options.environment,
      ...(this.options.release ? { release: this.options.release } : {}),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      window_started_at: window.window_started_at,
      window_ended_at: window.window_ended_at,
      truncated: window.truncated,
    }
    const chunks = chunkUsageSymbols(
      window.symbols,
      MAX_PAYLOAD_BYTES - USAGE_ENVELOPE_BYTES,
      USAGE_MAX_SYMBOLS_PER_FLUSH,
    )
    for (const symbols of chunks) {
      if (this.transport.send({ ...envelope, symbols }, url)) {
        this.stats.increment('enqueued')
        this.diagnostics.notify('enqueue', {
          path: pathOf(url),
          batch: symbols.length,
        })
      }
    }
  }

  private recordSlowMethod(
    label: string,
    durationMs: number,
    args: Record<string, unknown> | undefined,
  ): void {
    if (!this.enabled) return
    if (durationMs < this.options.slowMethodThresholdMs) return

    this.enqueue(
      buildSlowMethodEvent({
        label,
        durationMs,
        environment: this.options.environment,
        release: this.options.release,
        traceId: this.scope.traceId,
        args: this.options.captureMethodArguments ? args : undefined,
      }),
      metricsUri(this.options),
      capGenericToBudget,
    )
  }

  private perfEnabled(): boolean {
    return this.enabled && this.options.detectPerformanceIssues
  }

  private scopeHash(): EventPayload {
    return this.scope.toEventHash({ sendPii: this.options.sendPii })
  }

  private autoRequest(): Record<string, unknown> | undefined {
    if (!this.options.captureRequest) return undefined
    return this.requestProvider()
  }

  private sampled(rate: number): boolean {
    if (rate >= 1) return true
    if (rate <= 0) return false
    return this.random() < rate
  }

  // The Web Vitals die is rolled once per client and then holds forever: the
  // page load is in or out, not halfway. The memoized value is what keeps the
  // first send and those of the courtesy flush together.
  private sampledForWebVitals(): boolean {
    this.webVitalsSampled ??= this.sampled(this.options.webVitalsSampleRate)
    return this.webVitalsSampled
  }

  // Internal diagnostic logs on the console (never in the log buffer: that avoids
  // telemetry loops on a failed send). Active only with `debug: true`.
  private debugLog(message: string, error?: unknown): void {
    if (!this.options.debug) return
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.debug('[closeyourit]', message, error ?? '')
    }
  }
}

// Caps of the events and replay channels anchored to the shared conservative
// budget (CYJS-10): applied in `enqueue` as the last step before sending.
function capEventToBudget(payload: EventPayload): EventPayload {
  return capEvent(payload, MAX_PAYLOAD_BYTES)
}

function capReplayChunkToBudget(payload: EventPayload): EventPayload {
  return capReplayChunk(payload, MAX_PAYLOAD_BYTES)
}

// Metrics and pageviews: label/url/route/path/referrer/utm (and beforeSend
// injections) have no cap of their own, the generic cap keeps them under budget.
function capGenericToBudget(payload: EventPayload): EventPayload {
  return capGeneric(payload, MAX_PAYLOAD_BYTES)
}

// Endpoint path (without host or query): non-sensitive metadata attached to
// the `enqueue` diagnostic event (never the full URL).
function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function defaultNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

// First useful stack line (crash frame) for the dedup key.
function topFrameKey(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('at ') || line.includes('@')) return line
  }
  return undefined
}
