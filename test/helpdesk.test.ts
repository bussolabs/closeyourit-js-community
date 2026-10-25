import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountHelpdesk, mountHelpdeskFromScript } from '../src/helpdesk'
import { resetReplaySessionMemory } from '../src/session'

const OPTIONS = {
  endpointUrl: 'https://cyi.example.com/',
  projectId: 'project-1',
  publicKey: 'public-key',
}

function root(): ShadowRoot {
  const host = document.querySelector('[data-closeyourit-helpdesk]')
  if (!host?.shadowRoot) throw new Error('help desk button not mounted')
  return host.shadowRoot
}

function field<T extends Element>(selector: string): T {
  const node = root().querySelector<T>(selector)
  if (!node) throw new Error(`missing ${selector}`)
  return node
}

function respondWith(status: number): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(null, { status }))
}

async function submit(message: string, email = ''): Promise<void> {
  field<HTMLTextAreaElement>('textarea').value = message
  field<HTMLInputElement>('input[type="email"]').value = email
  field<HTMLFormElement>('form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
  await vi.waitFor(() => {
    expect(field<HTMLButtonElement>('.send').disabled).toBe(false)
  })
}

describe('help desk button', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en'
    sessionStorage.clear()
    resetReplaySessionMemory()
  })

  afterEach(() => {
    document
      .querySelectorAll('[data-closeyourit-helpdesk]')
      .forEach((node) => node.remove())
    vi.restoreAllMocks()
  })

  it('sends only origin and path of the page, never query or hash', async () => {
    // Reset-password and invite tokens travel in the query string.
    const before = location.href
    history.replaceState(null, '', '/reset?token=secret#step')
    const fetchImpl = respondWith(202)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    try {
      await submit('Hello')
    } finally {
      history.replaceState(null, '', before)
    }

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, string>
    expect(body.page_url).toBe(`${location.origin}/reset`)
  })

  it('shows a closed button and opens the form on click', () => {
    mountHelpdesk(OPTIONS)
    const toggle = field<HTMLButtonElement>('.toggle')
    const panel = field<HTMLFormElement>('form')

    expect(toggle.textContent).toBe('Need help?')
    expect(panel.hidden).toBe(true)

    toggle.click()

    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(root().activeElement).toBe(field('textarea'))
  })

  it('closes on Escape and on the close button, giving focus back to the button', () => {
    mountHelpdesk(OPTIONS)
    const toggle = field<HTMLButtonElement>('.toggle')
    const panel = field<HTMLFormElement>('form')

    toggle.click()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panel.hidden).toBe(true)
    expect(root().activeElement).toBe(toggle)

    toggle.click()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(panel.hidden).toBe(false)
    field<HTMLButtonElement>('.close').click()
    expect(panel.hidden).toBe(true)
  })

  it('sends the message with the page, the visit id and the empty trap field', async () => {
    const fetchImpl = respondWith(202)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    await submit('I cannot pay by card.', ' anna@example.com ')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://cyi.example.com/api/v1/projects/project-1/helpdesk_requests?sentry_key=public-key',
    )
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as Record<string, string>
    expect(body.message).toBe('I cannot pay by card.')
    expect(body.email).toBe('anna@example.com')
    expect(body.page_url).toBe(location.origin + location.pathname)
    expect(body.session_id).toMatch(/^[0-9a-f]{32}$/)
    expect(body.website).toBe('')
    expect(field('.status').textContent).toBe('Thank you. Your request has been sent.')
    expect(field<HTMLTextAreaElement>('textarea').value).toBe('')
  })

  it('leaves the email out when the visitor wrote none', async () => {
    const fetchImpl = respondWith(202)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    await submit('Hello')

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('email')
  })

  it('hides an access key pasted in the message', async () => {
    const fetchImpl = respondWith(202)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    await submit('It fails with password=hunter2 in the address')

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(
      (JSON.parse(init.body as string) as { message: string }).message,
    ).not.toContain('hunter2')
  })

  it('does not send an empty message', () => {
    const fetchImpl = respondWith(202)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    field<HTMLTextAreaElement>('textarea').value = '   '
    field<HTMLFormElement>('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(field('.status').className).toBe('status error')
  })

  it.each([
    [422, 'Check the message and the email, then try again.'],
    [429, 'Too many requests. Try again in a minute.'],
    [403, 'The request could not be sent. Try again later.'],
  ])('explains a %i answer and keeps what was written', async (status, text) => {
    const fetchImpl = respondWith(status)
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    await submit('Hello')

    expect(field('.status').textContent).toBe(text)
    expect(field<HTMLTextAreaElement>('textarea').value).toBe('Hello')
  })

  it('reports a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline')
    })
    mountHelpdesk({ ...OPTIONS, fetchImpl: fetchImpl as unknown as typeof fetch })

    await submit('Hello')

    expect(field('.status').textContent).toBe(
      'The request could not be sent. Try again later.',
    )
  })

  it('uses the global fetch when none is injected', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }))
    mountHelpdesk(OPTIONS)

    await submit('Hello')

    expect(globalFetch).toHaveBeenCalledTimes(1)
  })

  it('speaks Italian when asked or when the page is Italian', () => {
    mountHelpdesk({ ...OPTIONS, lang: 'it' })
    expect(field('.toggle').textContent).toBe('Serve aiuto?')

    document.documentElement.lang = 'it-IT'
    mountHelpdesk(OPTIONS)
    expect(field('.toggle').textContent).toBe('Serve aiuto?')
  })

  it('keeps one button when mounted twice, and removes it on unmount', () => {
    mountHelpdesk(OPTIONS)
    const unmount = mountHelpdesk({ ...OPTIONS, position: 'left' })

    expect(document.querySelectorAll('[data-closeyourit-helpdesk]')).toHaveLength(1)
    expect(field('.wrap').className).toBe('wrap left')

    unmount()
    expect(document.querySelector('[data-closeyourit-helpdesk]')).toBeNull()
  })

  it('shows nothing and warns when a required setting is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mountHelpdesk({ ...OPTIONS, publicKey: '' })()

    expect(document.querySelector('[data-closeyourit-helpdesk]')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  describe('from the script tag', () => {
    function scriptWith(data: Record<string, string>): HTMLScriptElement {
      const script = document.createElement('script')
      Object.assign(script.dataset, data)
      return script
    }

    it('reads the settings from the data attributes', () => {
      mountHelpdeskFromScript(
        scriptWith({
          endpoint: 'https://cyi.example.com',
          projectId: 'project-1',
          publicKey: 'public-key',
          lang: 'it',
          position: 'left',
        }),
      )

      expect(field('.toggle').textContent).toBe('Serve aiuto?')
      expect(field('.wrap').className).toBe('wrap left')
    })

    it('ignores an unknown language', () => {
      mountHelpdeskFromScript(
        scriptWith({
          endpoint: 'https://cyi.example.com',
          projectId: 'project-1',
          publicKey: 'public-key',
          lang: 'fr',
        }),
      )

      expect(field('.toggle').textContent).toBe('Need help?')
    })

    it('does nothing without a tag or without the required attributes', () => {
      mountHelpdeskFromScript(null)()
      mountHelpdeskFromScript(scriptWith({ endpoint: 'https://cyi.example.com' }))()

      expect(document.querySelector('[data-closeyourit-helpdesk]')).toBeNull()
    })
  })
})
