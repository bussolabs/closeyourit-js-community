// Builds the Sentry-compatible payloads sent to the CloseYourIt ingest.
// Mirror of `CloseYourIt::Events::{ErrorEvent,MessageEvent,LogEvent}` (gem) and
// of their counterparts in `closeyourit-dart`. All fields are snake_case.

import { runtimeContext } from './runtime'
import { parseStack } from './stackTrace'
import { scrub, scrubMessage } from './scrubber'
import type { EventLevel, EventPayload, LogLevel } from './types'
import { uuidV4NoDashes } from './uuid'
import { PLATFORM, SDK_NAME, SDK_VERSION } from './version'

const SDK_INFO = { name: SDK_NAME, version: SDK_VERSION } as const

// Includes the outer exception; preserve it and the nearest nine causes.
const MAX_EXCEPTIONS = 10

export interface NormalizedError {
  type: string
  value: string
  stack: string | undefined
  causes?: NormalizedError[]
  truncated?: boolean
}

export function normalizeError(input: unknown): NormalizedError {
  const outer = normalizeSingleError(input)
  const causes: NormalizedError[] = []
  const seen = new Set<unknown>([input])
  let current = input
  while (isObject(current)) {
    let cause: unknown
    try {
      cause = (current as { cause?: unknown }).cause
    } catch {
      outer.truncated = true
      break
    }
    if (cause === undefined || cause === null) break
    if (seen.has(cause) || causes.length === MAX_EXCEPTIONS - 1) {
      outer.truncated = true
      break
    }
    seen.add(cause)
    const normalized = normalizeSingleError(cause)
    if (normalized.truncated) outer.truncated = true
    causes.push(normalized)
    current = cause
  }
  if (causes.length > 0) outer.causes = causes.reverse()
  return outer
}

function isObject(input: unknown): input is object {
  return input !== null && (typeof input === 'object' || typeof input === 'function')
}

function normalizeSingleError(input: unknown): NormalizedError {
  if (!isObject(input)) return { type: 'Error', value: String(input), stack: undefined }
  let truncated = false
  const read = (key: string): unknown => {
    try {
      return (input as Record<string, unknown>)[key]
    } catch {
      truncated = true
      return undefined
    }
  }
  const name = read('name')
  const message = read('message')
  const stack = read('stack')
  let nativeError = false
  try {
    nativeError = input instanceof Error
  } catch {
    truncated = true
  }
  const type = typeof name === 'string' && (!nativeError || name) ? name : 'Error'
  let value: string
  if (typeof message === 'string') {
    value = nativeError && !message ? type : message
  } else {
    try {
      // Never serialize the cause graph as a fallback message. Scrub structured
      // keys before stringification, where their sensitivity would be lost.
      const serialized = JSON.stringify(scrub(errorFields(input)))
      if (serialized === undefined)
        throw new Error('Error details cannot be serialized')
      value = serialized
    } catch {
      truncated = true
      value = '[Unserializable error]'
    }
  }
  return {
    type,
    value,
    stack: typeof stack === 'string' ? stack : undefined,
    ...(truncated ? { truncated: true } : {}),
  }
}

// Copy data only: a toJSON hook could reintroduce secrets after scrubbing.
function errorFields(input: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (typeof input === 'function') return undefined
  if (!isObject(input)) return input
  if (seen.has(input)) return '[Circular]'
  if (depth === MAX_EXCEPTIONS) throw new Error('Error details exceed maximum depth')
  seen.add(input)
  if (Array.isArray(input))
    return input.map((value) => errorFields(value, seen, depth + 1))
  return Object.fromEntries(
    Object.keys(input)
      .filter((key) => key !== 'cause' && key !== 'toJSON')
      .map((key) => [
        key,
        errorFields((input as Record<string, unknown>)[key], seen, depth + 1),
      ]),
  )
}

interface ErrorEventInput {
  error: NormalizedError
  environment: string
  release?: string | undefined
  handled: boolean
  level: EventLevel
  scopeHash: EventPayload
  traceId?: string | undefined
  /// Id of the replay session in progress → `contexts.replay.replay_id`, ties
  /// the error to the session video.
  replayId?: string | undefined
  contexts?: Record<string, unknown> | undefined
  /// `contexts.runtime` (default: detected from the environment).
  runtime?: Record<string, unknown> | undefined
  /// Automatic request context; the scope's `request` takes precedence.
  request?: Record<string, unknown> | undefined
  /// Server hostname (Node) → top-level `server_name` field, in parity with the
  /// Ruby gem. Resolved by the client (via `serverName()`) and present only server
  /// side with `sendServerName` on; in the browser it stays absent.
  serverName?: string | undefined
}

/// Error payload for `POST …/events`.
export function buildErrorEvent(input: ErrorEventInput): EventPayload {
  const { base, scopeContexts } = splitScope(input.scopeHash)
  const exceptions = [...(input.error.causes ?? []), input.error]

  const payload: EventPayload = {
    event_id: uuidV4NoDashes(),
    timestamp: nowIso(),
    platform: PLATFORM,
    level: input.level,
    environment: input.environment,
    ...(input.release ? { release: input.release } : {}),
    ...(input.serverName ? { server_name: input.serverName } : {}),
    exception: {
      values: exceptions.map((error) => ({
        type: error.type,
        value: scrubMessage(error.value),
        stacktrace: { frames: parseStack(error.stack) },
        mechanism: { type: PLATFORM, handled: input.handled },
      })),
    },
    contexts: {
      runtime: input.runtime ?? runtimeContext(),
      ...scopeContexts,
      ...scrub(input.contexts ?? {}),
      ...(input.replayId ? { replay: { replay_id: input.replayId } } : {}),
    },
    sdk: SDK_INFO,
    // The automatic request comes before the scope spread: a manual
    // `scope.setRequest` overrides it.
    ...(input.request ? { request: input.request } : {}),
    ...base,
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.error.truncated ? { truncated: true } : {}),
  }
  return payload
}

interface MessageEventInput {
  message: string
  environment: string
  release?: string | undefined
  level: EventLevel
  scopeHash: EventPayload
  traceId?: string | undefined
  replayId?: string | undefined
  runtime?: Record<string, unknown> | undefined
  request?: Record<string, unknown> | undefined
  /// Server hostname (Node) → top-level `server_name` field (see
  /// `ErrorEventInput`). Absent in the browser.
  serverName?: string | undefined
}

/// Diagnostic message payload for `POST …/events`.
export function buildMessageEvent(input: MessageEventInput): EventPayload {
  const { base, scopeContexts } = splitScope(input.scopeHash)
  return {
    event_id: uuidV4NoDashes(),
    timestamp: nowIso(),
    platform: PLATFORM,
    level: input.level,
    environment: input.environment,
    ...(input.release ? { release: input.release } : {}),
    ...(input.serverName ? { server_name: input.serverName } : {}),
    message: { formatted: scrubMessage(input.message) },
    contexts: {
      runtime: input.runtime ?? runtimeContext(),
      ...scopeContexts,
      ...(input.replayId ? { replay: { replay_id: input.replayId } } : {}),
    },
    sdk: SDK_INFO,
    ...(input.request ? { request: input.request } : {}),
    ...base,
    ...(input.traceId ? { trace_id: input.traceId } : {}),
  }
}

interface LogEventInput {
  message: string
  level: LogLevel
  environment: string
  release?: string | undefined
  logger?: string | undefined
  traceId?: string | undefined
  attributes?: Record<string, unknown> | undefined
}

/// Log entry for `POST …/logs` (sent in batches, as an array).
export function buildLogEvent(input: LogEventInput): EventPayload {
  const attributes =
    input.attributes && Object.keys(input.attributes).length > 0
      ? scrub(input.attributes)
      : undefined

  return {
    event_id: uuidV4NoDashes(),
    timestamp: nowIso(),
    level: input.level,
    // Scrub the message on logs too (not only on errors/message events): a log can contain
    // PII/secrets as much as an error (e.g. `Failed auth email=… token=…`). Parity with buildErrorEvent.
    message: scrubMessage(input.message),
    ...(attributes ? { attributes } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    environment: input.environment,
    ...(input.release ? { release: input.release } : {}),
    sdk: SDK_INFO,
  }
}

// Extracts `contexts` from the scope hash: it must be merged into the event's
// contexts, not spread at top level (parity with dart/ruby).
function splitScope(scopeHash: EventPayload): {
  base: EventPayload
  scopeContexts: Record<string, unknown>
} {
  const base: EventPayload = { ...scopeHash }
  const scopeContexts = (base['contexts'] as Record<string, unknown>) ?? {}
  delete base['contexts']
  return { base, scopeContexts }
}

function nowIso(): string {
  return new Date().toISOString()
}
