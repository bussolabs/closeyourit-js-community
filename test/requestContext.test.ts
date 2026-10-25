import { afterEach, describe, expect, it } from 'vitest'
import { autoRequestContext } from '../src/requestContext'

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { value, configurable: true })
}

afterEach(() => setReferrer(''))

describe('autoRequestContext', () => {
  it('without sendPii: url without query, plus User-Agent', () => {
    const request = autoRequestContext(false)!
    expect(String(request['url'])).toBe(location.origin + location.pathname)
    expect((request['headers'] as Record<string, string>)['User-Agent']).toBe(
      navigator.userAgent,
    )
    expect(request).not.toHaveProperty('referrer')
  })

  it('with sendPii: full url (href)', () => {
    const request = autoRequestContext(true)!
    expect(String(request['url'])).toBe(location.href)
  })

  it('referrer present: stripped without sendPii, whole with sendPii', () => {
    setReferrer('https://ref.test/page?utm=1#frag')
    expect(autoRequestContext(false)!['referrer']).toBe('https://ref.test/page')
    expect(autoRequestContext(true)!['referrer']).toBe(
      'https://ref.test/page?utm=1#frag',
    )
  })

  it('non-URL referrer: split fallback without query', () => {
    setReferrer('relative-page?x=1#f')
    expect(autoRequestContext(false)!['referrer']).toBe('relative-page')
  })
})
