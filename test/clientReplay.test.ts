import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

// Browser (jsdom): credential = DSN public key (CYJS-1).
const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  projectId: 'p',
  environment: 'production',
}

function fakeTransport(): {
  send: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  calls: Array<{ payload: EventPayload; url: string }>
} {
  const calls: Array<{ payload: EventPayload; url: string }> = []
  return {
    calls,
    send: vi.fn((payload: EventPayload, url: string) => {
      calls.push({ payload, url })
      return true
    }),
    flush: vi.fn(async () => {}),
  }
}

function makeClient(options: Partial<CloseYourItOptions> = {}): {
  client: Client
  transport: ReturnType<typeof fakeTransport>
} {
  const transport = fakeTransport()
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport, random: () => 0 },
  )
  return { client, transport }
}

describe('Client — captureReplayChunk', () => {
  it('sends the chunk to the replays endpoint with environment', () => {
    const { client, transport } = makeClient()
    client.captureReplayChunk({ replay_session_id: 's', seq: 0, events: [] })

    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]!.url).toBe(
      'https://www.closeyour.it/api/v1/projects/p/replays',
    )
    expect(transport.calls[0]!.payload).toMatchObject({
      replay_session_id: 's',
      environment: 'production',
    })
  })

  it('is a no-op when disabled (publicKey missing in the browser)', () => {
    const { client, transport } = makeClient({ publicKey: '' })
    client.captureReplayChunk({ replay_session_id: 's', seq: 0, events: [] })
    expect(transport.send).not.toHaveBeenCalled()
  })
})

describe('Client — replay_session_id on errors', () => {
  it('attaches contexts.replay.replay_id to errors after setReplaySessionId', () => {
    const { client, transport } = makeClient()
    client.setReplaySessionId('sess-42')
    client.captureException(new Error('boom'))

    const contexts = transport.calls[0]!.payload['contexts'] as {
      replay?: { replay_id?: string }
    }
    expect(contexts.replay?.replay_id).toBe('sess-42')
  })

  it('does not add contexts.replay when there is no replay session', () => {
    const { client, transport } = makeClient()
    client.captureException(new Error('boom'))

    const contexts = transport.calls[0]!.payload['contexts'] as {
      replay?: unknown
    }
    expect(contexts.replay).toBeUndefined()
  })

  it('attaches replay_id to diagnostic messages too', () => {
    const { client, transport } = makeClient()
    client.setReplaySessionId('sess-99')
    client.captureMessage('hello', 'info')

    const contexts = transport.calls[0]!.payload['contexts'] as {
      replay?: { replay_id?: string }
    }
    expect(contexts.replay?.replay_id).toBe('sess-99')
  })
})
