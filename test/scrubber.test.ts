import { describe, expect, it } from 'vitest'
import { FILTERED, isSensitiveKey, scrub, scrubMessage } from '../src/scrubber'

describe('isSensitiveKey', () => {
  it('recognizes the sensitive keys shared with gem/dart', () => {
    for (const key of [
      'password',
      'passwd',
      'secret',
      'token',
      'api_key',
      'apiKey',
      'authorization',
      'cookie',
      'csrf',
      'credit_card',
      'cvv',
      'ssn',
      'iban',
    ]) {
      expect(isSensitiveKey(key)).toBe(true)
    }
  })

  it('includes email (browser hardening)', () => {
    expect(isSensitiveKey('email')).toBe(true)
    expect(isSensitiveKey('e-mail')).toBe(true)
    expect(isSensitiveKey('e_mail')).toBe(true)
    expect(isSensitiveKey('userEmail')).toBe(true)
  })

  it('lets the non-sensitive keys through', () => {
    for (const key of ['id', 'name', 'order_id', 'count', 'status']) {
      expect(isSensitiveKey(key)).toBe(false)
    }
  })
})

describe('scrub', () => {
  it('redacts the values of the sensitive keys', () => {
    const result = scrub({ id: 1, password: 'hunter2', token: 'abc' })
    expect(result).toEqual({ id: 1, password: FILTERED, token: FILTERED })
  })

  it('traverses nested objects and arrays', () => {
    const result = scrub({
      user: { id: 1, authorization: 'Bearer x' },
      items: [{ card: '4242', qty: 2 }],
    })
    expect(result).toEqual({
      user: { id: 1, authorization: FILTERED },
      items: [{ card: FILTERED, qty: 2 }],
    })
  })

  it('redacts the whole value even if it is an object', () => {
    const result = scrub({ secret: { nested: 'x' } })
    expect(result).toEqual({ secret: FILTERED })
  })

  it('preserves primitives and null', () => {
    expect(scrub(42)).toBe(42)
    expect(scrub('hello')).toBe('hello')
    expect(scrub(null)).toBe(null)
  })

  it('handles circular references without looping', () => {
    const obj: Record<string, unknown> = { id: 1 }
    obj['self'] = obj
    const result = scrub(obj) as Record<string, unknown>
    expect(result['id']).toBe(1)
    expect(result['self']).toBe('[Circular]')
  })
})

describe('scrubMessage', () => {
  it('redacts the sensitive_key=value assignments', () => {
    expect(scrubMessage('login failed password=hunter2 for user')).toContain(FILTERED)
    expect(scrubMessage('token: abc123')).toBe(FILTERED)
  })

  it('leaves a message without secrets untouched', () => {
    expect(scrubMessage('cache miss for key foo')).toBe('cache miss for key foo')
  })
})

// CYJS-38 — an access header written inside free text (the message of
// an exception, a log line with the `curl` that failed) only took away the
// scheme: `Authorization: Bearer …` became `[FILTERED] <value>`, i.e. the secret
// stayed in clear. Placeholders, never real credentials.
describe('scrubMessage — access headers in free text (CYJS-38)', () => {
  it('redacts the value after Bearer keeping the header name readable', () => {
    const redacted = scrubMessage('Authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).toBe(`Authorization: ${FILTERED}`)
    expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).not.toContain('Bearer')
  })

  it('ignores case and spacing, and covers Basic as well as Bearer', () => {
    expect(scrubMessage('authorization:Bearer EXAMPLE_NOT_A_CREDENTIAL')).toBe(
      `authorization:${FILTERED}`,
    )
    expect(scrubMessage('AUTHORIZATION:   Basic EXAMPLE_NOT_A_CREDENTIAL')).toBe(
      `AUTHORIZATION:   ${FILTERED}`,
    )
  })

  it('also covers the equals-sign form', () => {
    const redacted = scrubMessage('Authorization=Bearer EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).toBe(`Authorization=${FILTERED}`)
    expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
  })

  it('covers the other authentication and origin headers', () => {
    for (const line of [
      'Proxy-Authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL',
      'Cookie: theme=dark; sid=EXAMPLE_NOT_A_CREDENTIAL',
      'Set-Cookie: sid=EXAMPLE_NOT_A_CREDENTIAL; HttpOnly',
      'X-Api-Key: EXAMPLE_NOT_A_CREDENTIAL',
      'X-Auth-Token: EXAMPLE_NOT_A_CREDENTIAL',
      'X-Forwarded-For: 203.0.113.7',
      'X-Real-IP: 203.0.113.7',
      'True-Client-IP: 203.0.113.7',
      'Forwarded: for=203.0.113.7',
    ]) {
      const redacted = scrubMessage(line)
      expect(redacted).toContain(FILTERED)
      expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
      expect(redacted).not.toContain('203.0.113.7')
    }
  })

  it('redacts the authentication scheme even under a non-canonical key', () => {
    // `user_authorization` is not a header name: without the scheme rule
    // the pair would stop at `Bearer` and leave the value in clear.
    const redacted = scrubMessage('user_authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).toContain(FILTERED)
  })

  it('stops at end of line: the rest of the message stays readable', () => {
    const redacted = scrubMessage(
      'POST /api/v1/events failed\nAuthorization: Bearer EXAMPLE_NOT_A_CREDENTIAL\nresponse 401 Unauthorized',
    )
    expect(redacted).toBe(
      `POST /api/v1/events failed\nAuthorization: ${FILTERED}\nresponse 401 Unauthorized`,
    )
  })

  it('leaves untouched the prose that names authorization without carrying its value', () => {
    for (const message of [
      'authorization failed for user 42',
      'cache miss for key foo',
      'the cookie banner was dismissed',
    ]) {
      expect(scrubMessage(message)).toBe(message)
    }
  })

  it('is idempotent: passing an already redacted text again does not change it', () => {
    const once = scrubMessage('Authorization: Bearer EXAMPLE_NOT_A_CREDENTIAL')
    expect(scrubMessage(once)).toBe(once)
  })

  it('the structured header stays redacted by key, as before', () => {
    expect(
      scrub({ headers: { Authorization: 'Bearer EXAMPLE_NOT_A_CREDENTIAL' } }),
    ).toEqual({
      headers: { Authorization: FILTERED },
    })
  })
})

// CYJS-38 review finding: a request dump breaks the line after the header
// name. Stopping at end of line redacted the empty string and left the whole secret
// one line below — a regression compared with the previous rule, which did catch
// the value on the next line.
describe('scrubMessage — header with the value on the next line (CYJS-38)', () => {
  it('redacts the value that wrapped to the next line, with or without an authentication scheme', () => {
    for (const input of [
      'Authorization:\nEXAMPLE_NOT_A_CREDENTIAL',
      'Authorization:\nBearer EXAMPLE_NOT_A_CREDENTIAL',
      'Cookie:\n  sid=EXAMPLE_NOT_A_CREDENTIAL',
    ]) {
      const redacted = scrubMessage(input)
      expect(redacted).toContain(FILTERED)
      expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
    }
  })

  it('consumes only the value line: the rest of the message stays readable', () => {
    const redacted = scrubMessage(
      'request rejected\nAuthorization:\nBearer EXAMPLE_NOT_A_CREDENTIAL\nresponse 401 Unauthorized',
    )
    expect(redacted).not.toContain('EXAMPLE_NOT_A_CREDENTIAL')
    expect(redacted).toContain('request rejected')
    expect(redacted).toContain('response 401 Unauthorized')
  })

  it('a header without a value stays redacted as empty without eating the next line', () => {
    expect(scrubMessage('Authorization:\n\norder 42 created')).toBe(
      `Authorization:${FILTERED}\n\norder 42 created`,
    )
  })
})
