import { createServer } from 'node:http'

const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('A valid proof server port is required')
// Both Node adapters otherwise assume HTTPS. This owned loopback server is the trusted HTTP proxy.
process.env.PROTOCOL_HEADER = 'x-cyi-laboratory-protocol'
const { handler } = await import('./build/handler.js')
const server = createServer((request, response) => {
  request.headers['x-cyi-laboratory-protocol'] = 'http'
  handler(request, response)
})
server.listen(port, '127.0.0.1', () => process.stdout.write('SvelteKit proof ready\n'))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => process.exit(0))
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 2000).unref()
  })
