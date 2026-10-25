// Diagnostic counters of the telemetry operations. Mirror of
// `CloseYourIt::Stats` (gem) and `Stats` (dart). Besides the aggregates
// (`enqueued`/`sent`/`dropped`/`failed`, plus `timeout` as a sub-count of the
// `failed`, Ruby gem parity) it keeps the `reasons` breakdown to make the
// REASON of every drop/failure visible — so `getStats` tells a full queue
// apart from a `beforeSend` drop or a 5xx (CYJS-9).

import type { DropReason, StatsSnapshot } from './types'

export type { StatsSnapshot } from './types'

export type StatKey = 'enqueued' | 'sent' | 'dropped' | 'failed' | 'timeout'

const DROP_REASONS: DropReason[] = [
  'sample_rate',
  'before_send',
  'error',
  'queue_full',
  'response',
  'network',
]

// Reasons that represent an ATTEMPTED but failed send (non-2xx / network): they
// count among the `failed`. The others are client-side drops (never sent) → `dropped`.
const FAILED_REASONS = new Set<DropReason>(['response', 'network'])

/// Snapshot with all counters at zero (used pre-init / after close).
export function emptyStatsSnapshot(): StatsSnapshot {
  return {
    enqueued: 0,
    sent: 0,
    dropped: 0,
    failed: 0,
    timeout: 0,
    reasons: zeroReasons(),
  }
}

function zeroReasons(): Record<DropReason, number> {
  return {
    sample_rate: 0,
    before_send: 0,
    error: 0,
    queue_full: 0,
    response: 0,
    network: 0,
  }
}

export class Stats {
  private counts: Record<StatKey, number> = {
    enqueued: 0,
    sent: 0,
    dropped: 0,
    failed: 0,
    timeout: 0,
  }

  private reasons: Record<DropReason, number> = zeroReasons()

  /// Increments an aggregate counter ([enqueued]/[sent] in normal use).
  increment(key: StatKey): void {
    this.counts[key] += 1
  }

  /// Current value of an aggregate counter.
  get(key: StatKey): number {
    return this.counts[key]
  }

  /// Records a drop/failure with its [reason]: increments `dropped`
  /// (client-side drops) or `failed` (`response`/`network`, send attempted)
  /// and always the reason's counter in `reasons`.
  record(reason: DropReason): void {
    this.reasons[reason] += 1
    if (FAILED_REASONS.has(reason)) this.counts.failed += 1
    else this.counts.dropped += 1
  }

  /// Records a network timeout: `failed` + `timeout` (sub-count of the
  /// failed ones, Ruby gem parity: isolates connectivity problems from non-2xx).
  recordTimeout(): void {
    this.counts.failed += 1
    this.counts.timeout += 1
  }

  /// Snapshot of the counters (deep copy: no aliasing with the internal state).
  toObject(): StatsSnapshot {
    return { ...this.counts, reasons: { ...this.reasons } }
  }

  /// Resets all counters and reasons.
  reset(): void {
    for (const key of Object.keys(this.counts) as StatKey[]) this.counts[key] = 0
    for (const reason of DROP_REASONS) this.reasons[reason] = 0
  }
}
