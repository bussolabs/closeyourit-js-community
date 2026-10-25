import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPageview } from '../src/pageviews'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { value, configurable: true })
}

beforeEach(() => {
  history.replaceState({}, '', '/')
  setReferrer('')
})

afterEach(() => {
  setReferrer('')
})

describe('buildPageview', () => {
  it('composes event_id, hostname, path and occurred_at from the location', () => {
    history.replaceState({}, '', '/articles/foo')
    const pv = buildPageview()

    expect(pv.event_id).toMatch(UUID_RE)
    expect(pv.hostname).toBe(location.hostname)
    expect(pv.path).toBe('/articles/foo')
    // occurred_at is a valid ISO8601 with a stable round-trip.
    expect(pv.occurred_at).toBe(new Date(pv.occurred_at).toISOString())
  })

  it('omits referrer when document.referrer is empty', () => {
    setReferrer('')
    expect(buildPageview()).not.toHaveProperty('referrer')
  })

  it('includes the raw referrer when present', () => {
    setReferrer('https://www.google.com/search?q=secret')
    expect(buildPageview().referrer).toBe('https://www.google.com/search?q=secret')
  })

  it('extracts the 5 utm keys (source/medium/campaign/term/content), never the whole query', () => {
    history.replaceState(
      {},
      '',
      '/land?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=shoes&utm_content=banner-a&gclid=abc&x=1',
    )
    const pv = buildPageview()

    expect(pv.utm_source).toBe('newsletter')
    expect(pv.utm_medium).toBe('email')
    expect(pv.utm_campaign).toBe('launch')
    expect(pv.utm_term).toBe('shoes')
    expect(pv.utm_content).toBe('banner-a')
    // The whole query does NOT travel: no foreign key in the payload.
    expect(JSON.stringify(pv)).not.toContain('gclid')
    expect(JSON.stringify(pv)).not.toContain('"x"')
  })

  it('omits the missing UTMs', () => {
    history.replaceState({}, '', '/no-utm?x=1')
    const pv = buildPageview()

    expect(pv).not.toHaveProperty('utm_source')
    expect(pv).not.toHaveProperty('utm_medium')
    expect(pv).not.toHaveProperty('utm_campaign')
    expect(pv).not.toHaveProperty('utm_term')
    expect(pv).not.toHaveProperty('utm_content')
  })

  it('includes screen_width from the current viewport', () => {
    const pv = buildPageview()
    expect(pv.screen_width).toBe(window.innerWidth)
    expect(typeof pv.screen_width).toBe('number')
  })

  it('the query string NEVER enters the path', () => {
    history.replaceState({}, '', '/pricing?utm_source=x&foo=bar')
    const pv = buildPageview()

    expect(pv.path).toBe('/pricing')
    expect(pv.path).not.toContain('?')
  })

  it('overrides.path forces the path (default location.pathname)', () => {
    history.replaceState({}, '', '/real')
    expect(buildPageview({ path: '/virtual' }).path).toBe('/virtual')
    expect(buildPageview().path).toBe('/real')
  })
})
