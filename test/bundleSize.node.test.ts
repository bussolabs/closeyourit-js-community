// @vitest-environment node
// Gate on the browser bundle size (CYJS-28). The snippet's weight is
// production code as much as the rest: it grows for every visitor of every
// site that installed the SDK, including those who do not use the function just
// added. Here we guard the gate itself — that the cap exists,
// that it points at the published artifact and that an overrun is loud.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUDGET_FILE,
  checkBundleSizes,
  measureBundle,
  overBudget,
} from '../scripts/bundle-size.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const budget = JSON.parse(readFileSync(join(repoRoot, BUDGET_FILE), 'utf8')) as {
  files: Record<string, { raw: number; brotli: number }>
}
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  jsdelivr: string
  unpkg: string
  scripts: Record<string, string>
}

// The file the snippet really loads, in the form the budget names it
// (without package.json's `./`).
const distributed = pkg.jsdelivr.replace(/^\.\//, '')

let scratch: string | undefined

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('committed budget', () => {
  it('caps exactly the bundle jsDelivr serves to visitors', () => {
    // A budget watching a file other than the published one would give a
    // green that protects nobody.
    expect(pkg.jsdelivr).toBe(pkg.unpkg)
    expect(Object.keys(budget.files)).toContain(distributed)
  })

  it('declares a cap on both the raw file and the brotli', () => {
    // Brotli is what travels over the network, raw is what the browser
    // then has to parse and execute: both count.
    for (const limits of Object.values(budget.files)) {
      expect(limits.raw).toBeGreaterThan(0)
      expect(limits.brotli).toBeGreaterThan(0)
      expect(limits.brotli).toBeLessThan(limits.raw)
    }
  })

  it('is verified by a command the CI can run', () => {
    expect(pkg.scripts['size']).toContain('scripts/bundle-size.mjs')
  })
})

describe('measureBundle', () => {
  it('measures the raw file and its compressed version', () => {
    const measured = measureBundle(Buffer.from('a'.repeat(4096)))

    expect(measured.raw).toBe(4096)
    expect(measured.brotli).toBeGreaterThan(0)
    expect(measured.brotli).toBeLessThan(measured.raw)
  })
})

describe('overBudget', () => {
  it('stays silent when the measurement is within the cap', () => {
    expect(
      overBudget('dist/app.js', { raw: 100, brotli: 40 }, { raw: 100, brotli: 50 }),
    ).toEqual([])
  })

  it('says which measurement overran and by how much', () => {
    const failures = overBudget(
      'dist/app.js',
      { raw: 1200, brotli: 500 },
      { raw: 1000, brotli: 600 },
    )

    expect(failures).toEqual([
      { file: 'dist/app.js', kind: 'raw', actual: 1200, limit: 1000, excess: 200 },
    ])
  })
})

describe('checkBundleSizes', () => {
  it('stops if the artifact was not built', () => {
    // A gate that passes when the file is missing is worse than no gate: it declares
    // safe a bundle nobody measured.
    scratch = mkdtempSync(join(tmpdir(), 'cyjs-budget-'))
    writeFileSync(
      join(scratch, BUDGET_FILE),
      JSON.stringify({ files: { 'dist/mancante.js': { raw: 10, brotli: 5 } } }),
    )

    expect(() => checkBundleSizes(scratch)).toThrow(/pnpm build/)
  })

  it.skipIf(!existsSync(join(repoRoot, distributed)))(
    'the freshly built bundle stays within the declared cap',
    () => {
      const { failures } = checkBundleSizes(repoRoot)

      expect(failures).toEqual([])
    },
  )
})
