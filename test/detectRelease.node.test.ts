// @vitest-environment node
// Node-side release auto-detect (CYJS-5): tag-first parity with the Ruby gem.
// On a real Node runtime the SDK reads the deploy ENV vars — the semver tag takes
// precedence, the SHA is the fallback. Only ENV, NEVER a git subprocess.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveOptions } from '../src/options'
import { detectRelease } from '../src/runtime'

const base = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_abc',
  projectId: 'proj-1',
}

// Isolates the release ENV vars: CI might already have some of them set.
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

describe('detectRelease (Node, tag-first — CYJS-5)', () => {
  it('auto-detects the semver tag from APP_GIT_TAG when options.release is missing', () => {
    process.env.APP_GIT_TAG = 'v1.4.2'
    expect(detectRelease()).toBe('v1.4.2')
    expect(resolveOptions(base).release).toBe('v1.4.2')
  })

  it('the consumer options.release always wins over the auto-detect', () => {
    process.env.APP_GIT_TAG = 'v1.4.2'
    expect(resolveOptions({ ...base, release: 'app@9.9.9' }).release).toBe('app@9.9.9')
  })

  it('APP_GIT_TAG takes precedence over GIT_TAG', () => {
    process.env.APP_GIT_TAG = 'v2.0.0'
    process.env.GIT_TAG = 'v1.0.0'
    expect(detectRelease()).toBe('v2.0.0')
  })

  it('uses GIT_TAG (semver without v) when APP_GIT_TAG is absent', () => {
    process.env.GIT_TAG = '3.1.0'
    expect(detectRelease()).toBe('3.1.0')
  })

  it('accepts a semver tag with a pre-release/build suffix', () => {
    process.env.APP_GIT_TAG = 'v1.2.3-rc.1'
    expect(detectRelease()).toBe('v1.2.3-rc.1')
  })

  it('ignores a non-semver tag (unknown) and falls back to the SHA (KAMAL_VERSION)', () => {
    process.env.APP_GIT_TAG = 'unknown'
    process.env.KAMAL_VERSION = 'abc1234'
    expect(detectRelease()).toBe('abc1234')
  })

  it('ignores a branch name as a tag and falls back to GIT_SHA', () => {
    process.env.GIT_TAG = 'feature/login'
    process.env.GIT_SHA = 'deadbeef'
    expect(detectRelease()).toBe('deadbeef')
  })

  it('KAMAL_VERSION takes precedence over GIT_SHA in the SHA fallback', () => {
    process.env.KAMAL_VERSION = 'kamal-9'
    process.env.GIT_SHA = 'sha-1'
    expect(detectRelease()).toBe('kamal-9')
  })

  it('undefined when no release ENV var is present', () => {
    expect(detectRelease()).toBeUndefined()
    expect(resolveOptions(base).release).toBeUndefined()
  })
})
