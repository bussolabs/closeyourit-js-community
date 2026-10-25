import { describe, expect, it } from 'vitest'
import { buildReplayChunk } from '../src/replay'
import { replayUri, resolveOptions } from '../src/options'
import type { CloseYourItOptions } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_x',
  projectId: 'p',
}

describe('buildReplayChunk', () => {
  it('maps the fields to snake_case with an ISO started_at', () => {
    const chunk = buildReplayChunk({
      replaySessionId: 'sess-1',
      seq: 3,
      startedAt: 0,
      events: [{ type: 2, data: {} }],
    })

    expect(chunk).toEqual({
      replay_session_id: 'sess-1',
      seq: 3,
      started_at: '1970-01-01T00:00:00.000Z',
      events: [{ type: 2, data: {} }],
    })
  })

  it('carries the rrweb events without inspecting them', () => {
    const events = [{ type: 4 }, { type: 3, data: { source: 2 } }]
    const chunk = buildReplayChunk({
      replaySessionId: 's',
      seq: 0,
      startedAt: 10,
      events,
    })

    expect(chunk['events']).toBe(events)
  })

  it('includes path and user when present (behavior gallery)', () => {
    const chunk = buildReplayChunk({
      replaySessionId: 's',
      seq: 0,
      startedAt: 0,
      events: [],
      path: '/checkout',
      user: 'acc-1',
    })
    expect(chunk).toMatchObject({ path: '/checkout', user: 'acc-1' })
  })

  it('omits path/user when missing (backward compat)', () => {
    const chunk = buildReplayChunk({
      replaySessionId: 's',
      seq: 0,
      startedAt: 0,
      events: [],
    })
    expect(chunk).not.toHaveProperty('path')
    expect(chunk).not.toHaveProperty('user')
  })
})

describe('replayUri', () => {
  it('builds the chunk ingest endpoint', () => {
    expect(replayUri(resolveOptions(base))).toBe(
      'https://www.closeyour.it/api/v1/projects/p/replays',
    )
  })
})

describe('resolveOptions — replay options', () => {
  it('default: replay off, mask input on, flush 5000, block selector undefined', () => {
    const opts = resolveOptions(base)
    expect(opts.replay).toBe(false)
    expect(opts.replayMaskAllInputs).toBe(true)
    expect(opts.replayFlushIntervalMs).toBe(5000)
    expect(opts.replayBlockSelector).toBeUndefined()
  })

  // CYJS-15 · In a management app the sensitive data is mostly text shown on
  // screen (names, case files, amounts), not only what is typed into fields. The
  // default must cover that too: `*` is the rrweb selector that matches
  // every element, so it masks all text nodes.
  it('default: also masks the text shown by the page, not only the inputs', () => {
    expect(resolveOptions(base).replayMaskTextSelector).toBe('*')
  })

  // The opt-out is by construction: whoever wants to see part of the page in clear
  // passes a narrower selector, which restricts masking to those elements only.
  it('an explicit selector narrows the masking and wins over the default', () => {
    const opts = resolveOptions({ ...base, replayMaskTextSelector: '.secret' })
    expect(opts.replayMaskTextSelector).toBe('.secret')
  })

  it('applies the explicit overrides', () => {
    const opts = resolveOptions({
      ...base,
      replay: true,
      replayMaskAllInputs: false,
      replayBlockSelector: '.cyi-block',
      replayMaskTextSelector: '.secret',
      replayFlushIntervalMs: 2000,
    })
    expect(opts.replay).toBe(true)
    expect(opts.replayMaskAllInputs).toBe(false)
    expect(opts.replayBlockSelector).toBe('.cyi-block')
    expect(opts.replayMaskTextSelector).toBe('.secret')
    expect(opts.replayFlushIntervalMs).toBe(2000)
  })

  it('an invalid flush interval (0/negative) falls back to the default', () => {
    expect(
      resolveOptions({ ...base, replayFlushIntervalMs: 0 }).replayFlushIntervalMs,
    ).toBe(5000)
    expect(
      resolveOptions({ ...base, replayFlushIntervalMs: -1 }).replayFlushIntervalMs,
    ).toBe(5000)
  })
})
