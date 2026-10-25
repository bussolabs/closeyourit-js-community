import { describe, expect, it } from 'vitest'
import { isBrowser, isNode, runtimeContext, serverName } from '../src/runtime'

// Default environment of the suite: jsdom → the browser branch must win even
// if `process` exists (Node under jsdom).
describe('runtime (jsdom)', () => {
  it('detects the browser', () => {
    expect(isBrowser()).toBe(true)
    expect(isNode()).toBe(false)
  })

  it('runtimeContext is browser', () => {
    expect(runtimeContext()).toEqual({ name: 'browser' })
  })

  it('serverName is undefined in the browser (hostname is server-only)', () => {
    expect(serverName()).toBeUndefined()
  })
})
