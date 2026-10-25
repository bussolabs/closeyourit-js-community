import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist')
const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('A valid proof server port is required')
const configuration = {
  endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
  projectId: process.env.CYI_PROOF_PROJECT,
  publicKey: process.env.CYI_PROOF_PUBLIC_KEY,
  environment: 'certification',
  release: process.env.CYI_PROOF_RELEASE || 'vue-local',
  enabled: process.env.CYI_PROOF_ENABLED === '1',
}
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end()
    return
  }
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname === '/api/config') {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        request.method === 'HEAD' ? undefined : JSON.stringify(configuration),
      )
      return
    }
    const path = resolve(
      root,
      `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`,
    )
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.setHeader(
      'Content-Type',
      contentTypes[extname(path)] || 'application/octet-stream',
    )
    response.end(request.method === 'HEAD' ? undefined : await readFile(path))
  } catch {
    response.writeHead(404).end()
  }
})
server.listen(port, '127.0.0.1', () => process.stdout.write('Vue proof ready\n'))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)))
