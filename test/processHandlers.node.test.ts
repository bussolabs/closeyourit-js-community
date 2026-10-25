// @vitest-environment node
// Node process handlers: uncaughtException/unhandledRejection capture,
// flush (with a timeout) and — if ours are the only listeners — preserve
// the default crash semantics by exiting with code 1.

import { describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import { installProcessHandlers } from '../src/integrations/node/processHandlers'

type Listener = (...args: unknown[]) => unknown

class FakeProc {
  readonly handlers = new Map<string, Listener[]>()
  exitCode: number | null = null
  stderrOut = ''
  readonly stderr = {
    write: (s: string): boolean => {
      this.stderrOut += s
      return true
    },
  }

  on(event: string, listener: Listener): this {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    const list = (this.handlers.get(event) ?? []).filter((l) => l !== listener)
    this.handlers.set(event, list)
    return this
  }

  listeners(event: string): Listener[] {
    return [...(this.handlers.get(event) ?? [])]
  }

  exit(code: number): void {
    this.exitCode = code
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners(event)) {
      await listener(...args)
    }
  }
}

function fakeClient(flush: () => Promise<void> = async () => {}): {
  captureException: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
} {
  return {
    captureException: vi.fn(),
    flush: vi.fn(flush),
  }
}

describe('installProcessHandlers — uncaughtException', () => {
  it('captures, flushes and exits with 1 if we are the only listeners', async () => {
    const proc = new FakeProc()
    const client = fakeClient()
    installProcessHandlers(client as unknown as Client, proc)

    const boom = new Error('boom')
    await proc.emit('uncaughtException', boom)

    expect(client.captureException).toHaveBeenCalledWith(boom, {
      handled: false,
      level: 'fatal',
    })
    expect(client.flush).toHaveBeenCalled()
    expect(proc.exitCode).toBe(1)
    expect(proc.stderrOut).toContain('boom')
  })

  it('does NOT exit if the user has their own handler', async () => {
    const proc = new FakeProc()
    proc.on('uncaughtException', () => {})
    const client = fakeClient()
    installProcessHandlers(client as unknown as Client, proc)

    await proc.emit('uncaughtException', new Error('x'))

    expect(client.captureException).toHaveBeenCalled()
    expect(proc.exitCode).toBeNull()
  })

  it('exits anyway if the flush does not resolve within the timeout', async () => {
    vi.useFakeTimers()
    const proc = new FakeProc()
    const client = fakeClient(() => new Promise(() => {})) // never resolved
    installProcessHandlers(client as unknown as Client, proc, {
      flushTimeoutMs: 2000,
    })

    const emitted = proc.emit('uncaughtException', new Error('x'))
    await vi.advanceTimersByTimeAsync(2100)
    await emitted

    expect(proc.exitCode).toBe(1)
    vi.useRealTimers()
  })
})

describe('installProcessHandlers — unhandledRejection', () => {
  it('captures the reason, flushes and exits with 1 if the only listeners', async () => {
    const proc = new FakeProc()
    const client = fakeClient()
    installProcessHandlers(client as unknown as Client, proc)

    await proc.emit('unhandledRejection', 'reason')

    expect(client.captureException).toHaveBeenCalledWith('reason', {
      handled: false,
      level: 'fatal',
    })
    expect(proc.exitCode).toBe(1)
  })

  it('does NOT exit with a user handler present', async () => {
    const proc = new FakeProc()
    proc.on('unhandledRejection', () => {})
    const client = fakeClient()
    installProcessHandlers(client as unknown as Client, proc)

    await proc.emit('unhandledRejection', new Error('x'))

    expect(proc.exitCode).toBeNull()
  })
})

describe('installProcessHandlers — uninstall', () => {
  it('removes the registered listeners', () => {
    const proc = new FakeProc()
    const client = fakeClient()
    const off = installProcessHandlers(client as unknown as Client, proc)

    expect(proc.listeners('uncaughtException')).toHaveLength(1)
    expect(proc.listeners('unhandledRejection')).toHaveLength(1)
    off()
    expect(proc.listeners('uncaughtException')).toHaveLength(0)
    expect(proc.listeners('unhandledRejection')).toHaveLength(0)
  })
})
