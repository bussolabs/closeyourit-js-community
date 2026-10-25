#!/usr/bin/env node
// Packaged frameworks and real HTTP. Construction-only evidence is not backend delivery.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = mkdtempSync(join(tmpdir(), 'cyi-node-frameworks-'))
const environment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
environment.CI = '1'
const node = process.env.SMOKE_CONSUMER_NODE || process.execPath
const children = new Set()
const results = []
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
function run(command, args, cwd = repo) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    timeout: 240_000,
    encoding: 'utf8',
    maxBuffer: 4_194_304,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  children.delete(child)
  assert.equal(child.exitCode, 0, 'The owned producer must shut down cleanly')
}
async function request(origin, path, method = 'GET') {
  const response = await fetch(origin + path, {
    method,
    body: method === 'POST' ? 'private-body' : undefined,
    headers: {
      'Content-Type': 'text/plain',
      cookie: 'private-cookie',
      baggage: 'private=private-baggage',
      tracestate: 'private=private-state',
    },
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, text: await response.text() }
}
async function start(app, profile, enabled, uninstall, outage) {
  const port = await freePort()
  let offlinePort = outage ? await freePort() : 1
  while (offlinePort === port) offlinePort = await freePort()
  const child = spawn(node, ['server.mjs'], {
    cwd: app,
    env: {
      ...environment,
      PORT: String(port),
      CYI_PROOF_PROFILE: profile,
      CYI_PROOF_ENABLED: enabled ? '1' : '0',
      CYI_PROOF_UNINSTALL: uninstall ? '1' : '0',
      CYI_PROOF_CONSTRUCTION_ONLY: outage ? '0' : '1',
      CYI_PROOF_ENDPOINT: `http://127.0.0.1:${offlinePort}`,
      CYI_PROOF_OTLP_ENDPOINT: `http://127.0.0.1:${offlinePort}/v1/traces`,
      CYI_PROOF_PROJECT: 'node-proof',
      CYI_PROOF_TOKEN: 'cyi_' + 'a'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.stderr.resume()
  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Producer exited before readiness: ${profile}`)
    try {
      const response = await request(origin, '/proof-status')
      if (response.status === 200) return { child, origin }
    } catch {
      /* Bounded readiness. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Producer readiness expired: ${profile}`)
}
try {
  let artifact = process.env.SMOKE_PACKAGE_ARTIFACT
  if (artifact) assert.equal(hash(artifact), process.env.SMOKE_PACKAGE_SHA256)
  else
    artifact = join(
      workspace,
      JSON.parse(
        run('npm', [
          'pack',
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          workspace,
        ]),
      )[0].filename,
    )
  const app = join(workspace, 'consumer')
  cpSync(join(repo, 'examples/node-frameworks'), app, { recursive: true })
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', artifact], app)
  run(
    node,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      'types.mts',
    ],
    app,
  )
  for (const profile of ['express', 'fastify', 'nest-express', 'nest-fastify']) {
    for (const mode of ['enabled', 'disabled', 'uninstalled', 'outage']) {
      const { child, origin } = await start(
        app,
        profile,
        mode !== 'disabled',
        mode === 'uninstalled',
        mode === 'outage',
      )
      try {
        const initial = JSON.parse((await request(origin, '/proof-status')).text)
        assert.equal(initial.spans.length, 0)
        assert.equal(initial.observations.length, 0)
        const responses = await Promise.all(
          ['one', 'two', 'error'].map((id) =>
            request(origin, '/work/' + id + '?secret=private-query', 'POST'),
          ),
        )
        assert.deepEqual(
          responses.map((response) => response.status),
          [
            profile.startsWith('nest') ? 201 : 200,
            profile.startsWith('nest') ? 201 : 200,
            503,
          ],
        )
        assert.equal(JSON.parse(responses[0].text).body_unchanged, true)
        assert.deepEqual(JSON.parse(responses[2].text), { application: 'preserved' })
        assert.equal((await request(origin, '/stream')).text, 'first\nsecond\nthird\n')
        const forwarded = JSON.parse((await request(origin, '/fetch')).text)
        assert.equal(forwarded.body_unchanged, true)
        assert.equal(forwarded.custom, 'preserved')
        const final = JSON.parse((await request(origin, '/proof-status')).text)
        assert.equal(final.construction_only, mode !== 'outage')
        if (mode === 'enabled' || mode === 'outage') {
          assert.equal(
            final.observations.filter((item) => item.kind === 'error').length,
            1,
          )
          assert.equal(
            final.observations.filter((item) => item.kind === 'log').length,
            3,
          )
          assert.equal(final.spans.length, 7)
          for (const span of final.spans) {
            assert.match(span.start_time_unix_nano, /^[1-9][0-9]+$/)
            assert.match(span.end_time_unix_nano, /^[1-9][0-9]+$/)
            assert.ok(
              BigInt(span.end_time_unix_nano) >= BigInt(span.start_time_unix_nano),
            )
          }
          const call = final.spans.find((span) => span.kind === 2)
          const target = final.spans.find((span) => span.name === 'POST /echo')
          assert.equal(target.parent_span_id, call.span_id)
          assert.equal(forwarded.traceparent.split('-')[2], call.span_id)
          assert.equal(
            final.spans.filter(
              (span) =>
                span.trace_id ===
                final.observations.find((item) => item.kind === 'error').trace_id,
            ).length,
            1,
          )
        } else {
          assert.equal(final.spans.length, 0)
          assert.equal(
            final.observations.filter((item) => item.kind === 'error').length,
            0,
          )
          assert.equal(final.observations.length, mode === 'disabled' ? 0 : 3)
        }
        if (mode === 'outage') {
          assert.equal(
            final.enqueue_batches.reduce((sum, count) => sum + count, 0),
            4,
          )
          assert.equal(final.stats.enqueued, final.enqueue_batches.length)
          assert.equal(final.stats.sent, 0)
          assert.equal(final.stats.dropped, 0)
          assert.equal(final.stats.failed, final.stats.enqueued)
          assert.equal(
            final.stats.reasons.network + final.stats.timeout,
            final.stats.failed,
          )
          assert.deepEqual(final.span_transport, { attempted: 7, sent: 0, failed: 7 })
        }
        if (profile.startsWith('nest')) {
          assert.equal(final.subscriptions, 3)
          assert.equal(final.teardowns, 3)
        }
        assert.doesNotMatch(
          JSON.stringify(final),
          /private-(body|cookie|baggage|state|query)/,
        )
        results.push({
          profile,
          mode,
          version: final.version,
          runtime: final.node,
          errors: final.observations.filter((item) => item.kind === 'error').length,
          spans: final.spans.length,
          passed: true,
        })
      } finally {
        await stop(child)
      }
    }
  }
  const report = {
    artifact_sha256: hash(artifact),
    workspace,
    construction_and_refused_transport_only: true,
    delivery_verified: false,
    results,
  }
  writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  for (const child of children) await stop(child)
  if (process.env.SMOKE_KEEP !== '1')
    rmSync(workspace, { recursive: true, force: true })
}
