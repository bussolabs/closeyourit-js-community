// Security regression (CYJS-1): in the browser the secret `cyi_` bearer must
// NEVER end up in a request. The browser-safe credential is the DSN public
// key (`?sentry_key=`), on the Sentry drop-in path for events. These tests
// run in jsdom (isBrowser() === true).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as CloseYourIt from '../src/index'

const SECRET = 'cyi_supersecret123'
const PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' // 32 hex, DSN style

let fetchMock: ReturnType<typeof vi.fn>

function authHeaderOf(callIndex: number): string | undefined {
  const init = fetchMock.mock.calls[callIndex]![1] as RequestInit
  const headers = (init.headers ?? {}) as Record<string, string>
  return headers['Authorization']
}

function urlOf(callIndex: number): string {
  return fetchMock.mock.calls[callIndex]![0] as string
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ status: 200 } as Response))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await CloseYourIt.close()
  vi.unstubAllGlobals()
})

describe('browser security — server-only secret bearer (CYJS-1)', () => {
  it('with only the secret cyi_ bearer in the browser the SDK stays a no-op and does not send the secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    CloseYourIt.init({
      endpointUrl: 'https://www.closeyour.it',
      token: SECRET,
      projectId: 'p',
      environment: 'production',
    })

    expect(CloseYourIt.isEnabled()).toBe(false)
    CloseYourIt.captureException(new Error('boom'))
    CloseYourIt.captureMessage('hello')
    expect(fetchMock).not.toHaveBeenCalled()

    // The warning explains why and points to publicKey.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publicKey'))
    warn.mockRestore()
  })

  it('with the DSN public key in the browser it sends events to the /store drop-in with ?sentry_key= and without Authorization', () => {
    CloseYourIt.init({
      endpointUrl: 'https://www.closeyour.it',
      publicKey: PUBLIC_KEY,
      projectId: 'p',
      environment: 'production',
    })

    expect(CloseYourIt.isEnabled()).toBe(true)
    CloseYourIt.captureException(new Error('boom'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urlOf(0)).toBe(
      `https://www.closeyour.it/api/p/store?sentry_key=${PUBLIC_KEY}`,
    )
    expect(authHeaderOf(0)).toBeUndefined()
  })

  it('in the browser the secret bearer is ignored when publicKey is also present (never sent)', () => {
    CloseYourIt.init({
      endpointUrl: 'https://www.closeyour.it',
      token: SECRET, // present but server-only → ignored in the browser
      publicKey: PUBLIC_KEY,
      projectId: 'p',
      environment: 'production',
    })

    CloseYourIt.captureException(new Error('boom'))
    CloseYourIt.log('info', 'x')
    CloseYourIt.capturePageview({ path: '/home' })
    void CloseYourIt.flush()

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      const headers = (init.headers ?? {}) as Record<string, string>
      expect(headers['Authorization']).toBeUndefined()
      // No URL or body may contain the secret.
      expect(String(call[0])).not.toContain(SECRET)
      expect(String(init.body ?? '')).not.toContain(SECRET)
    }
  })

  it('in the browser the non-event channels (logs/metrics/pageviews) use the v1 paths with ?sentry_key=', () => {
    CloseYourIt.init({
      endpointUrl: 'https://www.closeyour.it',
      publicKey: PUBLIC_KEY,
      projectId: 'p',
      environment: 'production',
    })

    CloseYourIt.capturePageview({ path: '/home' })

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/pageviews'))
    expect(call).toBeDefined()
    expect(String(call![0])).toBe(
      `https://www.closeyour.it/api/v1/projects/p/pageviews?sentry_key=${PUBLIC_KEY}`,
    )
    const headers = ((call![1] as RequestInit).headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})
