// @vitest-environment node
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '../src/client'
import { DatabaseMonitoring } from '../src/database'
import type { EventPayload } from '../src/types'

function observingClient(payloads: EventPayload[], enabled = true): Client {
  return new Client({
    endpointUrl: 'http://127.0.0.1:1',
    projectId: randomUUID(),
    token: `cyi_${randomUUID().replaceAll('-', '')}`,
    enabled,
    environment: 'database-tests',
    release: 'database-tests@1',
    autoInstall: false,
    beforeSend(payload) {
      payloads.push(payload)
      return null
    },
  })
}

describe.skipIf(!process.env.CYI_TEST_MYSQL_SOCKET && !process.env.CYI_TEST_MYSQL_PORT)(
  'database metrics with real MySQL',
  () => {
    it('ends manual request profiles once and leaves slow-query thresholds independent', async () => {
      const payloads: EventPayload[] = []
      const client = observingClient(payloads)
      const monitoring = new DatabaseMonitoring(client, {
        enabled: true,
        slowQueryThresholdMs: 1e9,
        repeatedQueryThreshold: 2,
      })
      const pool = mysql.createPool({
        ...(process.env.CYI_TEST_MYSQL_SOCKET
          ? { socketPath: process.env.CYI_TEST_MYSQL_SOCKET }
          : { host: '127.0.0.1', port: Number(process.env.CYI_TEST_MYSQL_PORT) }),
        user: 'root',
      })
      try {
        monitoring.instrumentMysql(pool, 'promise')
        await monitoring.request(async (end) => {
          for (let index = 0; index < 2; index++)
            expect((await pool.execute('SELECT ? AS value', [index]))[0]).toEqual([
              { value: index },
            ])
          expect(payloads).toHaveLength(0)
          end()
          end()
        })
        expect(payloads).toHaveLength(1)
        expect(payloads[0]).toMatchObject({
          kind: 'performance_issue',
          subtype: 'n_plus_one',
          query_count: 2,
          db_system: 'mysql',
        })
        monitoring.uninstall()
        monitoring.instrumentMysql(pool, 'promise')
        expect(Object.hasOwn(pool, 'execute')).toBe(false)
      } finally {
        monitoring.uninstall()
        await pool.end()
        await client.close()
      }
    })
  },
)

describe('database monitoring lifecycle', () => {
  it('requires explicit opt-in and preserves unobserved operations', async () => {
    const client = observingClient([])
    const monitoring = new DatabaseMonitoring(client)
    const pool = new pg.Pool()
    const original = pool.query
    monitoring.instrumentPostgres(pool)
    expect(pool.query).toBe(original)
    expect(monitoring.profile(() => 17)).toBe(17)
    expect(
      monitoring.request((end) => {
        end()
        return 19
      }),
    ).toBe(19)
    monitoring.uninstall()
    monitoring.uninstall()
    await client.close()
    await pool.end()
  })

  it('validates configuration before installing any hooks', async () => {
    const client = observingClient([])
    for (const value of [-1, NaN, Infinity])
      expect(
        () => new DatabaseMonitoring(client, { slowQueryThresholdMs: value }),
      ).toThrow(RangeError)
    expect(() => new DatabaseMonitoring(client, { repeatedQueryThreshold: 1 })).toThrow(
      RangeError,
    )
    const monitoring = new DatabaseMonitoring(client)
    expect(() => monitoring.instrumentMysql({}, 'invalid' as 'promise')).toThrow(
      TypeError,
    )
    monitoring.uninstall()
    await client.close()
  })
})

describe.skipIf(!process.env.CYI_TEST_PG_SOCKET)(
  'database metrics with real PostgreSQL',
  () => {
    const pool = new pg.Pool({
      host: process.env.CYI_TEST_PG_SOCKET,
      database: 'postgres',
      max: 3,
    })
    afterAll(() => pool.end())

    it('rejects a second owner and allows a new owner after uninstall', async () => {
      const firstEvents: EventPayload[] = []
      const secondEvents: EventPayload[] = []
      const firstClient = observingClient(firstEvents)
      const secondClient = observingClient(secondEvents)
      const first = new DatabaseMonitoring(firstClient, {
        enabled: true,
        slowQueryThresholdMs: 0,
      })
      const second = new DatabaseMonitoring(secondClient, {
        enabled: true,
        slowQueryThresholdMs: 0,
      })
      try {
        first.instrumentPostgres(pool)
        second.instrumentPostgres(pool)
        await pool.query('SELECT 1')
        expect(firstEvents).toHaveLength(1)
        expect(secondEvents).toHaveLength(0)
        expect(second.getStats().unpatchable).toBe(1)
        first.uninstall()
        second.instrumentPostgres(pool)
        await pool.query('SELECT 2')
        expect(firstEvents).toHaveLength(1)
        expect(secondEvents).toHaveLength(1)
      } finally {
        first.uninstall()
        second.uninstall()
        await firstClient.close()
        await secondClient.close()
      }
    })

    it('keeps concurrent query profiles isolated and removes private values', async () => {
      const payloads: EventPayload[] = []
      const client = observingClient(payloads)
      const monitoring = new DatabaseMonitoring(client, {
        enabled: true,
        slowQueryThresholdMs: 0,
        repeatedQueryThreshold: 3,
      })
      monitoring.instrumentPostgres(pool)
      async function request(count: number, trace: string) {
        return client.runWithScope(async () => {
          client.scope.setTraceId(trace)
          await monitoring.profile(async () => {
            for (let index = 0; index < count; index++)
              expect(
                (
                  await pool.query('SELECT $1::text AS private_name', [
                    `private-${index}@example.test`,
                  ])
                ).rows[0].private_name,
              ).toBe(`private-${index}@example.test`)
          })
        })
      }
      try {
        await Promise.all([request(2, '1'.repeat(32)), request(3, '2'.repeat(32))])
        expect(payloads.filter((item) => item.kind === 'slow_query')).toHaveLength(5)
        const repeated = payloads.filter((item) => item.subtype === 'n_plus_one')
        expect(repeated).toHaveLength(1)
        expect(repeated[0]).toMatchObject({
          query_count: 3,
          trace_id: '2'.repeat(32),
          environment: 'database-tests',
          release: 'database-tests@1',
          db_system: 'postgresql',
        })
        expect(JSON.stringify(payloads)).not.toMatch(
          /private|example\.test|node_modules|alessiobussolari/,
        )
        expect(new Set(payloads.map((item) => item.sample_id)).size).toBe(6)
        expect(
          payloads.every(
            (item) => typeof item.duration_ms === 'number' && item.duration_ms >= 0,
          ),
        ).toBe(true)
      } finally {
        monitoring.uninstall()
        await client.close()
      }
    })

    it('reports unsupported SQL without changing successful business queries', async () => {
      const payloads: EventPayload[] = []
      const client = observingClient(payloads)
      const monitoring = new DatabaseMonitoring(client, {
        enabled: true,
        slowQueryThresholdMs: 0,
      })
      monitoring.instrumentPostgres(pool)
      try {
        expect((await pool.query("SELECT 'private\\value' AS value")).rows).toEqual([
          { value: 'private\\value' },
        ])
        expect(monitoring.getStats().unsupported_sql).toBe(1)
        expect(payloads).toHaveLength(0)
        monitoring.uninstall()
        expect((await pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
        expect(payloads).toHaveLength(0)
      } finally {
        monitoring.uninstall()
        await client.close()
      }
    })

    it('leaves disabled clients and unfinished callbacks silent', async () => {
      const payloads: EventPayload[] = []
      const client = observingClient(payloads, false)
      const monitoring = new DatabaseMonitoring(client, {
        enabled: true,
        slowQueryThresholdMs: 0,
      })
      const original = pool.query
      monitoring.instrumentPostgres(pool)
      expect(pool.query).toBe(original)
      await monitoring.profile(() => pool.query('SELECT 1'))
      expect(payloads).toHaveLength(0)
      monitoring.uninstall()
      await client.close()
    })
  },
)
