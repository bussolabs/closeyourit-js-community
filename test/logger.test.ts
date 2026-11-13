import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { CloseYourItLogger } from '../src/logger'
import type { Transport } from '../src/transport'
import type { EventPayload } from '../src/types'

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

// With a real, enabled client: an Error or a missing value must not reach the
// application as an exception (CYJS-77).
describe('CloseYourItLogger — non-string messages with the client enabled', () => {
  it('sends an Error as its message and ignores a missing one', async () => {
    const send = vi.fn((_payload: unknown, _url: string) => true)
    const client = new Client(
      {
        endpointUrl: 'https://www.closeyour.it',
        publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        projectId: 'p',
        environment: 'production',
      },
      {
        transport: { send, flush: vi.fn(async () => {}) } as unknown as Transport,
        random: () => 0,
      },
    )
    expect(client.enabled).toBe(true)
    const logger = new CloseYourItLogger(() => client, 'payments')

    expect(() => {
      logger.error(new Error('card declined') as never)
      logger.warn(undefined as never)
      logger.info(null as never)
    }).not.toThrow()
    await client.flush()

    const batch = send.mock.calls[0]![0] as EventPayload[]
    expect(batch.map((log) => log['message'])).toEqual(['card declined'])
    expect(client.stats.toObject().reasons.error).toBe(0)
    await client.close()
  })
})
