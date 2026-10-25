// @vitest-environment node
// CYJS-30 — the gate before publishing.
//
// We exercise the check by running it, not by reading it: what matters is the
// exit code GitHub Actions sees, and it is the only thing that really stops
// `npm publish`. A test comparing the source text would say green
// even with the script broken.
//
// The mismatch cases run on a copy in a temporary folder, with
// a purpose-built package.json and src/version.ts next to it: the script
// anchors to its own location, so the copy reads the fake files and this
// repository is not touched.

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../scripts/check-release.mjs')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

type Outcome = { ok: boolean; output: string }

function runScript(script: string, tag: string): Outcome {
  try {
    const stdout = execFileSync(process.execPath, [script, '--tag', tag], {
      encoding: 'utf8',
      // The environment's GITHUB_REF_NAME must not be able to affect the outcome: here the
      // tag always comes from --tag.
      env: { ...process.env, GITHUB_REF_NAME: '' },
    })
    return { ok: true, output: stdout }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** A copy of the script with the two numbers we want next to it. */
function copyWith(packageVersion: string, declaredVersion: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cyjs30-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'scripts'))
  mkdirSync(path.join(root, 'src'))
  cpSync(SCRIPT, path.join(root, 'scripts/check-release.mjs'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fake', version: packageVersion }),
  )
  writeFileSync(
    path.join(root, 'src/version.ts'),
    `export const SDK_VERSION = '${declaredVersion}'\n`,
  )
  return path.join(root, 'scripts/check-release.mjs')
}

describe('check-release: the tag must be final', () => {
  // The real hole: the job condition accepted any `v*`, so a test
  // tag published and npm marked it as the latest good version. Whoever
  // installs without asking for a precise number ended up with stuff not
  // yet verified.
  for (const tag of [
    'v1.2.0-beta.1',
    'v1.2.0-rc.1',
    'v1.2.0-alpha',
    'v1.2.0+build.5',
  ]) {
    it(`rejects ${tag}`, () => {
      const outcome = runScript(SCRIPT, tag)
      expect(outcome.ok).toBe(false)
      expect(outcome.output).toContain('is not a final tag')
    })
  }

  for (const tag of ['1.2.0', 'v1.2', 'latest', 'v1.2.0.1']) {
    it(`rejects the invalid form ${tag}`, () => {
      expect(runScript(SCRIPT, tag).ok).toBe(false)
    })
  }

  it('rejects when there is no tag to verify', () => {
    const outcome = runScript(SCRIPT, '')
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('no tag to verify')
  })
})

describe('check-release: the three numbers must be the same number', () => {
  it('passes when package.json and SDK_VERSION match the tag', () => {
    const outcome = runScript(copyWith('3.4.5', '3.4.5'), 'v3.4.5')
    expect(outcome.ok).toBe(true)
    expect(outcome.output).toContain('aligned')
  })

  it('stops if package.json lagged behind', () => {
    const outcome = runScript(copyWith('3.4.4', '3.4.5'), 'v3.4.5')
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('package.json says 3.4.4')
  })

  it('stops if SDK_VERSION lagged behind', () => {
    // It is the number the library declares itself to be when it sends an error: if
    // it lags behind, in the panel the sites' errors appear to come from a
    // version that is not the real one.
    const outcome = runScript(copyWith('3.4.5', '3.4.4'), 'v3.4.5')
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('src/version.ts says 3.4.4')
  })

  it('lists all the wrong numbers in one go', () => {
    // Whoever releases fixes one thing, restarts, and discovers the other on the next round: every
    // round is a whole pipeline.
    const outcome = runScript(copyWith('3.4.4', '3.4.3'), 'v3.4.5')
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('package.json says 3.4.4')
    expect(outcome.output).toContain('src/version.ts says 3.4.3')
  })
})

describe('the three numbers of this repository', () => {
  // Without this, the mismatch is discovered only on release day, with the
  // pipeline already running. Here it is discovered on the first commit that touches only one of them.
  it('package.json and src/version.ts declare the same version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
    const declaredVersion = source.match(
      /export const SDK_VERSION = ['"]([^'"]+)['"]/,
    )?.[1]
    expect(declaredVersion).toBe(pkg.version)
  })
})
