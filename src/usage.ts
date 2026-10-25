// CYJS-31 — usage telemetry: records WHICH symbols actually run (routes, jobs,
// literal custom keys) and delivers them in windows. Mirror of
// `CloseYourIt::UsageRegistry` (gem, CYSK-29): same symbol contract, same window
// semantics, same meaning of `truncated`.
//
// The rules that make the system immune to losses:
// - counts are INDICATIVE, only `last_seen_at` is load-bearing: a lost flush
//   costs one window on a symbol that shows up again right after;
// - the registry EMPTIES on every flush: the cap ([maxSymbols]) limits the
//   distinct symbols seen in ONE window — a quantity tied to traffic, not to the
//   size of the code;
// - beyond the cap the window carries `truncated: true`, and on the scanner side
//   that flag disqualifies the kind;
// - no sampling, ever: sampling a route called 3 times a month manufactures
//   exactly the false "never seen" that the channel exists to avoid;
// - `route` is the handler name (`users#index`, `GET:/users/:id`), NEVER the
//   URL called: the symbol format excludes spaces and query strings, so paths
//   with parameters, users and IPs cannot even be expressed.

import { utf8Bytes } from './budget'

/// The three kinds of the contract: a route, a background job, a literal key
/// declared by the application.
export type UsageKind = 'route' | 'job' | 'custom'

export const USAGE_KINDS: readonly UsageKind[] = ['route', 'job', 'custom']

/// Symbols come from framework payloads or literal strings: the pattern is the
/// contract (identical to `Usage::Symbol::SYMBOL_FORMAT` on the backend side).
/// No spaces, no query strings, no user data.
const SYMBOL_FORMAT = /^[A-Za-z0-9_:#.\/-]{1,200}$/

/// Symbol cap per single request accepted by the backend: beyond it, the whole
/// flush is rejected with 413 (`R413-USAGE-001`). It serves both as a clamp on
/// the configurable cap and as the maximum size of a send chunk.
export const USAGE_MAX_SYMBOLS_PER_FLUSH = 5000

/// Default flush interval (5 minutes), on par with the Ruby gem.
export const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 300_000

/// Default cap of distinct symbols per window (parity with the Ruby gem).
export const DEFAULT_USAGE_MAX_SYMBOLS = 2000

/// Room reserved for the flush envelope (environment, release, sdk, window
/// bounds, `truncated`): the byte budget of the symbol chunks starts from the
/// request budget minus this margin.
export const USAGE_ENVELOPE_BYTES = 2048

/// A symbol seen at runtime, in the shape that travels on the wire.
export interface UsageSymbol {
  kind: UsageKind
  symbol: string
  count: number
  last_seen_at: string
}

/// A closed observation window, ready to be sent.
export interface UsageWindow {
  symbols: UsageSymbol[]
  truncated: boolean
  window_started_at: string
  window_ended_at: string
}

/// `true` if [symbol] honours the contract (1–200 characters, no spaces, no
/// query string). Out-of-contract symbols are silently discarded: one dirty
/// entry must not bring down the whole window.
export function isUsageSymbol(symbol: string): boolean {
  // `RegExp.test` converts the argument to a string: without this guard, from
  // untyped JavaScript `used()` or `used(null)` would record the symbols
  // "undefined" and "null", which the format accepts — garbage in the project's
  // symbol table, and indistinguishable from a real key at that.
  if (typeof symbol !== 'string') return false
  return SYMBOL_FORMAT.test(symbol)
}

interface Entry {
  kind: UsageKind
  symbol: string
  count: number
  lastSeenAt: string
}

export class UsageRegistry {
  private entries = new Map<string, Entry>()
  private truncated = false
  private windowStartedAt = new Date().toISOString()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly onFlush: (window: UsageWindow) => void,
    private readonly maxSymbols: number = DEFAULT_USAGE_MAX_SYMBOLS,
    private readonly flushIntervalMs: number = DEFAULT_USAGE_FLUSH_INTERVAL_MS,
  ) {}

  /// Declares that [symbol] was EXECUTED. On the hot path: one lookup and one
  /// increment. No-op on an out-of-contract kind or symbol, and after [dispose].
  record(kind: UsageKind, symbol: string): void {
    if (this.disposed) return
    if (!USAGE_KINDS.includes(kind)) return
    if (!isUsageSymbol(symbol)) return

    // Separator that the symbol format cannot contain, written as an escape: a
    // literal NUL in the source would make the file be treated as binary.
    const key = `${kind}\u0000${symbol}`
    const entry = this.entries.get(key)
    if (entry) {
      entry.count += 1
      entry.lastSeenAt = new Date().toISOString()
    } else if (this.entries.size >= this.maxSymbols) {
      // Beyond the cap NEW symbols are no longer accepted, but the ones already
      // seen keep counting: the window declares `truncated` and the scanner
      // knows it cannot infer "never seen" from this kind.
      this.truncated = true
    } else {
      this.entries.set(key, {
        kind,
        symbol,
        count: 1,
        lastSeenAt: new Date().toISOString(),
      })
    }
    this.ensureTimer()
  }

  /// Closes the current window and hands it to `onFlush` (no-op if there is
  /// nothing to say). The registry restarts empty, with a new window.
  flush(): void {
    if (this.entries.size === 0 && !this.truncated) return

    const window: UsageWindow = {
      symbols: [...this.entries.values()].map((entry) => ({
        kind: entry.kind,
        symbol: entry.symbol,
        count: entry.count,
        last_seen_at: entry.lastSeenAt,
      })),
      truncated: this.truncated,
      window_started_at: this.windowStartedAt,
      window_ended_at: new Date().toISOString(),
    }
    this.entries = new Map()
    this.truncated = false
    this.windowStartedAt = window.window_ended_at

    try {
      this.onFlush(window)
    } catch {
      // The flush also runs on the timer: an error must not propagate into the
      // app nor stop the following windows. The load-bearing semantics is
      // `last_seen_at`, a lost window falsifies nothing.
    }
  }

  /// Stops the timer and delivers one last window. Afterwards, [record] is a no-op.
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.flush()
    this.disposed = true
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.flushIntervalMs <= 0) return
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    // In Node the timer must not keep the process alive (no-op in the browser).
    const t = this.timer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }
}

/// Splits [symbols] into blocks that stay under [maxBytes] and under [maxCount],
/// without ever losing a symbol: a symbol larger than the budget goes alone (it
/// is at most 200 characters long anyway, so the case is theoretical). Order
/// preserved. Used by the flush: a single 413 would take away the whole window.
export function chunkUsageSymbols(
  symbols: UsageSymbol[],
  maxBytes: number,
  maxCount: number,
): UsageSymbol[][] {
  const chunks: UsageSymbol[][] = []
  let current: UsageSymbol[] = []
  let bytes = 0

  for (const symbol of symbols) {
    const size = utf8Bytes(JSON.stringify(symbol)) + 1 // +1: the separating comma
    const full =
      current.length >= maxCount || (current.length > 0 && bytes + size > maxBytes)
    if (full) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(symbol)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
