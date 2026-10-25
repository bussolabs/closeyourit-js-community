import { defineConfig } from 'tsup'

// Two distinct outputs:
//  1. library: ESM (.mjs) + CJS (.js) + types (.d.ts) from src/index.ts — for bundlers/npm.
//  2. minified IIFE: dist/closeyourit.min.js with the global `window.CloseYourIt` — for <script>.
// `type` is absent from package.json (commonjs) → tsup uses .mjs for ESM and .js for CJS.

// `web-vitals` travels INSIDE the bundle, in all three formats (CYJS-28).
// By default tsup keeps `dependencies` external, but that is not possible here:
// its per-metric entries (`web-vitals/onLCP.js`) are ESM-only, and on Node 20 —
// the minimum that `engines` declares — a `require` from our CJS build would
// reject them. By bundling it the consumer gets code that runs everywhere, and
// treeshaking keeps only the five modules we actually use.
const BUNDLED_DEPENDENCIES = ['web-vitals']

export default defineConfig([
  {
    entry: {
      express: 'src/express.ts',
      fastify: 'src/fastify.ts',
      nest: 'src/nest.ts',
      database: 'src/database.ts',
    },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    treeshake: true,
    target: 'es2020',
    external: [
      'express',
      'fastify',
      '@nestjs/common',
      '@opentelemetry/api',
      'rxjs',
      'node:async_hooks',
      'node:http',
      'node:crypto',
    ],
  },
  {
    entry: {
      svelte: 'src/svelte.ts',
      'sveltekit/client': 'src/sveltekit/client.ts',
      'sveltekit/server': 'src/sveltekit/server.ts',
    },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    treeshake: true,
    target: 'es2020',
    external: ['svelte', 'node:async_hooks'],
  },
  {
    entry: { angular: 'src/angular.ts' },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    treeshake: true,
    target: 'es2020',
    external: ['@angular/core', '@angular/common/http', '@angular/router', 'rxjs'],
  },
  {
    entry: {
      vue: 'src/vue.ts',
      'nuxt/client': 'src/nuxt/client.ts',
      'nuxt/server': 'src/nuxt/server.ts',
    },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    treeshake: true,
    target: 'es2020',
    external: ['vue', 'node:async_hooks'],
  },
  {
    entry: { react: 'src/react.ts' },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    // Preserve the client boundary directive through packaging.
    treeshake: false,
    target: 'es2020',
    external: ['react'],
    banner: { js: "'use client';" },
  },
  {
    entry: { 'next/server': 'src/next/server.ts' },
    format: ['esm', 'cjs'],
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    treeshake: true,
    target: 'es2020',
  },
  {
    // `helpdesk` is its own entry (CYRA-942): who does not import it ships none of it.
    entry: { index: 'src/index.ts', helpdesk: 'src/helpdesk.ts' },
    format: ['esm', 'cjs'],
    // tsup injects `baseUrl` into the dts build; TypeScript 6 rejects it as
    // deprecated (TS5101) unless the 6.0 deprecations are acknowledged.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    // scripts/build.mjs cleans once before concurrent entry builds, including DTS workers.
    clean: false,
    treeshake: true,
    target: 'es2020',
    noExternal: BUNDLED_DEPENDENCIES,
  },
  {
    entry: { closeyourit: 'src/index.ts' },
    format: ['iife'],
    globalName: 'CloseYourIt',
    minify: true,
    sourcemap: true,
    treeshake: true,
    target: 'es2018',
    outExtension: () => ({ js: '.min.js' }),
    noExternal: BUNDLED_DEPENDENCIES,
  },
  // The "Need help?" button as a file of its own: loaded only by the sites that switch it on.
  {
    entry: { helpdesk: 'src/helpdesk.iife.ts' },
    format: ['iife'],
    globalName: 'CloseYourItHelpdesk',
    minify: true,
    sourcemap: true,
    treeshake: true,
    target: 'es2018',
    outExtension: () => ({ js: '.min.js' }),
  },
])
