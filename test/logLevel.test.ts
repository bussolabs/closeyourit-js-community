import { describe, expect, it } from 'vitest'
import { logLevelOrdinal, meetsMinLevel, normalizeLogLevel } from '../src/logLevel'

describe('normalizeLogLevel', () => {
  it('passes the canonical levels through unchanged', () => {
    expect(normalizeLogLevel('debug')).toBe('debug')
    expect(normalizeLogLevel('info')).toBe('info')
    expect(normalizeLogLevel('warning')).toBe('warning')
    expect(normalizeLogLevel('error')).toBe('error')
    expect(normalizeLogLevel('fatal')).toBe('fatal')
  })

  it('normalizes the aliases (ruby/dart parity)', () => {
    expect(normalizeLogLevel('warn')).toBe('warning')
    expect(normalizeLogLevel('err')).toBe('error')
    expect(normalizeLogLevel('unknown')).toBe('fatal')
  })

  it('is case-insensitive and tolerates spaces', () => {
    expect(normalizeLogLevel('WARN')).toBe('warning')
    expect(normalizeLogLevel(' Error ')).toBe('error')
  })

  it('an unknown level falls back to info', () => {
    expect(normalizeLogLevel('verbose')).toBe('info')
    expect(normalizeLogLevel('')).toBe('info')
  })
})

describe('logLevelOrdinal / meetsMinLevel', () => {
  it('orders debug < info < warning < error < fatal', () => {
    expect(logLevelOrdinal('debug')).toBeLessThan(logLevelOrdinal('info'))
    expect(logLevelOrdinal('info')).toBeLessThan(logLevelOrdinal('warning'))
    expect(logLevelOrdinal('warning')).toBeLessThan(logLevelOrdinal('error'))
    expect(logLevelOrdinal('error')).toBeLessThan(logLevelOrdinal('fatal'))
  })

  it('meetsMinLevel filters below the threshold and passes from the threshold up', () => {
    expect(meetsMinLevel('debug', 'info')).toBe(false)
    expect(meetsMinLevel('info', 'info')).toBe(true)
    expect(meetsMinLevel('fatal', 'info')).toBe(true)
    expect(meetsMinLevel('warning', 'error')).toBe(false)
  })
})
