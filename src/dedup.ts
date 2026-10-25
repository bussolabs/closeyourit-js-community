// Two-level deduplication:
// 1. object identity (WeakSet): the same `Error` bubbling up through several handlers
//    is sent only once, forever — equivalent to the gem's
//    `@__closeyourit_captured` ivar and to the dart `Expando`;
// 2. time window on a key (type + message + crash frame): identical bursts
//    within [windowMs] are dropped (e.g. an onerror in a loop) —
//    covers the cases without an object (window.onerror strings).

export class Deduplicator {
  private readonly seen = new Map<string, number>()
  private readonly captured = new WeakSet<object>()

  constructor(
    private readonly windowMs: number = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /// `true` if [error] (object) has already been captured. Primitives cannot be
  /// tracked by identity → always `false` (the window takes care of them).
  wasCaptured(error: unknown): boolean {
    return isObject(error) && this.captured.has(error)
  }

  /// Marks [error] as captured (no-op on primitives).
  markCaptured(error: unknown): void {
    if (isObject(error)) this.captured.add(error)
  }

  /// `true` if [key] has already been seen within the window; otherwise records it.
  isDuplicate(key: string): boolean {
    const current = this.now()
    this.prune(current)
    const previous = this.seen.get(key)
    if (previous !== undefined && current - previous < this.windowMs) {
      return true
    }
    this.seen.set(key, current)
    return false
  }

  private prune(current: number): void {
    for (const [key, ts] of this.seen) {
      if (current - ts >= this.windowMs) this.seen.delete(key)
    }
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/// Dedup key from type, message and first frame (top of stack = crash).
export function dedupKey(
  type: string,
  message: string,
  topFrame: string | undefined,
): string {
  return `${type}|${message}|${topFrame ?? ''}`
}
