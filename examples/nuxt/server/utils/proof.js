import { getClient, init } from '@bussolabs/closeyourit-js'
import { createNitroInstrumentation } from '@bussolabs/closeyourit-js/nuxt/server'

export const client =
  getClient() ??
  init({
    endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
    token: process.env.CYI_PROOF_TOKEN,
    projectId: process.env.CYI_PROOF_PROJECT,
    environment: 'certification',
    release: process.env.CYI_PROOF_RELEASE || 'nuxt-local',
    enabled: process.env.CYI_PROOF_ENABLED === '1',
    autoInstall: false,
    slowMethodThresholdMs: 1,
    logsFlushIntervalMs: 100,
    beforeSend(payload) {
      const records = (globalThis[Symbol.for('cyi.nuxt.proof.observations')] ??= [])
      if (records.length < 1000)
        records.push({
          event_id: payload.event_id,
          sample_id: payload.sample_id,
          trace_id: payload.trace_id,
          kind: payload.kind ?? (payload.exception ? 'error' : 'log'),
          release: payload.release,
          route: payload.label ?? payload.contexts?.nuxt?.route,
        })
      return process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1' ? null : payload
    },
  })
export const integration = createNitroInstrumentation(client)
if (process.env.CYI_PROOF_UNINSTALL === '1') integration.uninstall()
export function observations() {
  return {
    enabled: client.enabled,
    construction_only: process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1',
    stats: client.stats.toObject(),
    observations: globalThis[Symbol.for('cyi.nuxt.proof.observations')] ?? [],
  }
}
export function publicConfiguration() {
  return {
    endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
    publicKey: process.env.CYI_PROOF_PUBLIC_KEY,
    projectId: process.env.CYI_PROOF_PROJECT,
    environment: 'certification',
    release: process.env.CYI_PROOF_RELEASE || 'nuxt-local',
    enabled: process.env.CYI_PROOF_ENABLED === '1',
  }
}
