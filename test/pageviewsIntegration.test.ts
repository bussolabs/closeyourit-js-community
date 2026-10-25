import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../src/client'
import { installPageviews } from '../src/integrations/browser/pageviews'

let uninstall: () => void = () => {}
afterEach(() => {
  uninstall()
  uninstall = () => {}
})

function harness(): { client: Client; count: () => number } {
  let calls = 0
  const client = {
    capturePageview: () => {
      calls += 1
    },
  } as unknown as Client
  return { client, count: () => calls }
}

describe('installPageviews', () => {
  it('emits an initial pageview on install', () => {
    const { client, count } = harness()
    uninstall = installPageviews(client)
    expect(count()).toBe(1)
  })

  it('emits a new pageview when the pathname changes', () => {
    history.replaceState({}, '', '/a')
    const { client, count } = harness()
    uninstall = installPageviews(client) // initial
    history.pushState({}, '', '/b')
    expect(count()).toBe(2)
  })

  it('does NOT emit on a hash change or replaceState on the same pathname', () => {
    history.replaceState({}, '', '/same')
    const { client, count } = harness()
    uninstall = installPageviews(client) // initial
    history.pushState({}, '', '/same#section') // same pathname → skip
    history.replaceState({}, '', '/same?x=1') // same pathname → skip
    expect(count()).toBe(1)
  })

  it('emits on every distinct pathname transition', () => {
    history.replaceState({}, '', '/a')
    const { client, count } = harness()
    uninstall = installPageviews(client) // initial (1)
    history.pushState({}, '', '/b') // 2
    history.pushState({}, '', '/c') // 3
    history.pushState({}, '', '/c') // same pathname → skip
    expect(count()).toBe(3)
  })

  it('after uninstall it emits no more pageviews', () => {
    history.replaceState({}, '', '/x')
    const { client, count } = harness()
    const off = installPageviews(client) // initial (1)
    off()
    history.pushState({}, '', '/y')
    expect(count()).toBe(1)
  })
})
