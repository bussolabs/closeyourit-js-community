// Batch buffer for logs. Mirror of `CloseYourIt::LogBuffer` (gem) and `LogBuffer`
// (dart). Accumulates the logs and drains them when: it reaches [batchSize],
// [flushIntervalMs] expires (timer), or on [flushNow]/[dispose].

import type { EventPayload } from './types'

/// Maximum number of logs per single HTTP request to `/logs` (the backend rejects
/// larger batches with 413). Batches over the threshold are split.
export const LOGS_MAX_BATCH = 1000

/// Splits [items] into blocks of at most [size] elements (order preserved).
export function chunkBatches<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}

export class LogBuffer {
  private events: EventPayload[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly onFlush: (batch: EventPayload[]) => void,
    private readonly batchSize: number = 50,
    private readonly flushIntervalMs: number = 5000,
  ) {}

  get length(): number {
    return this.events.length
  }

  add(event: EventPayload): void {
    if (this.disposed) return
    this.events.push(event)
    this.ensureTimer()
    if (this.events.length >= this.batchSize) this.flush()
  }

  /// Drains the buffer handing the batch to [onFlush] (no-op if empty).
  flush(): void {
    if (this.events.length === 0) return
    const batch = this.events
    this.events = []
    this.onFlush(batch)
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.flushIntervalMs <= 0) return
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    // In Node the timer must not keep the process alive (no-op in the browser).
    const t = this.timer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  /// Stops the timer and drains one last time. Afterwards, [add] is a no-op.
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.flush()
  }
}
