import { describe, expect, it } from 'vitest'
import { spanId, uuidV4, uuidV4NoDashes } from '../src/uuid'

describe('uuidV4', () => {
  it('produces a valid UUID v4', () => {
    const uuid = uuidV4()
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('generates distinct values', () => {
    const set = new Set(Array.from({ length: 100 }, () => uuidV4()))
    expect(set.size).toBe(100)
  })
})

describe('uuidV4NoDashes', () => {
  it('is 32 hexadecimal characters without dashes', () => {
    const id = uuidV4NoDashes()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(id).not.toContain('-')
  })
})

describe('spanId', () => {
  it('is 16 hexadecimal characters (W3C span-id)', () => {
    expect(spanId()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is never all-zero (valid parent-id)', () => {
    for (let i = 0; i < 100; i++) {
      expect(spanId()).not.toBe('0000000000000000')
    }
  })

  it('generates distinct values', () => {
    const set = new Set(Array.from({ length: 100 }, () => spanId()))
    expect(set.size).toBe(100)
  })
})
