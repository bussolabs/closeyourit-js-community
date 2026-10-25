import assert from 'node:assert/strict'
import pg from 'pg'
import mysql from 'mysql2/promise'

// Only the ephemeral CI services expose these loopback ports. Never use application URLs.
assert.equal(process.env.CYI_DATABASE_TEST_SETUP, '1')
assert.equal(process.env.CYI_TEST_PG_SOCKET, '127.0.0.1')
for (const name of ['PGPORT', 'CYI_TEST_MYSQL_PORT'])
  assert.ok(
    /^[0-9]+$/.test(process.env[name] ?? '') &&
      Number(process.env[name]) > 0 &&
      Number(process.env[name]) <= 65535,
  )
const postgres = new pg.Client({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT),
  user: 'postgres',
  database: 'postgres',
})
await postgres.connect()
try {
  await postgres.query(
    'CREATE TABLE cyi969_accounts (id varchar(36) PRIMARY KEY, name varchar(100) NOT NULL)',
  )
} finally {
  await postgres.end()
}
const connection = await mysql.createConnection({
  host: '127.0.0.1',
  port: Number(process.env.CYI_TEST_MYSQL_PORT),
  user: 'root',
})
try {
  await connection.query('CREATE DATABASE cyi969')
  await connection.query(
    'CREATE TABLE cyi969.cyi969_accounts (id varchar(36) PRIMARY KEY, name varchar(100) NOT NULL)',
  )
} finally {
  await connection.end()
}
