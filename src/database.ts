import { createHash, randomUUID } from 'node:crypto'
import type { Client } from './client'
import type { EventPayload } from './types'
import { scrubMessage } from './scrubber'
import { SDK_NAME, SDK_VERSION } from './version'
import { DatabaseDriverHooks } from './node/databaseDriver'
import type { DriverMode } from './node/databaseDriver'
import { QueryProfiles } from './node/queryProfiles'
import type { ProfileLimit } from './node/queryProfiles'
import { normalizeDatabaseSql } from './node/sql'

export interface DatabaseMonitoringOptions {
  /** Explicit opt-in. No hooks are installed unless true. */
  enabled?: boolean
  slowQueryThresholdMs?: number
  repeatedQueryThreshold?: number
}

type SkipReason =
  | ProfileLimit
  | 'unsupported_query'
  | 'instance_limit'
  | 'unpatchable'
  | 'unsupported_sql'

/** Observes application-owned pg/mysql2 instances, including ORM use of those instances. */
export class DatabaseMonitoring {
  private active: boolean
  private readonly threshold: number
  private readonly profiles: QueryProfiles
  private readonly hooks: DatabaseDriverHooks
  private readonly skipped: Record<SkipReason, number> = {
    unsupported_query: 0,
    instance_limit: 0,
    unpatchable: 0,
    unsupported_sql: 0,
    profile_limit: 0,
    group_limit: 0,
    query_limit: 0,
  }

  constructor(
    private readonly client: Client,
    options: DatabaseMonitoringOptions = {},
  ) {
    this.active = options.enabled === true
    this.threshold = options.slowQueryThresholdMs ?? 100
    if (!Number.isFinite(this.threshold) || this.threshold < 0)
      throw new RangeError('Slow query threshold must be finite and non-negative')
    this.profiles = new QueryProfiles(options.repeatedQueryThreshold ?? 5, (reason) =>
      this.skip(reason),
    )
    this.hooks = new DatabaseDriverHooks({
      begin: (args, mode) => this.begin(args, mode),
      skipped: (reason) => this.skip(reason),
    })
  }

  /** Pass the same Pool/Client supplied to Drizzle or PrismaPg. Never patch ORM and driver twice. */
  instrumentPostgres(target: object): void {
    if (this.enabled()) this.hooks.install(target, 'pg')
  }

  instrumentMysql(target: object, mode: 'promise' | 'callback'): void {
    if (mode !== 'promise' && mode !== 'callback')
      throw new TypeError('MySQL mode must be promise or callback')
    if (this.enabled()) this.hooks.install(target, `mysql-${mode}`)
  }

  /** Scope repeated-query detection to an awaited operation, such as an HTTP handler. */
  profile<T>(operation: () => T): T {
    return this.enabled() ? this.profiles.profile(operation) : operation()
  }

  /** Callback/streaming handlers must invoke end on response finish or close. */
  request<T>(operation: (end: () => void) => T): T {
    return this.enabled() ? this.profiles.request(operation) : operation(() => {})
  }

  getStats(): Readonly<Record<SkipReason, number>> {
    return { ...this.skipped }
  }

  /** Restores owned methods; never closes pools, clients or the application's SDK. */
  uninstall(): void {
    this.active = false
    this.hooks.uninstall()
    this.profiles.uninstall()
  }

  private enabled(): boolean {
    return this.active && this.client.enabled
  }

  private skip(reason: SkipReason): void {
    this.skipped[reason] = Math.min(Number.MAX_SAFE_INTEGER, this.skipped[reason] + 1)
  }

  private begin(args: readonly unknown[], mode: DriverMode): (() => void) | undefined {
    if (!this.enabled()) return
    const dialect = mode === 'pg' ? 'postgresql' : 'mysql'
    const input = args[0]
    // Driver hooks already reject custom objects/accessors. Do not read bindings or names.
    const raw =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object'
          ? Object.getOwnPropertyDescriptor(input, mode === 'pg' ? 'text' : 'sql')
              ?.value
          : undefined
    const sql = typeof raw === 'string' ? normalizeDatabaseSql(raw, dialect) : undefined
    if (!sql) {
      this.skip('unsupported_sql')
      // Keep the nested-driver guard active so pool forwarding counts one omission.
      return () => {}
    }
    const traceId = this.client.scope.traceId
    const source = callSite()
    const base: EventPayload = {
      sql,
      source,
      db_system: dialect,
      environment: this.client.options.environment,
      ...(this.client.options.release
        ? { release: scrubMessage(this.client.options.release) }
        : {}),
      ...(traceId ? { trace_id: traceId } : {}),
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    }
    const key = createHash('sha256')
      .update(`${dialect}\n${sql}\n${source}`)
      .digest('hex')
    const complete = this.profiles.track(key, (count, totalMs) => {
      this.emit({
        ...base,
        kind: 'performance_issue',
        subtype: 'n_plus_one',
        query_count: count,
        duration_ms: totalMs,
        total_query_time_ms: totalMs,
      })
    })
    const start = this.client.nowMs()
    return () => {
      if (!this.enabled()) return
      const durationMs = this.client.nowMs() - start
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      complete?.(durationMs)
      if (durationMs >= this.threshold)
        this.emit({ ...base, kind: 'slow_query', duration_ms: durationMs })
    }
  }

  private emit(payload: EventPayload): void {
    if (!this.enabled()) return
    this.client.captureMetric({
      ...payload,
      sample_id: randomUUID(),
      occurred_at: new Date().toISOString(),
    })
  }
}

function callSite(): string {
  // Never send paths or function names: they may contain tenant or user identifiers.
  const frames = (new Error().stack ?? '').slice(0, 8192).split('\n').slice(1, 12)
  const frame = frames.find(
    (line) =>
      !/callSite|DatabaseMonitoring\.|DatabaseDriverHooks\.|Object\.begin|AsyncLocalStorage|databaseDriver\.[cm]?[jt]s|\/dist\/database\.[cm]?js/.test(
        line,
      ),
  )
  return frame
    ? `node:${createHash('sha256').update(frame.trim()).digest('hex').slice(0, 16)}`
    : 'node:unknown'
}
