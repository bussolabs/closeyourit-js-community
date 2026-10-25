// @vitest-environment node
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { resolve } from 'node:path'

it('stops the owned Svelte proof server with an incomplete HTTP connection without SIGKILL', async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string')
    throw new Error('A local address is required')
  await new Promise<void>((done) => reservation.close(() => done()))
  const child = spawn(process.execPath, [resolve('examples/svelte/server.mjs')], {
    env: { PATH: process.env.PATH, PORT: String(address.port), CYI_PROOF_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let socket: ReturnType<typeof connect> | undefined
  const exited = once(child, 'exit')
  try {
    await once(child.stdout!, 'data')
    socket = connect(address.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n')
    await new Promise((done) => setTimeout(done, 30))
    child.kill('SIGTERM')
    const result = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done('deadline'), 3000)),
    ])
    expect(result).toEqual([0, null])
  } finally {
    socket?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}, 10_000)
