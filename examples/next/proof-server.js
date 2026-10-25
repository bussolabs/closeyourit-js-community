import { getClient, init } from '@bussolabs/closeyourit-js'
import { createNextInstrumentation } from '@bussolabs/closeyourit-js/next/server'

export const client =
  getClient() ??
  init({
    endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
    token: process.env.CYI_PROOF_TOKEN,
    projectId: process.env.CYI_PROOF_PROJECT,
    environment: 'certification',
    release: process.env.CYI_PROOF_RELEASE || 'next-local',
    enabled: process.env.CYI_PROOF_ENABLED === '1',
    autoInstall: false,
    slowMethodThresholdMs: 1,
    logsFlushIntervalMs: 100,
    beforeSend: (payload) => {
      const observations = (globalThis[Symbol.for('cyi.next.proof.observations')] ??=
        [])
      if (observations.length < 1000)
        observations.push({
          event_id: payload.event_id,
          sample_id: payload.sample_id,
          trace_id: payload.trace_id,
          kind: payload.kind ?? (payload.exception ? 'error' : 'log'),
          release: payload.release,
          route: payload.label ?? payload.contexts?.next?.route,
        })
      return process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1' ? null : payload
    },
  })
export const integration = createNextInstrumentation(client)
if (process.env.CYI_PROOF_UNINSTALL === '1') integration.uninstall()

export function observations() {
  return {
    enabled: client.enabled,
    stats: client.stats.toObject(),
    construction_only: process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1',
    observations: globalThis[Symbol.for('cyi.next.proof.observations')] ?? [],
  }
}

export function publicConfiguration() {
  return {
    endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
    publicKey: process.env.CYI_PROOF_PUBLIC_KEY,
    projectId: process.env.CYI_PROOF_PROJECT,
    environment: 'certification',
    release: process.env.CYI_PROOF_RELEASE || 'next-local',
    enabled: process.env.CYI_PROOF_ENABLED === '1',
    breadcrumbs: false,
  }
}
