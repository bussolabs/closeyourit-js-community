// Fire-and-forget HTTP sending. It never throws (telemetry must not crash the
// host) and has no retry loop.
//
// Auth (CYJS-1): two mutually exclusive modes decided upstream based on the
// environment. `bearer` → `Authorization: Bearer <secret>` header (SERVER-ONLY:
// the `cyi_` bearer must never end up in the browser bundle). `dsn` → non-secret
// DSN public key via the `?sentry_key=` query (browser-safe): no custom header,
// so the CORS preflight stays on `Content-Type` only.
//
// Browser: `fetch` with `keepalive: true` (only under Chrome's 64KB body quota)
// so requests survive the page unload. Redirects are left to native fetch
// (`follow`): with `manual` the response would be an `opaqueredirect` with no
// readable Location.
//
// Browser, page leaving (CYJS-29): `fetch(keepalive)` is not enough when the tab
// closes — iOS Safari abandons the request and the last measurement is lost — so
// from `pagehide`/`visibilitychange(hidden)` onwards sending goes through
// `navigator.sendBeacon`. Usable ONLY in `dsn` mode: the beacon cannot set
// headers (in `bearer` it would leave without a credential), while here the auth
// is the public key in the query. The body travels as `text/plain`: with
// `application/json` the request would not be CORS-simple and would trigger a
// preflight that a send while the page closes does not survive (the backend
// parses the raw body). Fallback to `fetch(keepalive)` where the beacon is
// missing or rejects the payload (per-origin quota exceeded).
//
// Requests ALREADY sent with fetch when the page closes stay where they are:
// they are NOT resent with the beacon. Resending would duplicate them every time
// the fetch arrives anyway (the normal case), and a metric counted twice is a
// certain harm against a merely possible loss. `keepalive` covers them, as far
// as it can.
//
// Node: `redirect:'manual'` + manual follow (max 2) re-POSTing the same body —
// a 301 apex→www with `follow` would downgrade the POST to a GET (parity with the
// ruby/dart Transport, MAX_REDIRECTS=2). In addition the User-Agent
// `closeyourit-js/{version}` is sent (in the browser it is forbidden by the fetch
// spec). Every hop of the follow is authorized against the STARTING address —
// same host or www-swap, http/https, never an HTTPS→HTTP downgrade — because the
// re-POST carries payload and credential with it (CYJS-37).

import { errorName } from './diagnostics'
import type { TransportAuth } from './options'
import { isBrowser, isNode } from './runtime'
import type { Stats } from './stats'
import type { DiagnosticDetails, DiagnosticEvent } from './types'
import { SDK_NAME, SDK_VERSION } from './version'

type NotifyDiagnostic = (event: DiagnosticEvent, details?: DiagnosticDetails) => void

type FetchImpl = typeof fetch

/// "Beacon" send (signature of `navigator.sendBeacon`): `true` if the browser
/// took charge of the request, `false` if it rejected it (quota exceeded).
export type BeaconImpl = (url: string, body: BodyInit) => boolean

const MAX_REDIRECTS = 2
// Chrome's keepalive quota: 64KB per-origin on in-flight bodies. Beyond the
// threshold (with margin) the send goes without keepalive: it only loses the
// guarantee of surviving the unload, but it does not fail with a TypeError.
const KEEPALIVE_MAX_BODY = 60_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// The only schemes on which re-POSTing telemetry makes sense. An `ftp:`, `file:`
// or `data:` Location carries the same host name as the start but is not a
// channel on which to resend payload and credential (CYJS-37).
const REDIRECT_PROTOCOLS = new Set(['https:', 'http:'])
// The only Content-Type that keeps the beacon within CORS-simple requests: with
// `application/json` the preflight would fire and the send while the page closes
// would not survive it. It is also the type the spec assigns to a string-only beacon.
const BEACON_CONTENT_TYPE = 'text/plain;charset=UTF-8'

export interface TransportOptions {
  auth: TransportAuth
  stats: Stats
  fetchImpl?: FetchImpl | undefined
  /// Injectable beacon sender (tests). Default: `navigator.sendBeacon`, resolved on
  /// every send — the SDK can be initialized before the DOM exists (SSR).
  beaconImpl?: BeaconImpl | undefined
  maxQueue?: number
  timeoutMs?: number
  debug?: (message: string, error?: unknown) => void
  /// Diagnostic notifier (process-local, non-recursive): receives the
  /// send/drop/timeout steps for the `onDiagnostic` hook (CYJS-9).
  diagnostic?: NotifyDiagnostic
}

export class Transport {
  private readonly auth: TransportAuth
  private readonly stats: Stats
  private readonly fetchImpl: FetchImpl | undefined
  private readonly beaconImpl: BeaconImpl | undefined
  private readonly maxQueue: number
  private readonly timeoutMs: number
  private readonly debug: ((message: string, error?: unknown) => void) | undefined
  private readonly diagnostic: NotifyDiagnostic

  private inFlight = 0
  private readonly pending = new Set<Promise<void>>()
  // The page is leaving the stage (`pagehide`/`visibilitychange(hidden)`): the
  // facade's lifecycle signals it, it is not guessed here.
  private pageHiding = false

  constructor(options: TransportOptions) {
    this.auth = options.auth
    this.stats = options.stats
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined)
    this.beaconImpl = options.beaconImpl
    this.maxQueue = options.maxQueue ?? 30
    this.timeoutMs = options.timeoutMs ?? 5000
    this.debug = options.debug
    this.diagnostic = options.diagnostic ?? (() => {})
  }

  /// Signals that the page is leaving the stage (`pagehide`,
  /// `visibilitychange(hidden)`) or has come back (`pageshow` from bfcache). While
  /// the page is leaving, browser sends in `dsn` mode go through the beacon: it
  /// is the only one the browser completes after the tab closes (CYJS-29). No
  /// effect on Node nor in `bearer` mode.
  setPageHiding(hiding: boolean): void {
    this.pageHiding = hiding
  }

  /// Sends [payload] (object or array) to [url]. Returns `true` if the send was
  /// accepted (beacon taken in charge or request queued), `false` if dropped
  /// (queue full or no transport available).
  send(payload: unknown, url: string): boolean {
    const body = JSON.stringify(payload)

    // Page leaving: the beacon is synchronous, does not consume the in-flight
    // queue and survives the tab closing. If it is missing or rejects the payload
    // we continue with the fetch below — a lost send is worse than one without a
    // survival guarantee.
    if (this.beaconEligible() && this.sendViaBeacon(body, url)) return true

    const fetchImpl = this.fetchImpl
    if (!fetchImpl) {
      // No `fetch` in the environment: the event has no way to leave → transport
      // failure (parity with the `failed` counter, reason `network`).
      this.stats.record('network')
      this.diagnostic('drop', { reason: 'network' })
      return false
    }
    if (this.inFlight >= this.maxQueue) {
      this.stats.record('queue_full')
      this.diagnostic('drop', { reason: 'queue_full' })
      this.debug?.('queue full, event dropped')
      return false
    }

    const controller = createAbortController()
    const timer =
      controller && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body,
      ...(isBrowser() && body.length < KEEPALIVE_MAX_BODY ? { keepalive: true } : {}),
      ...(isNode() ? { redirect: 'manual' as RequestRedirect } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    }

    this.inFlight += 1
    const promise = this.perform(fetchImpl, this.withAuth(url), init)
      .catch((error: unknown) => {
        // An abort is our network timeout (isolated from non-2xx, gem parity);
        // any other `fetch` rejection is a generic network error.
        if (isAbortError(error)) {
          this.stats.recordTimeout()
          this.diagnostic('timeout', { error: errorName(error) })
        } else {
          this.stats.record('network')
          this.diagnostic('drop', { reason: 'network', error: errorName(error) })
        }
        this.debug?.('send failed', error)
      })
      .finally(() => {
        this.inFlight -= 1
        if (timer !== undefined) clearTimeout(timer)
        this.pending.delete(promise)
      })

    this.pending.add(promise)
    return true
  }

  /// Awaits the in-flight sends (best-effort; does not throw). The beacon is
  /// already handed to the browser when `send` returns: here we only await its
  /// accounting, deferred to the end of the turn.
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  // The beacon applies only in the browser and only with the auth in the query
  // (`?sentry_key=`): since it cannot set headers, in `bearer` mode the send would
  // leave without a credential. `visibilityState` covers the case where the page
  // is already hidden before the SDK's lifecycle is listening (init in a
  // background tab).
  private beaconEligible(): boolean {
    if (this.auth.kind !== 'dsn' || !isBrowser()) return false
    return this.pageHiding || documentHidden()
  }

  // Hands the body to the browser via beacon. `false` = not delivered (beacon
  // missing, quota exceeded or exception): the caller falls back to fetch.
  private sendViaBeacon(body: string, url: string): boolean {
    const beacon = this.beaconImpl ?? navigatorBeacon()
    if (!beacon) return false
    try {
      if (!beacon(this.withAuth(url), beaconBody(body))) return false
    } catch (error) {
      this.debug?.('beacon failed', error)
      return false
    }
    // The send is already in the browser's hands, but the outcome is accounted at
    // the end of the turn: `send` is synchronous only here, and its caller must be
    // able to record the enqueue first — the diagnostic order stays `enqueue` →
    // `send` as in the fetch branch, with no intermediate snapshots showing more
    // sent than enqueued. The notification goes into `pending`, so `flush()` awaits it.
    const notified = Promise.resolve()
      .then(() => {
        // The beacon returns no response: `sent` here means "taken in charge by
        // the browser" and the diagnostics have no status to report.
        this.stats.increment('sent')
        this.diagnostic('send', {})
      })
      .finally(() => {
        this.pending.delete(notified)
      })

    this.pending.add(notified)
    return true
  }

  // Performs the request following redirects manually on Node (POST preserved).
  private async perform(
    fetchImpl: FetchImpl,
    url: string,
    init: RequestInit,
  ): Promise<void> {
    let currentUrl = url
    let response = await fetchImpl(currentUrl, init)

    if (isNode()) {
      let redirects = 0
      while (REDIRECT_STATUSES.has(response.status) && redirects < MAX_REDIRECTS) {
        const location = response.headers?.get('location')
        if (!location) break
        // A relative Location resolves against the current request (that is the
        // HTTP semantics), but the guard below always measures against the initial
        // origin: resolving and authorizing are two different things.
        const nextUrl = new URL(location, currentUrl).toString()
        if (!allowedRedirectTarget(url, nextUrl)) {
          // Only the target's origin: the query would bring the public key in
          // `?sentry_key=` into the log.
          this.debug?.(`redirect not followed to ${targetOrigin(nextUrl)}`)
          break
        }
        currentUrl = this.withAuth(nextUrl)
        redirects += 1
        response = await fetchImpl(currentUrl, init)
      }
    }

    if (response.status >= 200 && response.status < 300) {
      this.stats.increment('sent')
      this.diagnostic('send', { status: response.status })
    } else {
      // Non-2xx (4xx / 429 / 5xx): the event left but was rejected → send
      // failure. The `status` tells the cases apart in the diagnostic hook.
      this.stats.record('response')
      this.diagnostic('drop', { reason: 'response', status: response.status })
      if (this.debug) {
        // Includes the R- code + message from the backend envelope (diagnostic DX), not just the status.
        const detail = await errorDetail(response)
        this.debug(`send failed with status ${response.status}${detail}`)
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      // The bearer travels in a header only in server mode. In `dsn` the
      // credential is the public key in the query (?sentry_key=), never a header.
      ...(this.auth.kind === 'bearer'
        ? { Authorization: `Bearer ${this.auth.secret}` }
        : {}),
      'Content-Type': 'application/json',
      // In the browser the User-Agent is a forbidden header (the browser sets it).
      ...(isNode() ? { 'User-Agent': `${SDK_NAME}/${SDK_VERSION}` } : {}),
    }
  }

  // In `dsn` mode it authenticates by appending the DSN public key as a query
  // param (browser-safe, does not widen the CORS preflight). Idempotent: it does
  // not double the param if already present (e.g. resend on redirect follow).
  private withAuth(url: string): string {
    if (this.auth.kind !== 'dsn') return url
    if (url.includes('sentry_key=')) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}sentry_key=${encodeURIComponent(this.auth.publicKey)}`
  }
}

function createAbortController(): AbortController | undefined {
  return typeof AbortController === 'function' ? new AbortController() : undefined
}

// `navigator.sendBeacon` bound to its receiver (calling it detached throws
// "Illegal invocation"). `undefined` outside the browser or where it does not exist.
function navigatorBeacon(): BeaconImpl | undefined {
  if (typeof navigator === 'undefined') return undefined
  const beacon = navigator.sendBeacon
  return typeof beacon === 'function'
    ? (url, body) => beacon.call(navigator, url, body)
    : undefined
}

// Beacon body as `text/plain` (CORS-simple request, no preflight). Without `Blob`
// in the environment the string is sent: per spec the browser assigns it
// `text/plain;charset=UTF-8` anyway.
function beaconBody(body: string): BodyInit {
  if (typeof Blob !== 'function') return body
  return new Blob([body], { type: BEACON_CONTENT_TYPE })
}

// `true` when the page is not visible (tab in the background or closing).
function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

// `controller.abort()` (our timeout) makes `fetch` reject with an AbortError.
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

// The follow resends the credential (Bearer in a header or public key in the
// query) and the whole payload: it is allowed only towards the STARTING ADDRESS,
// i.e. same host or www-swap (`closeyour.it` ⇄ `www.closeyour.it`) and without
// downgrading the protocol. [originUrl] is the URL of the first send, never the
// previous hop: measuring each bounce against the previous one, apex→www→www.www
// would stay legitimate at every step and end up on a third-party host one small
// piece at a time (CYJS-37).
function allowedRedirectTarget(originUrl: string, toUrl: string): boolean {
  try {
    const origin = new URL(originUrl)
    const to = new URL(toUrl)
    if (!REDIRECT_PROTOCOLS.has(to.protocol)) return false
    // HTTPS→HTTP downgrade: same host, but credential and payload would travel in
    // clear text. The opposite upgrade is still allowed, and whoever already
    // starts in clear text (local ingest in development) loses nothing it had.
    if (origin.protocol === 'https:' && to.protocol !== 'https:') return false
    // `host` includes the port: a Location on the same machine but on another
    // port is another service, not our ingest.
    const from = origin.host
    return from === to.host || `www.${from}` === to.host || from === `www.${to.host}`
  } catch {
    return false
  }
}

// Origin (scheme + host + port) of the rejected target, for the diagnostic log:
// no path nor query, where the public key travels.
function targetOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'invalid target'
  }
}

// Extracts " (R…: message)" from the backend's error envelope for the diagnostic log.
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string }
    }
    const error = body?.error
    if (!error) return ''
    const parts = [error.code, error.message].filter(Boolean)
    return parts.length > 0 ? ` (${parts.join(': ')})` : ''
  } catch {
    return ''
  }
}
