# Node database monitoring

The optional `@bussolabs/closeyourit-js/database` entry observes application-owned
`pg` and `mysql2` instances. It emits `slow_query` metrics and request-local
`performance_issue` / `n_plus_one` verdicts through the existing Client transport.
It adds no database driver to the runtime dependencies or browser bundle.
The feature is introduced in the 0.13.0 candidate; registry publication is a separate gate.

## PostgreSQL and request boundaries

```ts
import pg from 'pg'
import { Client } from '@bussolabs/closeyourit-js'
import { DatabaseMonitoring } from '@bussolabs/closeyourit-js/database'

const client = new Client({
  endpointUrl: 'https://app.closeyour.it',
  projectId: process.env.CLOSEYOURIT_PROJECT_ID!,
  token: process.env.CLOSEYOURIT_TOKEN!,
  environment: 'production',
  release: 'orders@1.0.0',
})
const pool = new pg.Pool()
const monitoring = new DatabaseMonitoring(client, {
  enabled: true,
  slowQueryThresholdMs: 100,
  repeatedQueryThreshold: 5,
})
monitoring.instrumentPostgres(pool)

await client.runWithScope(() =>
  monitoring.profile(async () => {
    await pool.query('SELECT $1::integer AS value', [1])
  }),
)

monitoring.uninstall()
await client.close()
await pool.end()
```

`enabled` defaults to **false**. A disabled SDK client also prevents installation
and capture. Threshold defaults are **100 ms** and **five repetitions**; zero
milliseconds records every completed supported query. Repetition thresholds must
be integers from 2 to 1000. Both successful and failed completed queries are timed.

`profile` preserves synchronous results and awaits native Promise completion.
Nested profiles share their request. Separate concurrent profiles never share
counts. Queries outside a profile still produce slow-query measurements but no
repetition verdict. Detached work after completion is excluded from its aggregate.

For callback or streaming HTTP handlers, end the profile at response completion:

```ts
app.use((_request, response, next) =>
  monitoring.request((end) => {
    response.once('finish', end)
    response.once('close', end)
    next()
  }),
)
```

Install the existing HTTP adapter as well when request trace correlation is needed.
Database monitoring captures the Client's current trace ID; it does not create a
distributed span or adopt incoming headers itself.

## MySQL, Drizzle and Prisma

Pass a `mysql2/promise` pool or connection to
`monitoring.instrumentMysql(pool, 'promise')`. For `mysql2` callback APIs use
`instrumentMysql(pool, 'callback')`; calls without callbacks retain their native
stream/event semantics and are intentionally not instrumented.

With Drizzle, instrument the same native pool supplied to
`drizzle-orm/node-postgres` or `drizzle-orm/mysql2`. With Prisma 7, instrument the
explicit PostgreSQL pool passed to `new PrismaPg(pool)`. ORM operations are observed
at the driver boundary, once per physical query, including transaction statements.
**Prisma's MySQL path, internal engines and other driver adapters are not covered.**

Only the supplied instances and connections borrowed from them are patched.
Global prototypes remain untouched. A second monitor cannot own the same instance.
Uninstall restores only methods still owned by the adapter; application replacements
win. Pools, database transactions and the SDK Client remain application-owned.

## Privacy, budgets and diagnostics

Bindings, results, connection configuration and prepared-statement names are never
sent. Literals and placeholders become `?`; identifiers become deterministic
pseudonyms. Hashing is not an anonymity guarantee against guessed identifiers.
Only a fixed vocabulary of SQL structural keywords is retained. The call site is a
hash of a bounded stack frame, not a raw path, user name or function name. ORM/internal
frames can become the call site; an unavailable site is explicitly `node:unknown`.
These pseudonyms can vary across installations and builds.

SQL input is limited to **32,768 characters**, **1,024 tokens** and **8,192 output
characters**. Unknown syntax, multiple statements, executable MySQL comments and
unterminated input are omitted. Backslashes in ordinary quoted strings are omitted
because the connection's SQL mode is unknown; PostgreSQL's explicit `E'…'` form is
supported. Omission never rejects or rewrites the application's query.

At most **256 driver instances**, **64 simultaneous profiles**, **64 query groups
per profile** and **1,000 operations per profile** are retained. If a profile exceeds
a group/query limit, its repetition verdicts are suppressed rather than reporting
partial totals. Slow-query measurements remain independent of profile limits.
Callers must end manual profiles; unfinished profiles consume bounded capacity
until completion or uninstall.

`monitoring.getStats()` returns local omission counts: `unsupported_query`,
`unsupported_sql`, `unpatchable`, `instance_limit`, `profile_limit`, `group_limit`,
`query_limit`. `client.stats.toObject()` and the existing `onDiagnostic` hook report
delivery failures and drops. There is no retry queue or durable offline buffering.
Native Query/cursor/custom accessor objects and textless named prepared executions
are unsupported observations, while their business behavior is preserved.

## Verification

The real-driver suite covers pg **8.23.1**, mysql2 **3.24.5**, Drizzle **0.45.3** and
Prisma Client/adapter-pg **7.10.0** on Node **24.21.0**. The local servers are
PostgreSQL **17.11** and MySQL **26.7.0**, Darwin arm64. This does not claim every
Node/database version supported by those packages. CI additionally configures
PostgreSQL 17 and MySQL 8.4; configuration alone is not a passed test result.

`test/nodeDatabaseDriver.node.test.ts` exercises real CRUD, prepared queries,
transactions, concurrent rollback, callbacks, stream identity, native errors,
observation failures and uninstall. `test/database.node.test.ts` adds private query
payloads, concurrent request boundaries and ownership. Without the explicit local
database settings, these real-server cases are skipped and must not be reported as
passing integration evidence.

Prepare a separately installed candidate with:

```sh
mise exec -- node scripts/prepare-database-consumer.mjs /absolute/new/consumer
```

The companion Labs command `bin/certify-node-database` runs six profiles across
enabled, disabled, uninstalled and refused-network phases using ephemeral backend
credentials supplied through stdin. It compares sent sample identities with private
API readback and revokes the credentials afterwards. See the shared compatibility
record for the exact successful run and its artifact digest.

Lexical references: [PostgreSQL SQL syntax](https://www.postgresql.org/docs/current/sql-syntax-lexical.html)
and [MySQL string literals and SQL modes](https://dev.mysql.com/doc/refman/8.4/en/string-literals.html).
