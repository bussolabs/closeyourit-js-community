import { describe, expect, it } from 'vitest'
import { Stats, emptyStatsSnapshot } from '../src/stats'

describe('Stats', () => {
  it('starts from zero on all counters and reasons', () => {
    expect(new Stats().toObject()).toEqual({
      enqueued: 0,
      sent: 0,
      dropped: 0,
      failed: 0,
      timeout: 0,
      reasons: {
        sample_rate: 0,
        before_send: 0,
        error: 0,
        queue_full: 0,
        response: 0,
        network: 0,
      },
    })
  })

  it('emptyStatsSnapshot equals the snapshot of a new Stats', () => {
    expect(emptyStatsSnapshot()).toEqual(new Stats().toObject())
  })

  it('increments and reads the aggregate counters', () => {
    const stats = new Stats()
    stats.increment('sent')
    stats.increment('sent')
    stats.increment('enqueued')
    expect(stats.get('sent')).toBe(2)
    expect(stats.get('enqueued')).toBe(1)
  })

  it('recording a client-side drop increments dropped and the reason', () => {
    const stats = new Stats()
    stats.record('queue_full')
    stats.record('before_send')
    stats.record('sample_rate')
    expect(stats.get('dropped')).toBe(3)
    expect(stats.get('failed')).toBe(0)
    const snap = stats.toObject()
    expect(snap.reasons.queue_full).toBe(1)
    expect(snap.reasons.before_send).toBe(1)
    expect(snap.reasons.sample_rate).toBe(1)
  })

  it('recording a send failure increments failed and the reason', () => {
    const stats = new Stats()
    stats.record('response')
    stats.record('network')
    expect(stats.get('failed')).toBe(2)
    expect(stats.get('dropped')).toBe(0)
    const snap = stats.toObject()
    expect(snap.reasons.response).toBe(1)
    expect(snap.reasons.network).toBe(1)
  })

  it('recordTimeout counts failed and timeout (sub-count, gem parity)', () => {
    const stats = new Stats()
    stats.recordTimeout()
    expect(stats.get('failed')).toBe(1)
    expect(stats.get('timeout')).toBe(1)
  })

  it('reset clears counters and reasons', () => {
    const stats = new Stats()
    stats.increment('enqueued')
    stats.record('queue_full')
    stats.recordTimeout()
    stats.reset()
    expect(stats.toObject()).toEqual(emptyStatsSnapshot())
  })

  it('toObject returns a copy (no aliasing of counters and reasons)', () => {
    const stats = new Stats()
    const snap = stats.toObject()
    stats.increment('sent')
    stats.record('queue_full')
    expect(snap.sent).toBe(0)
    expect(snap.reasons.queue_full).toBe(0)
  })
})
