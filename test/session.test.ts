import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REPLAY_STORAGE_KEY,
  ensureReplaySession,
  resetReplaySessionMemory,
} from '../src/session'
import type { StorageLike } from '../src/session'

// In-memory storage with hooks to simulate errors (quota/access denied).
function fakeStorage(
  seed: Record<string, string> = {},
  opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem(key) {
      if (opts.throwOnGet) throw new Error('denied')
      return data.get(key) ?? null
    },
    setItem(key, value) {
      if (opts.throwOnSet) throw new Error('quota')
      data.set(key, value)
    },
  }
}

afterEach(() => {
  resetReplaySessionMemory()
})

describe('ensureReplaySession — with storage', () => {
  it('creates and persists a new session when the storage is empty', () => {
    const storage = fakeStorage()
    const session = ensureReplaySession(storage, () => 1000)

    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
    expect(session.startedAt).toBe(1000)
    expect(JSON.parse(storage.data.get(REPLAY_STORAGE_KEY)!)).toEqual(session)
  })

  it('reuses the existing session (idempotent)', () => {
    const storage = fakeStorage({
      [REPLAY_STORAGE_KEY]: JSON.stringify({ id: 'abc', startedAt: 42 }),
    })
    const session = ensureReplaySession(storage, () => 9999)

    expect(session).toEqual({ id: 'abc', startedAt: 42 })
  })

  it('regenerates if the value in storage is corrupted', () => {
    const storage = fakeStorage({ [REPLAY_STORAGE_KEY]: '{not json' })
    const session = ensureReplaySession(storage, () => 5)

    expect(session.startedAt).toBe(5)
    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('regenerates if the JSON lacks the expected fields', () => {
    const storage = fakeStorage({
      [REPLAY_STORAGE_KEY]: JSON.stringify({ id: 123 }),
    })
    const session = ensureReplaySession(storage, () => 7)

    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
    expect(session.startedAt).toBe(7)
  })

  it('creates a session even if getItem throws (access denied)', () => {
    const storage = fakeStorage({}, { throwOnGet: true })
    const session = ensureReplaySession(storage, () => 3)

    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
    expect(session.startedAt).toBe(3)
  })

  it('does not throw if setItem exceeds the quota (session valid for the page)', () => {
    const storage = fakeStorage({}, { throwOnSet: true })
    const session = ensureReplaySession(storage, () => 8)

    expect(session.id).toMatch(/^[0-9a-f]{32}$/)
    expect(session.startedAt).toBe(8)
  })
})

describe('ensureReplaySession — fallback in-memory (storage null)', () => {
  it('creates a session and keeps it stable across calls', () => {
    const first = ensureReplaySession(null, () => 100)
    const second = ensureReplaySession(null, () => 200)

    expect(second).toEqual(first)
    expect(first.startedAt).toBe(100)
  })
})

describe('ensureReplaySession — default storage (jsdom sessionStorage)', () => {
  beforeEach(() => sessionStorage.clear())

  it('persists in sessionStorage when storage is undefined', () => {
    const session = ensureReplaySession(undefined, () => 55)

    expect(sessionStorage.getItem(REPLAY_STORAGE_KEY)).not.toBeNull()
    const again = ensureReplaySession(undefined, () => 66)
    expect(again).toEqual(session)
  })
})
