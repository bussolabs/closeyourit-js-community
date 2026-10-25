import { afterEach, describe, expect, it, vi } from 'vitest'

// The script entry mounts the button from the tag that loaded it.
describe('help desk script entry', () => {
  afterEach(() => {
    document
      .querySelectorAll('[data-closeyourit-helpdesk]')
      .forEach((node) => node.remove())
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('mounts from the current script and exposes mount', async () => {
    const script = document.createElement('script')
    script.dataset.endpoint = 'https://cyi.example.com'
    script.dataset.projectId = 'project-1'
    script.dataset.publicKey = 'public-key'
    vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)

    const entry = await import('../src/helpdesk.iife')

    expect(document.querySelector('[data-closeyourit-helpdesk]')).not.toBeNull()
    expect(typeof entry.mount).toBe('function')
  })

  it('waits for the page when the body is not there yet', async () => {
    const script = document.createElement('script')
    script.dataset.endpoint = 'https://cyi.example.com'
    script.dataset.projectId = 'project-1'
    script.dataset.publicKey = 'public-key'
    vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)
    const body = document.body
    const bodySpy = vi
      .spyOn(document, 'body', 'get')
      .mockReturnValue(null as unknown as HTMLElement)

    await import('../src/helpdesk.iife')
    expect(document.querySelector('[data-closeyourit-helpdesk]')).toBeNull()

    bodySpy.mockReturnValue(body)
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(document.querySelector('[data-closeyourit-helpdesk]')).not.toBeNull()
  })
})
