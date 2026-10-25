// Page resource failures and CSP violations (CYJS-12). The browser events
// are simulated on the jsdom DOM and the payload is asserted on the wire.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { installResourceErrors } from '../src/integrations/browser/resourceErrors'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'proj-1',
  environment: 'production',
  captureResourceErrors: true,
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

// Simulates a resource load failure: the `error` event starts from the
// node, and the SDK intercepts it in the capture phase on window.
function failResource(tag: string, attributes: Record<string, string>): void {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value)
  }
  document.body.appendChild(element)
  element.dispatchEvent(new Event('error'))
  element.remove()
}

function violateCsp(details: Record<string, unknown>): void {
  const event = new Event('securitypolicyviolation')
  Object.assign(event, details)
  document.dispatchEvent(event)
}

function exceptionOf(calls: Array<{ payload: unknown }>, index = 0): EventPayload {
  const payload = calls[index]!.payload as EventPayload
  const exception = payload['exception'] as { values: EventPayload[] }
  return exception.values[0]!
}

let uninstall: () => void = () => {}
afterEach(() => {
  uninstall()
  uninstall = () => {}
  document.body.replaceChildren()
})

describe('installResourceErrors — resources that fail to load', () => {
  it('reports a script that failed to load with the resource URL', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js' })

    expect(calls).toHaveLength(1)
    const values = exceptionOf(calls)
    expect(values['type']).toBe('ResourceError')
    expect(values['value']).toBe('script non caricato: https://cdn.example.com/app.js')
    expect(values['mechanism']).toMatchObject({ handled: true })
  })

  it('is a warning, not an application error', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('link', {
      href: 'https://cdn.example.com/theme.css',
      rel: 'stylesheet',
    })

    expect((calls[0]!.payload as EventPayload)['level']).toBe('warning')
    expect(exceptionOf(calls)['value']).toBe(
      'foglio di stile non caricato: https://cdn.example.com/theme.css',
    )
  })

  it('recognizes images and other media', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('img', { src: 'https://cdn.example.com/logo.png' })

    expect(exceptionOf(calls)['value']).toBe(
      'immagine non caricata: https://cdn.example.com/logo.png',
    )
  })

  it('the resource query never travels', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js?token=secret&v=3' })

    expect(JSON.stringify(calls[0]!.payload)).not.toContain('secret')
    expect(exceptionOf(calls)['value']).toBe(
      'script non caricato: https://cdn.example.com/app.js',
    )
  })

  it('attaches the resource context', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js' })

    const contexts = (calls[0]!.payload as EventPayload)['contexts'] as EventPayload
    expect(contexts['resource']).toEqual({
      url: 'https://cdn.example.com/app.js',
      element: 'script',
    })
  })

  it('an element outside the list stays a resource, without breaking anything', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('input', { src: 'https://cdn.example.com/background.webp' })

    expect(exceptionOf(calls)['value']).toBe(
      'risorsa non caricata: https://cdn.example.com/background.webp',
    )
  })

  it('for a responsive image it reports the file the browser chose', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    // With `srcset` the browser picks a variant: `src` may be missing or
    // point to a file different from the one it actually tried to load.
    const element = document.createElement('img')
    element.setAttribute('srcset', 'https://cdn.example.com/logo-2x.png 2x')
    Object.defineProperty(element, 'currentSrc', {
      value: 'https://cdn.example.com/logo-2x.png',
    })
    document.body.appendChild(element)
    element.dispatchEvent(new Event('error'))
    element.remove()

    expect(exceptionOf(calls)['value']).toBe(
      'immagine non caricata: https://cdn.example.com/logo-2x.png',
    )
  })

  it('ignores resources without an address', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('img', {})

    expect(calls).toHaveLength(0)
  })

  it('does not touch JavaScript errors, which stay with the global handlers', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    const event = new Event('error')
    Object.assign(event, { message: 'boom', error: new Error('boom') })
    window.dispatchEvent(event)

    expect(calls).toHaveLength(0)
  })

  it('the same resource that keeps failing is reported only once', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js' })
    failResource('script', { src: 'https://cdn.example.com/app.js' })
    failResource('script', { src: 'https://cdn.example.com/app.js' })

    expect(calls).toHaveLength(1)
  })

  it('a page failing in bursts does not flood the ingest', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    for (let index = 0; index < 25; index++) {
      failResource('img', { src: `https://cdn.example.com/photo-${index}.png` })
    }

    expect(calls).toHaveLength(10)
  })

  it('teardown detaches the listener', () => {
    const { client, calls } = harness()
    const off = installResourceErrors(client)
    off()

    failResource('script', { src: 'https://cdn.example.com/app.js' })

    expect(calls).toHaveLength(0)
  })
})

describe('installResourceErrors — Content Security Policy violations', () => {
  it('reports the violated directive and the blocked resource', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    violateCsp({
      blockedURI: 'https://tracker.example.com/pixel.js',
      effectiveDirective: 'script-src',
      violatedDirective: 'script-src',
      disposition: 'enforce',
    })

    expect(calls).toHaveLength(1)
    const values = exceptionOf(calls)
    expect(values['type']).toBe('CSPViolation')
    expect(values['value']).toBe(
      'script-src ha bloccato https://tracker.example.com/pixel.js',
    )
  })

  it('attaches the violation context, with the source file without query', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    violateCsp({
      blockedURI: 'inline',
      effectiveDirective: 'style-src-elem',
      violatedDirective: 'style-src-elem',
      disposition: 'report',
      sourceFile: 'https://app.example.com/page?session=secret',
      lineNumber: 42,
    })

    const payload = calls[0]!.payload as EventPayload
    expect((payload['contexts'] as EventPayload)['csp']).toEqual({
      blocked_uri: 'inline',
      effective_directive: 'style-src-elem',
      disposition: 'report',
      source_file: 'https://app.example.com/page',
      line_number: 42,
    })
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('falls back to violatedDirective when effectiveDirective is missing', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    violateCsp({ blockedURI: 'eval', violatedDirective: 'script-src' })

    expect(exceptionOf(calls)['value']).toBe('script-src ha bloccato eval')
  })

  it('the same repeated violation counts as one report', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    const violation = {
      blockedURI: 'https://tracker.example.com/pixel.js',
      effectiveDirective: 'script-src',
      disposition: 'enforce',
    }
    violateCsp(violation)
    violateCsp(violation)

    expect(calls).toHaveLength(1)
  })

  it('the resource cap does not starve the CSP violations', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    // A CDN that is down makes the whole catalog fail: if the cap were shared, the
    // policy violations — a different problem — would never arrive.
    for (let index = 0; index < 20; index++) {
      failResource('img', { src: `https://cdn.example.com/photo-${index}.png` })
    }
    for (let index = 0; index < 3; index++) {
      violateCsp({
        blockedURI: `https://x.example.com/${index}.js`,
        effectiveDirective: 'script-src',
      })
    }

    expect(calls).toHaveLength(13)
  })

  it('each family has its own cap of ten per page', () => {
    const { client, calls } = harness()
    uninstall = installResourceErrors(client)

    for (let index = 0; index < 15; index++) {
      violateCsp({
        blockedURI: `https://x.example.com/${index}.js`,
        effectiveDirective: 'script-src',
      })
    }

    expect(calls).toHaveLength(10)
  })

  it('teardown also detaches the violations listener', () => {
    const { client, calls } = harness()
    const off = installResourceErrors(client)
    off()

    violateCsp({ blockedURI: 'eval', effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(0)
  })
})

describe('installResourceErrors — sampling and configuration', () => {
  it('honors sampleRate like the other events', () => {
    const { client, calls } = harness({ sampleRate: 0 })
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js' })

    expect(calls).toHaveLength(0)
    expect(client.stats.toObject().reasons.sample_rate).toBe(1)
  })

  it('excludedExceptions can switch off a single family of signals', () => {
    const { client, calls } = harness({ excludedExceptions: ['ResourceError'] })
    uninstall = installResourceErrors(client)

    failResource('script', { src: 'https://cdn.example.com/app.js' })
    violateCsp({ blockedURI: 'eval', effectiveDirective: 'script-src' })

    expect(calls).toHaveLength(1)
    expect(exceptionOf(calls)['type']).toBe('CSPViolation')
  })
})
