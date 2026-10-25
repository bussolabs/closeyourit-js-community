// Global handlers for Node: `uncaughtException` and `unhandledRejection`.
//
// An ACTIVE listener is used (not `uncaughtExceptionMonitor`): the monitor does not
// keep the event loop alive, so the asynchronous telemetry POST would die
// almost always before leaving. Registering a listener however DISABLES
// Node's default crash → it is restored by hand: after capture + flush
// (with timeout), if ours are the only listeners, it prints the error on
// stderr and exits with code 1 (sentry-node pattern). If the user has their own
// handlers, the decision to exit is theirs. Same policy for
// `unhandledRejection` (since Node ≥15 the default is to crash).

import type { Client } from '../../client'

/// Subset of `process` used by the handlers (injectable in tests).
export interface ProcessLike {
  on(event: string, listener: (...args: never[]) => unknown): unknown
  removeListener(event: string, listener: (...args: never[]) => unknown): unknown
  listeners(event: string): unknown[]
  exit(code: number): void
  stderr?: { write(chunk: string): unknown }
}

export interface ProcessHandlersOptions {
  /// Maximum time (ms) granted to the flush before exiting anyway.
  flushTimeoutMs?: number
}

/// Installs the handlers. Returns the uninstall function.
export function installProcessHandlers(
  client: Client,
  proc: ProcessLike = process as unknown as ProcessLike,
  options: ProcessHandlersOptions = {},
): () => void {
  const flushTimeoutMs = options.flushTimeoutMs ?? 2000

  const handle = async (event: string, error: unknown, self: unknown) => {
    client.captureException(error, { handled: false, level: 'fatal' })
    await flushWithTimeout(client, flushTimeoutMs)
    // Only our registered listener? Then we restore the default.
    const others = proc.listeners(event).filter((l) => l !== self)
    if (others.length === 0) {
      proc.stderr?.write(`${describeError(error)}\n`)
      proc.exit(1)
    }
  }

  const onUncaught = (error: unknown): Promise<void> =>
    handle('uncaughtException', error, onUncaught)
  const onRejection = (reason: unknown): Promise<void> =>
    handle('unhandledRejection', reason, onRejection)

  proc.on('uncaughtException', onUncaught as never)
  proc.on('unhandledRejection', onRejection as never)

  return () => {
    proc.removeListener('uncaughtException', onUncaught as never)
    proc.removeListener('unhandledRejection', onRejection as never)
  }
}

async function flushWithTimeout(client: Client, timeoutMs: number): Promise<void> {
  await Promise.race([
    client.flush(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
    }),
  ])
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}
