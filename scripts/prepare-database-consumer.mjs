import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = process.argv[2]
assert.ok(
  directory && isAbsolute(directory) && !existsSync(directory),
  'Consumer directory must be new and absolute',
)
const environment = Object.fromEntries(
  ['HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'MISE_DATA_DIR', 'MISE_CONFIG_DIR']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
)
environment.PATH = `${dirname(process.execPath)}:${environment.PATH}`
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 240000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function sourceHashes() {
  const paths = ['package.json', 'pnpm-lock.yaml', 'tsup.config.ts']
  function visit(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  visit('src')
  return Object.fromEntries(paths.sort().map((path) => [path, hash(join(root, path))]))
}
const sources = sourceHashes()
run('pnpm', ['build'])
assert.deepEqual(sourceHashes(), sources, 'Sources changed during the package build')
mkdirSync(directory)
for (const name of ['package.json', 'package-lock.json', 'schema.prisma', 'run.mjs'])
  cpSync(join(root, 'examples/node-database', name), join(directory, name))
const archive = JSON.parse(
  run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]),
)[0].filename
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory)
run(
  'npm',
  [
    'install',
    '--ignore-scripts',
    '--no-save',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
    join(directory, archive),
  ],
  directory,
)
run(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'generate', '--schema', 'schema.prisma'],
  directory,
)
const packages = Object.fromEntries(
  Object.keys(
    JSON.parse(readFileSync(join(directory, 'package.json'))).dependencies,
  ).map((name) => [
    name,
    JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json')))
      .version,
  ]),
)
assert.deepEqual(sourceHashes(), sources, 'Sources changed during consumer preparation')
writeFileSync(
  join(directory, 'candidate.json'),
  JSON.stringify(
    {
      artifact: { file: archive, sha256: hash(join(directory, archive)) },
      runtime: process.version,
      packages,
      sources,
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ consumer: directory, runtime: process.version, packages }))
