// Failures of the page resources and Content Security Policy violations
// (opt-in `captureResourceErrors`, CYJS-12). They are the faults the
// browser reports and that no stack trace tells: a third-party script
// that does not respond, a stylesheet that does not arrive, a policy that blocks
// something the page needed.
//
// The channel is the events one, as for JS errors: they are failures, and
// we want them grouped by resource and seen next to the others. They go through
// `captureException`, so they inherit sampling, `excludedExceptions`
// (`ResourceError` / `CSPViolation` turn off a single family), `beforeSend`,
// scrubbing and counters — without one more line of pipeline.
//
// Level `warning` and not `error`: a blocked resource is almost always environment
// or third parties (an ad blocker, an unreachable CDN), not a defect
// of the application. Raising it to error would fill the alerting with noise that
// nobody can fix.
//
// A resource's `error` event does NOT bubble up the DOM: it is intercepted in the
// capture phase on window, as `globalHandlers` already does — which instead
// discards these events, because without `error`/`message` there is nothing to normalize.

import type { Client } from '../../client'

// Cap of reports per page load, **per family**. An unreachable CDN
// makes every catalog image fail: the first ten already say
// everything, the others would only be traffic and quota burned on an ingest that
// learns nothing more. The cap is per family and not shared because a CDN down
// must not hide a blocking policy: they are two different problems, and whoever
// comes second is not to blame for how noisy the first is.
const MAX_FAILURES_PER_PAGE = 10

/// Readable labels for the elements that can fail to load. The
/// name ends up in the event message, which is the key the backend
/// groups by: "script non caricato: …" stays the same group at every occurrence.
const RESOURCE_LABELS: Record<string, string> = {
  script: 'script non caricato',
  link: 'foglio di stile non caricato',
  img: 'immagine non caricata',
  image: 'immagine non caricata',
  audio: 'audio non caricato',
  video: 'video non caricato',
  source: 'sorgente multimediale non caricata',
  track: 'traccia non caricata',
  iframe: 'contenuto incorporato non caricato',
  object: 'oggetto non caricato',
  embed: 'oggetto non caricato',
}

/// Installs the listeners (resources + CSP). Returns the uninstall function.
/// No-op outside the browser.
export function installResourceErrors(client: Client): () => void {
  if (typeof window === 'undefined') return () => {}

  // Keys already reported on this page, one collection per family: it acts as
  // deduplication (the same resource retrying is not worth a new report) and,
  // with its capacity, as a cap — which stays separate between resources and policies.
  const reported: Record<string, Set<string>> = {
    ResourceError: new Set(),
    CSPViolation: new Set(),
  }

  const capture = (
    name: 'ResourceError' | 'CSPViolation',
    key: string,
    message: string,
    contexts: Record<string, unknown>,
  ): void => {
    const seen = reported[name]!
    if (seen.has(key)) return
    if (seen.size >= MAX_FAILURES_PER_PAGE) return
    seen.add(key)
    client.captureException(
      { name, message },
      { level: 'warning', handled: true, contexts },
    )
  }

  const onError = (event: Event): void => {
    // A real JavaScript error: it belongs to `globalHandlers`, not touched here.
    const errorEvent = event as Partial<ErrorEvent> & Event
    if (errorEvent.error || errorEvent.message) return

    const target = event.target
    if (!target || target === window || !isElement(target)) return

    const url = resourceUrl(target)
    if (!url) return

    const element = target.tagName.toLowerCase()
    const label = RESOURCE_LABELS[element] ?? 'risorsa non caricata'
    capture('ResourceError', url, `${label}: ${url}`, {
      resource: { url, element },
    })
  }

  const onViolation = (event: Event): void => {
    const violation = event as Event & Partial<SecurityPolicyViolationEvent>
    const directive =
      violation.effectiveDirective || violation.violatedDirective || 'policy'
    const blocked = violation.blockedURI ? stripQuery(violation.blockedURI) : 'inline'
    const sourceFile = violation.sourceFile
      ? stripQuery(violation.sourceFile)
      : undefined

    capture(
      'CSPViolation',
      `${directive}:${blocked}`,
      `${directive} ha bloccato ${blocked}`,
      {
        csp: {
          blocked_uri: blocked,
          effective_directive: directive,
          ...(violation.disposition ? { disposition: violation.disposition } : {}),
          ...(sourceFile ? { source_file: sourceFile } : {}),
          ...(violation.lineNumber ? { line_number: violation.lineNumber } : {}),
        },
      },
    )
  }

  window.addEventListener('error', onError, true)
  if (typeof document !== 'undefined') {
    document.addEventListener('securitypolicyviolation', onViolation)
  }

  return () => {
    window.removeEventListener('error', onError, true)
    if (typeof document !== 'undefined') {
      document.removeEventListener('securitypolicyviolation', onViolation)
    }
  }
}

function isElement(target: EventTarget): target is Element {
  return typeof (target as Element).tagName === 'string'
}

// Address of the failed resource: `currentSrc` first — with `srcset` it is the
// browser that picks the variant, and the `src` attribute may be absent or
// point to another file — then `src`, `href` for stylesheets, `data` for
// embedded objects. Always without the query string: it may carry CDN signing
// tokens, and it is not needed to know which resource is missing.
function resourceUrl(element: Element): string | undefined {
  const current = (element as { currentSrc?: unknown }).currentSrc
  const raw =
    (typeof current === 'string' && current ? current : null) ??
    element.getAttribute('src') ??
    element.getAttribute('href') ??
    element.getAttribute('data')
  if (!raw) return undefined
  return stripQuery(raw)
}

function stripQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url
}
