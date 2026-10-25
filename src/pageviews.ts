// Builds the payload of a pageview (cookieless web analytics). snake_case
// fields, like the rest of the wire contract (closeyourit-docs/API.md §4.4).
// NO identifying signal travels in the body: IP and User-Agent are derived by the
// server from the request; of the query ONLY the 3 UTM keys travel (never the
// whole query). `path` never carries the query string. `environment` is added
// by the client when sending (it is the one that knows the resolved environment).
//
// It assumes a browser context: the only caller, `Client.capturePageview`, gates
// on `isBrowser()` before invoking it — a pageview outside the browser makes no
// sense (no location/referrer/UTM). No non-browser guard here: it would be
// unreachable dead code under jsdom.

import { uuidV4 } from './uuid'

/// Payload of a pageview ready to send, WITHOUT `environment` (the client adds
/// it). `referrer` and the `utm_*` are present only when populated.
export interface PageviewPayload {
  event_id: string
  /// Event name: absent (→ the server uses "pageview") for page visits,
  /// the custom event name for goals/conversions (CloseYourIt.captureEvent).
  name?: string
  hostname: string
  path: string
  referrer?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_term?: string
  utm_content?: string
  screen_width?: number
  occurred_at: string
}

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const

/// Builds the pageview from the current location. [overrides.path] forces the
/// path (default `location.pathname`, NEVER the query). `event_id` is a UUID v4 (with
/// dashes) for the `(project_id, event_id)` idempotency.
export function buildPageview(overrides: { path?: string } = {}): PageviewPayload {
  const payload: PageviewPayload = {
    event_id: uuidV4(),
    hostname: location.hostname,
    path: overrides.path ?? location.pathname,
    occurred_at: new Date().toISOString(),
  }

  if (document.referrer) payload.referrer = document.referrer

  // Viewport width: the server classifies it into a screen-size category
  // (never the raw value as a dimension — only the class). Always present in the browser.
  if (window.innerWidth > 0) payload.screen_width = window.innerWidth

  const params = new URLSearchParams(location.search)
  for (const key of UTM_KEYS) {
    const value = params.get(key)
    if (value) payload[key] = value
  }

  return payload
}
