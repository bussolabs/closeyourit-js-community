#!/usr/bin/env node
// Build real Angular CLI applications from a packaged SDK; no backend delivery claim.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const workspace = mkdtempSync(join(tmpdir(), 'cyi-angular-build-'))
const environment = Object.fromEntries(
  ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
Object.assign(environment, { CI: '1', NG_CLI_ANALYTICS: 'false' })
const records = []
function run(argv, cwd) {
  return execFileSync(argv[0], argv.slice(1), {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 4_194_304,
  })
}
const artifact = process.env.SMOKE_PACKAGE_ARTIFACT
  ? resolve(process.env.SMOKE_PACKAGE_ARTIFACT)
  : join(
      workspace,
      JSON.parse(
        run(
          [
            'npm',
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            workspace,
          ],
          repo,
        ),
      )[0].filename,
    )
const artifactDigest = process.env.SMOKE_PACKAGE_SHA256 || digest(artifact)
assert.match(artifactDigest, /^[a-f0-9]{64}$/)
if (process.env.SMOKE_PACKAGE_ARTIFACT)
  assert.ok(
    process.env.SMOKE_PACKAGE_SHA256,
    'An explicit artifact requires its expected digest',
  )
assert.equal(digest(artifact), artifactDigest)
try {
  for (const major of ['21', '22']) {
    const app = join(workspace, major)
    cpSync(join(repo, 'examples/angular'), app, { recursive: true })
    if (major === '21') {
      for (const file of ['package.json', 'package-lock.json'])
        cpSync(join(repo, 'examples/angular21', file), join(app, file))
      cpSync(join(repo, 'examples/angular21/mode.ts'), join(app, 'src/mode.ts'))
    }
    run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], app)
    run(
      [
        'npm',
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
    const build = run(
      [process.execPath, 'node_modules/@angular/cli/bin/ng.js', 'build', 'proof'],
      app,
    )
    const packageJson = JSON.parse(
      readFileSync(join(app, 'node_modules/@angular/core/package.json')),
    )
    const cli = JSON.parse(
      readFileSync(join(app, 'node_modules/@angular/cli/package.json')),
    )
    records.push({
      angular: packageJson.version,
      cli: cli.version,
      node: process.version,
      mode: major === '21' ? 'zone' : 'zoneless',
      app,
      build: true,
      artifact_sha256: digest(artifact),
      lock_sha256: digest(join(app, 'package-lock.json')),
      source_sha256: digest(join(app, 'src/main.ts')),
      output: build.slice(-4096),
    })
  }
  assert.equal(digest(artifact), artifactDigest)
  const report = {
    claim: 'implemented',
    runtime_observed: false,
    backend_delivery: false,
    workspace,
    records,
  }
  writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  writeFileSync(
    join(workspace, 'report.json'),
    JSON.stringify(
      {
        failed: true,
        workspace,
        records,
        diagnostic: error instanceof Error ? error.name : 'UnknownError',
      },
      null,
      2,
    ) + '\n',
  )
  throw error
}
