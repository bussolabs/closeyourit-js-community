// Pageview auto-tracking (opt-in `trackPageviews`). Emits a pageview at
// load and at every `pathname` change, reusing the shared History patch
// (`navigation.ts`) — so navigation breadcrumbs and pageviews do not double the
// monkey-patch. Installed only in the browser (`init` gates on `isBrowser()`).
//
// Dedup on the `pathname` (Plausible semantics, no timer): a hash change or a
// `replaceState` repeated on the same path do NOT produce a new pageview.

import type { Client } from '../../client'
import { subscribeNavigation } from './navigation'

/// Emits the initial pageview and subscribes to pathname changes. Returns the
/// uninstall function (unsubscribes from the shared patch).
export function installPageviews(client: Client): () => void {
  client.capturePageview()
  let lastPathname = location.pathname

  return subscribeNavigation(() => {
    if (location.pathname === lastPathname) return
    lastPathname = location.pathname
    client.capturePageview()
  })
}
