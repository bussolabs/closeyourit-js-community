// Web Vitals collection (opt-in `trackWebVitals`) on top of `web-vitals`, Google's
// reference library (CYJS-28).
//
// It is the package's ONLY dependency, and it is taken on purpose. LCP and CLS by hand
// are doable, INP is not: it depends on the percentile over the interactions, on the
// count the browser exposes only partially and on a handful of exceptions
// that change from one Chrome version to the next. A wrong version is not
// visible — it produces plausible numbers — and would stay wrong for months. It is also
// the only way to be comparable with CrUX, which is the whole point of
// putting the two columns side by side on the same page.
//
// Per-metric imports (`web-vitals/onLCP.js`, not the barrel): the IIFE grows for
// everyone who loads the snippet, even for those who do not turn the Web Vitals
// on. The cap is committed and the CI checks it (`pnpm size`).
//
// ONLY the standard build, NEVER `web-vitals/attribution`: that one carries
// the culprit element and weighs much more, and as long as the backend has nowhere
// to put it, it would be weight paid by every visitor for data nobody reads.
//
// DEFAULT behavior, not `reportAllChanges`: every metric arrives only
// once, with the final value. With `reportAllChanges` it would arrive at every
// change, and it would be one request per update instead of one per
// load.
//
// The integration must be installed AFTER the facade lifecycle: on a page that is leaving
// the send must go through the beacon (CYJS-29), and the lifecycle raises the signal.

import type { Metric } from 'web-vitals'
import { onCLS } from 'web-vitals/onCLS.js'
import { onFCP } from 'web-vitals/onFCP.js'
import { onINP } from 'web-vitals/onINP.js'
import { onLCP } from 'web-vitals/onLCP.js'
import { onTTFB } from 'web-vitals/onTTFB.js'
import type { Client } from '../../client'
import { buildWebVital } from '../../webVitals'
import type { WebVitalName, WebVitalPayload } from '../../webVitals'

// Interval of the courtesy flush: empties the buffer of the measurements that arrived AFTER
// the first send (see `flushed` below).
const COURTESY_FLUSH_MS = 5000

/// From the web-vitals vocabulary to the ingest one.
const METRIC_NAMES: Record<Metric['name'], WebVitalName> = {
  LCP: 'lcp',
  CLS: 'cls',
  INP: 'inp',
  TTFB: 'ttfb',
  FCP: 'fcp',
}

// Current recipient of the measurements: the live installation, or nobody after the
// teardown. It is ONE because there is only one initialized SDK.
let sink: ((metric: Metric) => void) | undefined
// The five callbacks have been registered for this page.
let listening = false

// Subscribes [onMetric] to the measurements and returns the function to unsubscribe it.
//
// The registration with `web-vitals` happens ONLY ONCE per page, not at
// every installation: the library offers no unsubscription and every call to
// `onLCP` & co. opens new `PerformanceObserver`s that stay alive — and keep working
// on the main thread — until the end of the page. Registering them at every `init` would
// pile them up with no way of closing them, and whoever reconfigures the SDK twice
// would pay for the monitoring twice. Worse: the second registration makes
// the already-reported metrics be delivered again, and the same load would send its LCP
// twice.
//
// The declared price: after a `close()` the observers stay open, because
// there is no API to close them. What can be avoided is that they multiply.
function subscribeToWebVitals(onMetric: (metric: Metric) => void): () => void {
  sink = onMetric
  if (!listening) {
    listening = true
    // The dispatch is stable: it forwards to the current recipient, so a
    // later `init` inherits the observers already open instead of opening more.
    const dispatch = (metric: Metric): void => sink?.(metric)
    onTTFB(dispatch)
    onFCP(dispatch)
    onLCP(dispatch)
    onCLS(dispatch)
    onINP(dispatch)
  }

  return () => {
    // Only if the slot is still ours: a later `init` has already taken it, and
    // freeing it here would turn off the collection of a live client.
    if (sink === onMetric) sink = undefined
  }
}

/// Registers the five callbacks and returns the uninstall function, which
/// detaches the listeners and still sends the measurements collected so far: an explicit
/// shutdown of the SDK is not a good reason to throw away a measurement already taken.
export function installWebVitals(client: Client): () => void {
  // The measurements wait here for the page exit. Indexed by metric because
  // web-vitals can report the same one several times (CLS grows at every return
  // to the foreground): until the batch has left the last value wins, which is
  // the most complete.
  const pending = new Map<WebVitalName, WebVitalPayload>()
  // Metrics already sent: a second measurement of the same metric, in the same
  // load, is not sent. Two values of the same page inside a
  // percentile skew it more than a value frozen at the first send.
  //
  // The RETURN FROM BFCACHE falls here too, and it is intended: web-vitals treats it
  // as a new navigation and re-measures everything, but those measurements stay
  // out here. It is the same choice as CYJS-12, declared in the README — after the page
  // exit the load is closed. Re-measuring it is a product decision
  // (it doubles the sends and opens the question of what the "load" is for the
  // percentile), not a detail to change here: the navigation type
  // `back-forward-cache` is not even in the ingest vocabulary.
  const sent = new Set<WebVitalName>()
  // Page the measurements belong to, read at installation: in a SPA the
  // path can change before the exit, and attributing the load
  // to the last route seen would blame the wrong page.
  const path = typeof location !== 'undefined' ? location.pathname : undefined

  // The first batch has left. Before that moment the measurements wait for
  // the page exit, so a load produces ONE request; after it, every
  // measurement that arrives is already final and there is no second `pagehide` to
  // count on — the courtesy flush takes it away.
  let flushed = false
  let courtesy: ReturnType<typeof setTimeout> | undefined

  const scheduleCourtesyFlush = (): void => {
    if (courtesy !== undefined) return
    courtesy = setTimeout(() => {
      courtesy = undefined
      flush()
    }, COURTESY_FLUSH_MS)
  }

  const record = (metric: Metric): void => {
    const name = METRIC_NAMES[metric.name]
    if (!name || sent.has(name)) return

    pending.set(
      name,
      buildWebVital({
        metric: name,
        value: metric.value,
        path,
        navigationType: metric.navigationType,
      }),
    )
    if (flushed) scheduleCourtesyFlush()
  }

  const flush = (): void => {
    if (courtesy !== undefined) {
      clearTimeout(courtesy)
      courtesy = undefined
    }
    flushed = true
    if (pending.size === 0) return

    const measures = [...pending.values()]
    for (const name of pending.keys()) sent.add(name)
    pending.clear()
    client.captureWebVitals(measures)
  }

  const onVisibility = (): void => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') flush()
  }

  // First the subscription, then our listeners: `web-vitals` delivers the
  // LCP, CLS and INP measurements right on `visibilitychange`, and must have already done so
  // when it is our turn to empty the buffer. Otherwise a second
  // send would be needed for the same metrics. (Its listeners are in the capture phase on
  // `window`, ours in bubble on `document`: the order holds even when
  // the subscription reuses a registration made by a previous installation.)
  const unsubscribe = subscribeToWebVitals(record)

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  return () => {
    // The unsubscription closes the door: a late measurement does not end up in an
    // already shut down client. The observers opened by `web-vitals` remain — there is no
    // API to close them — but they are ONE set per page, not one per `init`, and
    // a later installation inherits those instead of opening more.
    //
    // A shutdown while the page is still visible sends what has been collected
    // so far, and no more: LCP, CLS and INP are delivered by the library at the page
    // exit, so while the page is alive they may not have arrived yet. There is
    // no way to get them earlier — the only lever would be to simulate a
    // `visibilitychange`, which would lie to the whole page, not only to us. They are
    // still provisional values: losing them is less bad than inventing them.
    unsubscribe()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', flush)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    flush()
  }
}
