// The backend's canonical log levels and their normalization. Mirror of
// `LogLevel` (dart) and of the normalization in `LogDevice`/`LogEvent` (gem):
// warn→warning, err→error, unknown→fatal, unknown level→info.

import type { LogLevel } from './types'

const ORDINALS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  fatal: 4,
}

const ALIASES: Record<string, LogLevel> = {
  warn: 'warning',
  err: 'error',
  unknown: 'fatal',
}

/// Normalizes an arbitrary level to the wire canon (`debug|info|warning|error|fatal`).
export function normalizeLogLevel(input: string): LogLevel {
  const value = input.trim().toLowerCase()
  if (value in ORDINALS) return value as LogLevel
  return ALIASES[value] ?? 'info'
}

/// Position of the level in the severity scale (debug=0 … fatal=4).
export function logLevelOrdinal(level: LogLevel): number {
  return ORDINALS[level]
}

/// `true` if [level] is equal to or above [min].
export function meetsMinLevel(level: LogLevel, min: LogLevel): boolean {
  return logLevelOrdinal(level) >= logLevelOrdinal(min)
}
