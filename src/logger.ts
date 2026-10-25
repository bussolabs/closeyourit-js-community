// Named, null-safe application logger. Mirror of `CloseYourIt.logger`
// (gem, LogDevice) and `CloseYourItLogger` (dart): per-level convenience methods
// that delegate to `client.log`. `warn` is normalized to `warning` (wire
// canon). Before `init` every method is a no-op.

import type { Client } from './client'

export class CloseYourItLogger {
  constructor(
    private readonly getClient: () => Client | null,
    private readonly name?: string | undefined,
  ) {}

  /// A named child logger (`logger.named('payments').info(...)`).
  named(name: string): CloseYourItLogger {
    return new CloseYourItLogger(this.getClient, name)
  }

  debug(message: string, attributes?: Record<string, unknown>): void {
    this.emit('debug', message, attributes)
  }

  info(message: string, attributes?: Record<string, unknown>): void {
    this.emit('info', message, attributes)
  }

  warn(message: string, attributes?: Record<string, unknown>): void {
    this.emit('warning', message, attributes)
  }

  error(message: string, attributes?: Record<string, unknown>): void {
    this.emit('error', message, attributes)
  }

  fatal(message: string, attributes?: Record<string, unknown>): void {
    this.emit('fatal', message, attributes)
  }

  private emit(
    level: 'debug' | 'info' | 'warning' | 'error' | 'fatal',
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    this.getClient()?.log(level, message, attributes, this.name)
  }
}
