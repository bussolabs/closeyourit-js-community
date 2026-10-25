import { describe, expect, it } from 'vitest'
import { Deduplicator, dedupKey } from '../src/dedup'

describe('Deduplicator', () => {
  it('detects a duplicate within the window', () => {
    let now = 1000
    const dedup = new Deduplicator(5000, () => now)
    expect(dedup.isDuplicate('k')).toBe(false)
    now = 2000
    expect(dedup.isDuplicate('k')).toBe(true)
  })

  it('is not a duplicate beyond the window', () => {
    let now = 1000
    const dedup = new Deduplicator(5000, () => now)
    dedup.isDuplicate('k')
    now = 1000 + 5000
    expect(dedup.isDuplicate('k')).toBe(false)
  })

  it('different keys do not collide', () => {
    const dedup = new Deduplicator(5000, () => 0)
    expect(dedup.isDuplicate('a')).toBe(false)
    expect(dedup.isDuplicate('b')).toBe(false)
  })
})

describe('Deduplicator — object identity (WeakSet)', () => {
  it('marks and recognizes the same Error object', () => {
    const dedup = new Deduplicator(0, () => 0)
    const error = new Error('x')
    expect(dedup.wasCaptured(error)).toBe(false)
    dedup.markCaptured(error)
    expect(dedup.wasCaptured(error)).toBe(true)
  })

  it('different instances do not collide; primitives are ignored', () => {
    const dedup = new Deduplicator(0, () => 0)
    dedup.markCaptured(new Error('x'))
    expect(dedup.wasCaptured(new Error('x'))).toBe(false)
    dedup.markCaptured('stringa')
    expect(dedup.wasCaptured('stringa')).toBe(false)
  })
})

describe('dedupKey', () => {
  it('combines type, message and top frame', () => {
    expect(dedupKey('TypeError', 'x is null', 'at fn (a.js:1:1)')).toBe(
      'TypeError|x is null|at fn (a.js:1:1)',
    )
  })

  it('tolerates a missing top frame', () => {
    expect(dedupKey('Error', 'boom', undefined)).toBe('Error|boom|')
  })
})
