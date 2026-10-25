import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogBuffer, chunkBatches } from '../src/logBuffer'
import type { EventPayload } from '../src/types'

const event = (i: number): EventPayload => ({ message: `m${i}` })

describe('LogBuffer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes when batchSize is reached', () => {
    const batches: EventPayload[][] = []
    const buffer = new LogBuffer((b) => batches.push(b), 2, 5000)
    buffer.add(event(1))
    expect(batches).toHaveLength(0)
    buffer.add(event(2))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(buffer.length).toBe(0)
  })

  it('flushes when the interval expires', () => {
    const batches: EventPayload[][] = []
    const buffer = new LogBuffer((b) => batches.push(b), 100, 5000)
    buffer.add(event(1))
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(5000)
    expect(batches).toHaveLength(1)
  })

  it('manual flush is a no-op when empty', () => {
    const batches: EventPayload[][] = []
    const buffer = new LogBuffer((b) => batches.push(b), 100, 5000)
    buffer.flush()
    expect(batches).toHaveLength(0)
  })

  it('dispose drains and disables add', () => {
    const batches: EventPayload[][] = []
    const buffer = new LogBuffer((b) => batches.push(b), 100, 5000)
    buffer.add(event(1))
    buffer.dispose()
    expect(batches).toHaveLength(1)
    buffer.add(event(2))
    expect(buffer.length).toBe(0)
  })
})

describe('chunkBatches', () => {
  it('splits into chunks of size', () => {
    expect(chunkBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('a single chunk when below the threshold', () => {
    expect(chunkBatches([1, 2], 1000)).toEqual([[1, 2]])
  })

  it('size <= 0 returns a single chunk', () => {
    expect(chunkBatches([1, 2], 0)).toEqual([[1, 2]])
  })
})
