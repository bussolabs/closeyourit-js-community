// Metric payloads for `POST …/metrics`. Mirror of
// `CloseYourIt::Events::{SlowMethodEvent,PerformanceIssueEvent}` (gem) and
// `MetricEvent`/`PerformanceIssueEvent` (dart). Unlike error events,
// `sample_id` is a uuid WITH dashes. Metrics are never
// sampled.

import { isSensitiveKey, FILTERED, scrubMessage } from './scrubber'
import type { EventPayload } from './types'
import { uuidV4 } from './uuid'
import { SDK_NAME, SDK_VERSION } from './version'

const SDK_INFO = { name: SDK_NAME, version: SDK_VERSION } as const
const MAX_ARG_VALUE = 120

export interface SlowMethodInput {
  /// Measurement label: it is the metric fingerprint (required).
  label: string
  durationMs: number
  environment: string
  release?: string | undefined
  traceId?: string | undefined
  file?: string | undefined
  lineno?: number | undefined
  /// Optional arguments (already gated by `captureMethodArguments` in the client).
  args?: Record<string, unknown> | undefined
}

/// `kind: slow_method` payload. Empty label → TypeError: without a fingerprint the
/// metric cannot be grouped (dart 0.2.0 parity).
export function buildSlowMethodEvent(input: SlowMethodInput): EventPayload {
  if (typeof input.label !== 'string' || input.label.trim().length === 0) {
    throw new TypeError(
      'closeyourit: measure(label) requires a non-empty label (it is the metric fingerprint)',
    )
  }

  return {
    kind: 'slow_method',
    sample_id: uuidV4(),
    duration_ms: round2(input.durationMs),
    occurred_at: new Date().toISOString(),
    environment: input.environment,
    ...(input.release ? { release: scrubMessage(input.release) } : {}),
    label: input.label,
    ...(input.file ? { file: input.file } : {}),
    ...(input.lineno !== undefined ? { lineno: input.lineno } : {}),
    ...(input.args && Object.keys(input.args).length > 0
      ? { arguments: formatArgs(input.args) }
      : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    sdk: SDK_INFO,
  }
}

export type PerformanceIssueSubtype = 'slow_external_http' | 'repeated_http' | 'jank'

export interface PerformanceIssueInput {
  subtype: PerformanceIssueSubtype
  environment: string
  durationMs?: number | undefined
  traceId?: string | undefined
  /// slow_external_http / repeated_http
  httpHost?: string | undefined
  httpUrl?: string | undefined
  /// jank
  route?: string | undefined
  /// repeated_http: number of identical requests in the window. On the wire it is
  /// `query_count` — same name across SDKs (dart, gem) and readable by the Rails
  /// reader `occurrence_query_count` in the UI.
  queryCount?: number | undefined
}

/// `kind: performance_issue` payload. The fields not relevant to the subtype
/// stay absent (the backend groups by kind-specific signature).
export function buildPerformanceIssueEvent(input: PerformanceIssueInput): EventPayload {
  return {
    kind: 'performance_issue',
    subtype: input.subtype,
    sample_id: uuidV4(),
    ...(input.durationMs !== undefined
      ? { duration_ms: round2(input.durationMs) }
      : {}),
    occurred_at: new Date().toISOString(),
    environment: input.environment,
    ...(input.httpHost ? { http_host: input.httpHost } : {}),
    ...(input.httpUrl ? { http_url: input.httpUrl } : {}),
    ...(input.route ? { route: input.route } : {}),
    ...(input.queryCount !== undefined ? { query_count: input.queryCount } : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    sdk: SDK_INFO,
  }
}

// `arguments` on the wire: array of {name, value} with the value stringified, scrubbed
// by name and truncated (slow_method_event.rb parity).
function formatArgs(
  args: Record<string, unknown>,
): Array<{ name: string; value: string }> {
  return Object.entries(args).map(([name, value]) => ({
    name,
    value: isSensitiveKey(name) ? FILTERED : truncate(stringify(value)),
  }))
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(value: string): string {
  return value.length > MAX_ARG_VALUE ? `${value.slice(0, MAX_ARG_VALUE)}…` : value
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
