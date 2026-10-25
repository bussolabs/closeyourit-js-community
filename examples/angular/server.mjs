import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
const root = resolve('dist/proof/browser')
const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('A valid proof port is required')
const configuration = {
  endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'https://localhost.invalid',
  publicKey: process.env.CYI_PROOF_PUBLIC_KEY,
  projectId: process.env.CYI_PROOF_PROJECT,
  environment: 'certification',
  release: process.env.CYI_PROOF_RELEASE || 'angular-local',
  enabled: process.env.CYI_PROOF_ENABLED === '1',
  mode: process.env.CYI_PROOF_MODE,
  constructionOnly: process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1',
}
let retries = 0
const observations = []
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (path === '/api/config' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(configuration))
      return
    }
    if (path === '/api/http-status' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ observations }))
      return
    }
    if (
      ['/proof-http/success', '/proof-http/retry', '/proof-http/cancel'].includes(
        path,
      ) &&
      ['GET', 'POST'].includes(request.method)
    ) {
      let bytes = 0
      const chunks = []
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 1024) {
          response.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      const status = path === '/proof-http/retry' && ++retries === 1 ? 503 : 200
      const carrier = request.headers.traceparent
      const traceId =
        typeof carrier === 'string' &&
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(carrier)
          ? carrier.slice(3, 35)
          : null
      const observed = {
        path,
        method: request.method,
        status,
        trace_id: traceId,
        body_matches:
          Buffer.concat(chunks).toString('utf8') === '{"password":"private-body"}',
        completed: false,
        cancelled: false,
      }
      if (observations.length < 16) observations.push(observed)
      response.once('finish', () => {
        observed.completed = true
      })
      response.once('close', () => {
        observed.cancelled = !observed.completed
      })
      setTimeout(
        () => {
          response.writeHead(status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ok: true, body_seen: observed.body_matches }))
        },
        path === '/proof-http/cancel' ? 100 : 10,
      )
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    const file = resolve(
      root,
      '.' + decodeURIComponent(path === '/' ? '/index.html' : path),
    )
    if (!file.startsWith(root + sep)) {
      response.writeHead(404).end()
      return
    }
    let chosen = file
    try {
      if (!(await stat(chosen)).isFile()) chosen = resolve(root, 'index.html')
    } catch {
      chosen = resolve(root, 'index.html')
    }
    response.setHeader(
      'Content-Type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css',
        '.map': 'application/json',
      }[extname(chosen)] || 'application/octet-stream',
    )
    response.end(await readFile(chosen))
  } catch {
    response.writeHead(400).end()
  }
})
server.listen(port, '127.0.0.1', () => process.stdout.write('Angular proof ready\n'))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)))
