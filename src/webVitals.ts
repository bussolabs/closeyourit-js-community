// Builds the payload of a Web Vital measurement for `POST …/web_vitals`
// (CYJS-12, extended to TTFB and FCP in CYJS-28). snake_case fields like the rest of
// the wire contract, twin of `pageviews.ts`: no identifying signal in the
// body — the measurement is (metric, value, page), IP and User-Agent are derived by
// the server from the request.
// `path` never carries the query string or fragment, as for pageviews.
//
// The `rating` (good/needs-improvement/poor) does NOT travel: the backend computes it
// from the official thresholds. Sending it would mean duplicating those thresholds here
// and letting the measured party grade itself — an old SDK would paint green what is
// red today.
//
// It assumes a browser context (the only caller, the web vitals integration, runs
// only there): no non-browser guards, they would be dead code.

import { uuidV4 } from './uuid'

/// The collected metrics. The three Core Web Vitals Google judges a site by —
/// perceived loading (LCP), layout stability (CLS), responsiveness to
/// interactions (INP) — plus the two diagnostics that explain a high LCP: the
/// server response time (TTFB) and the first contentful paint (FCP).
export type WebVitalName = 'lcp' | 'cls' | 'inp' | 'ttfb' | 'fcp'

/// Navigation types recognized by the backend. The Navigation Timing API uses
/// `back_forward` with the underscore: the translation lives in
/// `normalizeNavigationType`, an untranslated type would be dropped server side.
const NAVIGATION_TYPES = [
  'navigate',
  'reload',
  'back-forward',
  'prerender',
  'restore',
] as const

/// Payload of a measurement, WITHOUT `environment`/`release` (the client adds them:
/// it is the one that knows the resolved configuration). A type alias and not an
/// interface: this way it stays assignable to `EventPayload` when the client ships it.
export type WebVitalPayload = {
  event_id: string
  metric: WebVitalName
  value: number
  hostname: string
  path: string
  navigation_type?: string
  occurred_at: string
}

export interface WebVitalInput {
  metric: WebVitalName
  value: number
  /// Path of the measured page (default `location.pathname`). Query and fragment
  /// are stripped anyway.
  path?: string | undefined
  /// Raw navigation type (`PerformanceNavigationTiming.type`).
  navigationType?: string | undefined
}

/// Builds the measurement from the current location. `event_id` is a UUID v4 (with
/// dashes) for the `(project_id, event_id)` idempotency, as for pageviews.
export function buildWebVital(input: WebVitalInput): WebVitalPayload {
  const navigationType = normalizeNavigationType(input.navigationType)

  return {
    event_id: uuidV4(),
    metric: input.metric,
    value: roundWebVital(input.metric, input.value),
    hostname: location.hostname,
    path: stripPath(input.path ?? location.pathname),
    ...(navigationType ? { navigation_type: navigationType } : {}),
    occurred_at: new Date().toISOString(),
  }
}

/// Navigation type in the backend's vocabulary, or `undefined` if unknown (a
/// made-up value would be dropped: better not to send it at all). This also covers
/// the types web-vitals knows and the ingest does not (`back-forward-cache`,
/// `soft-navigation`): the measurement goes out anyway, just without the type —
/// losing it over an accessory field would be a terrible trade.
export function normalizeNavigationType(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase().replace('back_forward', 'back-forward')
  return (NAVIGATION_TYPES as readonly string[]).includes(normalized)
    ? normalized
    : undefined
}

/// Per-metric rounding: CLS is dimensionless and moves on small values
/// (4 decimals), the others are milliseconds and the fraction adds nothing
/// to a percentile.
export function roundWebVital(metric: WebVitalName, value: number): number {
  if (metric === 'cls') return Math.round(value * 10000) / 10000
  return Math.round(value)
}

// Only the pathname: the query may carry tokens and identifiers, and a speed
// measurement has no need for them.
function stripPath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path
}
