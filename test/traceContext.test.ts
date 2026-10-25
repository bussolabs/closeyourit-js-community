import { describe, expect, it } from 'vitest'
import {
  formatTraceparent,
  isSameOrigin,
  matchesPropagationTarget,
  normalizeBaggage,
  parseTraceparent,
  parseTracestate,
  readTraceHeader,
} from '../src/traceContext'

// Canonical traceparent from the W3C example (version 00, sampled).
const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('parseTraceparent', () => {
  it('extracts trace-id, parent-id and sampled from a valid header', () => {
    const tp = parseTraceparent(VALID)
    expect(tp).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      sampled: true,
    })
  })

  it('reads the sampling flag from bit 0 of trace-flags', () => {
    expect(parseTraceparent(VALID.replace('-01', '-00'))?.sampled).toBe(false)
    // Bit 0 on even with other reserved bits set (0x03).
    expect(parseTraceparent(VALID.replace('-01', '-03'))?.sampled).toBe(true)
    expect(parseTraceparent(VALID.replace('-01', '-02'))?.sampled).toBe(false)
  })

  it('accepts a future version ignoring the extra fields (forward-compat)', () => {
    const future = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'
    expect(parseTraceparent(future)?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
  })

  it('rejects version ff (reserved)', () => {
    expect(parseTraceparent(VALID.replace(/^00/, 'ff'))).toBeNull()
  })

  it('rejects an all-zero trace-id or parent-id', () => {
    expect(
      parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    ).toBeNull()
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
    ).toBeNull()
  })

  it('rejects non-hexadecimal or uppercase characters (lowercase-only)', () => {
    expect(parseTraceparent(VALID.toUpperCase())).toBeNull()
    expect(
      parseTraceparent('00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toBeNull()
  })

  it('rejects non-hexadecimal version or trace-flags', () => {
    expect(
      parseTraceparent('gg-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toBeNull()
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz'),
    ).toBeNull()
  })

  it('rejects wrong field lengths and missing fields', () => {
    expect(parseTraceparent('00-4bf9-00f067aa0ba902b7-01')).toBeNull()
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f0-01')).toBeNull()
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'),
    ).toBeNull()
    // version 00 does not allow extra fields (it must be exactly 4 fields).
    expect(parseTraceparent(`${VALID}-extra`)).toBeNull()
  })

  it('is null-safe on missing or empty values', () => {
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('   ')).toBeNull()
  })
})

describe('formatTraceparent', () => {
  it('composes a version 00 traceparent with the sampling flag', () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736'
    const span = '00f067aa0ba902b7'
    expect(formatTraceparent(trace, span, true)).toBe(`00-${trace}-${span}-01`)
    expect(formatTraceparent(trace, span, false)).toBe(`00-${trace}-${span}-00`)
  })

  it('produces a re-parsable traceparent', () => {
    const out = formatTraceparent(
      '4bf92f3577b34da6a3ce929d0e0e4736',
      '00f067aa0ba902b7',
      true,
    )
    expect(parseTraceparent(out)?.sampled).toBe(true)
  })
})

describe('parseTracestate', () => {
  it('keeps a valid tracestate as an opaque string', () => {
    expect(parseTracestate('rojo=00f067aa0ba902b7,congo=t61rcWkgMzE')).toBe(
      'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
    )
  })

  it('drops the malformed members keeping the valid ones', () => {
    expect(parseTracestate('rojo=1, ,=novalue,bad,congo=2')).toBe('rojo=1,congo=2')
  })

  it('drops the members with a non-conforming key or an empty value', () => {
    expect(parseTracestate('ROJO=1')).toBeUndefined() // non-lowercase key
    expect(parseTracestate('rojo=')).toBeUndefined() // empty value
  })

  it('drops a member with a value over 256 characters', () => {
    expect(parseTracestate(`k=${'v'.repeat(300)}`)).toBeUndefined()
  })

  it('truncates to 32 members (W3C limit)', () => {
    const members = Array.from({ length: 40 }, (_, i) => `k${i}=v${i}`)
    const out = parseTracestate(members.join(','))
    expect(out?.split(',')).toHaveLength(32)
  })

  it('returns undefined on empty or entirely invalid', () => {
    expect(parseTracestate(undefined)).toBeUndefined()
    expect(parseTracestate('')).toBeUndefined()
    expect(parseTracestate('===,,,')).toBeUndefined()
  })
})

describe('normalizeBaggage', () => {
  it('keeps a valid baggage (opaque string)', () => {
    expect(normalizeBaggage('userId=alice,plan=pro')).toBe('userId=alice,plan=pro')
  })

  it('drops empty, with control characters or over 8192 bytes', () => {
    expect(normalizeBaggage(undefined)).toBeUndefined()
    expect(normalizeBaggage('   ')).toBeUndefined()
    expect(normalizeBaggage('key=val\x00ue')).toBeUndefined()
    expect(normalizeBaggage('key=val\nue')).toBeUndefined()
    expect(normalizeBaggage('x'.repeat(8193))).toBeUndefined()
  })
})

describe('matchesPropagationTarget', () => {
  it('matches a string target on the host, exactly or as a parent domain', () => {
    expect(
      matchesPropagationTarget('https://api.example.com/v1', ['api.example.com']),
    ).toBe(true)
    expect(
      matchesPropagationTarget('https://v2.api.example.com/v1', ['example.com']),
    ).toBe(true)
    expect(
      matchesPropagationTarget('http://127.0.0.1:39591/x', ['127.0.0.1:39591']),
    ).toBe(true)
    expect(matchesPropagationTarget('https://other.com/v1', ['api.example.com'])).toBe(
      false,
    )
  })

  it('does not match a string target found outside the host', () => {
    // A substring match would leak the trace (and baggage) to attacker.example.
    expect(
      matchesPropagationTarget('https://attacker.example/?api.internal', [
        'api.internal',
      ]),
    ).toBe(false)
    expect(
      matchesPropagationTarget('https://api.internal.attacker.example/', [
        'api.internal',
      ]),
    ).toBe(false)
    expect(matchesPropagationTarget('https://notapi.internal/', ['api.internal'])).toBe(
      false,
    )
    expect(matchesPropagationTarget('/relative/path', ['api.internal'])).toBe(false)
  })

  it('matches a string target with a scheme on protocol, hostname and declared port', () => {
    // `location.origin` and `http://127.0.0.1` are the common real-world shapes.
    expect(
      matchesPropagationTarget('http://127.0.0.1:4173/x', ['http://127.0.0.1']),
    ).toBe(true)
    expect(matchesPropagationTarget('https://127.0.0.1/', ['http://127.0.0.1'])).toBe(
      false,
    )
    expect(
      matchesPropagationTarget('http://127.0.0.1.evil.example/', ['http://127.0.0.1']),
    ).toBe(false)
    expect(
      matchesPropagationTarget('https://api.example.com:8443/v1', [
        'https://api.example.com:8443',
      ]),
    ).toBe(true)
    expect(
      matchesPropagationTarget('https://api.example.com/v1', [
        'https://api.example.com:8443',
      ]),
    ).toBe(false)
    expect(
      matchesPropagationTarget('https://app.example.com/api', [
        'https://app.example.com/',
      ]),
    ).toBe(true)
    // An explicit standard port still pins the port: `URL.port` would hide it.
    expect(
      matchesPropagationTarget('https://api.example.com/x', [
        'https://api.example.com:443',
      ]),
    ).toBe(true)
    expect(
      matchesPropagationTarget('https://api.example.com:8443/x', [
        'https://api.example.com:443',
      ]),
    ).toBe(false)
    expect(
      matchesPropagationTarget('http://127.0.0.1:4173', ['http://127.0.0.1:80']),
    ).toBe(false)
    expect(
      matchesPropagationTarget('https://attacker.example/?https://app.example.com', [
        'https://app.example.com',
      ]),
    ).toBe(false)
  })

  it('RegExp match on the full URL', () => {
    expect(
      matchesPropagationTarget('https://api.example.com/v1', [/^https:\/\/api\./]),
    ).toBe(true)
  })

  it('is deterministic with global/sticky RegExps (no lastIndex state)', () => {
    // `test()` on a RegExp with the g/y flag advances `lastIndex`: without sanitizing it
    // the check of the same destination would alternate true/false across calls.
    const global = /api\.internal/g
    expect(matchesPropagationTarget('https://api.internal/x', [global])).toBe(true)
    expect(matchesPropagationTarget('https://api.internal/x', [global])).toBe(true)
    expect(global.lastIndex).toBe(0)
    const sticky = /api\.internal/y
    expect(matchesPropagationTarget('https://api.internal/x', [sticky])).toBe(true)
    expect(matchesPropagationTarget('https://api.internal/x', [sticky])).toBe(true)
  })

  it('preserves the case-insensitive flag in the match', () => {
    expect(matchesPropagationTarget('https://API.internal/x', [/api\.internal/i])).toBe(
      true,
    )
  })

  it('ignores empty string targets (they do not match everything)', () => {
    expect(matchesPropagationTarget('https://any.com', [''])).toBe(false)
  })

  it('no match with an empty allowlist', () => {
    expect(matchesPropagationTarget('https://any.com', [])).toBe(false)
  })
})

describe('isSameOrigin', () => {
  it('true for a relative URL or same origin', () => {
    expect(isSameOrigin('/api/v1', 'https://app.example.com')).toBe(true)
    expect(isSameOrigin('https://app.example.com/api', 'https://app.example.com')).toBe(
      true,
    )
  })

  it('false for a different origin or an unparsable base', () => {
    expect(isSameOrigin('https://evil.com/api', 'https://app.example.com')).toBe(false)
    expect(isSameOrigin('/api', 'not-a-valid-origin')).toBe(false)
  })
})

describe('readTraceHeader', () => {
  it('reads from a case-insensitive getter', () => {
    const carrier = (name: string): string | undefined =>
      name.toLowerCase() === 'traceparent' ? VALID : undefined
    expect(readTraceHeader(carrier, 'traceparent')).toBe(VALID)
    expect(readTraceHeader(carrier, 'tracestate')).toBeUndefined()
  })

  it('reads from a header object with keys of arbitrary case', () => {
    expect(readTraceHeader({ TraceParent: VALID }, 'traceparent')).toBe(VALID)
    expect(readTraceHeader({ traceparent: VALID }, 'traceparent')).toBe(VALID)
  })

  it('takes the first value from a multi-value header (array)', () => {
    expect(readTraceHeader({ traceparent: [VALID, 'x'] }, 'traceparent')).toBe(VALID)
  })

  it('reads from a Headers object', () => {
    const headers = new Headers({ traceparent: VALID })
    expect(readTraceHeader(headers, 'traceparent')).toBe(VALID)
  })

  it('returns undefined on a missing header', () => {
    expect(readTraceHeader({}, 'traceparent')).toBeUndefined()
  })
})
