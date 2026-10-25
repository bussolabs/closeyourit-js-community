import { describe, expect, it } from 'vitest'
import {
  MAX_PAYLOAD_BYTES,
  capEvent,
  capGeneric,
  capLogEvent,
  capReplayChunk,
  chunkLogBatch,
  payloadBytes,
  truncateUtf8Json,
  utf8Bytes,
} from '../src/budget'
import type { EventPayload } from '../src/types'

// Minimal error event with an `extra.pad` field calibrated to bring the
// payload to exactly [target] UTF-8 bytes (ASCII: 1 char = 1 byte).
function eventOfBytes(target: number): EventPayload {
  const base: EventPayload = {
    event_id: 'eid',
    timestamp: '2026-07-27T00:00:00.000Z',
    platform: 'javascript',
    level: 'error',
    exception: {
      values: [{ type: 'Boom', value: 'esploso', mechanism: { handled: false } }],
    },
    extra: { pad: '' },
  }
  const base0 = payloadBytes(base)
  ;(base['extra'] as { pad: string }).pad = 'x'.repeat(Math.max(0, target - base0))
  return base
}

describe('utf8Bytes', () => {
  it('counts bytes, not characters, on ASCII', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('')).toBe(0)
  })

  it('counts the real UTF-8 bytes on Unicode (not the length in code units)', () => {
    // "é" = 2 byte, "€" = 3 byte, "😀" = 4 byte (1 code point, 2 UTF-16 code units).
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('€')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('😀').valueOf()).not.toBe('😀'.length)
  })

  it('matches TextEncoder', () => {
    const s = 'a€😀z accénti'
    expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).length)
  })

  it('uses the manual fallback when TextEncoder is missing (1/2/3/4 bytes)', () => {
    const s = 'aé€😀z' // 1 + 2 + 3 + 4 + 1 byte
    const expected = new TextEncoder().encode(s).length
    const original = globalThis.TextEncoder
    // @ts-expect-error removing the global to force the fallback branch
    delete globalThis.TextEncoder
    try {
      expect(utf8Bytes(s)).toBe(expected)
    } finally {
      globalThis.TextEncoder = original
    }
  })
})

describe('payloadBytes', () => {
  it('measures the bytes of the serialized JSON', () => {
    expect(payloadBytes({ a: 1 })).toBe(utf8Bytes('{"a":1}'))
  })
})

describe('capEvent — events channel (error/message)', () => {
  it('leaves a payload under budget untouched (no truncated flag)', () => {
    const ev = eventOfBytes(200)
    const out = capEvent(ev, 500)
    expect(out).toEqual(ev)
    expect(out['truncated']).toBeUndefined()
  })

  it('budget boundaries X-1 / X / X+1', () => {
    const budget = 400
    expect(capEvent(eventOfBytes(budget - 1), budget)['truncated']).toBeUndefined()
    expect(capEvent(eventOfBytes(budget), budget)['truncated']).toBeUndefined()
    const over = capEvent(eventOfBytes(budget + 1), budget)
    expect(over['truncated']).toBe(true)
    expect(payloadBytes(over)).toBeLessThanOrEqual(budget)
  })

  it('does not mutate the original payload', () => {
    const ev = eventOfBytes(600)
    const snapshot = JSON.parse(JSON.stringify(ev))
    capEvent(ev, 300)
    expect(ev).toEqual(snapshot)
  })

  it('preserves identity and the main error even when truncating heavily', () => {
    const ev = eventOfBytes(5000)
    const out = capEvent(ev, 300)
    expect(payloadBytes(out)).toBeLessThanOrEqual(300)
    expect(out['event_id']).toBe('eid')
    expect(out['level']).toBe('error')
    const values = (out['exception'] as { values: { type: string; value: string }[] })
      .values
    expect(values[0].type).toBe('Boom')
    expect(out['truncated']).toBe(true)
  })

  it('breadcrumbs 0/1/N: drops the oldest first, keeps the most recent', () => {
    const crumbs = Array.from({ length: 10 }, (_, i) => ({
      timestamp: '2026-07-27T00:00:00.000Z',
      type: 'default',
      message: `crumb-${i}-${'d'.repeat(40)}`,
    }))
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: 'v' }] },
      breadcrumbs: { values: crumbs },
    }
    const out = capEvent(ev, 300)
    expect(payloadBytes(out)).toBeLessThanOrEqual(300)
    expect(out['truncated']).toBe(true)
    const kept =
      (out['breadcrumbs'] as { values: { message: string }[] } | undefined)?.values ??
      []
    // The first crumb kept (if at least one is left) is more recent than the first original.
    if (kept.length > 0) {
      expect(kept[kept.length - 1].message).toBe('crumb-9-' + 'd'.repeat(40))
      expect(kept[0].message).not.toBe('crumb-0-' + 'd'.repeat(40))
    }
  })

  it('breadcrumbs N all removable: the key disappears if needed', () => {
    const crumbs = Array.from({ length: 50 }, (_, i) => ({
      message: 'x'.repeat(100),
      i,
    }))
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: 'v' }] },
      breadcrumbs: { values: crumbs },
    }
    const out = capEvent(ev, 120)
    expect(out['breadcrumbs']).toBeUndefined()
    expect(out['truncated']).toBe(true)
    expect(payloadBytes(out)).toBeLessThanOrEqual(120)
  })

  it('reduces in order: breadcrumbs before request/extra/tags', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: 'v' }] },
      breadcrumbs: { values: [{ message: 'x'.repeat(200) }] },
      request: { url: 'https://example.test', headers: { a: 'y'.repeat(50) } },
      extra: { note: 'ok' },
      tags: { area: 'checkout' },
    }
    // Budget that fits by removing only the breadcrumbs.
    const target = payloadBytes({ ...ev, breadcrumbs: undefined, truncated: true }) + 5
    const out = capEvent(ev, target)
    expect(out['truncated']).toBe(true)
    expect(out['breadcrumbs']).toBeUndefined()
    expect(out['request']).toBeDefined()
    expect(out['extra']).toBeDefined()
    expect(out['tags']).toBeDefined()
  })

  it('preserves the identity contexts (runtime/os/app/device/replay), drops the custom ones', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: 'v' }] },
      contexts: {
        runtime: { name: 'node', version: '20' },
        replay: { replay_id: 'rep-123' },
        custom_big: { blob: 'z'.repeat(4000) },
      },
    }
    const out = capEvent(ev, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    const ctx = out['contexts'] as Record<string, unknown>
    expect(ctx['replay']).toEqual({ replay_id: 'rep-123' })
    expect(ctx['runtime']).toEqual({ name: 'node', version: '20' })
    expect(ctx['custom_big']).toBeUndefined()
    expect(out['truncated']).toBe(true)
  })

  it('last resort: truncates the error value keeping type and Unicode intact', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: '😀'.repeat(500) }] },
    }
    const out = capEvent(ev, 130)
    expect(payloadBytes(out)).toBeLessThanOrEqual(130)
    const value = (out['exception'] as { values: { type: string; value: string }[] })
      .values[0]
    expect(value.type).toBe('Boom')
    // No emoji split in half: every code point stays 4 bytes.
    expect([...value.value].every((ch) => ch === '😀')).toBe(true)
    expect(out['truncated']).toBe(true)
  })
})

describe('capLogEvent — single log', () => {
  it('stays intact under budget', () => {
    const log: EventPayload = { event_id: 'l1', level: 'info', message: 'hello' }
    expect(capLogEvent(log, 500)).toEqual(log)
  })

  it('removes the attributes before touching the message', () => {
    const log: EventPayload = {
      event_id: 'l1',
      level: 'info',
      message: 'breve',
      attributes: { blob: 'a'.repeat(500) },
    }
    const out = capLogEvent(log, 120)
    expect(out['attributes']).toBeUndefined()
    expect(out['message']).toBe('breve')
    expect(out['truncated']).toBe(true)
    expect(payloadBytes(out)).toBeLessThanOrEqual(120)
  })

  it('truncates the message if still too large, preserving the identity', () => {
    const log: EventPayload = {
      event_id: 'l1',
      level: 'error',
      message: 'm'.repeat(2000),
    }
    const out = capLogEvent(log, 100)
    expect(payloadBytes(out)).toBeLessThanOrEqual(100)
    expect(out['event_id']).toBe('l1')
    expect(out['level']).toBe('error')
    expect(out['truncated']).toBe(true)
  })
})

describe('chunkLogBatch — logs channel (batch)', () => {
  const logs = (n: number, size = 10): EventPayload[] =>
    Array.from({ length: n }, (_, i) => ({
      event_id: `l${i}`,
      message: 'm'.repeat(size),
    }))

  it('batch that fits: a single chunk', () => {
    const batch = logs(3)
    const chunks = chunkLogBatch(batch, 10_000, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(3)
  })

  it('splits by bytes: every chunk respects the budget', () => {
    const batch = logs(20, 100)
    const budget = 400
    const chunks = chunkLogBatch(batch, budget, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(payloadBytes(chunk)).toBeLessThanOrEqual(budget)
    // No log lost.
    expect(chunks.flat()).toHaveLength(20)
  })

  it('splits by maximum count', () => {
    const chunks = chunkLogBatch(logs(5), 10_000, 2)
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1])
  })

  it('a giant log is truncated and goes alone into a chunk under budget', () => {
    const batch: EventPayload[] = [
      { event_id: 'small', message: 'ok' },
      {
        event_id: 'huge',
        message: 'z'.repeat(5000),
        attributes: { k: 'v'.repeat(5000) },
      },
    ]
    const budget = 300
    const chunks = chunkLogBatch(batch, budget, 1000)
    for (const chunk of chunks) expect(payloadBytes(chunk)).toBeLessThanOrEqual(budget)
    const huge = chunks.flat().find((l) => l['event_id'] === 'huge')
    expect(huge?.['truncated']).toBe(true)
    expect(huge?.['attributes']).toBeUndefined()
  })

  it('empty batch: no chunk', () => {
    expect(chunkLogBatch([], 500, 1000)).toEqual([])
  })
})

describe('capReplayChunk — replay channel', () => {
  const chunk = (nEvents: number, size = 10): EventPayload => ({
    replay_session_id: 'sess-1',
    seq: 3,
    started_at: '2026-07-27T00:00:00.000Z',
    events: Array.from({ length: nEvents }, (_, i) => ({ i, d: 'e'.repeat(size) })),
  })

  it('chunk under budget stays intact', () => {
    const c = chunk(2)
    expect(capReplayChunk(c, 10_000)).toEqual(c)
  })

  it('drops events from the tail keeping the prefix, marks truncated', () => {
    const c = chunk(20, 50)
    const budget = 400
    const out = capReplayChunk(c, budget)
    expect(payloadBytes(out)).toBeLessThanOrEqual(budget)
    expect(out['truncated']).toBe(true)
    expect(out['replay_session_id']).toBe('sess-1')
    expect(out['seq']).toBe(3)
    const events = out['events'] as { i: number }[]
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(20)
    // Prefix preserved in order: the first indexes, never a leading gap.
    expect(events[0].i).toBe(0)
    expect(events[events.length - 1].i).toBe(events.length - 1)
  })

  it('boundaries X-1 / X / X+1 on the number of events that fit', () => {
    const budget = payloadBytes(chunk(3, 20))
    expect(capReplayChunk(chunk(3, 20), budget)['truncated']).toBeUndefined()
    const over = capReplayChunk(chunk(4, 20), budget)
    expect(over['truncated']).toBe(true)
    expect(payloadBytes(over)).toBeLessThanOrEqual(budget)
  })

  it('overhead over budget: events emptied but identity preserved', () => {
    const c = chunk(5)
    const out = capReplayChunk(c, 40)
    expect((out['events'] as unknown[]).length).toBe(0)
    expect(out['replay_session_id']).toBe('sess-1')
    expect(out['truncated']).toBe(true)
  })
})

describe('JSON escaping — bytes after JSON.stringify, not of the raw string', () => {
  it('truncateUtf8Json counts the escaped cost (quotes double)', () => {
    // 10 raw quotes = 10 bytes, but escaped (\") = 20 JSON bytes.
    expect(truncateUtf8Json('"'.repeat(10), 10)).toHaveLength(5)
    // No escaping on plain ASCII: linear byte cut.
    expect(truncateUtf8Json('abcdef', 3)).toBe('abc')
    // Zero or negative budget → empty string.
    expect(truncateUtf8Json('x', 0)).toBe('')
  })

  it('capLogEvent: a message made only of quotes stays under budget after escaping', () => {
    const log: EventPayload = {
      event_id: 'l1',
      level: 'info',
      message: '"'.repeat(2000),
    }
    const out = capLogEvent(log, 120)
    expect(payloadBytes(out)).toBeLessThanOrEqual(120)
    expect(out['truncated']).toBe(true)
  })

  it('capEvent: a value with backslashes and newlines stays under budget', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: '\\\n'.repeat(1000) }] },
    }
    const out = capEvent(ev, 160)
    expect(payloadBytes(out)).toBeLessThanOrEqual(160)
    expect(out['truncated']).toBe(true)
  })
})

describe('safety net — guarantees fitting on the remaining non-identity fields', () => {
  it('capLogEvent: trims the remaining non-identity fields (huge logger)', () => {
    const log: EventPayload = {
      event_id: 'l1',
      level: 'info',
      message: 'ok',
      logger: 'z'.repeat(5000),
    }
    const out = capLogEvent(log, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    expect(out['event_id']).toBe('l1')
    expect(out['level']).toBe('info')
    expect(out['truncated']).toBe(true)
  })

  it('capEvent: truncates ALL the exception values, not only the last one', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: {
        values: [
          { type: 'Inner', value: 'a'.repeat(3000) },
          { type: 'Outer', value: 'b'.repeat(3000) },
        ],
      },
    }
    const out = capEvent(ev, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    const values = (out['exception'] as { values: { type: string }[] }).values
    expect(values[0].type).toBe('Inner')
    expect(values[1].type).toBe('Outer')
    expect(out['truncated']).toBe(true)
  })

  it('capEvent: removes the custom fields injected beyond reductions 1-7', () => {
    const ev: EventPayload = {
      event_id: 'eid',
      level: 'error',
      exception: { values: [{ type: 'Boom', value: 'v' }] },
      injected_blob: { data: 'q'.repeat(5000) },
    }
    const out = capEvent(ev, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    expect(out['injected_blob']).toBeUndefined()
    expect(out['event_id']).toBe('eid')
    expect(out['truncated']).toBe(true)
  })

  it('capReplayChunk: trims oversized metadata (huge user) keeping the session', () => {
    const c: EventPayload = {
      replay_session_id: 'sess-1',
      seq: 3,
      started_at: '2026-07-27T00:00:00.000Z',
      events: [{ i: 0 }],
      user: 'u'.repeat(5000),
    }
    const out = capReplayChunk(c, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    expect(out['replay_session_id']).toBe('sess-1')
    expect(out['seq']).toBe(3)
    expect(out['truncated']).toBe(true)
  })
})

describe('capGeneric — metrics/pageviews', () => {
  it('stays intact under budget', () => {
    const m: EventPayload = { kind: 'slow_method', label: 'checkout' }
    expect(capGeneric(m, 500)).toEqual(m)
  })

  it('truncates large string values (label/url) keeping the channel identity', () => {
    const m: EventPayload = {
      kind: 'slow_method',
      label: 'x'.repeat(5000),
      environment: 'production',
    }
    const out = capGeneric(m, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    expect(out['kind']).toBe('slow_method')
    expect(out['environment']).toBe('production')
    expect(out['truncated']).toBe(true)
  })

  it('removes non-string custom values (e.g. injected by beforeSend)', () => {
    const p: EventPayload = { name: 'signup', blob: { data: 'z'.repeat(5000) } }
    const out = capGeneric(p, 200)
    expect(payloadBytes(out)).toBeLessThanOrEqual(200)
    expect(out['name']).toBe('signup')
    expect(out['blob']).toBeUndefined()
    expect(out['truncated']).toBe(true)
  })
})

describe('MAX_PAYLOAD_BYTES', () => {
  it('is a conservative budget under the contract limits (5 MB decompressed, ~1 MB gateway)', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(512 * 1024)
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(1024 * 1024)
  })
})
