import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The browser integrations (globalHandlers, breadcrumbs) touch window/document/fetch.
    environment: 'jsdom',
    // Coverage gate on the package core. Thresholds = ratchet: they may ONLY go up.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // types.ts holds types only (no runtime). Everything else is under the gate.
      exclude: ['src/types.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
})
