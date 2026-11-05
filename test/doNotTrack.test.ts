// CYJS-74 · The browser's privacy signals (Do Not Track and Global Privacy
// Control) stop pageviews, custom events and session replay. Errors, logs and
// the other technical signals keep flowing: they keep the site working, they
// do not count people. `respectDoNotTrack: false` restores the old behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { close, getReplaySessionId, init } from '../src/index'
import { resolveOptions } from '../src/options'
import { doNotTrackRequested } from '../src/runtime'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

const PAGEVIEWS_URL = 'https://www.closeyour.it/api/v1/projects/p/pageviews'

// Properties set on navigator/window by a test, removed afterwards so the
// jsdom globals go back to "no signal".
const stubbed: Array<[object, string]> = []

function stubSignal(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true })
  stubbed.push([target, key])
}

afterEach(() => {
  for (const [target, key] of stubbed.splice(0)) {
    delete (target as Record<string, unknown>)[key]
  }
})

function makeClient(options: Partial<CloseYourItOptions> = {}) {
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
    { transport: transport as unknown as Transport, random: () => 0 },
  )
  return { client, transport, calls }
}

describe('doNotTrackRequested', () => {
  it('is false when the browser sends no privacy signal', () => {
    expect(doNotTrackRequested()).toBe(false)
  })

  it('is true with navigator.doNotTrack === "1"', () => {
    stubSignal(navigator, 'doNotTrack', '1')
    expect(doNotTrackRequested()).toBe(true)
  })

  it('is false with navigator.doNotTrack === "0" or "unspecified"', () => {
    stubSignal(navigator, 'doNotTrack', '0')
    expect(doNotTrackRequested()).toBe(false)
    stubSignal(navigator, 'doNotTrack', 'unspecified')
    expect(doNotTrackRequested()).toBe(false)
  })

  it('is true with navigator.globalPrivacyControl === true', () => {
    stubSignal(navigator, 'globalPrivacyControl', true)
    expect(doNotTrackRequested()).toBe(true)
  })

  it('accepts the legacy values of older browsers', () => {
    stubSignal(navigator, 'doNotTrack', 'yes')
    expect(doNotTrackRequested()).toBe(true)
    delete (navigator as unknown as Record<string, unknown>)['doNotTrack']

    stubSignal(window, 'doNotTrack', '1')
    expect(doNotTrackRequested()).toBe(true)
    delete (window as unknown as Record<string, unknown>)['doNotTrack']

    stubSignal(navigator, 'msDoNotTrack', '1')
    expect(doNotTrackRequested()).toBe(true)
  })
})

describe('respectDoNotTrack option', () => {
  it('defaults to true and can be turned off explicitly', () => {
    expect(resolveOptions(base).respectDoNotTrack).toBe(true)
    expect(
      resolveOptions({ ...base, respectDoNotTrack: false }).respectDoNotTrack,
    ).toBe(false)
  })
})

describe('Client — with Do Not Track on', () => {
  beforeEach(() => {
    stubSignal(navigator, 'doNotTrack', '1')
  })

  it('does not send pageviews', () => {
    const { client, transport } = makeClient()
    client.capturePageview()
    client.capturePageview({ path: '/second' })
    client.capturePageview({ path: '/third' })
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('does not send custom events (goals)', () => {
    const { client, transport } = makeClient()
    client.captureEvent('Signup')
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('does not send session replay chunks', () => {
    const { client, transport } = makeClient()
    client.captureReplayChunk({ replay_session_id: 's', seq: 0, events: [] })
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('still sends errors', () => {
    const { client, calls } = makeClient()
    client.captureException(new Error('boom'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://www.closeyour.it/api/p/store')
  })

  it('still sends logs', async () => {
    const { client, calls } = makeClient()
    client.log('info', 'signup completed')
    await client.flush()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.url.endsWith('/logs'))).toBe(true)
  })

  it('sends pageviews and events when respectDoNotTrack is false', () => {
    const { client, calls } = makeClient({ respectDoNotTrack: false })
    client.capturePageview()
    client.captureEvent('Signup')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.url === PAGEVIEWS_URL)).toBe(true)
  })
})

describe('Client — with Global Privacy Control only', () => {
  it('does not send pageviews', () => {
    stubSignal(navigator, 'globalPrivacyControl', true)
    const { client, transport } = makeClient()
    client.capturePageview()
    expect(transport.send).not.toHaveBeenCalled()
  })
})

describe('Client — without privacy signals', () => {
  it('sends pageviews as before', () => {
    const { client, calls } = makeClient()
    client.capturePageview()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(PAGEVIEWS_URL)
  })
})

describe('init — automatic tracking with Do Not Track on', () => {
  beforeEach(() => {
    sessionStorage.clear()
    ;(globalThis as { rrweb?: unknown }).rrweb = { record: () => () => {} }
  })

  afterEach(async () => {
    await close()
    delete (globalThis as { rrweb?: unknown }).rrweb
  })

  it('does not start the session recorder', () => {
    stubSignal(navigator, 'doNotTrack', '1')
    init({ ...base, replay: true })
    expect(getReplaySessionId()).toBeUndefined()
  })

  it('starts the session recorder when respectDoNotTrack is false', () => {
    stubSignal(navigator, 'doNotTrack', '1')
    init({ ...base, replay: true, respectDoNotTrack: false })
    expect(getReplaySessionId()).toMatch(/^[0-9a-f]{32}$/)
  })
})
