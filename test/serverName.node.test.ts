// @vitest-environment node
// Scenario CYJS-3: on Node backends the error must carry `server_name` (hostname),
// in parity with the Ruby gem, so on a multi-instance fleet you can tell which
// host generated the error and the `server_name` filter does not stay empty for Node.

import { hostname } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import type { Transport } from '../src/transport'
import type { CloseYourItOptions, EventPayload } from '../src/types'

const base: CloseYourItOptions = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_x',
  projectId: 'p',
  environment: 'production',
}

interface FakeTransport {
  send: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  calls: Array<{ payload: unknown; url: string }>
}

function fakeTransport(): FakeTransport {
  const calls: Array<{ payload: unknown; url: string }> = []
  return {
    calls,
    send: vi.fn((payload: unknown, url: string) => {
      calls.push({ payload, url })
      return true
    }),
    flush: vi.fn(async () => {}),
  }
}

function makeClient(options: Partial<CloseYourItOptions> = {}): {
  client: Client
  transport: FakeTransport
} {
  const transport = fakeTransport()
  const client = new Client(
    { ...base, ...options },
    { transport: transport as unknown as Transport, random: () => 0 },
  )
  return { client, transport }
}

describe('server_name on Node backends (CYJS-3)', () => {
  it('captureException includes server_name = hostname (parity with the gem)', () => {
    const { client, transport } = makeClient()
    client.captureException(new Error('server boom'))
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['server_name']).toBe(hostname())
  })

  it('captureMessage includes server_name = hostname', () => {
    const { client, transport } = makeClient()
    client.captureMessage('diagnostics')
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload['server_name']).toBe(hostname())
  })

  it('sendServerName:false disables sending server_name', () => {
    const { client, transport } = makeClient({ sendServerName: false })
    client.captureException(new Error('x'))
    const payload = transport.calls[0]!.payload as EventPayload
    expect(payload).not.toHaveProperty('server_name')
  })
})
