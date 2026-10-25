// Shared History API patch: intercepts pushState/replaceState/popstate
// and notifies the subscribers at every URL change. The monkey-patch is installed ONLY
// ONCE at the first subscriber and restored when the last one unsubscribes —
// so navigation breadcrumbs and pageviews can coexist without a double
// patch. Extracted from `breadcrumbs.ts` (the former `installNavigation`) to share it.

/// Notified at every URL change: [to] is the new href, [from] the previous one
/// (`null` if not known yet).
export type NavigationListener = (to: string, from: string | null) => void

const listeners = new Set<NavigationListener>()
let uninstallPatch: (() => void) | null = null
let lastHref = ''

/// Registers [listener] on SPA URL changes (pushState/replaceState/popstate) and
/// returns the unsubscribe function. The History patch is shared:
/// installed at the first subscriber, restored when the last one leaves.
export function subscribeNavigation(listener: NavigationListener): () => void {
  listeners.add(listener)
  if (uninstallPatch === null) uninstallPatch = installPatch()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && uninstallPatch !== null) {
      uninstallPatch()
      uninstallPatch = null
    }
  }
}

function installPatch(): () => void {
  if (typeof window === 'undefined' || typeof history === 'undefined') {
    return noop
  }

  lastHref = safeHref()

  const record = (): void => {
    const to = safeHref()
    if (to === lastHref) return
    const from = lastHref
    lastHref = to
    // Defensive copy: a listener might unsubscribe during the notification.
    for (const listener of [...listeners]) listener(to, from)
  }

  const originalPush = history.pushState
  const originalReplace = history.replaceState

  history.pushState = function patchedPush(
    this: History,
    ...args: Parameters<History['pushState']>
  ): void {
    originalPush.apply(this, args)
    record()
  }
  history.replaceState = function patchedReplace(
    this: History,
    ...args: Parameters<History['replaceState']>
  ): void {
    originalReplace.apply(this, args)
    record()
  }
  window.addEventListener('popstate', record)

  return () => {
    history.pushState = originalPush
    history.replaceState = originalReplace
    window.removeEventListener('popstate', record)
  }
}

const noop = (): void => {}

function safeHref(): string {
  return typeof location !== 'undefined' ? location.href : ''
}
