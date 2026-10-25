// Usage telemetry registry (CYJS-31): accumulates the symbols seen at
// runtime and delivers them in windows. Mirror of `CloseYourIt::UsageRegistry`
// (gem, CYSK-29).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UsageRegistry,
  chunkUsageSymbols,
  isUsageSymbol,
  type UsageWindow,
} from '../src/usage'

function collector(): { windows: UsageWindow[]; onFlush: (w: UsageWindow) => void } {
  const windows: UsageWindow[] = []
  return { windows, onFlush: (w) => windows.push(w) }
}

describe('UsageRegistry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accumulates the count and updates last_seen_at per symbol', () => {
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('route', 'users#index')
    vi.setSystemTime(new Date('2026-09-01T10:00:30.000Z'))
    registry.record('route', 'users#index')
    registry.flush()

    expect(windows).toHaveLength(1)
    expect(windows[0]!.symbols).toEqual([
      {
        kind: 'route',
        symbol: 'users#index',
        count: 2,
        last_seen_at: '2026-09-01T10:00:30.000Z',
      },
    ])
  })

  it('keeps equal symbols of different kinds distinct', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('job', 'Cleanup')
    registry.record('custom', 'Cleanup')
    registry.flush()

    expect(windows[0]!.symbols.map((s) => s.kind).sort()).toEqual(['custom', 'job'])
  })

  it('drops the kinds outside the contract', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('controller' as never, 'users#index')
    registry.flush()

    expect(windows).toHaveLength(0)
  })

  it('drops the malformed symbols without dropping the others', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('custom', 'checkout done') // space: not allowed
    registry.record('custom', '') // empty
    registry.record('custom', 'a'.repeat(201)) // over 200 characters
    registry.record('custom', '/users?id=42') // query string (user data)
    registry.record('custom', 'checkout.completed')
    registry.flush()

    expect(windows[0]!.symbols.map((s) => s.symbol)).toEqual(['checkout.completed'])
  })

  it('does not record non-string values passed from untyped JavaScript', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('custom', undefined as never)
    registry.record('custom', null as never)
    registry.record('custom', 42 as never)
    registry.flush()

    expect(windows).toHaveLength(0)
  })

  it('the window carries its time bounds and restarts after the flush', () => {
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('custom', 'a')
    vi.setSystemTime(new Date('2026-09-01T10:05:00.000Z'))
    registry.flush()
    registry.record('custom', 'b')
    vi.setSystemTime(new Date('2026-09-01T10:10:00.000Z'))
    registry.flush()

    expect(windows[0]!.window_started_at).toBe('2026-09-01T10:00:00.000Z')
    expect(windows[0]!.window_ended_at).toBe('2026-09-01T10:05:00.000Z')
    expect(windows[1]!.window_started_at).toBe('2026-09-01T10:05:00.000Z')
    expect(windows[1]!.window_ended_at).toBe('2026-09-01T10:10:00.000Z')
  })

  it('the flush empties the registry: the next window does not repeat the symbols', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.record('custom', 'a')
    registry.flush()
    registry.record('custom', 'a')
    registry.flush()

    expect(windows).toHaveLength(2)
    expect(windows[1]!.symbols[0]!.count).toBe(1)
  })

  it('flush is a no-op on an empty registry', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush)

    registry.flush()

    expect(windows).toHaveLength(0)
  })

  it('beyond the cap it marks truncated and adds no new symbols', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush, 2)

    registry.record('custom', 'a')
    registry.record('custom', 'b')
    registry.record('custom', 'c')
    registry.record('custom', 'a') // already present: keeps counting
    registry.flush()

    expect(windows[0]!.truncated).toBe(true)
    expect(windows[0]!.symbols.map((s) => s.symbol).sort()).toEqual(['a', 'b'])
    expect(windows[0]!.symbols.find((s) => s.symbol === 'a')!.count).toBe(2)
  })

  it('truncated restarts from false in the next window', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush, 1)

    registry.record('custom', 'a')
    registry.record('custom', 'b')
    registry.flush()
    registry.record('custom', 'c')
    registry.flush()

    expect(windows[0]!.truncated).toBe(true)
    expect(windows[1]!.truncated).toBe(false)
  })

  it('flushes when the interval expires', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush, 2000, 300_000)

    registry.record('custom', 'a')
    expect(windows).toHaveLength(0)
    vi.advanceTimersByTime(300_000)

    expect(windows).toHaveLength(1)
  })

  it('an onFlush that throws does not propagate and does not kill the timer', () => {
    let calls = 0
    const registry = new UsageRegistry(
      () => {
        calls += 1
        throw new Error('network down')
      },
      2000,
      1000,
    )

    registry.record('custom', 'a')
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    registry.record('custom', 'b')
    vi.advanceTimersByTime(1000)

    expect(calls).toBe(2)
  })

  it('dispose flushes one last time and makes record a no-op', () => {
    const { windows, onFlush } = collector()
    const registry = new UsageRegistry(onFlush, 2000, 300_000)

    registry.record('custom', 'a')
    registry.dispose()
    expect(windows).toHaveLength(1)

    registry.record('custom', 'b')
    vi.advanceTimersByTime(300_000)

    expect(windows).toHaveLength(1)
  })
})

describe('isUsageSymbol', () => {
  it('accepts the contract routes, jobs and custom keys', () => {
    expect(isUsageSymbol('UsersController#index')).toBe(true)
    expect(isUsageSymbol('GET:/users/:id')).toBe(true)
    expect(isUsageSymbol('app/jobs/Cleanup')).toBe(true)
    expect(isUsageSymbol('checkout.completed-v2')).toBe(true)
  })

  it('rejects spaces, empty and over 200 characters', () => {
    expect(isUsageSymbol('with space')).toBe(false)
    expect(isUsageSymbol('')).toBe(false)
    expect(isUsageSymbol('a'.repeat(200))).toBe(true)
    expect(isUsageSymbol('a'.repeat(201))).toBe(false)
  })

  it('rejects non-string values instead of converting them to "undefined"', () => {
    expect(isUsageSymbol(undefined as never)).toBe(false)
    expect(isUsageSymbol(null as never)).toBe(false)
    expect(isUsageSymbol(42 as never)).toBe(false)
  })
})

describe('chunkUsageSymbols', () => {
  const symbol = (i: number) => ({
    kind: 'custom' as const,
    symbol: `k${i}`,
    count: 1,
    last_seen_at: '2026-09-01T10:00:00.000Z',
  })

  it('a single chunk when count and bytes stay under the limits', () => {
    const symbols = [symbol(1), symbol(2)]
    expect(chunkUsageSymbols(symbols, 512 * 1024, 5000)).toEqual([symbols])
  })

  it('splits on the backend count cap', () => {
    const symbols = [symbol(1), symbol(2), symbol(3)]
    expect(chunkUsageSymbols(symbols, 512 * 1024, 2)).toEqual([
      [symbol(1), symbol(2)],
      [symbol(3)],
    ])
  })

  it('splits on the byte budget without losing symbols', () => {
    const symbols = [symbol(1), symbol(2), symbol(3)]
    const chunks = chunkUsageSymbols(symbols, 90, 5000)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(symbols)
  })

  it('a symbol larger than the budget goes alone instead of disappearing', () => {
    const symbols = [symbol(1), symbol(2)]
    expect(chunkUsageSymbols(symbols, 1, 5000)).toEqual([[symbol(1)], [symbol(2)]])
  })
})
