export default {
  // Keep instrumentation and route entry points on the same server-side SDK instance.
  serverExternalPackages: ['@bussolabs/closeyourit-js'],
  productionBrowserSourceMaps: true,
  experimental: { cpus: 2 },
}
