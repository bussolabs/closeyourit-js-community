// Normalization and validation of the options. Mirror of
// `CloseYourItOptions`/`Configuration` (dart/gem): the three required fields,
// when missing, disable the SDK (no-op) instead of throwing.

import { normalizeLogLevel } from './logLevel'
import { detectRelease } from './runtime'
import {
  DEFAULT_USAGE_FLUSH_INTERVAL_MS,
  DEFAULT_USAGE_MAX_SYMBOLS,
  USAGE_MAX_SYMBOLS_PER_FLUSH,
} from './usage'
import type {
  BeforeSend,
  CloseYourItOptions,
  LogLevel,
  OnDiagnostic,
  TracePropagationTarget,
} from './types'

/// Default threshold (ms) for a slow external HTTP request (breadcrumb
/// `slow_external_http` + performance verdict). Ruby/dart parity.
export const DEFAULT_SLOW_EXTERNAL_THRESHOLD_MS = 1000

export interface ResolvedOptions {
  endpointUrl: string
  token: string
  publicKey: string
  projectId: string
  environment: string
  release: string | undefined
  sampleRate: number
  beforeSend: BeforeSend | undefined
  onDiagnostic: OnDiagnostic | undefined
  debug: boolean
  autoInstall: boolean
  breadcrumbs: boolean
  autoBreadcrumbs: {
    click: boolean
    navigation: boolean
    console: boolean
    http: boolean
  }
  maxBreadcrumbs: number
  sendPii: boolean
  sendServerName: boolean
  maxQueue: number
  excludedExceptions: string[]
  captureRequest: boolean
  trackPageviews: boolean
  replay: boolean
  replayMaskAllInputs: boolean
  replayBlockSelector: string | undefined
  replayMaskTextSelector: string | undefined
  replayFlushIntervalMs: number
  logsEnabled: boolean
  logsSampleRate: number
  logsBatchSize: number
  logsFlushIntervalMs: number
  logsMinLevel: LogLevel
  slowMethodThresholdMs: number
  captureMethodArguments: boolean
  detectPerformanceIssues: boolean
  captureExternalHttp: boolean
  slowExternalThresholdMs: number
  repeatedHttpThreshold: number
  repeatedHttpWindowMs: number
  detectJank: boolean
  jankThresholdMs: number
  trackWebVitals: boolean
  webVitalsSampleRate: number
  captureResourceErrors: boolean
  usageEnabled: boolean
  usageFlushIntervalMs: number
  usageMaxSymbols: number
  tracePropagationTargets: TracePropagationTarget[]
  enabled: boolean
}

export function resolveOptions(options: CloseYourItOptions): ResolvedOptions {
  return {
    endpointUrl: (options.endpointUrl ?? '').trim().replace(/\/+$/, ''),
    token: (options.token ?? '').trim(),
    publicKey: (options.publicKey ?? '').trim(),
    projectId: (options.projectId ?? '').trim(),
    environment: options.environment ?? 'production',
    // explicit release from the consumer, otherwise Node-side auto-detect (tag-first,
    // parity with the Ruby gem); undefined in the browser (see `detectRelease`).
    release: options.release ?? detectRelease(),
    sampleRate: clampRate(options.sampleRate),
    beforeSend: options.beforeSend,
    onDiagnostic: options.onDiagnostic,
    debug: options.debug ?? false,
    autoInstall: options.autoInstall ?? true,
    breadcrumbs: options.breadcrumbs ?? true,
    autoBreadcrumbs: {
      click: options.autoBreadcrumbs?.click ?? true,
      navigation: options.autoBreadcrumbs?.navigation ?? true,
      console: options.autoBreadcrumbs?.console ?? true,
      http: options.autoBreadcrumbs?.http ?? true,
    },
    maxBreadcrumbs: options.maxBreadcrumbs ?? 50,
    sendPii: options.sendPii ?? false,
    sendServerName: options.sendServerName ?? true,
    maxQueue: positiveOr(options.maxQueue, 30),
    excludedExceptions: options.excludedExceptions ?? [],
    captureRequest: options.captureRequest ?? true,
    trackPageviews: options.trackPageviews ?? false,
    replay: options.replay ?? false,
    replayMaskAllInputs: options.replayMaskAllInputs ?? true,
    replayBlockSelector: options.replayBlockSelector,
    // CYJS-15 · In a back-office app most of the sensitive data is text the page
    // shows (names, cases, amounts), not only what is typed into the fields: the
    // default must cover it. `*` is the selector that in rrweb matches every
    // element, so it masks all text nodes. Whoever wants to see part of the page in
    // clear passes a narrower selector: the opt-out is by construction, and must be
    // declared.
    replayMaskTextSelector: options.replayMaskTextSelector ?? '*',
    replayFlushIntervalMs: positiveOr(options.replayFlushIntervalMs, 5000),
    logsEnabled: options.logsEnabled ?? true,
    logsSampleRate: clampRate(options.logsSampleRate),
    logsBatchSize: positiveOr(options.logsBatchSize, 50),
    logsFlushIntervalMs: options.logsFlushIntervalMs ?? 5000,
    logsMinLevel: normalizeLogLevel(options.logsMinLevel ?? 'info'),
    slowMethodThresholdMs: positiveOr(options.slowMethodThresholdMs, 200),
    captureMethodArguments: options.captureMethodArguments ?? false,
    detectPerformanceIssues: options.detectPerformanceIssues ?? false,
    captureExternalHttp: options.captureExternalHttp ?? true,
    slowExternalThresholdMs: clampThreshold(options.slowExternalThresholdMs),
    repeatedHttpThreshold: positiveOr(options.repeatedHttpThreshold, 5),
    repeatedHttpWindowMs: positiveOr(options.repeatedHttpWindowMs, 5000),
    detectJank: options.detectJank ?? true,
    jankThresholdMs: positiveOr(options.jankThresholdMs, 100),
    trackWebVitals: options.trackWebVitals ?? false,
    webVitalsSampleRate: clampRate(options.webVitalsSampleRate),
    captureResourceErrors: options.captureResourceErrors ?? false,
    usageEnabled: options.usageEnabled ?? false,
    usageFlushIntervalMs: positiveOr(
      options.usageFlushIntervalMs,
      DEFAULT_USAGE_FLUSH_INTERVAL_MS,
    ),
    // Clamped to the backend's per-request cap: a window larger than that would
    // be rejected as a whole (413), losing all the symbols seen.
    usageMaxSymbols: Math.min(
      positiveOr(options.usageMaxSymbols, DEFAULT_USAGE_MAX_SYMBOLS),
      USAGE_MAX_SYMBOLS_PER_FLUSH,
    ),
    tracePropagationTargets: options.tracePropagationTargets ?? [],
    enabled: options.enabled ?? true,
  }
}

function clampRate(rate: number | undefined): number {
  if (rate === undefined || Number.isNaN(rate)) return 1
  if (rate < 0) return 0
  if (rate > 1) return 1
  return rate
}

// Value > 0, otherwise the default (undefined/NaN/zero/negatives included).
function positiveOr(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value) || value <= 0) return fallback
  return value
}

// Threshold in ms: `0` is valid (disables detection); undefined/NaN/negatives
// fall back to the default.
function clampThreshold(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value) || value < 0) {
    return DEFAULT_SLOW_EXTERNAL_THRESHOLD_MS
  }
  return value
}

/// Structural comparison of two sets of **resolved** options, for the idempotency of
/// `init` (CYJS-8): equivalent ⇒ a new `init` does not reconfigure the SDK. The
/// comparison is recursive over nested objects and arrays; functions (`beforeSend`)
/// are compared by reference — a new closure counts as a change, a cautious choice
/// so as never to ignore an intent to reconfigure.
export function resolvedOptionsEqual(a: ResolvedOptions, b: ResolvedOptions): boolean {
  return deepEqual(a, b)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false
  }
  // RegExps (in `tracePropagationTargets`) have no enumerable keys: without this
  // branch two different patterns would come out equivalent. Comparing by source
  // and flags makes an allowlist change really reconfigure the SDK.
  if (a instanceof RegExp || b instanceof RegExp) {
    return (
      a instanceof RegExp &&
      b instanceof RegExp &&
      a.source === b.source &&
      a.flags === b.flags
    )
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObj, key) &&
      deepEqual(aObj[key], bObj[key]),
  )
}

/// Prefix of the **secret** bearer (`cyi_…`, server-only). The DSN public key is
/// instead hexadecimal with no prefix (parity with the backend generation).
export const SECRET_TOKEN_PREFIX = 'cyi_'

/// `true` if [value] is a secret `cyi_` bearer (never to be exposed in the browser).
export function isSecretToken(value: string): boolean {
  return value.startsWith(SECRET_TOKEN_PREFIX)
}

/// Credential the transport uses to authenticate with the ingest.
/// - `bearer`: `Authorization: Bearer <secret>` — server side only.
/// - `dsn`: DSN public key via `?sentry_key=` — browser-safe (no secret).
export type TransportAuth =
  { kind: 'bearer'; secret: string } | { kind: 'dsn'; publicKey: string }

/// Picks the sending credential based on the environment. In the browser the secret
/// bearer is NEVER eligible (it would end up in the bundle/Network): the
/// `publicKey` is needed. Server side the bearer is the primary choice, falling back
/// to the public key if it is the only one provided. `null` = no usable credential.
export function resolveTransportAuth(
  options: ResolvedOptions,
  browser: boolean,
): TransportAuth | null {
  if (browser) {
    return options.publicKey ? { kind: 'dsn', publicKey: options.publicKey } : null
  }
  if (options.token) return { kind: 'bearer', secret: options.token }
  if (options.publicKey) return { kind: 'dsn', publicKey: options.publicKey }
  return null
}

/// Reason why the SDK is disabled, or `null` if active. It depends on the
/// environment: in the browser the DSN public key is needed (the bearer is server-only).
export function disabledReason(
  options: ResolvedOptions,
  browser: boolean,
): string | null {
  if (!options.enabled) return 'disabled by configuration (enabled: false)'
  if (!options.endpointUrl) return 'endpointUrl missing'
  if (!options.projectId) return 'projectId missing'
  if (resolveTransportAuth(options, browser) === null) {
    return browser
      ? 'publicKey missing (in the browser the secret cyi_ bearer is server-only: use the DSN public key)'
      : 'token missing'
  }
  if (
    options.environment === 'production' &&
    options.endpointUrl.startsWith('http://')
  ) {
    return 'http:// endpoint not allowed in production'
  }
  return null
}

export function isEnabled(options: ResolvedOptions, browser: boolean): boolean {
  return disabledReason(options, browser) === null
}

/// Ingest URI for error/message events (bearer auth, v1 path).
export function eventsUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/events`
}

/// Sentry drop-in URI for error/message events when authenticating via the
/// DSN public key: the backend exposes `POST /api/:project_id/store` (single JSON
/// event), auth `?sentry_key=`. It is the browser-safe channel for errors.
export function storeUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/${options.projectId}/store`
}

/// Ingest URI for logs (batch).
export function logsUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/logs`
}

/// Ingest URI for metrics (slow_method, performance_issue).
export function metricsUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/metrics`
}

/// Ingest URI for pageviews (web analytics).
export function pageviewsUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/pageviews`
}

/// Ingest URI for session replay chunks.
export function replayUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/replays`
}

/// Ingest URI for Web Vitals measurements (LCP/CLS/INP/TTFB/FCP from real
/// visitors). Its own endpoint, not a branch of the pageviews: shape, batch cap and
/// throttle are different (CYJS-12, CYJS-28).
export function webVitalsUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/web_vitals`
}

/// Ingest URI for usage telemetry (which routes/jobs/keys really run).
/// Bearer-ONLY channel: the backend does not expose it to the DSN public key, so it
/// is not reachable from the browser (CYJS-31).
export function usagesUri(options: ResolvedOptions): string {
  return `${options.endpointUrl}/api/v1/projects/${options.projectId}/usages`
}

/// Endpoint host (to exclude the telemetry from the HTTP breadcrumbs).
export function endpointHost(options: ResolvedOptions): string | undefined {
  try {
    return new URL(options.endpointUrl).host
  } catch {
    return undefined
  }
}
