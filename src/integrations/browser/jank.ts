// Main thread jank detection via PerformanceObserver(longtask).
// A long task beyond `jankThresholdMs` (default 100 — longtask entries already
// have a 50ms floor) emits a `performance_issue` verdict with subtype `jank` and the
// current templatized route. longtask is in practice Chromium-only: where it is not
// supported the integration is a silent no-op.

import type { Client } from '../../client'
import { templatizePath } from '../../templatize'

interface LongTaskEntry {
  duration: number
}

interface LongTaskList {
  getEntries(): LongTaskEntry[]
}

/// Installs the observer. Returns the uninstall function.
export function installJankDetection(client: Client): () => void {
  const Observer = globalThis.PerformanceObserver as
    (typeof PerformanceObserver & { supportedEntryTypes?: string[] }) | undefined
  if (!Observer || !Observer.supportedEntryTypes?.includes('longtask')) {
    return () => {}
  }

  const observer = new Observer((list) => {
    for (const entry of (list as LongTaskList).getEntries()) {
      if (entry.duration <= client.options.jankThresholdMs) continue
      client.recordJank(entry.duration, currentRoute())
    }
  })

  try {
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    return () => {}
  }

  return () => observer.disconnect()
}

function currentRoute(): string {
  if (typeof location === 'undefined') return '<unknown>'
  return templatizePath(location.pathname)
}
