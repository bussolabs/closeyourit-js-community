// End-of-life flush on Node: `beforeExit` (natural exit of the event loop)
// and `SIGTERM` (orchestrated stop, e.g. deploy/container). On SIGTERM, if
// ours are the only listeners, the listener removes itself and re-sends the
// signal to the process — preserving the default termination without a loop. With
// user handlers present, the termination is up to them.

import type { Client } from '../../client'

/// Subset of `process` used by the lifecycle (injectable in tests).
export interface LifecycleProcessLike {
  pid: number
  on(event: string, listener: (...args: never[]) => unknown): unknown
  removeListener(event: string, listener: (...args: never[]) => unknown): unknown
  listeners(event: string): unknown[]
  kill(pid: number, signal: string): unknown
}

/// Installs the lifecycle flushes. Returns the uninstall function.
export function installNodeLifecycle(
  client: Client,
  proc: LifecycleProcessLike = process as unknown as LifecycleProcessLike,
): () => void {
  const onBeforeExit = (): void => {
    void client.flush()
  }

  const onSigterm = async (): Promise<void> => {
    await client.flush()
    const others = proc.listeners('SIGTERM').filter((l) => l !== onSigterm)
    if (others.length === 0) {
      proc.removeListener('SIGTERM', onSigterm as never)
      proc.kill(proc.pid, 'SIGTERM')
    }
  }

  proc.on('beforeExit', onBeforeExit as never)
  proc.on('SIGTERM', onSigterm as never)

  return () => {
    proc.removeListener('beforeExit', onBeforeExit as never)
    proc.removeListener('SIGTERM', onSigterm as never)
  }
}
