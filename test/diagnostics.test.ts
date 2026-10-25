import { describe, expect, it, vi } from 'vitest'
import { Diagnostics, diagnosticsSuppressed } from '../src/diagnostics'

describe('Diagnostics', () => {
  it('without a configured hook it is a no-op (no error)', () => {
    const diag = new Diagnostics()
    expect(() => diag.notify('drop', { reason: 'queue_full' })).not.toThrow()
    expect(diag.suppressed).toBe(false)
  })

  it('forwards the event and details to the callback', () => {
    const hook = vi.fn()
    const diag = new Diagnostics(hook)
    diag.notify('drop', { reason: 'sample_rate' })
    expect(hook).toHaveBeenCalledWith('drop', { reason: 'sample_rate' })
  })

  it('normalizes missing details to an empty object', () => {
    const hook = vi.fn()
    const diag = new Diagnostics(hook)
    diag.notify('shutdown')
    expect(hook).toHaveBeenCalledWith('shutdown', {})
  })

  it('is not recursive: a notify nested from the callback is suppressed', () => {
    const events: string[] = []
    const diag = new Diagnostics((event) => {
      events.push(event)
      // The callback tries to generate diagnostics again: it must not restart.
      diag.notify('drop', { reason: 'error' })
    })
    diag.notify('enqueue')
    expect(events).toEqual(['enqueue'])
  })

  it('exposes suppressed=true while the callback is running', () => {
    let seen = false
    const diag = new Diagnostics(() => {
      seen = diag.suppressed
    })
    diag.notify('send', { status: 200 })
    expect(seen).toBe(true)
    expect(diag.suppressed).toBe(false)
  })

  it('absorbs an error from the callback (does not propagate) and resets suppressed', () => {
    const diag = new Diagnostics(() => {
      throw new Error('hook difettoso')
    })
    expect(() => diag.notify('timeout', { error: 'AbortError' })).not.toThrow()
    expect(diag.suppressed).toBe(false)
  })

  it('suppression is process-wide while a hook is running', () => {
    let insideHook = false
    const diag = new Diagnostics(() => {
      insideHook = diagnosticsSuppressed()
    })
    expect(diagnosticsSuppressed()).toBe(false)
    diag.notify('enqueue')
    expect(insideHook).toBe(true)
    expect(diagnosticsSuppressed()).toBe(false)
  })

  it('a hook does not trigger the hook of another instance (global suppression, no cross-client)', () => {
    // Reproduces the re-init case: the hook of the closing client attempts diagnostics
    // that would end up on another instance (the new client). It must stay suppressed.
    const otherHook = vi.fn()
    const other = new Diagnostics(otherHook)
    const closing = new Diagnostics(() => other.notify('send', { status: 200 }))
    closing.notify('shutdown')
    expect(otherHook).not.toHaveBeenCalled()
  })
})
