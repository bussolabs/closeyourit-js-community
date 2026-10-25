import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import { installReplay } from '../src/integrations/browser/replay'
import type {
  ReplayDeps,
  ReplayRecordOptions,
} from '../src/integrations/browser/replay'
import type { StorageLike } from '../src/session'
import type { EventPayload } from '../src/types'

// Storage with a known session → deterministic id in the assertions.
function seededStorage(id = 'sess-x', startedAt = 1000): StorageLike {
  const value = JSON.stringify({ id, startedAt })
  return { getItem: () => value, setItem: () => {} }
}

interface FakeClient {
  options: {
    replayMaskAllInputs: boolean
    replayBlockSelector: string | undefined
    replayMaskTextSelector: string | undefined
    replayFlushIntervalMs: number
  }
  setReplaySessionId: ReturnType<typeof vi.fn>
  captureReplayChunk: ReturnType<typeof vi.fn>
  scope: { userId: string | undefined }
  chunks: EventPayload[]
}

function fakeClient(
  overrides: Partial<FakeClient['options']> = {},
  userId?: string,
): FakeClient {
  const chunks: EventPayload[] = []
  return {
    options: {
      replayMaskAllInputs: true,
      replayBlockSelector: undefined,
      replayMaskTextSelector: undefined,
      replayFlushIntervalMs: 5000,
      ...overrides,
    },
    setReplaySessionId: vi.fn(),
    captureReplayChunk: vi.fn((c: EventPayload) => chunks.push(c)),
    scope: { userId },
    chunks,
  }
}

// Fake recorder: exposes the `emit` callback and the received options; `stop` is spied.
function fakeRecorder(): {
  deps: Pick<ReplayDeps, 'record'>
  emit: (event: unknown) => void
  stop: ReturnType<typeof vi.fn>
  received: () => ReplayRecordOptions | undefined
} {
  let captured: ReplayRecordOptions | undefined
  const stop = vi.fn()
  return {
    deps: {
      record: (opts) => {
        captured = opts
        return stop
      },
    },
    emit: (event) => captured?.emit(event),
    stop,
    received: () => captured,
  }
}

let uninstall: () => void = () => {}

afterEach(() => {
  uninstall()
  uninstall = () => {}
  vi.useRealTimers()
  delete (globalThis as { rrweb?: unknown }).rrweb
})

describe('installReplay — startup', () => {
  it('registers the session id on the client and writes the correlation', () => {
    const client = fakeClient()
    const writeCorrelation = vi.fn()
    const rec = fakeRecorder()

    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage('sess-x'),
      writeCorrelation,
    })

    expect(client.setReplaySessionId).toHaveBeenCalledWith('sess-x')
    expect(writeCorrelation).toHaveBeenCalledWith('sess-x')
  })

  it('passes the mask options to the recorder', () => {
    const client = fakeClient({
      replayMaskAllInputs: false,
      replayBlockSelector: '.cyi-block',
      replayMaskTextSelector: '.secret',
    })
    const rec = fakeRecorder()

    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    expect(rec.received()).toMatchObject({
      maskAllInputs: false,
      blockSelector: '.cyi-block',
      maskTextSelector: '.secret',
    })
  })
})

describe('installReplay — chunk flush', () => {
  beforeEach(() => vi.useFakeTimers())

  it('sends a chunk on the periodic flush with an incremental seq', () => {
    const client = fakeClient({ replayFlushIntervalMs: 1000 })
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage('sess-x', 0),
      writeCorrelation: () => {},
    })

    rec.emit({ type: 2 })
    rec.emit({ type: 3 })
    vi.advanceTimersByTime(1000)

    rec.emit({ type: 4 })
    vi.advanceTimersByTime(1000)

    expect(client.chunks).toHaveLength(2)
    expect(client.chunks[0]).toMatchObject({
      replay_session_id: 'sess-x',
      seq: 0,
      started_at: '1970-01-01T00:00:00.000Z',
      events: [{ type: 2 }, { type: 3 }],
    })
    expect(client.chunks[1]).toMatchObject({ seq: 1, events: [{ type: 4 }] })
  })

  it('does NOT send anything when the buffer is empty', () => {
    const client = fakeClient({ replayFlushIntervalMs: 1000 })
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    vi.advanceTimersByTime(5000)
    expect(client.captureReplayChunk).not.toHaveBeenCalled()
  })

  it('includes path (current pathname) and user in the chunk', () => {
    history.replaceState({}, '', '/checkout')
    const client = fakeClient({ replayFlushIntervalMs: 1000 }, 'acc-9')
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    rec.emit({ type: 2 })
    vi.advanceTimersByTime(1000)
    expect(client.chunks[0]).toMatchObject({ path: '/checkout', user: 'acc-9' })
  })

  it('forces the flush beyond the buffer threshold (200 events) without waiting', () => {
    const client = fakeClient({ replayFlushIntervalMs: 100000 })
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    for (let i = 0; i < 200; i++) rec.emit({ i })

    expect(client.chunks).toHaveLength(1)
    expect((client.chunks[0]!['events'] as unknown[]).length).toBe(200)
  })
})

describe('installReplay — lifecycle', () => {
  it('flush on pagehide', () => {
    const client = fakeClient()
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    rec.emit({ type: 2 })
    window.dispatchEvent(new Event('pagehide'))

    expect(client.chunks).toHaveLength(1)
  })

  it('flush on visibilitychange(hidden), not on visible', () => {
    const client = fakeClient()
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    rec.emit({ type: 2 })
    document.dispatchEvent(new Event('visibilitychange')) // visibilityState = 'visible'
    expect(client.captureReplayChunk).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(client.chunks).toHaveLength(1)

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
  })
})

describe('installReplay — uninstall', () => {
  it('stops the recorder, drains the leftover buffer and detaches the listeners', () => {
    vi.useFakeTimers()
    const client = fakeClient({ replayFlushIntervalMs: 1000 })
    const rec = fakeRecorder()
    const off = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    rec.emit({ type: 2 })
    off() // stop + leftover flush

    expect(rec.stop).toHaveBeenCalledTimes(1)
    expect(client.chunks).toHaveLength(1) // the leftover was sent

    // After uninstall: no further flush from the timer or from pagehide.
    vi.advanceTimersByTime(5000)
    window.dispatchEvent(new Event('pagehide'))
    expect(client.chunks).toHaveLength(1)
    uninstall = () => {}
  })
})

describe('installReplay — default recorder (window.rrweb)', () => {
  it('uses window.rrweb.record when present', () => {
    const client = fakeClient()
    const stop = vi.fn()
    const record = vi.fn(() => stop)
    ;(globalThis as { rrweb?: unknown }).rrweb = { record }

    uninstall = installReplay(client as unknown as Client, {
      storage: seededStorage(),
      writeCorrelation: () => {},
    })

    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]![0]).toMatchObject({ maskAllInputs: true })
    uninstall()
    expect(stop).toHaveBeenCalledTimes(1)
    uninstall = () => {}
  })

  it('is a safe no-op when window.rrweb is missing', () => {
    const client = fakeClient()
    expect(() => {
      uninstall = installReplay(client as unknown as Client, {
        storage: seededStorage(),
        writeCorrelation: () => {},
      })
    }).not.toThrow()
  })

  it('handles a record that does not return a stop function', () => {
    const client = fakeClient()
    ;(globalThis as { rrweb?: unknown }).rrweb = { record: () => undefined }
    expect(() => {
      const off = installReplay(client as unknown as Client, {
        storage: seededStorage(),
        writeCorrelation: () => {},
      })
      off()
    }).not.toThrow()
    uninstall = () => {}
  })
})

describe('installReplay — default correlation cookie', () => {
  it('writes the cyi_replay cookie when writeCorrelation is not injected', () => {
    const client = fakeClient()
    const rec = fakeRecorder()
    uninstall = installReplay(client as unknown as Client, {
      ...rec.deps,
      storage: seededStorage('cookie-sess'),
    })

    expect(document.cookie).toContain('cyi_replay=cookie-sess')
    expect(document.cookie).not.toContain('Secure')
  })

  it('marks the cookie Secure on https pages', () => {
    const written: string[] = []
    const setter = vi.spyOn(document, 'cookie', 'set').mockImplementation((value) => {
      written.push(value)
    })
    vi.stubGlobal('location', { ...location, protocol: 'https:' })
    try {
      const client = fakeClient()
      const rec = fakeRecorder()
      uninstall = installReplay(client as unknown as Client, {
        ...rec.deps,
        storage: seededStorage('secure-sess'),
      })
    } finally {
      vi.unstubAllGlobals()
      setter.mockRestore()
    }

    expect(written).toContainEqual(
      'cyi_replay=secure-sess; path=/; SameSite=Lax; Secure',
    )
  })
})
