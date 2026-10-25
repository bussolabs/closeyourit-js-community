// @vitest-environment node
import pg from 'pg'
import mysql from 'mysql2'
import mysqlPromise from 'mysql2/promise'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { pgTable, varchar as pgVarchar } from 'drizzle-orm/pg-core'
import { mysqlTable, varchar as mysqlVarchar } from 'drizzle-orm/mysql-core'
import { drizzle as postgresDrizzle } from 'drizzle-orm/node-postgres'
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2'
import { PrismaPg } from '@prisma/adapter-pg'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseDriverHooks } from '../src/node/databaseDriver'

const pgAccounts = pgTable('cyi969_accounts', {
  id: pgVarchar('id', { length: 36 }).primaryKey(),
  name: pgVarchar('name', { length: 100 }).notNull(),
})
const mysqlAccounts = mysqlTable('cyi969_accounts', {
  id: mysqlVarchar('id', { length: 36 }).primaryKey(),
  name: mysqlVarchar('name', { length: 100 }).notNull(),
})

describe.skipIf(!process.env.CYI_TEST_PG_SOCKET)(
  'PostgreSQL instance hooks with a real server',
  () => {
    const pool = new pg.Pool({
      host: process.env.CYI_TEST_PG_SOCKET,
      database: 'postgres',
      max: 2,
    })
    const completed: unknown[][] = []
    const skipped: string[] = []
    const hooks = new DatabaseDriverHooks({
      begin(args) {
        return () => {
          completed.push([...args])
        }
      },
      skipped(reason) {
        skipped.push(reason)
      },
    })

    hooks.install(pool, 'pg')
    afterAll(async () => {
      hooks.uninstall()
      await pool.end()
    })

    it('observes promise results once across pool and borrowed client layers', async () => {
      const before = completed.length
      const result = await pool.query('SELECT 1 AS value')
      expect(result.rows).toEqual([{ value: 1 }])
      expect(completed.length - before).toBe(1)
    })

    it('preserves callback return behavior and subsequent callback queries', async () => {
      const before = completed.length
      await new Promise<void>((resolve, reject) => {
        const returned = pool.query('SELECT 2 AS value', (error, result) => {
          if (error) {
            reject(error)
            return
          }
          expect(result.rows).toEqual([{ value: 2 }])
          pool.query('SELECT 3 AS value', (nextError, nextResult) => {
            if (nextError) {
              reject(nextError)
              return
            }
            expect(nextResult.rows).toEqual([{ value: 3 }])
            resolve()
          })
        })
        expect(returned).toBeUndefined()
      })
      expect(completed.length - before).toBe(2)
    })

    it('preserves named prepared queries and borrowed connection release', async () => {
      const connection = await pool.connect()
      const before = completed.length
      try {
        expect(
          (
            await connection.query({
              name: 'owned-query',
              text: 'SELECT $1::integer AS value',
              values: [7],
            })
          ).rows,
        ).toEqual([{ value: 7 }])
        expect(
          (await connection.query({ name: 'owned-query', values: [9] })).rows,
        ).toEqual([{ value: 9 }])
      } finally {
        connection.release()
      }
      expect(completed.length - before).toBe(2)
    })

    it('preserves real error codes and continues subsequent business queries', async () => {
      const before = completed.length
      await expect(pool.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
      expect((await pool.query('SELECT 4 AS value')).rows).toEqual([{ value: 4 }])
      expect(completed.length - before).toBe(2)
    })

    it('passes native Query instances through with their original identity and listeners', async () => {
      const connection = await pool.connect()
      const before = completed.length
      try {
        const query = new pg.Query('SELECT 11 AS value')
        expect(connection.query(query)).toBe(query)
        expect(query.listenerCount('error')).toBe(0)
        const rows: unknown[] = []
        await new Promise<void>((resolve, reject) => {
          query.on('row', (row: unknown) => rows.push(row))
          query.on('error', reject)
          query.on('end', () => resolve())
        })
        expect(rows).toEqual([{ value: 11 }])
        expect(completed.length).toBe(before)
      } finally {
        connection.release()
      }
    })

    it('preserves asynchronous native rejection when query reflection fails', async () => {
      const failure = new Error('Reflection is application-owned')
      const query = new Proxy(
        { text: 'SELECT 12 AS value' },
        {
          getPrototypeOf() {
            throw failure
          },
        },
      )
      await expect(pg.Pool.prototype.query.call(pool, query)).rejects.toBe(failure)
      await expect(pool.query(query)).rejects.toBe(failure)
    })

    it('observes Drizzle queries and transactions once at the native driver boundary', async () => {
      const database = postgresDrizzle(pool)
      const before = completed.length
      const result = await database.execute(sql`SELECT ${13}::integer AS value`)
      expect(result.rows).toEqual([{ value: 13 }])
      expect(completed.length - before).toBe(1)
      const transactionStart = completed.length
      await database.transaction(async (transaction) => {
        expect(
          (await transaction.execute(sql`SELECT ${14}::integer AS value`)).rows,
        ).toEqual([{ value: 14 }])
      })
      expect(completed.length - transactionStart).toBe(3)
    })

    it('preserves real PostgreSQL Drizzle model CRUD', async () => {
      const database = postgresDrizzle(pool)
      const id = randomUUID()
      const before = completed.length
      await database.insert(pgAccounts).values({ id, name: 'initial' })
      expect(
        await database.select().from(pgAccounts).where(eq(pgAccounts.id, id)),
      ).toEqual([{ id, name: 'initial' }])
      await database
        .update(pgAccounts)
        .set({ name: 'updated' })
        .where(eq(pgAccounts.id, id))
      expect(
        await database.select().from(pgAccounts).where(eq(pgAccounts.id, id)),
      ).toEqual([{ id, name: 'updated' }])
      await database.delete(pgAccounts).where(eq(pgAccounts.id, id))
      expect(
        await database.select().from(pgAccounts).where(eq(pgAccounts.id, id)),
      ).toEqual([])
      expect(completed.length - before).toBe(6)
    })

    it.skipIf(!process.env.CYI_TEST_PRISMA_CLIENT)(
      'observes the explicit Prisma PostgreSQL adapter without duplicate ORM events',
      async () => {
        const { PrismaClient } = await import(process.env.CYI_TEST_PRISMA_CLIENT!)
        const database = new PrismaClient({ adapter: new PrismaPg(pool) })
        try {
          const before = completed.length
          expect(await database.$queryRaw`SELECT ${17}::integer AS value`).toEqual([
            { value: 17 },
          ])
          expect(completed.length - before).toBe(1)
        } finally {
          await database.$disconnect()
        }
        expect((await pool.query('SELECT 18 AS value')).rows).toEqual([{ value: 18 }])
      },
    )

    it.skipIf(!process.env.CYI_TEST_PRISMA_CLIENT)(
      'preserves real Prisma model CRUD through its PostgreSQL adapter',
      async () => {
        const { PrismaClient } = await import(process.env.CYI_TEST_PRISMA_CLIENT!)
        const database = new PrismaClient({ adapter: new PrismaPg(pool) })
        const id = randomUUID()
        try {
          const before = completed.length
          expect(
            await database.account.create({ data: { id, name: 'initial' } }),
          ).toEqual({ id, name: 'initial' })
          expect(await database.account.findUnique({ where: { id } })).toEqual({
            id,
            name: 'initial',
          })
          expect(
            await database.account.update({ where: { id }, data: { name: 'updated' } }),
          ).toEqual({ id, name: 'updated' })
          expect(await database.account.delete({ where: { id } })).toEqual({
            id,
            name: 'updated',
          })
          expect(await database.account.findUnique({ where: { id } })).toBeNull()
          expect(completed.length - before).toBe(5)
        } finally {
          await database.$disconnect()
        }
      },
    )

    it.skipIf(!process.env.CYI_TEST_PRISMA_CLIENT)(
      'preserves concurrent Prisma transactions and native rollback errors',
      async () => {
        const { PrismaClient } = await import(process.env.CYI_TEST_PRISMA_CLIENT!)
        const database = new PrismaClient({ adapter: new PrismaPg(pool) })
        try {
          const before = completed.length
          const ids = [randomUUID(), randomUUID(), randomUUID()]
          await Promise.all(
            ids.map(async (id) => {
              await database.$transaction([
                database.account.create({ data: { id, name: 'transactional' } }),
                database.account.update({ where: { id }, data: { name: 'committed' } }),
              ])
              expect(await database.account.findUnique({ where: { id } })).toEqual({
                id,
                name: 'committed',
              })
              await database.account.delete({ where: { id } })
            }),
          )
          expect(completed.length - before).toBe(18)
          const rollbackId = randomUUID()
          await expect(
            database.$transaction([
              database.account.create({ data: { id: rollbackId, name: 'first' } }),
              database.account.create({ data: { id: rollbackId, name: 'duplicate' } }),
            ]),
          ).rejects.toMatchObject({ code: 'P2002' })
          expect(
            await database.account.findUnique({ where: { id: rollbackId } }),
          ).toBeNull()
        } finally {
          await database.$disconnect()
        }
      },
    )

    it('preserves concurrent Drizzle PostgreSQL model transactions and rollback', async () => {
      const database = postgresDrizzle(pool)
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      const before = completed.length
      await Promise.all(
        ids.map((id) =>
          database.transaction(async (transaction) => {
            await transaction.insert(pgAccounts).values({ id, name: 'concurrent' })
            expect(
              await transaction.select().from(pgAccounts).where(eq(pgAccounts.id, id)),
            ).toEqual([{ id, name: 'concurrent' }])
            await transaction.delete(pgAccounts).where(eq(pgAccounts.id, id))
          }),
        ),
      )
      expect(completed.length - before).toBe(15)
      const rollbackId = randomUUID()
      const failure = new Error('Application rollback')
      await expect(
        database.transaction(async (transaction) => {
          await transaction
            .insert(pgAccounts)
            .values({ id: rollbackId, name: 'rollback' })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(
        await database.select().from(pgAccounts).where(eq(pgAccounts.id, rollbackId)),
      ).toEqual([])
    })

    it('preserves business results when observation fails', async () => {
      const connection = new pg.Client({
        host: process.env.CYI_TEST_PG_SOCKET,
        database: 'postgres',
      })
      await connection.connect()
      let failAtStart = true
      const failing = new DatabaseDriverHooks({
        begin() {
          if (failAtStart) throw new Error('Observation setup failed')
          return () => {
            throw new Error('Observation completion failed')
          }
        },
        skipped() {
          throw new Error('Diagnostic hook failed')
        },
      })
      failing.install(connection, 'pg')
      try {
        expect((await connection.query('SELECT 19 AS value')).rows).toEqual([
          { value: 19 },
        ])
        failAtStart = false
        expect((await connection.query('SELECT 20 AS value')).rows).toEqual([
          { value: 20 },
        ])
      } finally {
        failing.uninstall()
        await connection.end()
      }
    })

    it('preserves native connection errors during a PostgreSQL outage', async () => {
      const unavailable = new pg.Pool({
        host: `/tmp/cyi969-missing-${randomUUID()}`,
        database: 'postgres',
      })
      const finished: number[] = []
      const monitoring = new DatabaseDriverHooks({
        begin() {
          return () => finished.push(1)
        },
        skipped() {},
      })
      monitoring.install(unavailable, 'pg')
      try {
        await expect(unavailable.query('SELECT 1')).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(finished).toEqual([1])
      } finally {
        monitoring.uninstall()
        await unavailable.end()
      }
    })

    it('restores methods and stops observations without closing application connections', async () => {
      hooks.uninstall()
      const before = completed.length
      expect(Object.hasOwn(pool, 'query')).toBe(false)
      expect((await pool.query('SELECT 5 AS value')).rows).toEqual([{ value: 5 }])
      expect(completed.length).toBe(before)
      expect(skipped.every((reason) => reason === 'unsupported_query')).toBe(true)
    })
  },
)

describe.skipIf(!process.env.CYI_TEST_MYSQL_SOCKET && !process.env.CYI_TEST_MYSQL_PORT)(
  'MySQL instance hooks with a real server',
  () => {
    const config = {
      ...(process.env.CYI_TEST_MYSQL_SOCKET
        ? { socketPath: process.env.CYI_TEST_MYSQL_SOCKET }
        : { host: '127.0.0.1', port: Number(process.env.CYI_TEST_MYSQL_PORT) }),
      user: 'root',
      database: 'cyi969',
      connectionLimit: 2,
    }
    const callbackPool = mysql.createPool(config)
    const promisePool = mysqlPromise.createPool(config)
    const completed: unknown[][] = []
    const skipped: string[] = []
    const hooks = new DatabaseDriverHooks({
      begin(args) {
        return () => {
          completed.push([...args])
        }
      },
      skipped(reason) {
        skipped.push(reason)
      },
    })
    hooks.install(callbackPool, 'mysql-callback')
    hooks.install(promisePool, 'mysql-promise')
    afterAll(async () => {
      hooks.uninstall()
      await promisePool.end()
      await new Promise<void>((resolve, reject) =>
        callbackPool.end((error) => (error ? reject(error) : resolve())),
      )
    })

    it('preserves promise query and execute result tuples without duplicates', async () => {
      const before = completed.length
      const [rows, fields] = await promisePool.query('SELECT ? AS value', [7])
      expect(rows).toEqual([{ value: 7 }])
      expect(fields[0]?.name).toBe('value')
      const [prepared] = await promisePool.execute('SELECT ? AS value', [8])
      expect(prepared).toEqual([{ value: 8 }])
      expect(completed.length - before).toBe(2)
    })

    it('preserves callback query objects and subsequent callback operations', async () => {
      const before = completed.length
      await new Promise<void>((resolve, reject) => {
        const query = callbackPool.query('SELECT ? AS value', [2], (error, result) => {
          if (error) {
            reject(error)
            return
          }
          expect(result).toEqual([{ value: 2 }])
          callbackPool.execute('SELECT ? AS value', [3], (nextError, nextResult) => {
            if (nextError) {
              reject(nextError)
              return
            }
            expect(nextResult).toEqual([{ value: 3 }])
            resolve()
          })
        })
        expect(query.constructor.name).toBe('Query')
      })
      expect(completed.length - before).toBe(2)
    })

    it('observes borrowed promise connections and preserves database errors', async () => {
      const connection = await promisePool.getConnection()
      const before = completed.length
      try {
        await expect(connection.query('SELECT missing_column')).rejects.toMatchObject({
          code: 'ER_BAD_FIELD_ERROR',
        })
        expect((await connection.query('SELECT 4 AS value'))[0]).toEqual([{ value: 4 }])
      } finally {
        connection.release()
      }
      expect(completed.length - before).toBe(2)
    })

    it('passes native streams through without inserting telemetry error listeners', async () => {
      const before = completed.length
      const query = callbackPool.query('SELECT 5 AS value')
      expect(query.listenerCount('error')).toBe(0)
      const rows: unknown[] = []
      for await (const row of query.stream()) rows.push(row)
      expect(rows).toEqual([{ value: 5 }])
      expect(completed.length).toBe(before)
      expect(skipped).toContain('unsupported_query')
    })

    it('observes Drizzle query and transaction work without an ORM duplicate', async () => {
      const database = mysqlDrizzle(promisePool)
      const before = completed.length
      expect((await database.execute(sql`SELECT ${15} AS value`))[0]).toEqual([
        { value: 15 },
      ])
      expect(completed.length - before).toBe(1)
      const transactionStart = completed.length
      await database.transaction(async (transaction) => {
        expect((await transaction.execute(sql`SELECT ${16} AS value`))[0]).toEqual([
          { value: 16 },
        ])
      })
      expect(completed.length - transactionStart).toBe(3)
    })

    it('preserves real MySQL Drizzle model CRUD', async () => {
      const database = mysqlDrizzle(promisePool)
      const id = randomUUID()
      const before = completed.length
      await database.insert(mysqlAccounts).values({ id, name: 'initial' })
      expect(
        await database.select().from(mysqlAccounts).where(eq(mysqlAccounts.id, id)),
      ).toEqual([{ id, name: 'initial' }])
      await database
        .update(mysqlAccounts)
        .set({ name: 'updated' })
        .where(eq(mysqlAccounts.id, id))
      expect(
        await database.select().from(mysqlAccounts).where(eq(mysqlAccounts.id, id)),
      ).toEqual([{ id, name: 'updated' }])
      await database.delete(mysqlAccounts).where(eq(mysqlAccounts.id, id))
      expect(
        await database.select().from(mysqlAccounts).where(eq(mysqlAccounts.id, id)),
      ).toEqual([])
      expect(completed.length - before).toBe(6)
    })

    it('preserves concurrent Drizzle MySQL model transactions and rollback', async () => {
      const database = mysqlDrizzle(promisePool)
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      const before = completed.length
      await Promise.all(
        ids.map((id) =>
          database.transaction(async (transaction) => {
            await transaction.insert(mysqlAccounts).values({ id, name: 'concurrent' })
            expect(
              await transaction
                .select()
                .from(mysqlAccounts)
                .where(eq(mysqlAccounts.id, id)),
            ).toEqual([{ id, name: 'concurrent' }])
            await transaction.delete(mysqlAccounts).where(eq(mysqlAccounts.id, id))
          }),
        ),
      )
      expect(completed.length - before).toBe(15)
      const rollbackId = randomUUID()
      const failure = new Error('Application rollback')
      await expect(
        database.transaction(async (transaction) => {
          await transaction
            .insert(mysqlAccounts)
            .values({ id: rollbackId, name: 'rollback' })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(
        await database
          .select()
          .from(mysqlAccounts)
          .where(eq(mysqlAccounts.id, rollbackId)),
      ).toEqual([])
    })

    it('preserves native connection errors during a MySQL outage', async () => {
      const unavailable = mysqlPromise.createPool({
        socketPath: `/tmp/cyi969-missing-${randomUUID()}.sock`,
        user: 'root',
      })
      const finished: number[] = []
      const monitoring = new DatabaseDriverHooks({
        begin() {
          return () => finished.push(1)
        },
        skipped() {},
      })
      monitoring.install(unavailable, 'mysql-promise')
      try {
        await expect(unavailable.query('SELECT 1')).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(finished).toEqual([1])
      } finally {
        monitoring.uninstall()
        await unavailable.end()
      }
    })

    it('uninstalls without closing either application-owned pool', async () => {
      hooks.uninstall()
      const before = completed.length
      expect(Object.hasOwn(callbackPool, 'query')).toBe(false)
      expect(Object.hasOwn(promisePool, 'execute')).toBe(false)
      expect((await promisePool.query('SELECT 6 AS value'))[0]).toEqual([{ value: 6 }])
      expect(completed.length).toBe(before)
    })
  },
)
