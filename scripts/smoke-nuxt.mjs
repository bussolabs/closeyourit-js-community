#!/usr/bin/env node
// Packed real Nuxt applications; beforeSend construction is distinct from backend delivery.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = mkdtempSync(join(tmpdir(), 'cyi-nuxt-'))
const environment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
Object.assign(environment, { NUXT_TELEMETRY_DISABLED: '1', CI: '1' })
const node = process.env.SMOKE_CONSUMER_NODE || process.execPath
const children = new Set()
const results = []
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
  if (!children.has(child)) return
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
async function request(endpoint, path, status) {
  const response = await fetch(endpoint + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  assert.equal(response.status, status, path)
  return text
}
async function start(app, extra) {
  const listen = await port()
  const child = spawn(node, ['.output/server/index.mjs'], {
    cwd: app,
    env: { ...environment, HOST: '127.0.0.1', PORT: String(listen), ...extra },
    stdio: 'ignore',
  })
  children.add(child)
  let failed
  child.on('error', (error) => {
    failed = error
  })
  const endpoint = `http://127.0.0.1:${listen}`
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if (failed) throw failed
      await request(endpoint, '/', 200)
      return { child, endpoint }
    } catch (error) {
      if (failed || Date.now() >= deadline || child.exitCode !== null) {
        await stop(child)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

try {
  let artifact = process.env.SMOKE_PACKAGE_ARTIFACT
  if (artifact) {
    assert.match(process.env.SMOKE_PACKAGE_SHA256 ?? '', /^[a-f0-9]{64}$/)
    assert.equal(hash(artifact), process.env.SMOKE_PACKAGE_SHA256)
  } else {
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
  for (const version of ['3.21.11', '4.5.2']) {
    const app = join(workspace, version)
    cpSync(join(repo, 'examples/nuxt'), app, { recursive: true })
    if (version.startsWith('3.'))
      for (const file of ['package.json', 'package-lock.json', 'vendor'])
        cpSync(join(repo, 'examples/nuxt3', file), join(app, file), { recursive: true })
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
    run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], app)
    writeFileSync(
      join(app, 'types.mts'),
      `
import type { NuxtApp } from 'nuxt/app';
import { useRouter } from 'nuxt/app';
import type { NitroApp } from 'nitropack';
import type { H3Event } from 'h3';
import { createApp } from 'vue';
import { Client } from '@bussolabs/closeyourit-js';
import { instrumentVue } from '@bussolabs/closeyourit-js/vue';
import { instrumentNuxtClient } from '@bussolabs/closeyourit-js/nuxt/client';
import { createNitroInstrumentation } from '@bussolabs/closeyourit-js/nuxt/server';
declare const app: NuxtApp;
declare const nitro: NitroApp;
declare const event: H3Event;
const client = new Client({ enabled: false, endpointUrl: '', projectId: '' });
instrumentVue(createApp({}), client, { onUnhandledError: (error) => { throw error; } });
instrumentNuxtClient(app.hooks, client, useRouter());
const monitoring = createNitroInstrumentation(client);
monitoring.install(nitro.hooks);
monitoring.withRequest(event, '/typed', () => 42);
`,
    )
    run(
      process.execPath,
      [
        join(repo, 'node_modules/typescript/bin/tsc'),
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
    const base = {
      CYI_PROOF_PROJECT: 'local-construction',
      CYI_PROOF_TOKEN: 'cyi_' + 'a'.repeat(40),
      CYI_PROOF_RELEASE: `nuxt-${version}`,
      CYI_PROOF_CONSTRUCTION_ONLY: '1',
    }
    const disabled = await start(app, { ...base, CYI_PROOF_ENABLED: '0' })
    await request(disabled.endpoint, '/api/work/ok', 200)
    await request(disabled.endpoint, '/api/work/one', 500)
    await request(disabled.endpoint, '/ssr-error', 500)
    assert.equal(await request(disabled.endpoint, '/api/stream', 200), 'first\nlast\n')
    assert.deepEqual(
      JSON.parse(await request(disabled.endpoint, '/api/proof-status', 200))
        .observations,
      [],
    )
    await stop(disabled.child)

    const active = await start(app, { ...base, CYI_PROOF_ENABLED: '1' })
    await Promise.all(
      ['one', 'two', 'three'].map((id) =>
        request(active.endpoint, `/api/work/${id}?private=never-observe`, 500),
      ),
    )
    const status = JSON.parse(await request(active.endpoint, '/api/proof-status', 200))
    const errors = status.observations.filter((entry) => entry.kind === 'error')
    const metrics = status.observations.filter((entry) => entry.kind === 'slow_method')
    const logs = status.observations.filter((entry) => entry.kind === 'log')
    assert.equal(errors.length, 3, 'Exactly three request errors')
    assert.equal(metrics.length, 3, 'Exactly three handler durations')
    assert.equal(logs.length, 3, 'Exactly three request logs')
    assert.equal(new Set(errors.map((entry) => entry.trace_id)).size, 3)
    for (const error of errors) {
      assert.equal(
        metrics.filter((entry) => entry.trace_id === error.trace_id).length,
        1,
      )
      assert.equal(logs.filter((entry) => entry.trace_id === error.trace_id).length, 1)
      assert.equal(error.route, '/api/work/:id')
      assert.equal(error.release, base.CYI_PROOF_RELEASE)
    }
    await request(active.endpoint, '/ssr-error', 500)
    const rendered = JSON.parse(
      await request(active.endpoint, '/api/proof-status', 200),
    )
    assert.equal(
      rendered.observations.filter((entry) => entry.kind === 'error').length,
      4,
      'One SSR error',
    )
    assert.equal(await request(active.endpoint, '/api/stream', 200), 'first\nlast\n')
    await stop(active.child)

    const removed = await start(app, {
      ...base,
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_UNINSTALL: '1',
    })
    await request(removed.endpoint, '/api/work/one', 500)
    const removedStatus = JSON.parse(
      await request(removed.endpoint, '/api/proof-status', 200),
    )
    assert.equal(
      removedStatus.observations.filter(
        (entry) => entry.kind === 'error' || entry.kind === 'slow_method',
      ).length,
      0,
    )
    await stop(removed.child)

    const closedPort = await port()
    const outage = await start(app, {
      ...base,
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_CONSTRUCTION_ONLY: '0',
      CYI_PROOF_ENDPOINT: `http://127.0.0.1:${closedPort}`,
    })
    await request(outage.endpoint, '/api/work/ok', 200)
    const outageStatus = JSON.parse(
      await request(outage.endpoint, '/api/proof-status', 200),
    )
    assert.ok(outageStatus.stats.failed > 0, 'Real unavailable transport is visible')
    await stop(outage.child)
    results.push({
      nuxt: version,
      vue: JSON.parse(readFileSync(join(app, 'node_modules/vue/package.json'))).version,
      node: run(node, ['--version']).trim(),
      artifact_sha256: hash(artifact),
      lock_sha256: hash(join(app, 'package-lock.json')),
      concurrent_correlations: 3,
      ssr_errors: 1,
      disabled: true,
      uninstall: true,
      stream_bytes_preserved: true,
      unavailable_transport: true,
      backend_delivery: false,
    })
  }
  process.stdout.write(
    JSON.stringify({ profile: 'nuxt-construction', results }, null, 2) + '\n',
  )
} finally {
  await Promise.all([...children].map(stop))
  rmSync(workspace, { recursive: true, force: true })
}
