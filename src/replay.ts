// Builds the payload of a session replay chunk for `POST …/replays`. A
// chunk collects a window of the session's rrweb events. snake_case wire
// contract like the other builders. The rrweb events are OPAQUE here: the PII
// masking is already applied upstream (rrweb options + `beforeSend`), this builder
// does not inspect them. The `environment` is added by the client, as for pageviews.

import type { EventPayload } from './types'

/// Inputs for a replay chunk.
export interface ReplayChunkInput {
  /// Opaque session id (see `session.ts`), shared with the correlated errors.
  replaySessionId: string
  /// Progressive index of the chunk in the session (orders the reconstruction).
  seq: number
  /// Session start epoch ms (t0 relative to the rrweb events).
  startedAt: number
  /// Raw rrweb events of the window.
  events: unknown[]
  /// Current pathname at flush (for the behavior gallery: visited pages).
  /// Omitted if not in the browser. No query string.
  path?: string | undefined
  /// User id (from `setUser`), if set: the backend hashes it (never in clear).
  user?: string | undefined
}

/// Payload of a replay chunk for `POST …/replays`. `path`/`user` optional:
/// the backend is backward compatible with chunks that do not carry them.
export function buildReplayChunk(input: ReplayChunkInput): EventPayload {
  return {
    replay_session_id: input.replaySessionId,
    seq: input.seq,
    started_at: new Date(input.startedAt).toISOString(),
    events: input.events,
    ...(input.path ? { path: input.path } : {}),
    ...(input.user ? { user: input.user } : {}),
  }
}
