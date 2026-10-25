// Process-local diagnostic notifier. Forwards every stage of an event's lifecycle
// (enqueue/send/drop/timeout/shutdown) to the `onDiagnostic` hook, if
// configured. Mirror of `CloseYourIt.notify_diagnostic` (Ruby gem, CYRB-12).
//
// Non-recursive by construction: while a hook is running the suppression is
// active — the Client gates the capture APIs on it (no telemetry from the
// diagnostics) and a further `notify` is ignored (no loop). An error raised by
// the hook is absorbed: the diagnostics must never crash the host nor interrupt
// the send in progress.
//
// The suppression is PROCESS-global (like the Ruby gem's thread-local), not
// per-client: during a live `init` (CYJS-8) the old client may be closing while
// the new one is already in use, and the old one's hook could capture via the
// facade onto the new client. A global flag guarantees that «while any hook is
// running, no capture goes through» holds for the whole process.

import type { DiagnosticDetails, DiagnosticEvent, OnDiagnostic } from './types'

// True while a diagnostic hook is running, anywhere in the process. JS is
// single-thread and `notify` is synchronous: only one hook runs at a time → a
// boolean is enough, always reset to `false` in the `finally`.
let active = false

/// `true` if ANY diagnostic hook is running in the process. The capture APIs
/// gate on it so as not to generate telemetry from the diagnostics,
/// even through the facade after a re-init (CYJS-9).
export function diagnosticsSuppressed(): boolean {
  return active
}

/// Only the NAME of the error class, never the message: the latter could
/// contain URLs or sensitive data and the diagnostics must never expose
/// payloads/secrets. Fallback `'Error'` for non-Error values.
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

export class Diagnostics {
  private readonly hook: OnDiagnostic | undefined

  constructor(hook?: OnDiagnostic) {
    this.hook = hook
  }

  /// `true` while a diagnostic hook is running (global suppression).
  get suppressed(): boolean {
    return active
  }

  /// Notifies [event] to the hook with [details]. No-op without a hook or during a
  /// notify already in progress (of this or another instance). An exception
  /// from the hook is absorbed.
  notify(event: DiagnosticEvent, details: DiagnosticDetails = {}): void {
    if (!this.hook || active) return
    active = true
    try {
      this.hook(event, details)
    } catch {
      // Faulty hook: the diagnostics must never propagate nor interrupt.
    } finally {
      active = false
    }
  }
}
