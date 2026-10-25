// @vitest-environment node
// On Node `init` installs the process handlers (not the window patches).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as CloseYourIt from '../src/index'

const config = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_x',
  projectId: 'p',
  environment: 'production',
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ status: 202 } as Response)),
  )
})

afterEach(async () => {
  await CloseYourIt.close()
  vi.unstubAllGlobals()
})

describe('facade on Node', () => {
  it('init adds the process handlers and close removes them', async () => {
    const beforeUncaught = process.listeners('uncaughtException').length
    const beforeSigterm = process.listeners('SIGTERM').length

    CloseYourIt.init(config)
    expect(CloseYourIt.isEnabled()).toBe(true)
    expect(process.listeners('uncaughtException').length).toBe(beforeUncaught + 1)
    expect(process.listeners('SIGTERM').length).toBe(beforeSigterm + 1)

    await CloseYourIt.close()
    expect(process.listeners('uncaughtException').length).toBe(beforeUncaught)
    expect(process.listeners('SIGTERM').length).toBe(beforeSigterm)
  })

  it('captureException works without window', () => {
    CloseYourIt.init(config)
    CloseYourIt.captureException(new Error('server boom'))
    expect(CloseYourIt.getStats().enqueued).toBe(1)
  })

  it('the event runtime is node', () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    CloseYourIt.init(config)
    CloseYourIt.captureMessage('x')
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { contexts: { runtime: { name: string } } }
    expect(body.contexts.runtime.name).toBe('node')
  })

  it('runWithScope isolates the context per flow and restores it (facade, CYJS-7)', () => {
    CloseYourIt.init(config)
    const rootTrace = CloseYourIt.getTraceId()

    CloseYourIt.runWithScope(() => {
      CloseYourIt.setUser({ id: 'req' })
      // new correlation unit inside the request flow
      expect(CloseYourIt.getTraceId()).not.toBe(rootTrace)
    })

    // outside the block it goes back to the base correlation
    expect(CloseYourIt.getTraceId()).toBe(rootTrace)
  })

  it('runWithScope is a safe no-op before init (still runs fn)', async () => {
    await CloseYourIt.close()
    expect(CloseYourIt.runWithScope(() => 'ok')).toBe('ok')
  })

  it('re-init with different options does not duplicate the process handlers (CYJS-8)', async () => {
    const before = process.listeners('uncaughtException').length

    CloseYourIt.init({ ...config, release: 'v1' })
    expect(process.listeners('uncaughtException').length).toBe(before + 1)

    // New configuration: teardown of the old one + reinstall, no accumulation.
    CloseYourIt.init({ ...config, release: 'v2' })
    expect(process.listeners('uncaughtException').length).toBe(before + 1)

    await CloseYourIt.close()
    expect(process.listeners('uncaughtException').length).toBe(before)
  })

  it('re-init applies the new release to events (CYJS-8)', () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    CloseYourIt.init({ ...config, release: 'v1' })
    CloseYourIt.init({ ...config, release: 'v2' })
    CloseYourIt.captureMessage('x')

    const call = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/events'))
    const body = JSON.parse((call![1] as RequestInit).body as string) as {
      release: string
    }
    expect(body.release).toBe('v2')
  })

  it('re-init with the same configuration is idempotent (same client, handlers unchanged)', () => {
    const before = process.listeners('uncaughtException').length
    const first = CloseYourIt.init(config)
    const second = CloseYourIt.init({ ...config })
    expect(second).toBe(first)
    expect(process.listeners('uncaughtException').length).toBe(before + 1)
  })
})
