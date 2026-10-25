#!/usr/bin/env node
// Real packaged Node adapters; construction and refused transport are not backend delivery.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = mkdtempSync(join(tmpdir(), 'cyi-sveltekit-'))
const environment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
environment.CI = '1'
const node = process.env.SMOKE_CONSUMER_NODE || process.execPath
const children = new Set()
const results = []
const fetchRequests = []
const fetchTarget = createHttpServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  fetchRequests.push({ url: request.url, body })
  if (request.url.includes('delay'))
    await new Promise((resolve) => setTimeout(resolve, 100))
  response.setHeader('Content-Type', 'application/json')
  response.end(
    JSON.stringify({
      body,
      application_header: request.headers['x-proof-header'],
      traceparent: request.headers.traceparent ?? null,
      baggage: request.headers.baggage ?? null,
      tracestate: request.headers.tracestate ?? null,
    }),
  )
})
function run(command, args, cwd = repo, timeout = 240_000) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    timeout,
    encoding: 'utf8',
    maxBuffer: 4_194_304,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
async function port() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  children.delete(child)
}
async function request(endpoint, path, status, method = 'GET') {
  const response = await fetch(endpoint + path, {
    method,
    body: method === 'POST' ? 'private-body' : undefined,
    headers: { Origin: endpoint, cookie: 'private-cookie', baggage: 'private=baggage' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  assert.equal(response.status, status, path)
  return text
}
async function start(app, extra) {
  const listen = await port()
  const child = spawn(node, ['server.mjs'], {
    cwd: app,
    env: { ...environment, HOST: '127.0.0.1', PORT: String(listen), ...extra },
    stdio: 'ignore',
  })
  children.add(child)
  let failure
  child.on('error', (error) => {
    failure = error
  })
  const endpoint = `http://127.0.0.1:${listen}`
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if (failure) throw failure
      await request(endpoint, '/api/proof-status', 200)
      return { child, endpoint }
    } catch (error) {
      if (failure || Date.now() >= deadline || child.exitCode !== null) {
        await stop(child)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
try {
  await new Promise((resolve) => fetchTarget.listen(0, '127.0.0.1', resolve))
  const fetchEndpoint = `http://127.0.0.1:${fetchTarget.address().port}/echo`
  let artifact = process.env.SMOKE_PACKAGE_ARTIFACT
  if (artifact) assert.equal(hash(artifact), process.env.SMOKE_PACKAGE_SHA256)
  else {
    const packed = JSON.parse(
      run('npm', [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        workspace,
      ]),
    )[0]
    artifact = join(workspace, packed.filename)
  }
  for (const version of ['2.70.3', '3.0.0']) {
    const app = join(workspace, version)
    cpSync(join(repo, 'examples/sveltekit'), app, { recursive: true })
    if (version.startsWith('2.')) {
      for (const file of ['package.json', 'package-lock.json'])
        cpSync(join(repo, 'examples/sveltekit2', file), join(app, file))
      cpSync(join(repo, 'examples/sveltekit2/profile.js'), join(app, 'src/profile.js'))
    }
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], app)
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-save',
        '--package-lock=false',
        '--no-audit',
        '--no-fund',
        artifact,
      ],
      app,
    )
    run(node, ['node_modules/vite/bin/vite.js', 'build'], app)
    const typesModule = version.startsWith('2.')
      ? '@sveltejs/kit'
      : '@sveltejs/kit/hooks'
    writeFileSync(
      join(app, 'types.mts'),
      `import type { Handle, HandleServerError, HandleClientError, HandleFetch } from '${typesModule}';
import { Client } from '@bussolabs/closeyourit-js';
import { createSvelteKitServer } from '@bussolabs/closeyourit-js/sveltekit/server';
import { createSvelteKitClient } from '@bussolabs/closeyourit-js/sveltekit/client';
const client = new Client({ enabled: false, endpointUrl: '', projectId: '' });
const server = createSvelteKitServer(client, { version: ${version[0]} });
const handle: Handle = server.wrapHandle<Parameters<Handle>[0]>(({ event, resolve }) => resolve(event));
const handleError: HandleServerError = server.wrapHandleError<Parameters<HandleServerError>[0], void>(() => undefined);
const handleFetch: HandleFetch = server.wrapHandleFetch<Parameters<HandleFetch>[0]>(async ({ request, fetch }) => fetch(request));
const browser = createSvelteKitClient(client, { version: ${version[0]} });
const clientError: HandleClientError = browser.wrapHandleError<Parameters<HandleClientError>[0], void>(() => undefined);
`,
    )
    run(
      node,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        'types.mts',
      ],
      app,
    )
    if (process.env.SMOKE_BUILD_ONLY === '1') {
      results.push({ version, app, artifact_sha256: hash(artifact) })
      continue
    }
    const base = {
      CYI_PROOF_PROJECT: 'local-construction',
      CYI_PROOF_TOKEN: 'cyi_' + 'a'.repeat(40),
      CYI_PROOF_RELEASE: `sveltekit-${version}`,
      CYI_PROOF_CONSTRUCTION_ONLY: '1',
      CYI_PROOF_FETCH_TARGET: fetchEndpoint,
    }
    const disabled = await start(app, { ...base, CYI_PROOF_ENABLED: '0' })
    await request(disabled.endpoint, '/api/work/one', 500, 'POST')
    assert.equal(await request(disabled.endpoint, '/stream', 200), 'first\nlast\n')
    assert.deepEqual(
      JSON.parse(await request(disabled.endpoint, '/api/proof-status', 200))
        .observations,
      [],
    )
    await stop(disabled.child)
    const active = await start(app, { ...base, CYI_PROOF_ENABLED: '1' })
    await Promise.all(
      ['one', 'two', 'three'].map((id) =>
        request(active.endpoint, `/api/work/${id}?private=private-query`, 500, 'POST'),
      ),
    )
    const status = JSON.parse(await request(active.endpoint, '/api/proof-status', 200))
    const errors = status.observations.filter((entry) => entry.kind === 'error')
    const metrics = status.observations.filter((entry) => entry.kind === 'slow_method')
    const logs = status.observations.filter((entry) => entry.kind === 'log')
    assert.equal(errors.length, 3)
    assert.equal(metrics.length, 3)
    assert.equal(logs.length, 3)
    assert.equal(new Set(errors.map((entry) => entry.trace_id)).size, 3)
    for (const error of errors) {
      assert.equal(
        metrics.filter((entry) => entry.trace_id === error.trace_id).length,
        1,
      )
      assert.equal(logs.filter((entry) => entry.trace_id === error.trace_id).length, 1)
      assert.equal(error.route, '/api/work/[id]')
      assert.equal(error.release, base.CYI_PROOF_RELEASE)
    }
    await request(active.endpoint, '/api/work/expected', 404, 'POST')
    await request(active.endpoint, '/api/work/redirect', 307, 'POST')
    assert.equal(
      JSON.parse(
        await request(active.endpoint, '/api/proof-status', 200),
      ).observations.filter((entry) => entry.kind === 'error').length,
      3,
    )
    await request(active.endpoint, '/ssr-error', 500)
    assert.equal(await request(active.endpoint, '/stream', 200), 'first\nlast\n')
    assert.match(await request(active.endpoint, '/deferred', 200), /Deferred content/)
    await request(active.endpoint, '/deferred-error', 200)
    const final = JSON.parse(await request(active.endpoint, '/api/proof-status', 200))
    assert.equal(final.observations.filter((entry) => entry.kind === 'error').length, 5)
    const delayed = final.observations.find(
      (entry) => entry.kind === 'error' && entry.route === '/deferred-error',
    )
    assert.ok(delayed)
    assert.equal(
      final.observations.filter(
        (entry) => entry.kind === 'slow_method' && entry.trace_id === delayed.trace_id,
      ).length,
      1,
    )
    for (const mode of ['normal', 'existing', 'untrusted']) {
      const fetched = JSON.parse(
        await request(active.endpoint, `/api/fetch?mode=${mode}`, 200, 'POST'),
      )
      assert.equal(fetched.received.body, 'private-body')
      assert.equal(fetched.received.application_header, 'application-header')
      assert.equal(fetched.received.baggage, null)
      assert.equal(fetched.received.tracestate, null)
      if (mode === 'normal')
        assert.equal(fetched.received.traceparent.split('-')[1], fetched.trace_id)
      else if (mode === 'existing')
        assert.equal(
          fetched.received.traceparent,
          '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
        )
      else assert.equal(fetched.received.traceparent, null)
    }
    const aborted = JSON.parse(
      await request(active.endpoint, '/api/fetch?mode=abort', 200, 'POST'),
    )
    assert.equal(aborted.aborted, true)
    assert.ok(
      fetchRequests.some(
        (entry) => entry.url.includes('delay') && entry.body === 'private-body',
      ),
    )
    await stop(active.child)
    const removed = await start(app, {
      ...base,
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_UNINSTALL: '1',
    })
    await request(removed.endpoint, '/api/work/one', 500, 'POST')
    const removedStatus = JSON.parse(
      await request(removed.endpoint, '/api/proof-status', 200),
    )
    assert.equal(
      removedStatus.observations.filter((entry) => entry.kind !== 'log').length,
      0,
    )
    await stop(removed.child)
    const outage = await start(app, {
      ...base,
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_CONSTRUCTION_ONLY: '0',
      CYI_PROOF_ENDPOINT: `http://127.0.0.1:${await port()}`,
    })
    const body = JSON.parse(await request(outage.endpoint, '/api/work/ok', 200, 'POST'))
    assert.equal(body.body_unchanged, true)
    const outageStatus = JSON.parse(
      await request(outage.endpoint, '/api/proof-status', 200),
    )
    assert.ok(outageStatus.stats.failed > 0)
    assert.equal(outageStatus.stats.sent, 0)
    await stop(outage.child)
    results.push({
      version,
      svelte: '5.57.1',
      node: run(node, ['--version']).trim(),
      artifact_sha256: hash(artifact),
      lock_sha256: hash(join(app, 'package-lock.json')),
      concurrent_correlations: 3,
      ssr_errors: 1,
      deferred_correlated_error: true,
      expected_excluded: true,
      disabled: true,
      uninstall: true,
      stream_bytes_preserved: true,
      real_handle_fetch: true,
      fetch_body_headers_carrier_and_cancellation: true,
      unavailable_transport: true,
      backend_delivery: false,
    })
  }
  const standalone = join(workspace, 'standalone')
  cpSync(join(repo, 'examples/svelte'), standalone, { recursive: true })
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], standalone)
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-save',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      artifact,
    ],
    standalone,
  )
  run(node, ['node_modules/vite/bin/vite.js', 'build'], standalone)
  process.stdout.write(
    JSON.stringify({ profile: 'sveltekit-construction', workspace, results }, null, 2) +
      '\n',
  )
} finally {
  await Promise.all([...children].map(stop))
  fetchTarget.closeAllConnections()
  await new Promise((resolve) => fetchTarget.close(resolve))
  if (process.env.SMOKE_KEEP_WORKSPACE !== '1')
    rmSync(workspace, { recursive: true, force: true })
}
