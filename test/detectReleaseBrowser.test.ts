// Browser scenario (CYJS-5): no auto-detect from the environment. jsdom exposes
// window/document → browser runtime: process variables are NOT read
// (even if they exist under the Node test runner), only `options.release` remains
// (which in the browser must be passed explicitly, build-time inject).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveOptions } from '../src/options'
import { detectRelease } from '../src/runtime'

const base = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'proj-1',
}

const RELEASE_ENV = ['APP_GIT_TAG', 'GIT_TAG', 'KAMAL_VERSION', 'GIT_SHA'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of RELEASE_ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of RELEASE_ENV) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('detectRelease (browser unchanged — CYJS-5)', () => {
  it('does not auto-detect in the browser, not even with the deploy ENV vars present', () => {
    process.env.APP_GIT_TAG = 'v9.9.9'
    process.env.KAMAL_VERSION = 'kamal-x'
    expect(detectRelease()).toBeUndefined()
    expect(resolveOptions(base).release).toBeUndefined()
  })

  it('in the browser the release passed in the options stays', () => {
    process.env.APP_GIT_TAG = 'v9.9.9'
    expect(resolveOptions({ ...base, release: 'web@1.4.2' }).release).toBe('web@1.4.2')
  })
})
