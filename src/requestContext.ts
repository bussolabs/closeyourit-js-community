// Automatic request context for events. In the browser the "request" is the
// current page: URL (without query, unless sendPii), User-Agent and referrer.
// On Node there is no implicit request → `undefined` (use
// `scope.setRequest` in servers, e.g. from a middleware).

import { isBrowser } from './runtime'

export function autoRequestContext(
  sendPii: boolean,
): Record<string, unknown> | undefined {
  if (!isBrowser()) return undefined

  const request: Record<string, unknown> = {
    url: sendPii ? location.href : location.origin + location.pathname,
    headers: { 'User-Agent': navigator.userAgent },
  }
  const referrer = typeof document !== 'undefined' ? document.referrer : ''
  if (referrer) {
    request['referrer'] = sendPii ? referrer : stripQuery(referrer)
  }
  return request
}

function stripQuery(href: string): string {
  try {
    const url = new URL(href)
    return url.origin + url.pathname
  } catch {
    return (href.split('?')[0] ?? href).split('#')[0] ?? href
  }
}
