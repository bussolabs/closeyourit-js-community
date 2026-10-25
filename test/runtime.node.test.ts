// @vitest-environment node
import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isBrowser, isNode, runtimeContext, serverName } from '../src/runtime'

describe('runtime (node)', () => {
  it('detects Node', () => {
    expect(isBrowser()).toBe(false)
    expect(isNode()).toBe(true)
  })

  it('runtimeContext carries the process name and version', () => {
    expect(runtimeContext()).toEqual({ name: 'node', version: process.version })
  })

  it('serverName returns the machine hostname (parity with the Ruby gem)', () => {
    expect(serverName()).toBe(hostname())
  })

  it('serverName is undefined (without throwing) if getBuiltinModule is not exposed', () => {
    // Defense in depth: a Node runtime without process.getBuiltinModule
    // (< 20.16, below the engines minimum) must not crash, only omit.
    const original = process.getBuiltinModule
    ;(process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined
    try {
      expect(serverName()).toBeUndefined()
    } finally {
      process.getBuiltinModule = original
    }
  })
})
