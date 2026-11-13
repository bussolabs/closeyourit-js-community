// Text of a log or diagnostic message received from the host (CYJS-77). The
// typings ask for a string, but plain JavaScript callers pass anything — most
// often a whole `Error` — and the scrubber used to throw on it. Same criterion
// as the console breadcrumbs: an `Error` becomes its message (its name when the
// message is empty), any other value its wire JSON. `null`/`undefined` and a
// value whose conversion throws become the empty string, which the callers drop.

import { toWireJson } from './wireJson'

/// [value] as message text; `''` when missing or not convertible.
export function messageText(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value == null) return ''
    if (value instanceof Error) return String(value.message || value.name)
    return toWireJson(value) ?? String(value)
  } catch {
    return ''
  }
}
