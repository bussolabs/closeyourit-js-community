// Usage telemetry in the browser (CYJS-31): the `…/usages` channel accepts ONLY the
// secret bearer, which is never eligible in the browser (CYJS-1). This verifies
// that in the browser the registry stays off — and that whoever turns it on is warned
// instead of seeing the data disappear silently.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import * as CloseYourIt from '../src/index'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'proj-1',
  environment: 'production',
  usageEnabled: true,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ status: 202 } as Response))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await CloseYourIt.close()
  vi.unstubAllGlobals()
})

describe('Client — usage telemetry in the browser', () => {
  it('sends nothing: the usages channel is not reachable with the DSN public key', async () => {
    const calls: string[] = []
    const transport = {
      send: vi.fn((_payload: unknown, url: string) => {
        calls.push(url)
        return true
      }),
      flush: vi.fn(async () => {}),
      setPageHiding: vi.fn(),
    }
    const client = new Client(base, { transport: transport as unknown as Transport })

    client.used('checkout.completed')
    client.recordUsage('route', 'users#index')
    await client.close()

    expect(calls.filter((url) => url.includes('/usages'))).toHaveLength(0)
  })
})

describe('facade — usage telemetry', () => {
  it('used and recordUsage are no-ops before init', () => {
    expect(() => CloseYourIt.used('a')).not.toThrow()
    expect(() => CloseYourIt.recordUsage('route', 'users#index')).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('init warns when usage telemetry is on in the browser', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    CloseYourIt.init(base)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage telemetry'))
    warn.mockRestore()
  })

  it('init does not warn when usage telemetry stays off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    CloseYourIt.init({ ...base, usageEnabled: false })

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
