// Session replay recorder (opt-in `replay`). Records the session with rrweb,
// buffers the events and sends them in chunks (periodic flush + on
// `pagehide`/`visibilitychange(hidden)`). Structural twin of `installPageviews`.
//
// rrweb is NOT a dependency of the package (which stays zero-dep): the recorder uses
// the `window.rrweb` global provided by the page (rrweb UMD build via
// script/importmap), consistent with the SDK distribution model. The
// `record` is injectable for tests → no rrweb in the test path.
//
// Correlation with server errors: at first start the session writes a
// `cyi_replay` cookie (opaque id). Same-origin requests carry it → the
// `closeyourit-ruby` gem reads it and ties the server errors to the same replay. JS
// errors instead carry the id in `contexts.replay.replay_id` (via the scope).

import type { Client } from '../../client'
import { buildReplayChunk } from '../../replay'
import { ensureReplaySession } from '../../session'
import type { StorageLike } from '../../session'

/// Options passed to the rrweb recorder (subset used).
export interface ReplayRecordOptions {
  emit: (event: unknown) => void
  maskAllInputs: boolean
  blockSelector: string | undefined
  maskTextSelector: string | undefined
}

/// Injectable dependencies (tests).
export interface ReplayDeps {
  /// Starts recording and returns the stop function. Default: `window.rrweb`.
  record?: (opts: ReplayRecordOptions) => () => void
  /// Storage for the session (`undefined` = default, `null` = in-memory fallback).
  storage?: StorageLike | null
  /// Clock (test).
  now?: () => number
  /// Writes the id where same-origin requests carry it to the backend (default:
  /// `cyi_replay` cookie). Injectable for tests.
  writeCorrelation?: (id: string) => void
}

// Accumulated rrweb events beyond which a flush is forced: avoids unbounded chunks under
// intense interactions (rrweb emits many events during scroll/typing).
const REPLAY_MAX_BUFFER = 200

/// Starts the recorder. Returns the uninstall function (rrweb stop + final
/// flush + removal of listeners/interval).
export function installReplay(client: Client, deps: ReplayDeps = {}): () => void {
  const session = ensureReplaySession(deps.storage, deps.now)
  client.setReplaySessionId(session.id)
  ;(deps.writeCorrelation ?? writeReplayCookie)(session.id)

  let buffer: unknown[] = []
  let seq = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    const events = buffer
    buffer = []
    client.captureReplayChunk(
      buildReplayChunk({
        replaySessionId: session.id,
        seq: seq++,
        startedAt: session.startedAt,
        events,
        path: currentPath(),
        user: client.scope.userId,
      }),
    )
  }

  const record = deps.record ?? defaultRecord
  const stop = record({
    emit: (event) => {
      buffer.push(event)
      if (buffer.length >= REPLAY_MAX_BUFFER) flush()
    },
    maskAllInputs: client.options.replayMaskAllInputs,
    blockSelector: client.options.replayBlockSelector,
    maskTextSelector: client.options.replayMaskTextSelector,
  })

  const interval = setInterval(flush, client.options.replayFlushIntervalMs)
  const onHide = (): void => flush()
  const onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      flush()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  return () => {
    clearInterval(interval)
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onHide)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    stop()
    flush()
  }
}

// Current pathname at flush (without query string): feeds the gallery's "visited pages".
// `undefined` outside the browser.
function currentPath(): string | undefined {
  return typeof location !== 'undefined' ? location.pathname : undefined
}

/// Minimal shape of the rrweb global build (`window.rrweb`).
interface RrwebGlobal {
  record: (opts: Record<string, unknown>) => (() => void) | undefined
}

// Default recorder: uses `window.rrweb` if present, otherwise no-op (the
// replay stays inactive, the rest of the SDK unchanged). No static import of
// rrweb → the core package stays zero-dep.
function defaultRecord(opts: ReplayRecordOptions): () => void {
  const rrweb = (globalThis as { rrweb?: RrwebGlobal }).rrweb
  if (!rrweb || typeof rrweb.record !== 'function') return () => {}
  const stop = rrweb.record({
    emit: (event: unknown) => opts.emit(event),
    maskAllInputs: opts.maskAllInputs,
    ...(opts.blockSelector ? { blockSelector: opts.blockSelector } : {}),
    ...(opts.maskTextSelector ? { maskTextSelector: opts.maskTextSelector } : {}),
  })
  return typeof stop === 'function' ? stop : () => {}
}

// Correlation cookie: session cookie, `SameSite=Lax`, opaque id (no PII). Same-origin
// requests (Turbo, XHR, forms, full-page navigations) carry it
// → the server gem ties the server errors to the replay. Written only with replay active,
// which requires the user's consent.
function writeReplayCookie(id: string): void {
  if (typeof document === 'undefined') return
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `cyi_replay=${encodeURIComponent(id)}; path=/; SameSite=Lax${secure}`
  } catch {
    // environments without cookies: the server correlation is best-effort
  }
}
