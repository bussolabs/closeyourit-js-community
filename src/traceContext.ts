// Parser/validator/formatter of the W3C Trace Context (`traceparent`/`tracestate`)
// and of the W3C Baggage, plus the propagation decision via allowlist. Pure,
// isomorphic module (no access to window/process): the glue with scope and options
// lives in the `Client`. References: W3C Trace Context (traceparent/tracestate) and
// W3C Baggage. The W3C `trace-id` (32 hex) matches the internal CloseYourIt
// `trace_id` (UUID v4 without dashes), so adopting a distributed trace is a 1:1 mapping.

import type { TraceCarrier, TracePropagationTarget } from './types'

/// W3C trace context extracted from a valid `traceparent`.
export interface TraceParent {
  /// `trace-id`: 32 lowercase hex chars, not all-zero.
  traceId: string
  /// `parent-id` (the caller's span-id): 16 lowercase hex chars, not all-zero.
  parentId: string
  /// Bit 0 of `trace-flags` (`sampled`): the upstream trace is sampled.
  sampled: boolean
}

const HEX2 = /^[0-9a-f]{2}$/
const HEX16 = /^[0-9a-f]{16}$/
const HEX32 = /^[0-9a-f]{32}$/
const ZERO_TRACE = '0'.repeat(32)
const ZERO_PARENT = '0'.repeat(16)

/// Parses a W3C `traceparent` header. Returns the trace context, or `null` if
/// missing or malformed (lowercase-only, fixed-length fields, trace-id/parent-id
/// not all-zero, reserved version `ff` rejected). A future version (> `00`) is
/// accepted by reading the first four fields and ignoring any additional fields,
/// as the standard recommends.
export function parseTraceparent(value: string | null | undefined): TraceParent | null {
  if (!value) return null
  const parts = value.trim().split('-')
  if (parts.length < 4) return null

  const version = parts[0]!
  const traceId = parts[1]!
  const parentId = parts[2]!
  const flags = parts[3]!

  if (!HEX2.test(version) || version === 'ff') return null
  // The current version (`00`) is defined on exactly four fields: no extra field
  // allowed. Future versions may add some (ignored).
  if (version === '00' && parts.length !== 4) return null
  if (!HEX32.test(traceId) || traceId === ZERO_TRACE) return null
  if (!HEX16.test(parentId) || parentId === ZERO_PARENT) return null
  if (!HEX2.test(flags)) return null

  return { traceId, parentId, sampled: (parseInt(flags, 16) & 0x01) === 0x01 }
}

/// Builds a version `00` `traceparent` from trace-id, span-id and sampling flag.
/// The two ids are expected to be already valid (32 and 16 hex chars).
export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled: boolean,
): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`
}

// key = lcalpha *( lcalpha / DIGIT / "_" / "-" / "*" / "/" ) with optional
// "@vendor" tenant (conforming simplification of the W3C tracestate grammar).
const TRACESTATE_KEY = /^[a-z0-9][a-z0-9_\-*/]*(@[a-z0-9][a-z0-9_\-*/]*)?$/

function isValidTracestateMember(member: string): boolean {
  const eq = member.indexOf('=')
  if (eq <= 0) return false
  const key = member.slice(0, eq)
  const val = member.slice(eq + 1)
  if (!TRACESTATE_KEY.test(key)) return false
  if (val.length === 0 || val.length > 256) return false
  // value: printable ASCII (the comma is already consumed as list separator by
  // `parseTracestate`, which splits before validating the members).
  return /^[\x20-\x7e]*$/.test(val)
}

/// Validates and normalizes a `tracestate` header as an opaque string to re-propagate:
/// drops malformed members, truncates to 32 members (W3C limit). Returns
/// `undefined` if missing or entirely invalid.
export function parseTracestate(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const valid = value
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && isValidTracestateMember(m))
    .slice(0, 32)
  return valid.length > 0 ? valid.join(',') : undefined
}

/// Maximum recommended size for the `baggage` header (W3C Baggage).
const MAX_BAGGAGE_BYTES = 8192

/// Validates a `baggage` header as an opaque string to re-propagate ONLY towards
/// trusted destinations: it may contain PII, so it must never be attached to events
/// nor sent to hosts that are not allowed. Returns `undefined` if empty,
/// non-printable or over the limit.
export function normalizeBaggage(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_BAGGAGE_BYTES) return undefined
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined
}

/// `true` if [url] is among the trusted destinations. A string with a scheme
/// (`http://127.0.0.1`, `location.origin`) matches on protocol and hostname, plus
/// the port only when the target declares one. A bare string is compared with
/// the URL host (`host[:port]`), equal or as a parent domain (`example.com`
/// trusts `api.example.com`). A RegExp is tested on the full URL. Never a
/// substring match: `https://attacker.example/?api.internal` must not pass.
/// Empty string targets and unparsable URLs never match.
export function matchesPropagationTarget(
  url: string,
  targets: readonly TracePropagationTarget[],
): boolean {
  let parsed: URL | null | undefined
  for (const target of targets) {
    if (typeof target === 'string') {
      parsed ??= parseUrl(url)
      if (target.length > 0 && parsed && stringTargetMatches(parsed, target))
        return true
    } else if (regExpMatches(target, url)) {
      return true
    }
  }
  return false
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function stringTargetMatches(url: URL, target: string): boolean {
  if (!target.includes('://')) {
    const wanted = target.toLowerCase()
    return url.host === wanted || url.host.endsWith(`.${wanted}`)
  }
  const wanted = parseUrl(target)
  if (!wanted) return false
  // `URL.port` is '' for the scheme default (`:443` on https), so an explicit
  // standard port is read from the raw string; both sides then compare as ''.
  const portSpecified =
    wanted.port !== '' ||
    /:\d+(?=[/?#]|$)/.test(target.slice(target.indexOf('://') + 3))
  return (
    url.protocol === wanted.protocol &&
    url.hostname === wanted.hostname &&
    (!portSpecified || url.port === wanted.port)
  )
}

// `RegExp.test` with the `g`/`y` flag advances `lastIndex`, making the match of the
// same destination intermittent across successive calls. We test on a copy
// without those flags (the others — `i`, `m`, `s`, `u`, `d` — are preserved),
// without mutating the RegExp supplied by the consumer.
function regExpMatches(pattern: RegExp, url: string): boolean {
  if (!pattern.global && !pattern.sticky) return pattern.test(url)
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(url)
}

/// `true` if [target] resolves to the same origin as [origin] (relative URLs
/// included): one's own origin is first-party and trusted by definition. `false`
/// on unparsable URLs.
export function isSameOrigin(target: string, origin: string): boolean {
  try {
    return new URL(target, origin).origin === origin
  } catch {
    return false
  }
}

/// Reads a header (case-insensitive) from a heterogeneous carrier: a getter
/// `(name) => value`, a `Headers`, or a header map (Node) with string/array
/// values. Of multiple values it takes the first. `undefined` if missing.
export function readTraceHeader(
  carrier: TraceCarrier,
  name: string,
): string | undefined {
  if (typeof carrier === 'function') return orUndefined(carrier(name))
  if (typeof Headers !== 'undefined' && carrier instanceof Headers) {
    return orUndefined(carrier.get(name))
  }
  const wanted = name.toLowerCase()
  for (const key of Object.keys(carrier)) {
    if (key.toLowerCase() !== wanted) continue
    const value = (carrier as Record<string, string | string[] | undefined | null>)[key]
    if (Array.isArray(value))
      return value.length > 0 ? orUndefined(value[0]) : undefined
    return orUndefined(value)
  }
  return undefined
}

function orUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value
}
