// "Need help?" button for the sites of a project (CYRA-942). It ships as its own
// file (`dist/helpdesk.min.js`, `@bussolabs/closeyourit-js/helpdesk`), never inside
// the main bundle: a site that does not switch it on downloads nothing more.
//
// The form lives in a shadow root, so the page styles cannot break it and its
// styles cannot leak into the page. It posts one object to the public help desk
// endpoint with the DSN public key in the query, like the other browser channels.

import { scrubMessage } from './scrubber'
import { ensureReplaySession } from './session'

export type HelpdeskLang = 'en' | 'it'

export interface HelpdeskOptions {
  /// Address of the CloseYourIt server: your own installation or the hosted one.
  endpointUrl: string
  projectId: string
  /// DSN public key: not a secret, it can sit in the page.
  publicKey: string
  /// Texts language. Default: the page language (`<html lang>`), English otherwise.
  lang?: HelpdeskLang | undefined
  /// Side of the screen the button sits on. Default: right.
  position?: 'left' | 'right' | undefined
  /// Injectable fetch (tests). Default: the global one.
  fetchImpl?: typeof fetch | undefined
}

interface Texts {
  button: string
  title: string
  message: string
  email: string
  emailHint: string
  send: string
  sending: string
  close: string
  sent: string
  invalid: string
  tooMany: string
  failed: string
}

const TEXTS: Record<HelpdeskLang, Texts> = {
  en: {
    button: 'Need help?',
    title: 'Write to us',
    message: 'Your message',
    email: 'Your email',
    emailHint: 'Optional. We use it only to answer you.',
    send: 'Send',
    sending: 'Sending…',
    close: 'Close',
    sent: 'Thank you. Your request has been sent.',
    invalid: 'Check the message and the email, then try again.',
    tooMany: 'Too many requests. Try again in a minute.',
    failed: 'The request could not be sent. Try again later.',
  },
  it: {
    button: 'Serve aiuto?',
    title: 'Scrivici',
    message: 'Il tuo messaggio',
    email: 'La tua email',
    emailHint: 'Facoltativa. La usiamo solo per risponderti.',
    send: 'Invia',
    sending: 'Invio in corso…',
    close: 'Chiudi',
    sent: 'Grazie. La tua richiesta è stata inviata.',
    invalid: "Controlla il messaggio e l'email, poi riprova.",
    tooMany: 'Troppe richieste. Riprova fra un minuto.',
    failed: 'Non siamo riusciti a inviare la richiesta. Riprova più tardi.',
  },
}

/// Same limit the server enforces on the message.
const MESSAGE_MAX_CHARS = 4000
/// Field only bots fill: hidden from people, always sent empty.
const HONEYPOT_FIELD = 'website'
const HOST_ATTRIBUTE = 'data-closeyourit-helpdesk'

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { position: fixed; bottom: 16px; z-index: 2147483000; display: flex; flex-direction: column; gap: 8px; }
.wrap.right { right: 16px; align-items: flex-end; }
.wrap.left { left: 16px; align-items: flex-start; }
.toggle, .send { cursor: pointer; border: 0; border-radius: 999px; background: #4f46e5; color: #fff; font-size: 14px; font-weight: 600; padding: 10px 16px; }
.toggle:focus-visible, .send:focus-visible, .close:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
.panel { width: min(340px, calc(100vw - 32px)); background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 12px; padding: 16px; box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: 15px; font-weight: 600; margin: 0; }
.close { cursor: pointer; border: 0; background: transparent; color: #71717a; font-size: 13px; padding: 4px; }
label { display: block; font-size: 12px; font-weight: 500; margin: 10px 0 4px; }
textarea, input { width: 100%; border: 1px solid #d4d4d8; border-radius: 8px; padding: 8px 10px; font-size: 14px; color: #18181b; background: #fff; }
textarea { min-height: 96px; resize: vertical; }
.hint { font-size: 11.5px; color: #71717a; margin: 4px 0 0; }
.trap { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
.send { border-radius: 8px; width: 100%; margin-top: 12px; }
.send[disabled] { opacity: .6; cursor: default; }
.status { font-size: 12.5px; margin: 10px 0 0; min-height: 1em; }
.status.error { color: #b91c1c; }
.status.ok { color: #15803d; }
@media (prefers-color-scheme: dark) {
  .panel { background: #18181b; color: #f4f4f5; border-color: #3f3f46; }
  textarea, input { background: #27272a; color: #f4f4f5; border-color: #3f3f46; }
  .close, .hint { color: #a1a1aa; }
  .status.error { color: #fca5a5; }
  .status.ok { color: #86efac; }
}
`

/// Adds the button to the page. Returns the function that removes it. Calling it
/// twice keeps one button: the second call replaces the first.
export function mountHelpdesk(options: HelpdeskOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  if (!options.endpointUrl || !options.projectId || !options.publicKey) {
    console.warn(
      '[closeyourit] help desk button not shown: endpointUrl, projectId and publicKey are required',
    )
    return () => {}
  }

  document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).forEach((node) => node.remove())

  const texts = TEXTS[resolveLang(options.lang)]
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '')
  const root = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const wrap = element('div', `wrap ${options.position === 'left' ? 'left' : 'right'}`)
  const panel = element('form', 'panel')
  panel.id = 'cyi-helpdesk-panel'
  panel.hidden = true
  panel.noValidate = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', texts.title)

  const head = element('div', 'head')
  const title = element('p', 'title', texts.title)
  const close = element('button', 'close', texts.close)
  close.type = 'button'
  head.append(title, close)

  const message = document.createElement('textarea')
  message.id = 'cyi-helpdesk-message'
  message.name = 'message'
  message.required = true
  message.maxLength = MESSAGE_MAX_CHARS

  const email = document.createElement('input')
  email.id = 'cyi-helpdesk-email'
  email.name = 'email'
  email.type = 'email'
  email.autocomplete = 'email'

  const trap = document.createElement('input')
  trap.name = HONEYPOT_FIELD
  trap.className = 'trap'
  trap.tabIndex = -1
  trap.autocomplete = 'off'
  trap.setAttribute('aria-hidden', 'true')

  const send = element('button', 'send', texts.send)
  send.type = 'submit'
  const status = element('p', 'status')
  status.setAttribute('role', 'status')

  panel.append(
    head,
    labelFor(message, texts.message),
    message,
    labelFor(email, texts.email),
    email,
    element('p', 'hint', texts.emailHint),
    trap,
    send,
    status,
  )

  const toggle = element('button', 'toggle', texts.button)
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', panel.id)

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) message.focus()
    else toggle.focus()
  }
  const setStatus = (text: string, kind: 'error' | 'ok' | ''): void => {
    status.textContent = text
    status.className = kind ? `status ${kind}` : 'status'
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden !== false))
  close.addEventListener('click', () => setOpen(false))
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false)
  })

  panel.addEventListener('submit', (event) => {
    event.preventDefault()
    if (send.disabled) return
    if (message.value.trim() === '') {
      setStatus(texts.invalid, 'error')
      message.focus()
      return
    }

    send.disabled = true
    send.textContent = texts.sending
    setStatus('', '')
    void deliver(options, {
      message: message.value,
      email: email.value,
      trap: trap.value,
    }).then((outcome) => {
      send.disabled = false
      send.textContent = texts.send
      if (outcome === 'sent') {
        panel.reset()
        setStatus(texts.sent, 'ok')
      } else {
        setStatus(texts[outcome], 'error')
      }
    })
  })

  wrap.append(panel, toggle)
  root.append(style, wrap)
  document.body.append(host)

  return () => host.remove()
}

type Outcome = 'sent' | 'invalid' | 'tooMany' | 'failed'

interface Draft {
  message: string
  email: string
  trap: string
}

async function deliver(options: HelpdeskOptions, draft: Draft): Promise<Outcome> {
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!fetchImpl) return 'failed'

  const payload: Record<string, string> = {
    message: scrubMessage(draft.message),
    // Origin and path only: reset-password and invite tokens travel in the query.
    page_url: location.origin + location.pathname,
    session_id: ensureReplaySession().id,
    [HONEYPOT_FIELD]: draft.trap,
  }
  const address = draft.email.trim()
  if (address !== '') payload.email = address

  try {
    const response = await fetchImpl(requestUrl(options), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.status === 202) return 'sent'
    if (response.status === 422) return 'invalid'
    if (response.status === 429) return 'tooMany'
    return 'failed'
  } catch {
    return 'failed'
  }
}

function requestUrl(options: HelpdeskOptions): string {
  const base = options.endpointUrl.replace(/\/+$/, '')
  const project = encodeURIComponent(options.projectId)
  const key = encodeURIComponent(options.publicKey)
  return `${base}/api/v1/projects/${project}/helpdesk_requests?sentry_key=${key}`
}

function resolveLang(lang: HelpdeskLang | undefined): HelpdeskLang {
  if (lang === 'it' || lang === 'en') return lang
  return document.documentElement.lang.toLowerCase().startsWith('it') ? 'it' : 'en'
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function labelFor(field: HTMLElement, text: string): HTMLLabelElement {
  const label = document.createElement('label')
  label.htmlFor = field.id
  label.textContent = text
  return label
}

/// Reads the settings from the `<script>` tag that loaded the file and adds the
/// button: `data-endpoint`, `data-project-id`, `data-public-key`, and the optional
/// `data-lang` and `data-position`. Without the three required ones nothing happens.
export function mountHelpdeskFromScript(
  script: HTMLOrSVGScriptElement | null,
): () => void {
  if (!script) return () => {}
  const data = script.dataset
  if (!data.endpoint || !data.projectId || !data.publicKey) return () => {}

  return mountHelpdesk({
    endpointUrl: data.endpoint,
    projectId: data.projectId,
    publicKey: data.publicKey,
    lang: data.lang === 'it' || data.lang === 'en' ? data.lang : undefined,
    position: data.position === 'left' ? 'left' : 'right',
  })
}
