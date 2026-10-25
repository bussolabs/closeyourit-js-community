import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLogEvent, buildMessageEvent } from '../src/events'
import { buildSlowMethodEvent } from '../src/metricEvents'
import { buildPageview } from '../src/pageviews'
import { buildReplayChunk } from '../src/replay'
import { Stats } from '../src/stats'
import { Transport } from '../src/transport'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'ingest')
const CONTRACT = join(ROOT, 'v1')

function json(relative: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACT, relative), 'utf8'))
}

function validator(definition: string): ReturnType<Ajv['compile']> {
  const schema = json('schema.json') as { $defs: Record<string, unknown> }
  const ajv = new Ajv({ strict: true, strictRequired: false })
  addFormats(ajv)
  return ajv.compile({ $ref: `#/$defs/${definition}`, $defs: schema.$defs })
}

afterEach(() => vi.useRealTimers())

describe('ingest v1 contract', () => {
  it('matches the locked canonical snapshot and all the checksums', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'LOCK.json'), 'utf8')) as {
      sha256sums: string
    }
    const sums = readFileSync(join(CONTRACT, 'SHA256SUMS'), 'utf8')
    expect(createHash('sha256').update(sums).digest('hex')).toBe(lock.sha256sums)

    for (const line of sums.trim().split('\n')) {
      const [expected, relative] = line.split('  ./')
      expect(relative).toBeDefined()
      const digest = createHash('sha256')
        .update(readFileSync(join(CONTRACT, relative!)))
        .digest('hex')
      expect(digest, relative).toBe(expected)
    }
  })

  it('applies the declared validity to every golden fixture', () => {
    const manifest = json('manifest.json') as {
      fixtures: Array<{ path: string; definition: string; valid: boolean }>
    }

    for (const fixture of manifest.fixtures) {
      expect(validator(fixture.definition)(json(fixture.path)), fixture.path).toBe(
        fixture.valid,
      )
    }
  })

  it('validates the JS producers for events, logs, metrics, pageviews and replays', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T14:00:00Z'))
    history.replaceState({}, '', '/pricing')

    const payloads: Array<[string, unknown]> = [
      [
        'event',
        buildMessageEvent({
          message: 'cache miss',
          environment: 'production',
          level: 'warning',
          scopeHash: {},
        }),
      ],
      [
        'log',
        buildLogEvent({
          message: 'order charged',
          environment: 'production',
          level: 'info',
        }),
      ],
      [
        'slow_method',
        buildSlowMethodEvent({
          label: 'checkout.total',
          durationMs: 12.345,
          environment: 'production',
        }),
      ],
      ['pageview', { ...buildPageview(), environment: 'production' }],
      [
        'replay',
        {
          ...buildReplayChunk({
            replaySessionId: 'session-contract-1',
            seq: 0,
            startedAt: Date.now(),
            events: [{ type: 2, data: {} }],
            path: '/pricing',
          }),
          environment: 'production',
        },
      ],
    ]

    for (const [definition, payload] of payloads) {
      const validate = validator(definition)
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true)
    }
  })

  it('consumes the whole HTTP matrix and classifies every outcome as 2xx or failed', async () => {
    const cases = json('fixtures/http/cases.json') as Array<{
      id: string
      status: number | null
    }>

    for (const contractCase of cases) {
      const stats = new Stats()
      const fetchImpl = vi.fn(() =>
        contractCase.status === null
          ? Promise.reject(new Error('network'))
          : Promise.resolve({ status: contractCase.status } as Response),
      )
      const transport = new Transport({
        auth: { kind: 'bearer', secret: 'cyi_contract' },
        stats,
        fetchImpl,
        timeoutMs: 0,
      })

      transport.send({}, 'https://closeyour.it/api/v1/projects/p/events')
      await transport.flush()

      const accepted =
        contractCase.status !== null &&
        contractCase.status >= 200 &&
        contractCase.status < 300
      expect(stats.get(accepted ? 'sent' : 'failed'), contractCase.id).toBe(1)
    }
  })

  it('keeps the separation between bearer, public DSN and gateway explicit', () => {
    const cases = json('fixtures/http/auth-cases.json') as Array<{
      id: string
      credential: string
      status: number
      forward_to?: string
    }>
    const byId = Object.fromEntries(cases.map((item) => [item.id, item]))

    expect(byId['public-store']?.credential).toBe('public_dsn')
    expect(byId['public-pageviews-rejected']?.status).toBe(401)
    expect(byId['gateway-pageviews']?.forward_to).toMatch(/^\/api\/v1\/projects\//)
    expect(byId['gateway-replays']?.forward_to).toMatch(/^\/api\/v1\/projects\//)
  })
})
