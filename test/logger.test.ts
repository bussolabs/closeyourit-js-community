import { describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import { CloseYourItLogger } from '../src/logger'

function fakeClient(): { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() }
}

describe('CloseYourItLogger', () => {
  it('exposes the 5 methods and normalizes warn→warning', () => {
    const client = fakeClient()
    const logger = new CloseYourItLogger(() => client as unknown as Client)

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.fatal('f')

    expect(client.log.mock.calls.map((c) => c[0])).toEqual([
      'debug',
      'info',
      'warning',
      'error',
      'fatal',
    ])
    expect(client.log.mock.calls.map((c) => c[1])).toEqual(['d', 'i', 'w', 'e', 'f'])
  })

  it('passes attributes and the logger name', () => {
    const client = fakeClient()
    const logger = new CloseYourItLogger(() => client as unknown as Client, 'payments')
    logger.info('order created', { order_id: 1 })
    expect(client.log).toHaveBeenCalledWith(
      'info',
      'order created',
      { order_id: 1 },
      'payments',
    )
  })

  it('named() creates a named child logger', () => {
    const client = fakeClient()
    const logger = new CloseYourItLogger(() => client as unknown as Client)
    logger.named('checkout').warn('slow')
    expect(client.log).toHaveBeenCalledWith('warning', 'slow', undefined, 'checkout')
  })

  it('is null-safe before init (no throw, no call)', () => {
    const logger = new CloseYourItLogger(() => null)
    expect(() => logger.error('x')).not.toThrow()
  })
})
