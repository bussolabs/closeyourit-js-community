// Global handlers of unhandled errors. We use `addEventListener` (not
// the assignment of `window.onerror`) so as not to clobber pre-existing handlers.
// They return an uninstall function.

import type { Client } from '../../client'

/// Installs the `error` and `unhandledrejection` listeners. No-op outside the browser.
export function installGlobalHandlers(client: Client): () => void {
  if (typeof window === 'undefined') return () => {}

  const onError = (event: Event): void => {
    const errorEvent = event as Partial<ErrorEvent> & Event
    // Resource loading errors (img/script): no error/message → ignore.
    if (!errorEvent.error && !errorEvent.message) return

    if (errorEvent.error) {
      client.captureException(errorEvent.error, { handled: false })
      return
    }
    client.captureException(synthesizeError(errorEvent), { handled: false })
  }

  const onRejection = (event: Event): void => {
    const rejection = event as PromiseRejectionEvent
    const reason = rejection.reason ?? 'Unhandled promise rejection'
    client.captureException(reason, { handled: false })
  }

  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection, true)

  return () => {
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection, true)
  }
}

// window.onerror does not carry an Error object: we synthesize name/message/stack from
// message/filename/lineno/colno so `parseStack` produces a consistent frame.
function synthesizeError(event: Partial<ErrorEvent>): {
  name: string
  message: string
  stack: string | undefined
} {
  const message = event.message ?? 'Unknown error'
  let stack: string | undefined
  if (event.filename) {
    const line = event.lineno ?? 0
    const col = event.colno ?? 0
    stack = `Error: ${message}\n    at ${event.filename}:${line}:${col}`
  }
  return { name: 'Error', message, stack }
}
