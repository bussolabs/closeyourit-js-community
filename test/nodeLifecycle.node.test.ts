// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import { installNodeLifecycle } from '../src/integrations/node/lifecycle'

type Listener = (...args: unknown[]) => unknown

class FakeProc {
  readonly handlers = new Map<string, Listener[]>()
  readonly killed: string[] = []
  pid = 4242

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

  kill(_pid: number, signal: string): boolean {
    this.killed.push(signal)
    return true
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners(event)) {
      await listener(...args)
    }
  }
}

function fakeClient(): { flush: ReturnType<typeof vi.fn> } {
  return { flush: vi.fn(async () => {}) }
}

describe('installNodeLifecycle', () => {
  it('beforeExit flushes the buffers', async () => {
    const proc = new FakeProc()
    const client = fakeClient()
    installNodeLifecycle(client as unknown as Client, proc)

    await proc.emit('beforeExit')

    expect(client.flush).toHaveBeenCalled()
    expect(proc.killed).toHaveLength(0)
  })

  it('SIGTERM flushes and re-sends the signal if we are the only listeners', async () => {
    const proc = new FakeProc()
    const client = fakeClient()
    installNodeLifecycle(client as unknown as Client, proc)

    await proc.emit('SIGTERM')

    expect(client.flush).toHaveBeenCalled()
    // The listener removed itself before the re-kill: no loop.
    expect(proc.listeners('SIGTERM')).toHaveLength(0)
    expect(proc.killed).toEqual(['SIGTERM'])
  })

  it('SIGTERM with a user handler: flushes but does NOT re-send the signal', async () => {
    const proc = new FakeProc()
    proc.on('SIGTERM', () => {})
    const client = fakeClient()
    installNodeLifecycle(client as unknown as Client, proc)

    await proc.emit('SIGTERM')

    expect(client.flush).toHaveBeenCalled()
    expect(proc.killed).toHaveLength(0)
  })

  it('uninstall removes the listeners', () => {
    const proc = new FakeProc()
    const client = fakeClient()
    const off = installNodeLifecycle(client as unknown as Client, proc)

    expect(proc.listeners('beforeExit')).toHaveLength(1)
    expect(proc.listeners('SIGTERM')).toHaveLength(1)
    off()
    expect(proc.listeners('beforeExit')).toHaveLength(0)
    expect(proc.listeners('SIGTERM')).toHaveLength(0)
  })
})
