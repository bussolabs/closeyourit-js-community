// Byte budget and payload truncation before sending (CYJS-10).
//
// The service limits (shared contract, CYRA-110/112) reject oversized payloads
// with `413`. Without a budget applied on the client side, an event with huge
// breadcrumbs/contexts, a log batch or a large replay chunk would be lost
// ENTIRELY: exactly the signal that was needed. Here we reduce the least
// important content FIRST — preserving identity and the main error — and mark
// the payload with `truncated: true`.
//
// We measure UTF-8 BYTES after `JSON.stringify`, NOT characters: an emoji is 1
// code point but 4 bytes, and the byte size is what the server compares against
// the limit. Applying the budget upstream also prevents a trusted gateway from
// rejecting (413) and retrying a payload that would never fit (CYRA-112).
//
// Strategy per channel (verified at the X-1/X/X+1 boundaries in the tests):
//   - events (error/message) → capEvent: drops, in this order, breadcrumbs (the
//     oldest), request, custom contexts (keeps runtime/os/app/device/replay),
//     extra, tags, stacktrace frames; as a last resort it truncates the error
//     value. It never touches event_id/level/timestamp/exception.type.
//   - logs (batch) → chunkLogBatch: truncates the single oversized log
//     (attributes then message) and splits the array into several requests, each
//     under budget and under the count cap, without losing any log.
//   - replay (chunk) → capReplayChunk: drops rrweb events from the tail, keeping
//     the prefix in order; session identity (replay_session_id/seq) intact.
//   - metrics/pageviews → capGeneric: fields already small upstream, but label/url/
//     route/path/referrer/utm (and `beforeSend` injections) have no cap of their
//     own, so a generic net truncates/removes them if needed.
//
// Every cap ends with the `enforceBudget` safety net, which GUARANTEES getting
// back under budget by trimming the non-identity leftovers (including those
// injected by `beforeSend`) that the specific strategy did not anticipate.

import type { EventPayload } from './types'

/// Conservative budget per single HTTP request, in UTF-8 bytes of the JSON body
/// (NOT compressed — the transport does not gzip). Derived from the contract (API.md §6):
/// decompressed envelope max 5 MB (`MAX_DECOMPRESSED`), compressed max 1 MB
/// (`MAX_COMPRESSED`); a trusted gateway applies a `DefaultMaxBodyBytes`
/// "at least as restrictive". 512 KiB sits well below all of them: a healthy
/// event/chunk never comes close, truncation only kicks in on anomalous payloads.
export const MAX_PAYLOAD_BYTES = 512 * 1024

// Byte overhead of a JSON array's square brackets (`[` + `]`). Used to cap the
// single element while leaving room for its chunk's wrapper.
const ARRAY_BRACKETS = 2

// Identity/diagnostic contexts to preserve when trimming custom contexts: they
// link the event (replay) or describe the environment (parity with the contract,
// where os/app are indexed). Everything else is "custom" and goes first.
const CORE_CONTEXTS = new Set(['runtime', 'os', 'app', 'device', 'replay'])

// Identity keys per channel: the `enforceBudget` safety net never removes them
// (and never truncates their strings). Whatever is left out is reducible.
const EVENT_KEEP = new Set([
  'event_id',
  'timestamp',
  'platform',
  'level',
  'environment',
  'release',
  'server_name',
  'sdk',
  'trace_id',
  'exception',
  'message',
  'contexts',
  'user',
  'truncated',
])
const LOG_KEEP = new Set([
  'event_id',
  'timestamp',
  'level',
  'message',
  'trace_id',
  'sdk',
  'truncated',
])
const REPLAY_KEEP = new Set([
  'replay_session_id',
  'seq',
  'started_at',
  'events',
  'environment',
  'truncated',
])
// Free-form channels (metrics/pageviews): the common minimal identity. Label,
// url, route, path, referrer, utm are strings outside the set → truncated if
// needed; custom objects (or those injected by beforeSend) are removed.
const GENERIC_KEEP = new Set([
  'kind',
  'subtype',
  'name',
  'event_id',
  'environment',
  'trace_id',
  'timestamp',
  'truncated',
])

// Shared encoder (browser + Node ≥ 20): `TextEncoder().encode` counts the real
// UTF-8 bytes. Lazily cached on the first call; missing only in minimal environments.
let cachedEncoder: TextEncoder | undefined

/// UTF-8 bytes of [value] (not characters): the metric the server compares.
export function utf8Bytes(value: string): number {
  if (typeof TextEncoder === 'function') {
    cachedEncoder ??= new TextEncoder()
    return cachedEncoder.encode(value).length
  }
  return manualUtf8Bytes(value)
}

// Fallback without `TextEncoder`: sums the bytes per code point (`for…of` iterates
// by code point, so surrogate pairs count 4 bytes only once).
function manualUtf8Bytes(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp <= 0x7f) bytes += 1
    else if (cp <= 0x7ff) bytes += 2
    else if (cp <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/// UTF-8 bytes of the payload serialized as JSON.
export function payloadBytes(payload: unknown): number {
  return utf8Bytes(JSON.stringify(payload) ?? '')
}

// Bytes of a string's JSON contribution: `JSON.stringify` wraps it in quotes
// and ESCAPES `"`, `\` and control characters (`"`→`\"`, newline→`\n`,
// ctrl→`\u00XX`), so the serialized string can weigh more than the raw one. We
// count the real bytes that end up in the body, minus the 2 outer quotes, so
// the field budget is computed "after JSON.stringify".
function jsonEscapedBytes(str: string): number {
  return utf8Bytes(JSON.stringify(str)) - 2
}

/// Truncates [str] so that its JSON contribution (bytes after escaping) is ≤
/// [maxEscapedBytes], without splitting a code point (surrogate pairs stay
/// whole). It is the right truncation for a field that will be serialized as JSON.
export function truncateUtf8Json(str: string, maxEscapedBytes: number): string {
  if (maxEscapedBytes <= 0) return ''
  if (jsonEscapedBytes(str) <= maxEscapedBytes) return str
  let out = ''
  let used = 0
  for (const ch of str) {
    const cost = utf8Bytes(JSON.stringify(ch)) - 2
    if (used + cost > maxEscapedBytes) break
    out += ch
    used += cost
  }
  return out
}

// Safety net shared by all channels: guarantees that, after the specific
// strategy, `payloadBytes(payload) ≤ budget` even when reducible leftovers the
// strategy did not anticipate remain — custom fields or ones injected by
// `beforeSend`, oversized `logger`/`release`/`path`/`user`. First it truncates
// the non-identity top-level string values (the largest first, respecting JSON
// escaping), then it removes the non-identity non-string values (custom
// objects/arrays). The keys in [keep] are never removed and their strings never
// truncated: they are the channel's identity. With a realistic budget it is
// always enough; under tiny budgets the irreducible identity takes precedence.
function enforceBudget(payload: EventPayload, budget: number, keep: Set<string>): void {
  while (payloadBytes(payload) > budget) {
    const key = largestTopLevel(payload, keep, 'string')
    if (!key) break
    const current = payload[key] as string
    const room = budget - payloadBytes({ ...payload, [key]: '' })
    const next = truncateUtf8Json(current, Math.max(0, room))
    if (next === current) break
    payload[key] = next
  }
  while (payloadBytes(payload) > budget) {
    const key = largestTopLevel(payload, keep, 'other')
    if (!key) break
    delete payload[key]
  }
}

// Top-level key (not in [keep]) with the heaviest value of the requested type
// (`string` or `other`), or `undefined` if there are none.
function largestTopLevel(
  payload: EventPayload,
  keep: Set<string>,
  kind: 'string' | 'other',
): string | undefined {
  let best: string | undefined
  let bestBytes = 0
  for (const key of Object.keys(payload)) {
    if (keep.has(key)) continue
    const value = payload[key]
    const isString = typeof value === 'string'
    if (kind === 'string' ? !isString : isString) continue
    const bytes = payloadBytes(value)
    if (bytes > bestBytes) {
      bestBytes = bytes
      best = key
    }
  }
  return best
}

// JSON-safe clone: payloads are already JSON (they go on the wire), so we do not
// mutate the callers' input while trimming the nested branches.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/// Reduces an error/message event until it fits in [budget] bytes, preserving
/// identity and the main error. Returns the original payload if already under
/// budget; otherwise a reduced copy with `truncated: true`.
export function capEvent(input: EventPayload, budget: number): EventPayload {
  if (payloadBytes(input) <= budget) return input

  const payload = clone(input)
  // The flag goes in right away: this way it is already counted in all later
  // measurements and adding it cannot push the payload over budget again.
  payload['truncated'] = true
  const fits = (): boolean => payloadBytes(payload) <= budget

  // 1. Breadcrumbs: drops the oldest (the least relevant to the crash) one by one;
  //    if even emptying them is not enough, removes the key.
  dropOldestBreadcrumbs(payload, fits)
  if (fits()) return payload

  // 2. Request context (URL/headers/body of the request): useful but not identity.
  if (removeKey(payload, 'request') && fits()) return payload

  // 3. Custom contexts: keeps only the core ones (runtime/os/app/device/replay).
  if (pruneContexts(payload) && fits()) return payload

  // 4-5. Extra and tags: enrichment metadata, they do not affect grouping.
  if (removeKey(payload, 'extra') && fits()) return payload
  if (removeKey(payload, 'tags') && fits()) return payload

  // 6. Stacktrace frames: keeps the ones closest to the crash (at the tail),
  //    discards the outermost until it fits.
  if (trimStackFrames(payload, fits)) return payload

  // 7. Last resort: truncates the error values (and the formatted message)
  //    leaving type/mechanism. The identity and the error class remain.
  truncatePrimaryMessage(payload, budget)
  // 8. Safety net: non-identity top-level leftovers (fields injected by
  //    beforeSend) that steps 1-7 do not touch.
  enforceBudget(payload, budget, EVENT_KEEP)
  return payload
}

/// Reduces a single log until it fits in [budget]: first it removes the
/// `attributes`, then truncates the `message`, finally (safety net) trims the
/// remaining non-identity fields. Preserves event_id/level/timestamp.
export function capLogEvent(input: EventPayload, budget: number): EventPayload {
  if (payloadBytes(input) <= budget) return input

  const payload = clone(input)
  payload['truncated'] = true
  if (removeKey(payload, 'attributes') && payloadBytes(payload) <= budget)
    return payload

  if (typeof payload['message'] === 'string') {
    // Room left for the message's JSON contribution = budget minus everything
    // else already serialized (the field's quotes are already in withoutMessage).
    const withoutMessage = { ...payload, message: '' }
    const room = budget - payloadBytes(withoutMessage)
    payload['message'] = truncateUtf8Json(payload['message'], Math.max(0, room))
  }
  // Remaining non-identity fields (logger/release/environment or injected by
  // beforeSend) still over budget: the safety net truncates/removes them.
  enforceBudget(payload, budget, LOG_KEEP)
  return payload
}

/// Splits a log batch into several requests, each under [budget] bytes and under
/// [maxCount] elements, without losing any log. Single oversized logs are first
/// truncated by [capLogEvent]. The empty array yields no chunk.
export function chunkLogBatch(
  batch: EventPayload[],
  budget: number,
  maxCount: number,
): EventPayload[][] {
  const chunks: EventPayload[][] = []
  let current: EventPayload[] = []
  let currentBytes = ARRAY_BRACKETS

  const push = (): void => {
    if (current.length > 0) chunks.push(current)
    current = []
    currentBytes = ARRAY_BRACKETS
  }

  for (const raw of batch) {
    // Every log must fit alone in a chunk: we cap it at budget minus the brackets.
    const log = capLogEvent(raw, budget - ARRAY_BRACKETS)
    // Bytes added to the chunk: the element + the comma if it is not the first. The
    // JSON of an array is `[` + join(',') + `]`, so the count is exact.
    const add = payloadBytes(log) + (current.length > 0 ? 1 : 0)
    const overBytes = currentBytes + add > budget
    const overCount = current.length >= maxCount
    if (current.length > 0 && (overBytes || overCount)) push()
    current.push(log)
    currentBytes += current.length > 1 ? payloadBytes(log) + 1 : payloadBytes(log)
  }
  push()
  return chunks
}

/// Reduces a replay chunk until it fits in [budget]: drops rrweb events from the
/// tail, keeping the prefix in order (continuous timeline from the start).
/// Session identity (replay_session_id/seq/started_at) always preserved.
export function capReplayChunk(input: EventPayload, budget: number): EventPayload {
  if (payloadBytes(input) <= budget) return input

  const payload = clone(input)
  payload['truncated'] = true
  const events = Array.isArray(payload['events'])
    ? (payload['events'] as unknown[])
    : []

  // Longest prefix of events that fits: overhead (chunk with events:[]) +
  // cumulative bytes of the events + commas. The count follows the JSON shape.
  const overhead = payloadBytes({ ...payload, events: [] }) - ARRAY_BRACKETS
  let used = overhead + ARRAY_BRACKETS
  const kept: unknown[] = []
  for (const ev of events) {
    const add = payloadBytes(ev) + (kept.length > 0 ? 1 : 0)
    if (used + add > budget) break
    kept.push(ev)
    used += add
  }
  payload['events'] = kept
  // Safety net: if even the metadata (large path/user, injected fields) blows
  // the budget, trim it while keeping the session identity and the events.
  enforceBudget(payload, budget, REPLAY_KEEP)
  return payload
}

/// Generic cap for free-form channels (metrics, pageviews): if it exceeds
/// [budget], truncates the non-identity string values (label/url/route/path/
/// referrer/utm…) and removes the custom values, marking `truncated`. The
/// channel's minimal identity (kind/subtype/name/environment…) remains.
export function capGeneric(input: EventPayload, budget: number): EventPayload {
  if (payloadBytes(input) <= budget) return input
  const payload = clone(input)
  payload['truncated'] = true
  enforceBudget(payload, budget, GENERIC_KEEP)
  return payload
}

// ---------------------------------------------------------------- reducers

// Drops the oldest breadcrumbs (head of the array) one by one until [fits] or
// the array is empty; in that case removes the key entirely.
function dropOldestBreadcrumbs(payload: EventPayload, fits: () => boolean): void {
  const container = payload['breadcrumbs']
  const values =
    container &&
    typeof container === 'object' &&
    Array.isArray((container as { values?: unknown }).values)
      ? (container as { values: unknown[] }).values
      : undefined
  if (!values) return
  while (values.length > 0 && !fits()) values.shift()
  if (values.length === 0) delete payload['breadcrumbs']
}

// Removes [key] if present. Returns `true` if it removed something.
function removeKey(payload: EventPayload, key: string): boolean {
  if (!(key in payload)) return false
  delete payload[key]
  return true
}

// Keeps only the core keys in contexts; removes the custom ones. Returns `true` if
// it removed at least one key.
function pruneContexts(payload: EventPayload): boolean {
  const contexts = payload['contexts']
  if (!contexts || typeof contexts !== 'object') return false
  const map = contexts as Record<string, unknown>
  let changed = false
  for (const key of Object.keys(map)) {
    if (!CORE_CONTEXTS.has(key)) {
      delete map[key]
      changed = true
    }
  }
  if (Object.keys(map).length === 0) delete payload['contexts']
  return changed
}

// Reduces the stacktrace frames keeping the ones closest to the crash (tail of the
// array, where `parseStack` puts the frame that threw) until [fits]. Returns `true`
// if the payload fits after the reduction.
function trimStackFrames(payload: EventPayload, fits: () => boolean): boolean {
  const values = exceptionValues(payload)
  if (!values) return false
  for (const value of values) {
    const frames = stackFrames(value)
    if (!frames) continue
    while (frames.length > 0 && !fits()) frames.shift()
  }
  return fits()
}

// Truncates the error messages (exception.values[*].value and message.formatted)
// as a last gasp, leaving room for the already serialized identity. The backend
// reads the last value, but the others take up bytes too: it reduces them all.
// type and mechanism stay intact. The count accounts for JSON escaping.
function truncatePrimaryMessage(payload: EventPayload, budget: number): void {
  const values = exceptionValues(payload)
  if (values) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (!value || typeof value.value !== 'string') continue
      const probe = clone(payload)
      const probeValue = exceptionValues(probe)?.[i]
      if (!probeValue) continue
      probeValue.value = ''
      const room = budget - payloadBytes(probe)
      value.value = truncateUtf8Json(value.value, Math.max(0, room))
    }
  }
  const message = payload['message']
  if (
    message &&
    typeof message === 'object' &&
    typeof (message as { formatted?: unknown }).formatted === 'string'
  ) {
    const probe = clone(payload)
    ;(probe['message'] as { formatted: string }).formatted = ''
    const room = budget - payloadBytes(probe)
    ;(message as { formatted: string }).formatted = truncateUtf8Json(
      (message as { formatted: string }).formatted,
      Math.max(0, room),
    )
  }
}

interface ExceptionValue {
  type?: string
  value?: string
  stacktrace?: { frames?: unknown[] }
}

function exceptionValues(payload: EventPayload): ExceptionValue[] | undefined {
  const exception = payload['exception']
  if (!exception || typeof exception !== 'object') return undefined
  const values = (exception as { values?: unknown }).values
  return Array.isArray(values) ? (values as ExceptionValue[]) : undefined
}

function stackFrames(value: ExceptionValue): unknown[] | undefined {
  const frames = value.stacktrace?.frames
  return Array.isArray(frames) ? frames : undefined
}
