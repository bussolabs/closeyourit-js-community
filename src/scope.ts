// Context attached to events: user, tags, extra, context, trace_id and breadcrumb
// history. Mirror of `CloseYourIt::Scope` (gem) and `Scope` (dart). In the browser
// there is a single global holder (single-thread); on Node the `Client` isolates a
// copy per async flow via [fork] + AsyncLocalStorage (CYJS-7), so the data of one
// request does not end up in the events of another concurrent one. Per-operation
// correlation is obtained via [traceId].

import { Breadcrumb, BreadcrumbBuffer } from './breadcrumbs'
import type { BreadcrumbInput } from './breadcrumbs'
import { scrub } from './scrubber'
import type { EventPayload, UserContext } from './types'

export class Scope {
  readonly breadcrumbs: BreadcrumbBuffer

  private user: Record<string, unknown> | undefined
  private tags: Record<string, string> = {}
  private extra: Record<string, unknown> = {}
  private contexts: Record<string, Record<string, unknown>> = {}
  private request: Record<string, unknown> | undefined

  /// Correlation ID shared by logs/errors of the same operation/page.
  traceId: string | undefined

  /// ID of the replay session in progress (longer-lived than `traceId`: it covers
  /// the whole browser session). Attached to errors as `contexts.replay.replay_id`.
  replaySessionId: string | undefined

  /// `parent-id` (the caller's span-id) of the W3C trace context adopted with
  /// `continueTrace`. Present only after continuing a distributed trace.
  traceParentId: string | undefined

  /// Sampling flag of the adopted W3C trace (bit 0 of `trace-flags`).
  traceSampled: boolean | undefined

  /// Opaque W3C `tracestate` (already validated/truncated) to re-propagate.
  traceState: string | undefined

  /// Adopted opaque W3C `baggage`: it may contain PII, so it is re-propagated ONLY
  /// towards trusted destinations and NEVER attached to events.
  traceBaggage: string | undefined

  constructor(maxBreadcrumbs = 50) {
    this.breadcrumbs = new BreadcrumbBuffer(maxBreadcrumbs)
  }

  setUser(user: UserContext | null): void {
    this.user = user === null ? undefined : { ...user }
  }

  /// Current user id as a string (for session replay correlation), or
  /// `undefined` if not set.
  get userId(): string | undefined {
    const id = this.user?.['id']
    return id === undefined || id === null ? undefined : String(id)
  }

  setTag(key: string, value: string): void {
    this.tags[key] = value
  }

  setTags(tags: Record<string, string>): void {
    Object.assign(this.tags, tags)
  }

  setExtra(key: string, value: unknown): void {
    this.extra[key] = value
  }

  setContext(key: string, value: Record<string, unknown>): void {
    this.contexts[key] = value
  }

  setTraceId(id: string | undefined): void {
    this.traceId = id
  }

  /// Adopts an incoming W3C trace context: its `trace-id` becomes the correlation
  /// `traceId` (so errors/logs carry it) and parent/sampling/tracestate/baggage
  /// are kept for re-propagation towards trusted hosts.
  continueTrace(ctx: {
    traceId: string
    parentId: string
    sampled: boolean
    tracestate?: string | undefined
    baggage?: string | undefined
  }): void {
    this.traceId = ctx.traceId
    this.traceParentId = ctx.parentId
    this.traceSampled = ctx.sampled
    this.traceState = ctx.tracestate
    this.traceBaggage = ctx.baggage
  }

  setReplaySessionId(id: string | undefined): void {
    this.replaySessionId = id
  }

  /// Manual request context: wins over the automatically detected one.
  setRequest(request: Record<string, unknown> | null): void {
    this.request = request === null ? undefined : { ...request }
  }

  addBreadcrumb(input: BreadcrumbInput): void {
    this.breadcrumbs.add(new Breadcrumb(input))
  }

  /// Creates an isolated scope starting from this one: copies user/tags/extra/contexts/
  /// request/replaySessionId into new structures, so mutations on the fork do not
  /// touch the original (nor vice versa). It is the basis of per-async-flow
  /// isolation on Node (CYJS-7).
  ///
  /// With [opts.freshTrace] (per-request: `runWithScope`) the fork starts as a
  /// new correlation unit — `traceId` cleared and no inherited breadcrumbs —
  /// while keeping the scope data as a base. Without it (temporary context:
  /// `withScope`) it inherits `traceId` and a copy of the current breadcrumbs.
  fork(opts: { freshTrace?: boolean } = {}): Scope {
    const forked = new Scope(this.breadcrumbs.maxSize)
    forked.user = this.user ? { ...this.user } : undefined
    forked.tags = { ...this.tags }
    forked.extra = { ...this.extra }
    forked.contexts = cloneContexts(this.contexts)
    forked.request = this.request ? { ...this.request } : undefined
    forked.replaySessionId = this.replaySessionId
    if (!(opts.freshTrace ?? false)) {
      forked.traceId = this.traceId
      // The W3C trace context is part of the same correlation unit as the
      // traceId: inherited with the temporary context, cleared with freshTrace.
      forked.traceParentId = this.traceParentId
      forked.traceSampled = this.traceSampled
      forked.traceState = this.traceState
      forked.traceBaggage = this.traceBaggage
      for (const crumb of this.breadcrumbs.toList()) forked.breadcrumbs.add(crumb)
    }
    return forked
  }

  clear(): void {
    this.user = undefined
    this.tags = {}
    this.extra = {}
    this.contexts = {}
    this.request = undefined
    this.traceId = undefined
    this.traceParentId = undefined
    this.traceSampled = undefined
    this.traceState = undefined
    this.traceBaggage = undefined
    this.breadcrumbs.clear()
  }

  /// Serializes into Sentry keys, including only the populated sections.
  /// Tags/extra/contexts/request go through the scrubber (defense in depth).
  /// `user` has its own dedicated policy (gem parity): without `sendPii` it is reduced
  /// to `{id}` (email & co. are not sent at all); with `sendPii` it travels whole —
  /// setting it is an explicit declaration of intent.
  toEventHash(opts: { sendPii?: boolean } = {}): EventPayload {
    const hash: EventPayload = {}

    if (this.user) {
      const user = (opts.sendPii ?? false) ? { ...this.user } : pickId(this.user)
      if (user) hash['user'] = user
    }
    if (Object.keys(this.tags).length > 0) hash['tags'] = scrub(this.tags)
    if (Object.keys(this.extra).length > 0) hash['extra'] = scrub(this.extra)
    if (Object.keys(this.contexts).length > 0) {
      hash['contexts'] = scrub(this.contexts)
    }
    if (this.request) hash['request'] = scrub(this.request)
    const crumbs = this.breadcrumbs.toJSON()
    if (crumbs) hash['breadcrumbs'] = crumbs

    return hash
  }
}

function pickId(user: Record<string, unknown>): Record<string, unknown> | undefined {
  return 'id' in user ? { id: user['id'] } : undefined
}

// Copies the contexts per key (one level): `setContext` always replaces the whole
// key, so a per-key shallow copy is enough to isolate the fork from the original.
function cloneContexts(
  contexts: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const key of Object.keys(contexts)) out[key] = { ...contexts[key] }
  return out
}
