import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { close, getReplaySessionId, init } from '../src/index'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

beforeEach(() => {
  sessionStorage.clear()
  // Fake rrweb recorder (global loaded by the page).
  ;(globalThis as { rrweb?: unknown }).rrweb = { record: () => () => {} }
})

afterEach(async () => {
  await close()
  delete (globalThis as { rrweb?: unknown }).rrweb
})

describe('init — session replay wiring', () => {
  it('with replay:true installs the recorder and sets the session id', () => {
    init({ ...base, replay: true })
    expect(getReplaySessionId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('with replay:false (default) does not activate the recorder', () => {
    init({ ...base })
    expect(getReplaySessionId()).toBeUndefined()
  })

  it('after close() the replay id is no longer available', async () => {
    init({ ...base, replay: true })
    expect(getReplaySessionId()).toBeDefined()
    await close()
    expect(getReplaySessionId()).toBeUndefined()
  })
})
