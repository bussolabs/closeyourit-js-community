// @vitest-environment node
// PACKAGING contract (CYJS-11): locks down the published manifest so a future
// edit cannot break consumption. Verifies the fields a consumer uses to
// resolve ESM/CJS/types/bundle and that `files` exposes no sources or tests. The
// REAL consumption (npm pack + install + import in the three formats) is in the CI
// smoke (`scripts/smoke-package.mjs`, `pnpm smoke`), too heavy for the suite.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  files: string[]
  main: string
  module: string
  types: string
  unpkg: string
  jsdelivr: string
  exports: Record<string, Record<string, Record<string, string>> | string>
  engines: { node: string }
  publishConfig: { access: string }
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

describe('npm package packaging contract (CYJS-11)', () => {
  it('publishes only /dist: no source or test ends up in the tarball', () => {
    // `files: ['/dist']` is the structural guarantee that src/ and test/ are not
    // packed; the smoke re-verifies it on the real tarball.
    expect(pkg.files).toEqual(['/dist'])
  })

  it('declares the CJS, ESM and types targets inside dist/', () => {
    expect(pkg.main).toBe('./dist/index.js') // CommonJS
    expect(pkg.module).toBe('./dist/index.mjs') // ESM for bundlers
    expect(pkg.types).toBe('./dist/index.d.ts') // types
  })

  it('gives each format its own types in the root export', () => {
    expect(pkg.exports['.']).toEqual({
      import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
      require: { types: './dist/index.d.ts', default: './dist/index.js' },
    })
  })

  // A single `.d.ts` for both conditions is read as CommonJS by an ESM consumer
  // under nodenext ("masquerading as CJS", CYJS-84): every typed subpath must
  // point `import` at `.d.mts` and `require` at `.d.ts`.
  it('pairs every typed subpath with the declarations of its own format', () => {
    let typed = 0
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue
      typed++
      expect(Object.keys(target), subpath).toEqual(['import', 'require'])
      const base = target.import.default.replace(/\.mjs$/, '')
      // `types` must precede `default`: TypeScript resolves the first condition
      // that matches, so it must go first or the types are not found.
      expect(target.import, subpath).toEqual({
        types: `${base}.d.mts`,
        default: `${base}.mjs`,
      })
      expect(Object.keys(target.import)[0], subpath).toBe('types')
      expect(target.require, subpath).toEqual({
        types: `${base}.d.ts`,
        default: `${base}.js`,
      })
      expect(Object.keys(target.require)[0], subpath).toBe('types')
    }
    // Every module but the two <script> bundles ships types.
    expect(typed).toBe(Object.keys(pkg.exports).length - 2)
  })

  it('exposes the IIFE browser bundle as the ./min subpath and for the CDNs', () => {
    expect(pkg.exports['./min']).toBe('./dist/closeyourit.min.js')
    expect(pkg.unpkg).toBe('./dist/closeyourit.min.js')
    expect(pkg.jsdelivr).toBe('./dist/closeyourit.min.js')
  })

  it('exposes the help desk button as its own subpath, apart from the main bundle', () => {
    expect(pkg.exports['./helpdesk']).toEqual({
      import: { types: './dist/helpdesk.d.mts', default: './dist/helpdesk.mjs' },
      require: { types: './dist/helpdesk.d.ts', default: './dist/helpdesk.js' },
    })
    expect(pkg.exports['./helpdesk/min']).toBe('./dist/helpdesk.min.js')
  })

  it('requires the minimum supported Node (>=20.16) and publishes as public', () => {
    // The CI smoke matrix must cover this minimum: if it changes here
    // `.github/workflows/ci.yml` (smoke job) must be updated too.
    expect(pkg.engines.node).toBe('>=20.16')
    expect(pkg.publishConfig.access).toBe('public')
  })
})
