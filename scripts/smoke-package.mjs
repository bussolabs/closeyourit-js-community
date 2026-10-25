#!/usr/bin/env node
// Smoke test of the PUBLISHED PACKAGE, not of the source (CYJS-11). The vitest
// suite exercises `src/**`; here we verify that the npm ARCHIVE — just as a
// consumer receives it — is installable and usable in the promised formats
// (ESM, CommonJS, IIFE browser bundle) and that the types resolve, with no
// missing files nor implicit dependencies. Failing here BLOCKS the release: in CI the
// `publish` job depends on this gate.
//
// Two distinct environments:
//  - The author's TOOLCHAIN (Node/pnpm pinned in mise.toml): build → npm pack →
//    check of the tarball contents → install in a clean project →
//    type-check with the repo's tsc. Static, independent of the target runtime.
//  - CONSUMER: the CJS require, the ESM import and the IIFE bundle load run
//    with the consumer's Node — by default this same process, or the
//    binary given by `SMOKE_CONSUMER_NODE` (in CI: the minimum/current Node
//    of the matrix). This way the supported runtime (`engines: >=20.16`) is verified
//    on the right Node WITHOUT running pnpm — which requires Node ≥22.13 — on
//    older versions.
// Every failing step exits with code ≠ 0.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const pkgName = rootPkg.name
// Node a consumer uses the package with: in CI the binary of the matrix Node
// (minimum/current); locally the same process that runs the smoke.
const consumerNode = process.env.SMOKE_CONSUMER_NODE || process.execPath

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  })
}

const passed = []
function check(name, fn) {
  process.stdout.write(`• ${name} … `)
  fn()
  process.stdout.write('ok\n')
  passed.push(name)
}

// Temporary container for tarball + consumer project (outside the repo).
const work = mkdtempSync(join(tmpdir(), 'cyi-smoke-'))
try {
  const consumerVersion = run(consumerNode, ['--version']).trim()
  console.log(`Consumer Node: ${consumerVersion} (${consumerNode})\n`)

  // 1) Fresh build (equivalent to the `prepack` script npm runs when publishing).
  check('build', () => run(process.execPath, ['scripts/build.mjs']))

  // 2) npm pack → real tarball in the tempdir (no noise in the repo).
  let meta
  check('npm pack', () => {
    const out = run('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      work,
    ])
    meta = JSON.parse(out)[0]
  })
  const tarball = join(work, meta.filename)
  const packed = meta.files.map((f) => f.path)

  // 3) The tarball contains the promised dist files and does NOT expose src/ or test/.
  check('tarball contents (dist present, no src/test)', () => {
    const required = [
      'package.json',
      'dist/index.mjs',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/closeyourit.min.js',
      'dist/helpdesk.mjs',
      'dist/helpdesk.js',
      'dist/helpdesk.d.ts',
      'dist/helpdesk.min.js',
      'dist/react.mjs',
      'dist/react.js',
      'dist/react.d.ts',
      'dist/next/server.mjs',
      'dist/next/server.js',
      'dist/next/server.d.ts',
    ]
    const missing = required.filter((f) => !packed.includes(f))
    if (missing.length)
      throw new Error(`missing from the tarball: ${missing.join(', ')}`)
    const leaked = packed.filter((f) => f.startsWith('src/') || f.startsWith('test/'))
    if (leaked.length)
      throw new Error(`sources/tests in the tarball: ${leaked.join(', ')}`)
  })

  // 4) Clean consumer project: no dependency beyond the tarball, so an
  //    implicit (undeclared) dependency would surface as a missing module.
  const consumer = join(work, 'consumer')
  check('install in a clean project', () => {
    mkdirSync(consumer)
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify(
        { name: 'cyi-consumer', private: true, version: '0.0.0' },
        null,
        2,
      ),
    )
    run('npm', ['install', tarball, '--no-audit', '--no-fund'], {
      cwd: consumer,
    })
  })
  const installed = join(consumer, 'node_modules', ...pkgName.split('/'))

  // 5) All the targets declared by the installed manifest exist on disk:
  //    no main/module/types/exports/CDN field points to a missing file.
  check('targets declared by the manifest all present', () => {
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    const targets = new Set()
    for (const key of ['main', 'module', 'types', 'unpkg', 'jsdelivr']) {
      if (pkg[key]) targets.add(pkg[key])
    }
    const collect = (node) => {
      if (typeof node === 'string') targets.add(node)
      else if (node && typeof node === 'object') Object.values(node).forEach(collect)
    }
    collect(pkg.exports)
    const absent = [...targets].filter((t) => !existsSync(join(installed, t)))
    if (absent.length)
      throw new Error(`target declared but absent: ${absent.join(', ')}`)
  })

  // 6) CommonJS: `require` resolves the `require` condition (dist/index.js), run
  //    with the consumer's Node (minimum/current runtime).
  check('require CommonJS', () => {
    const file = join(consumer, 'consume.cjs')
    writeFileSync(
      file,
      [
        `const assert = require('node:assert')`,
        `const cyi = require('${pkgName}')`,
        `assert(typeof require('${pkgName}/database').DatabaseMonitoring === 'function')`,
        `assert(typeof require('${pkgName}/vue').instrumentVue === 'function')`,
        `assert(typeof require('${pkgName}/nuxt/client').instrumentNuxtClient === 'function')`,
        `assert(typeof require('${pkgName}/nuxt/server').createNitroInstrumentation === 'function')`,
        `for (const fn of ['init', 'captureException', 'captureMessage', 'flush', 'close']) {`,
        `  assert(typeof cyi[fn] === 'function', 'CJS: missing export ' + fn)`,
        `}`,
        `assert(cyi.SDK_NAME === 'closeyourit-js', 'CJS: wrong SDK_NAME')`,
        `assert(typeof cyi.SDK_VERSION === 'string', 'CJS: SDK_VERSION missing')`,
        `console.log('  cjs: SDK_VERSION=' + cyi.SDK_VERSION)`,
        ``,
      ].join('\n'),
    )
    run(consumerNode, [file], { cwd: consumer })
  })

  // 7) ESM: `import` resolves the `import` condition (dist/index.mjs), both with
  //    named exports and via namespace; on the consumer's Node.
  check('import ESM', () => {
    const file = join(consumer, 'consume.mjs')
    writeFileSync(
      file,
      [
        `import assert from 'node:assert'`,
        `import { init, captureException, SDK_NAME } from '${pkgName}'`,
        `import * as ns from '${pkgName}'`,
        `import { DatabaseMonitoring } from '${pkgName}/database'`,
        `assert(typeof DatabaseMonitoring === 'function')`,
        `import { instrumentVue } from '${pkgName}/vue'`,
        `import { instrumentNuxtClient } from '${pkgName}/nuxt/client'`,
        `import { createNitroInstrumentation } from '${pkgName}/nuxt/server'`,
        `assert([instrumentVue, instrumentNuxtClient, createNitroInstrumentation].every(value => typeof value === 'function'))`,
        `assert(typeof init === 'function', 'ESM: init is not a function')`,
        `assert(typeof captureException === 'function', 'ESM: captureException is not a function')`,
        `assert(SDK_NAME === 'closeyourit-js', 'ESM: wrong SDK_NAME')`,
        `assert(typeof ns.flush === 'function', 'ESM: flush missing from the namespace')`,
        `console.log('  esm: ok')`,
        ``,
      ].join('\n'),
    )
    run(consumerNode, [file], { cwd: consumer })
  })

  // 8) IIFE browser bundle: evaluated with `vm` in a context without Node builtins
  //    (no `process`), it exposes the `CloseYourIt` global with the public API.
  //    Run on the consumer's Node, so the bundle is proven on the target
  //    runtime and not only on the toolchain one.
  check('IIFE browser bundle (CloseYourIt global)', () => {
    const runner = join(consumer, 'browser-smoke.mjs')
    writeFileSync(
      runner,
      [
        `import { readFileSync } from 'node:fs'`,
        `import { createContext, runInContext } from 'node:vm'`,
        `const iife = readFileSync(process.argv[2], 'utf8')`,
        `// Minimal self-referencing DOM: if the bundle reads window/self/globalThis`,
        `// it always finds the context global; no 'process', so the Node branch`,
        `// stays off as in a real browser.`,
        `const sandbox = { console, navigator: { userAgent: 'cyi-smoke-browser' } }`,
        `sandbox.window = sandbox`,
        `sandbox.self = sandbox`,
        `sandbox.document = { addEventListener() {}, removeEventListener() {} }`,
        `createContext(sandbox)`,
        `runInContext(iife, sandbox, { filename: 'closeyourit.min.js' })`,
        `const api = sandbox.CloseYourIt`,
        `if (!api) throw new Error('CloseYourIt global not defined after loading the bundle')`,
        `for (const fn of ['init', 'captureException', 'captureMessage', 'flush', 'close']) {`,
        `  if (typeof api[fn] !== 'function') throw new Error('IIFE: missing method ' + fn)`,
        `}`,
        `console.log('  browser: ok')`,
        ``,
      ].join('\n'),
    )
    run(consumerNode, [runner, join(installed, 'dist', 'closeyourit.min.js')], {
      cwd: consumer,
    })
  })

  // 9) Types: a `.mts` consumer resolves module and types with the strictest
  //    resolution (nodenext), using the tsc already installed in the repo (no network).
  //    Static check → on the toolchain, not on the consumer's Node.
  check('type resolution (tsc --moduleResolution nodenext)', () => {
    writeFileSync(
      join(consumer, 'smoke.mts'),
      [
        `import { init } from '${pkgName}'`,
        `import type { CloseYourItOptions } from '${pkgName}'`,
        `import { DatabaseMonitoring } from '${pkgName}/database'`,
        `const profile: <T>(work: () => T) => T = DatabaseMonitoring.prototype.profile`,
        `void profile`,
        `const use: (o: CloseYourItOptions) => unknown = init`,
        `void use`,
        ``,
      ].join('\n'),
    )
    const tscBin = join(
      dirname(require.resolve('typescript/package.json')),
      'bin',
      'tsc',
    )
    run(
      process.execPath,
      [
        tscBin,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        'smoke.mts',
      ],
      { cwd: consumer },
    )
  })

  console.log(
    `\n✓ smoke package OK — ${passed.length} checks passed on ${pkgName}@${rootPkg.version} (consumer ${consumerVersion})`,
  )
} catch (err) {
  console.error(`\n✗ smoke package FAILED: ${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
