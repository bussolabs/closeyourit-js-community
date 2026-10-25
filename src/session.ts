// Replay session: an opaque id stable for the whole browser session, longer-lived
// than the `trace_id` (which is per page). Persisted in `sessionStorage` so as
// to survive full-page navigations (Turbo Drive included); if the storage is
// not available (SSR, private mode, access denied) it falls back to an
// in-memory id valid for the current page. The id is random and does NOT contain PII.

import { uuidV4NoDashes } from './uuid'

/// Key in sessionStorage and name of the server-side correlation cookie.
export const REPLAY_STORAGE_KEY = 'cyi_replay'

/// Current replay session.
export interface ReplaySession {
  /// Opaque id shared by all the chunks and errors of the session.
  id: string
  /// Session start epoch ms (t0 for the viewer-side reconstruction).
  startedAt: number
}

/// Subset of `Storage` in use (injectable in tests).
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// Fallback when the storage is not available: a single in-memory session for
// the current context (the browser is single-thread → one session per page).
let memorySession: ReplaySession | null = null

/// Returns the current replay session, creating it on first access; idempotent
/// within the same browser session. [storage] injectable: `undefined` uses the
/// default (`sessionStorage` if available), `null` forces the in-memory fallback.
export function ensureReplaySession(
  storage: StorageLike | null | undefined = defaultStorage(),
  now: () => number = () => Date.now(),
): ReplaySession {
  const store = storage === undefined ? defaultStorage() : storage
  if (store) {
    const existing = readStored(store)
    if (existing) return existing
    const created: ReplaySession = { id: uuidV4NoDashes(), startedAt: now() }
    writeStored(store, created)
    return created
  }
  if (memorySession) return memorySession
  memorySession = { id: uuidV4NoDashes(), startedAt: now() }
  return memorySession
}

/// Clears the in-memory fallback. Tests only (isolates sessions between cases).
export function resetReplaySessionMemory(): void {
  memorySession = null
}

function readStored(storage: StorageLike): ReplaySession | null {
  let raw: string | null
  try {
    raw = storage.getItem(REPLAY_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ReplaySession>
    if (typeof parsed.id === 'string' && typeof parsed.startedAt === 'number') {
      return { id: parsed.id, startedAt: parsed.startedAt }
    }
  } catch {
    // corrupted value → regenerate
  }
  return null
}

function writeStored(storage: StorageLike, session: ReplaySession): void {
  try {
    storage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // quota exceeded or access denied: the session stays valid for the page
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage
  } catch {
    // accessing sessionStorage may throw (cross-origin iframe, storage off)
  }
  return null
}
