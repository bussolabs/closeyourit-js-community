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
  exports: Record<string, Record<string, string> | string>
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

  it('exposes consistent and ordered import/require/types condition exports', () => {
    const root = pkg.exports['.'] as Record<string, string>
    expect(root.types).toBe('./dist/index.d.ts')
    expect(root.import).toBe('./dist/index.mjs')
    expect(root.require).toBe('./dist/index.js')
    // `types` must precede import/require: TypeScript resolves the first condition
    // that matches, so it must go first or the types are not found.
    expect(Object.keys(root)[0]).toBe('types')
  })

  it('exposes the IIFE browser bundle as the ./min subpath and for the CDNs', () => {
    expect(pkg.exports['./min']).toBe('./dist/closeyourit.min.js')
    expect(pkg.unpkg).toBe('./dist/closeyourit.min.js')
    expect(pkg.jsdelivr).toBe('./dist/closeyourit.min.js')
  })

  it('exposes the help desk button as its own subpath, apart from the main bundle', () => {
    const helpdesk = pkg.exports['./helpdesk'] as Record<string, string>
    expect(helpdesk.types).toBe('./dist/helpdesk.d.ts')
    expect(helpdesk.import).toBe('./dist/helpdesk.mjs')
    expect(helpdesk.require).toBe('./dist/helpdesk.js')
    expect(Object.keys(helpdesk)[0]).toBe('types')
    expect(pkg.exports['./helpdesk/min']).toBe('./dist/helpdesk.min.js')
  })

  it('requires the minimum supported Node (>=20.16) and publishes as public', () => {
    // The CI smoke matrix must cover this minimum: if it changes here
    // `.github/workflows/ci.yml` (smoke job) must be updated too.
    expect(pkg.engines.node).toBe('>=20.16')
    expect(pkg.publishConfig.access).toBe('public')
  })
})
