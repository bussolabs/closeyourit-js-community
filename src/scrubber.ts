// Client-side PII redaction, before sending. Mirror of `CloseYourIt::Scrubber`
// (gem) and `Scrubber` (dart): recursively redacts the values whose **key**
// matches the denylist of sensitive fields.
//
// The denylist shares its core with backend/gem/dart
// (`pass|secret|token|api[_-]?key|apikey|authorization|cookie|csrf|credit|card|cvv|ssn|iban`)
// and adds `email` — the browser is a high PII-risk context and the email is
// the most common personal data that ends up by mistake in attributes/context. It is a
// superset (more restrictive), not a different format: the backend re-scrubs anyway.

// Single source of the key tokens: `SENSITIVE_KEY` (keys of structured data) and
// the free-text rules cannot diverge.
const KEY_TOKENS =
  'pass|secret|token|api[_-]?key|apikey|authorization|cookie|csrf|credit|card|cvv|ssn|iban|e[_-]?mail'

const SENSITIVE_KEY = new RegExp(KEY_TOKENS, 'i')

// CYJS-38 — the three shapes in which a credential ends up inside free text, in the
// same shape as the backend PII authority (`Ingest::PiiScrubbing`): the redaction keeps
// the sentence standing, replacing only the value. A single `replace` pass, with the
// alternatives in priority order: what one rule has already consumed is not
// re-examined by the following ones, and the result is idempotent.

// 1. Header written in the text (`Authorization: Bearer …`, `Cookie: a=1; sid=…`).
// The value is taken up to END OF LINE, not up to the first space: an authentication
// scheme is made of two words and a cookie of several pairs separated by semicolons —
// stopping earlier left exactly the secret in clear (`[FILTERED] <token>`).
// If the line is empty after the separator the value is on the next line (a request
// dump wrapped onto a new line): that one must be taken, otherwise the header line
// would be redacted for nothing and the secret would stay whole one line below.
// Names aligned 1:1 with `PiiScrubbing::SENSITIVE_HEADER_NAMES`, sorted longest first
// so `proxy-authorization`/`set-cookie`/`x-forwarded-for` win over their suffix.
// The separator also accepts `=` (superset of the backend, which wants `:` here):
// `Authorization=Bearer …` is the same credential written another way.
const SENSITIVE_HEADER_NAMES = [
  'proxy-authorization',
  'authorization',
  'set-cookie',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'x-forwarded-for',
  'x-real-ip',
  'true-client-ip',
  'forwarded',
]

// 2. Authentication scheme as the value of any sensitive key
// (`user_authorization: Bearer …`): the name is not a canonical header, but the value is a
// two-word credential and must be taken up to end of line for the same reason.
const AUTH_SCHEMES =
  'bearer|basic|digest|token|apikey|api-key|oauth|negotiate|ntlm|hmac'

// 3. Assignment `sensitive_key=value` (or `:`) — the historical case, unchanged: the
// value stops at the first space, so the rest of the sentence stays readable.
const SENSITIVE_IN_MESSAGE = new RegExp(
  [
    `\\b(${SENSITIVE_HEADER_NAMES.join('|')})([ \\t]*[=:][ \\t]*)(?:[^\\r\\n]+|\\r?\\n[ \\t]*[^\\r\\n]+)?`,
    `(?:${KEY_TOKENS})[\\w-]*\\s*[=:]\\s*(?:${AUTH_SCHEMES})\\b[^\\r\\n]*`,
    `(?:${KEY_TOKENS})[\\w-]*\\s*[=:]\\s*\\S+`,
  ].join('|'),
  'gi',
)

export const FILTERED = '[FILTERED]'

/// `true` if the key is considered sensitive (partial match, case-insensitive).
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

/// Deep copy of [value] with the sensitive values redacted. A matching key
/// redacts the whole value (maps/lists too); nested Maps and Arrays
/// are traversed. Cycles guarded by `seen`.
export function scrub<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  return scrubValue(value, seen) as T
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((item) => scrubValue(item, seen))
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const input = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(input)) {
      result[key] = isSensitiveKey(key) ? FILTERED : scrubValue(input[key], seen)
    }
    return result
  }
  return value
}

/// Redacts the secrets inside a free-text message (e.g. an exception's message
/// or a log line), before sending: the `sensitive_key=value` pairs and the
/// access headers written out in full.
///
/// A header keeps its own name and loses the value
/// (`Authorization: Bearer x` → `Authorization: [FILTERED]`): same shape as the backend,
/// which is the PII authority, so the redacted text is identical whichever SDK it comes from.
export function scrubMessage(input: string): string {
  return input.replace(
    SENSITIVE_IN_MESSAGE,
    (match, headerName?: string, separator?: string) =>
      headerName === undefined ? FILTERED : `${headerName}${separator}${FILTERED}`,
  )
}
