// UUID v4 without dashes for `event_id`, and generator of the page `trace_id`.
// Uses `crypto.getRandomValues` when available, falling back to `Math.random`.

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

/// Canonical UUID v4 (with dashes).
export function uuidV4(): string {
  const b = randomBytes(16)
  // Version (4) and variant (10xx) per RFC 4122.
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex: string[] = []
  for (let i = 0; i < 16; i++) hex.push(b[i]!.toString(16).padStart(2, '0'))
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  )
}

/// UUID v4 without dashes — the `event_id` format accepted by the ingest.
export function uuidV4NoDashes(): string {
  return uuidV4().replace(/-/g, '')
}

/// W3C Trace Context span-id: 8 random bytes in hex (16 chars). It identifies
/// the single operation and is the `parent-id` of the propagated traceparent. Bit 0
/// of the first byte is forced to 1 so the span-id is never all-zero (a value
/// reserved/invalid per the standard), as `uuidV4` forces version and variant.
export function spanId(): string {
  const b = randomBytes(8)
  b[0] = b[0]! | 0x01
  let hex = ''
  for (let i = 0; i < 8; i++) hex += b[i]!.toString(16).padStart(2, '0')
  return hex
}
