import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import { installGlobalHandlers } from '../src/integrations/browser/globalHandlers'

function fakeClient(): { client: Client; capture: ReturnType<typeof vi.fn> } {
  const capture = vi.fn()
  return {
    capture,
    client: { captureException: capture } as unknown as Client,
  }
}

let uninstall: () => void = () => {}
afterEach(() => uninstall())

describe('installGlobalHandlers', () => {
  it('captures an error event with an Error object', () => {
    const { client, capture } = fakeClient()
    uninstall = installGlobalHandlers(client)

    const error = new Error('boom')
    window.dispatchEvent(new ErrorEvent('error', { error, message: 'boom' }))

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0]).toBe(error)
    expect(capture.mock.calls[0]![1]).toEqual({ handled: false })
  })

  it('synthesizes an error from window.onerror without an Error object', () => {
    const { client, capture } = fakeClient()
    uninstall = installGlobalHandlers(client)

    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'script error',
        filename: 'https://app/main.js',
        lineno: 12,
        colno: 3,
      }),
    )

    expect(capture).toHaveBeenCalledTimes(1)
    const synthetic = capture.mock.calls[0]![0] as { message: string; stack: string }
    expect(synthetic.message).toBe('script error')
    expect(synthetic.stack).toContain('https://app/main.js:12:3')
  })

  it('ignores resource loading errors (no error/message)', () => {
    const { client, capture } = fakeClient()
    uninstall = installGlobalHandlers(client)

    window.dispatchEvent(new Event('error'))
    expect(capture).not.toHaveBeenCalled()
  })

  it('captures an unhandled promise rejection', () => {
    const { client, capture } = fakeClient()
    uninstall = installGlobalHandlers(client)

    const event = new Event('unhandledrejection')
    const reason = new Error('rejected')
    ;(event as unknown as { reason: unknown }).reason = reason
    window.dispatchEvent(event)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]![0]).toBe(reason)
  })

  it('after uninstall it no longer captures', () => {
    const { client, capture } = fakeClient()
    const off = installGlobalHandlers(client)
    off()
    uninstall = () => {}
    // jsdom re-propagates as "uncaught" an 'error' ErrorEvent with a real and
    // unhandled Error: a listener that calls preventDefault silences it without
    // touching the assertion (we only verify that our handler is removed).
    const swallow = (e: Event): void => e.preventDefault()
    window.addEventListener('error', swallow, true)
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('x'), message: 'x' }),
    )
    window.removeEventListener('error', swallow, true)
    expect(capture).not.toHaveBeenCalled()
  })
})
