#!/usr/bin/env node
// Real package/framework construction and disabled-host behavior. This is not backend delivery evidence.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = mkdtempSync(join(tmpdir(), 'cyi-frameworks-'))
const environment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
Object.assign(environment, { NEXT_TELEMETRY_DISABLED: '1', CI: '1' })
const node = process.env.SMOKE_CONSUMER_NODE || process.execPath
const results = []
const children = new Set()

function run(command, args, cwd = repo, timeout = 180_000) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    timeout,
    encoding: 'utf8',
    maxBuffer: 2_097_152,
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
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.text()
  assert.equal(response.status, status, path)
  return body
}

async function start(app, extra = {}) {
  const listen = await port()
  const child = spawn(
    node,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '-H',
      '127.0.0.1',
      '-p',
      String(listen),
    ],
    {
      cwd: app,
      env: { ...environment, ...extra },
      stdio: 'ignore',
    },
  )
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
  const react18 = join(workspace, 'react18')
  cpSync(join(repo, 'examples/react18'), react18, { recursive: true })
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], react18)
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
    react18,
  )
  const reactProof = JSON.parse(run(node, ['proof.cjs'], react18))
  writeFileSync(
    join(react18, 'types.mts'),
    `
import { createElement } from 'react';
import { Client, getClient } from '@bussolabs/closeyourit-js';
import { ErrorBoundary, createReactErrorHandlers } from '@bussolabs/closeyourit-js/react';
import { createNextInstrumentation } from '@bussolabs/closeyourit-js/next/server';
const client = getClient() ?? new Client({ enabled: false, endpointUrl: '', projectId: '' });
createElement(ErrorBoundary, { client, fallback: null });
createReactErrorHandlers(client);
createNextInstrumentation(client).withRequest({ method: 'GET', headers: {} }, { routerKind: 'App Router', routePath: '/test', routeType: 'route' }, () => 42);
`,
  )
  run(
    process.execPath,
    [
      join(repo, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'types.mts',
    ],
    react18,
  )
  results.push({
    ...reactProof,
    node: run(node, ['--version']).trim(),
    lock_sha256: hash(join(react18, 'package-lock.json')),
  })
  for (const next of ['15.5.27', '16.3.8']) {
    const app = join(workspace, next)
    cpSync(join(repo, 'examples/next'), app, { recursive: true })
    if (next.startsWith('15.')) {
      for (const filename of ['package.json', 'package-lock.json'])
        cpSync(join(repo, 'examples/next15', filename), join(app, filename))
    }
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
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
    run('npm', ['run', 'build'], app)
    const { child, endpoint } = await start(app)
    try {
      const checks = [
        ['/api/work/one', 200],
        ['/api/stream', 200],
        ['/api/route-error', 500],
        ['/ssr-error', 500],
        ['/legacy', 200],
        ['/legacy-error', 500],
        ['/missing', 404],
        ['/redirect', 307],
      ]
      for (const [path, status] of checks) {
        const body = await request(endpoint, path, status)
        if (path === '/api/stream') assert.equal(body, 'first:second')
      }
      const browserFiles = readdirSync(join(app, '.next/static'), {
        recursive: true,
      }).filter((file) => file.endsWith('.js'))
      for (const file of browserFiles)
        assert(
          !readFileSync(join(app, '.next/static', file), 'utf8').includes(
            'CYI_PROOF_TOKEN',
          ),
          'Server credential configuration entered a browser chunk',
        )
      results.push({
        next,
        react: manifest.dependencies.react,
        node: run(node, ['--version']).trim(),
        checks: checks.length,
        lock_sha256: hash(join(app, 'package-lock.json')),
        sdk_enabled: false,
      })
    } finally {
      await stop(child)
    }
    const constructed = await start(app, {
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_CONSTRUCTION_ONLY: '1',
      CYI_PROOF_TOKEN: `cyi_${randomBytes(20).toString('hex')}`,
      CYI_PROOF_PROJECT: 'local-construction',
      CYI_PROOF_RELEASE: `next-${next}`,
    })
    try {
      const initial = JSON.parse(
        await request(constructed.endpoint, '/api/proof-status', 200),
      )
      assert.equal(
        initial.observations.length,
        0,
        'No event is constructed before a failing request',
      )
      await Promise.all(
        ['one', 'two', 'three'].map((scenario) =>
          request(constructed.endpoint, `/api/route-error?case=${scenario}`, 500),
        ),
      )
      const observation = JSON.parse(
        await request(constructed.endpoint, '/api/proof-status', 200),
      )
      const errors = observation.observations.filter((item) => item.kind === 'error')
      const durations = observation.observations.filter(
        (item) => item.kind === 'slow_method',
      )
      assert.equal(errors.length, 3)
      assert.equal(durations.length, 3)
      assert.equal(new Set(errors.map((item) => item.trace_id)).size, 3)
      assert.deepEqual(
        errors.map((item) => item.trace_id).sort(),
        durations.map((item) => item.trace_id).sort(),
        'Real Next hook and handler share each request trace without an incoming carrier',
      )
      for (const item of [...errors, ...durations])
        assert.equal(item.release, `next-${next}`)
      results.at(-1).constructed_error_duration_pairs = 3
      results.at(-1).construction_only = true
    } finally {
      await stop(constructed.child)
    }
    // A refused owned loopback endpoint is a real transport failure, not a fake server.
    const unavailablePort = await port()
    const offline = await start(app, {
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_ENDPOINT: `http://127.0.0.1:${unavailablePort}`,
      CYI_PROOF_TOKEN: `cyi_${randomBytes(20).toString('hex')}`,
      CYI_PROOF_PROJECT: 'local-offline',
    })
    try {
      await request(offline.endpoint, '/api/work/one', 200)
      await request(offline.endpoint, '/api/route-error', 500)
      assert.equal(await request(offline.endpoint, '/api/stream', 200), 'first:second')
      const observation = JSON.parse(
        await request(offline.endpoint, '/api/proof-status', 200),
      )
      assert(observation.stats.failed > 0)
      assert(observation.stats.reasons.network > 0)
      results.at(-1).offline_host_preserved = true
    } finally {
      await stop(offline.child)
    }
    const removed = await start(app, {
      CYI_PROOF_ENABLED: '1',
      CYI_PROOF_UNINSTALL: '1',
      CYI_PROOF_CONSTRUCTION_ONLY: '1',
      CYI_PROOF_TOKEN: `cyi_${randomBytes(20).toString('hex')}`,
      CYI_PROOF_PROJECT: 'local-uninstall',
    })
    try {
      await request(removed.endpoint, '/api/route-error', 500)
      assert.equal(await request(removed.endpoint, '/api/stream', 200), 'first:second')
      const observation = JSON.parse(
        await request(removed.endpoint, '/api/proof-status', 200),
      )
      assert.equal(observation.enabled, true)
      assert.equal(observation.observations.length, 0)
      results.at(-1).uninstall_host_preserved = true
    } finally {
      await stop(removed.child)
    }
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      artifact_sha256: hash(artifact),
      profiles: results,
      delivery_verified: false,
    }),
  )
} finally {
  for (const child of children) await stop(child)
  rmSync(workspace, { recursive: true, force: true })
}
