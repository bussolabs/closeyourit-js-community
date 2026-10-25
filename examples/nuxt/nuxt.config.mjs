import { fileURLToPath } from 'node:url'
export default defineNuxtConfig({
  srcDir: 'app',
  serverDir: fileURLToPath(new URL('./server', import.meta.url)),
  telemetry: false,
  devtools: { enabled: false },
  sourcemap: { server: true, client: true },
  nitro: { externals: { external: ['@bussolabs/closeyourit-js'] } },
})
