// Wiring of advanced web monitoring in the facade (CYJS-12): Web Vitals and
// resource/CSP failures are opt-in and are torn down with close().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metric } from 'web-vitals'
import { onLCP } from 'web-vitals/onLCP.js'
import { close, init } from '../src/index'
import type { CloseYourItOptions } from '../src/types'

// `web-vitals` is mocked as in the integration tests: here we only care that
// the facade connects it (or does not connect it) to the client (CYJS-28).
vi.mock('web-vitals/onCLS.js', () => ({ onCLS: vi.fn() }))
vi.mock('web-vitals/onFCP.js', () => ({ onFCP: vi.fn() }))
vi.mock('web-vitals/onINP.js', () => ({ onINP: vi.fn() }))
vi.mock('web-vitals/onLCP.js', () => ({ onLCP: vi.fn() }))
vi.mock('web-vitals/onTTFB.js', () => ({ onTTFB: vi.fn() }))

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

let sent: string[] = []

// The dispatch the SDK registers with `web-vitals`, stored as soon as it
// appears: registration happens only once per page (CYJS-28), so
// it cannot be fished out of the mock calls after they have been reset.
let dispatch: ((metric: Metric) => void) | undefined

// Delivers an LCP as `web-vitals` would. No-op as long as no installation
// has subscribed: that is the case where the wiring must stay silent.
function reportLcp(value: number): void {
  dispatch ??= vi.mocked(onLCP).mock.calls[0]?.[0]
  dispatch?.({
    name: 'LCP',
    value,
    delta: value,
    id: 'v6-LCP',
    rating: 'good',
    entries: [],
    navigationType: 'navigate',
    navigationId: 1,
  } as Metric)
}

beforeEach(() => {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      sent.push(url)
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(async () => {
  await close()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('init — Web Vitals wiring', () => {
  it('with trackWebVitals:true the measurements are sent when the page leaves the stage', () => {
    init({ ...base, trackWebVitals: true })

    reportLcp(1800)
    window.dispatchEvent(new Event('pagehide'))

    expect(sent.filter((url) => url.includes('/web_vitals'))).toHaveLength(1)
  })

  it('with trackWebVitals:false (default) it collects nothing', () => {
    init({ ...base })

    // The measurement is delivered anyway: without opt-in no installation
    // is subscribed to receive it, and nothing must be sent.
    reportLcp(1800)
    window.dispatchEvent(new Event('pagehide'))

    expect(sent.filter((url) => url.includes('/web_vitals'))).toHaveLength(0)
  })

  it('after close() pagehide no longer produces measurements', async () => {
    init({ ...base, trackWebVitals: true })
    reportLcp(1800)

    // close() tears down the integration, which sends the measurements collected so far.
    await close()
    const afterClose = sent.filter((url) => url.includes('/web_vitals')).length
    window.dispatchEvent(new Event('pagehide'))

    expect(sent.filter((url) => url.includes('/web_vitals'))).toHaveLength(afterClose)
  })
})

describe('init — resource and CSP failure wiring', () => {
  function failScript(): void {
    const element = document.createElement('script')
    element.setAttribute('src', 'https://cdn.example.com/app.js')
    document.body.appendChild(element)
    element.dispatchEvent(new Event('error'))
    element.remove()
  }

  it('with captureResourceErrors:true a missing resource becomes an event', () => {
    init({ ...base, captureResourceErrors: true })

    failScript()

    expect(sent.filter((url) => url.includes('/store'))).toHaveLength(1)
  })

  it('with captureResourceErrors:false (default) nobody notices', () => {
    init({ ...base })

    failScript()

    expect(sent.filter((url) => url.includes('/store'))).toHaveLength(0)
  })

  it('after close() the listener is detached', async () => {
    init({ ...base, captureResourceErrors: true })
    await close()

    failScript()

    expect(sent.filter((url) => url.includes('/store'))).toHaveLength(0)
  })
})
