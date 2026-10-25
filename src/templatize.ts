// Templatization of HTTP paths for metric grouping: the variable ids
// (uuids, numeric runs) become placeholders, so requests to the same route
// share the signature. Parity with `NetHTTPPatch` (gem) and
// `dio_interceptor` (dart): uuid→`<uuid>`, runs of ≥3 digits→`<n>`.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LONG_NUMBER_RE = /\d{3,}/g

export function templatizePath(path: string): string {
  return path.replace(UUID_RE, '<uuid>').replace(LONG_NUMBER_RE, '<n>')
}
