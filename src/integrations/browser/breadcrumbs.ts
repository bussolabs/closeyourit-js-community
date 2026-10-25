// Automatic browser breadcrumbs: clicks, navigation (history/popstate) and
// console.warn/error. HTTP requests live in `http.ts` (unified
// breadcrumb+performance instrumentation). Every sub-integration is gated by
// `autoBreadcrumbs.{click,navigation,console}`; `install…` returns the uninstall
// function that restores the patches.

import type { Client } from '../../client'
import { subscribeNavigation } from './navigation'

const MAX_MESSAGE = 200

/// Installs the sub-integrations enabled by the options.
export function installBreadcrumbs(client: Client): () => void {
  const auto = client.options.autoBreadcrumbs
  const uninstalls = [
    auto.click ? installClicks(client) : noop,
    auto.navigation ? installNavigation(client) : noop,
    auto.console ? installConsole(client) : noop,
  ]
  return () => uninstalls.forEach((fn) => fn())
}

const noop = (): void => {}

// ------------------------------------------------------------------- click

function installClicks(client: Client): () => void {
  if (typeof document === 'undefined') return noop
  const handler = (event: Event): void => {
    const target = event.target
    if (!isElement(target)) return
    client.addBreadcrumb({
      category: 'ui.click',
      type: 'default',
      message: syntheticSelector(target),
    })
  }
  document.addEventListener('click', handler, true)
  return () => document.removeEventListener('click', handler, true)
}

/// Synthetic, PII-free selector: tag + id + first classes + data-test(id).
export function syntheticSelector(el: Element): string {
  let selector = el.tagName.toLowerCase()
  if (el.id) selector += `#${el.id}`
  const classAttr = el.getAttribute('class') ?? ''
  const classes = classAttr.trim().split(/\s+/).filter(Boolean).slice(0, 3)
  if (classes.length > 0) selector += `.${classes.join('.')}`
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test')
  if (testId) selector += `[data-testid="${testId}"]`
  return selector
}

// -------------------------------------------------------------- navigation

// Consumer of the shared patch (`navigation.ts`): turns every URL change into
// a `navigation` breadcrumb, with from/to stripped of query and hash. The History
// patch is installed only once even when it coexists with the pageviews.
function installNavigation(client: Client): () => void {
  return subscribeNavigation((to, from) => {
    client.addBreadcrumb({
      category: 'navigation',
      type: 'navigation',
      data: { from: stripUrl(from ?? to), to: stripUrl(to) },
    })
  })
}

/// Removes query string and hash from a URL (PII-safe): origin + pathname remain.
export function stripUrl(href: string): string {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined
    const url = new URL(href, base)
    return url.origin + url.pathname
  } catch {
    return (href.split('?')[0] ?? href).split('#')[0] ?? href
  }
}

// ----------------------------------------------------------------- console

function installConsole(client: Client): () => void {
  if (typeof console === 'undefined') return noop

  const original = { warn: console.warn, error: console.error }

  const patch = (level: 'warning' | 'error', method: 'warn' | 'error'): void => {
    const originalMethod = original[method]
    console[method] = function patched(...args: unknown[]): void {
      client.addBreadcrumb({
        category: 'console',
        level,
        message: stringifyArgs(args),
      })
      originalMethod.apply(console, args)
    }
  }
  patch('warning', 'warn')
  patch('error', 'error')

  return () => {
    console.warn = original.warn
    console.error = original.error
  }
}

function stringifyArgs(args: unknown[]): string {
  const message = args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message
}

// ------------------------------------------------------------------ shared

function isElement(value: EventTarget | null): value is Element {
  return typeof Element !== 'undefined' && value instanceof Element
}
