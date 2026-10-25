import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import mysql from 'mysql2'
import mysqlPromise from 'mysql2/promise'
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres'
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/index.js'
import { Client } from '@bussolabs/closeyourit-js'
import { DatabaseMonitoring } from '@bussolabs/closeyourit-js/database'

// The runner supplies ephemeral credentials through stdin, never files or argv.
const config = JSON.parse(readFileSync(0, 'utf8'))
assert.ok(
  [
    'pg',
    'mysql-promise',
    'mysql-callback',
    'drizzle-pg',
    'drizzle-mysql',
    'prisma-pg',
  ].includes(config.profile),
)
assert.ok(['enabled', 'disabled', 'uninstalled', 'outage'].includes(config.phase))
assert.equal(new URL(config.endpoint).hostname, '127.0.0.1')
const observations = []
const client = new Client({
  endpointUrl: config.endpoint,
  projectId: config.project,
  token: config.token,
  environment: config.environment,
  release: config.release,
  autoInstall: false,
  maxQueue: 50,
  beforeSend(payload) {
    observations.push(payload)
    return payload
  },
})
const monitoring = new DatabaseMonitoring(client, {
  enabled: config.phase !== 'disabled',
  slowQueryThresholdMs: 0,
  repeatedQueryThreshold: 3,
})
let pool
let prisma
let query
let close
let version
try {
  if (config.profile.endsWith('pg') || config.profile === 'pg') {
    pool = new pg.Pool({
      host: config.pgSocket,
      port: config.pgPort,
      database: 'postgres',
      max: 3,
    })
    version = (await pool.query('SHOW server_version')).rows[0].server_version
    monitoring.instrumentPostgres(pool)
    close = () => pool.end()
    if (config.profile === 'prisma-pg') {
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
      query = (value) => prisma.$queryRaw`SELECT ${value}::text AS private_name`
    } else if (config.profile === 'drizzle-pg') {
      const database = pgDrizzle(pool)
      query = async (value) =>
        (await database.execute(sql`SELECT ${value}::text AS private_name`)).rows
    } else
      query = async (value) =>
        (await pool.query('SELECT $1::text AS private_name', [value])).rows
  } else {
    const options = {
      socketPath: config.mysqlSocket,
      user: 'root',
      database: 'cyi969',
      connectionLimit: 3,
    }
    if (config.profile === 'mysql-callback') {
      pool = mysql.createPool(options)
      query = (value) =>
        new Promise((resolve, reject) =>
          pool.query('SELECT ? AS private_name', [value], (error, rows) =>
            error ? reject(error) : resolve(rows),
          ),
        )
      version = (await pool.promise().query('SELECT VERSION() AS version'))[0][0]
        .version
      monitoring.instrumentMysql(pool, 'callback')
      close = () =>
        new Promise((resolve, reject) =>
          pool.end((error) => (error ? reject(error) : resolve())),
        )
    } else {
      pool = mysqlPromise.createPool(options)
      version = (await pool.query('SELECT VERSION() AS version'))[0][0].version
      monitoring.instrumentMysql(pool, 'promise')
      close = () => pool.end()
      if (config.profile === 'drizzle-mysql') {
        const database = mysqlDrizzle(pool)
        query = async (value) =>
          (await database.execute(sql`SELECT ${value} AS private_name`))[0]
      } else
        query = async (value) =>
          (await pool.execute('SELECT ? AS private_name', [value]))[0]
    }
  }
  if (config.phase === 'uninstalled') monitoring.uninstall()
  assert.equal(observations.length, 0)
  const requests = []
  await Promise.all(
    [2, 3].map((count) =>
      client.runWithScope(async () => {
        const traceId = randomUUID().replaceAll('-', '')
        client.scope.setTraceId(traceId)
        requests.push({ count, trace_id: traceId })
        await monitoring.profile(async () => {
          for (let index = 0; index < count; index++) {
            const value = `private-${randomUUID()}@example.test`
            assert.deepEqual(await query(value), [{ private_name: value }])
          }
        })
      }),
    ),
  )
  await client.flush()
  const output = {
    profile: config.profile,
    phase: config.phase,
    runtime: process.version,
    database_version: version,
    requests,
    observations,
    stats: client.stats.toObject(),
    skipped: monitoring.getStats(),
  }
  const active = ['enabled', 'outage'].includes(config.phase)
  assert.equal(observations.length, active ? 6 : 0)
  if (active) {
    assert.equal(observations.filter((row) => row.kind === 'slow_query').length, 5)
    const repeated = observations.filter((row) => row.subtype === 'n_plus_one')
    assert.equal(repeated.length, 1)
    assert.equal(repeated[0].query_count, 3)
    assert.equal(repeated[0].trace_id, requests.find((row) => row.count === 3).trace_id)
  }
  assert.equal(output.stats.dropped, 0)
  assert.equal(output.stats.enqueued, observations.length)
  assert.equal(output.stats.sent, config.phase === 'enabled' ? 6 : 0)
  assert.equal(output.stats.failed, config.phase === 'outage' ? 6 : 0)
  assert.ok(Object.values(output.skipped).every((count) => count === 0))
  const encoded = JSON.stringify(output)
  for (const privateValue of [
    config.token,
    'private-',
    'private_name',
    '@example.test',
  ])
    assert.ok(!encoded.includes(privateValue))
  process.stdout.write(encoded)
} finally {
  monitoring.uninstall()
  await prisma?.$disconnect()
  await close?.()
  await client.close()
}
