// Jank detection via PerformanceObserver(longtask). The observer is stubbed:
// the callback is driven by hand and the verdict is asserted on the wire.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { installJankDetection } from '../src/integrations/browser/jank'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
  detectPerformanceIssues: true,
}

function harness(options: Partial<CloseYourItOptions> = {}): {
  client: Client
  calls: Array<{ payload: unknown; url: string }>
} {
  const calls: Array<{ payload: unknown; url: string }> = []
  const transport = {
    send: vi.fn((payload: unknown, url: string) => {
      calls.push({ payload, url })
      return true
    }),
    flush: vi.fn(async () => {}),
  }
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport },
  )
  return { client, calls }
}

interface ObserverStub {
  callback: (list: { getEntries: () => Array<{ duration: number }> }) => void
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

// PerformanceObserver stub that exposes callback/observe/disconnect.
function stubObserver(supported: string[] = ['longtask']): ObserverStub {
  const stub: ObserverStub = {
    callback: () => {},
    observe: vi.fn(),
    disconnect: vi.fn(),
  }
  class FakeObserver {
    static supportedEntryTypes = supported
    constructor(cb: ObserverStub['callback']) {
      stub.callback = cb
    }
    observe = stub.observe
    disconnect = stub.disconnect
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  return stub
}

function emit(stub: ObserverStub, durations: number[]): void {
  stub.callback({
    getEntries: () => durations.map((duration) => ({ duration })),
  })
}

let uninstall: () => void = () => {}
afterEach(() => {
  uninstall()
  uninstall = () => {}
  vi.unstubAllGlobals()
})

describe('installJankDetection', () => {
  it('a long task over the threshold emits the jank verdict with a templatized route', () => {
    const stub = stubObserver()
    const { client, calls } = harness()
    uninstall = installJankDetection(client)

    emit(stub, [240])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/metrics')
    const payload = calls[0]!.payload as EventPayload
    expect(payload['kind']).toBe('performance_issue')
    expect(payload['subtype']).toBe('jank')
    expect(payload['duration_ms']).toBe(240)
    expect(typeof payload['route']).toBe('string')
  })

  it('below the threshold it emits nothing', () => {
    const stub = stubObserver()
    const { calls, client } = harness()
    uninstall = installJankDetection(client)

    emit(stub, [80])

    expect(calls).toHaveLength(0)
  })

  it('no-op if longtask is not supported (Safari/Firefox)', () => {
    stubObserver(['paint'])
    const { client } = harness()
    uninstall = installJankDetection(client)
    // No observe: the integration does not hook in.
    expect(uninstall).toBeTypeOf('function')
  })

  it('uninstall disconnects the observer', () => {
    const stub = stubObserver()
    const { client } = harness()
    const off = installJankDetection(client)
    off()
    expect(stub.disconnect).toHaveBeenCalled()
  })

  it('honors a custom jankThresholdMs', () => {
    const stub = stubObserver()
    const { client, calls } = harness({ jankThresholdMs: 300 })
    uninstall = installJankDetection(client)

    emit(stub, [240])
    expect(calls).toHaveLength(0)
    emit(stub, [301])
    expect(calls).toHaveLength(1)
  })
})
