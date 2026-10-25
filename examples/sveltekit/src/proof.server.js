import { getClient, init } from '@bussolabs/closeyourit-js'
import { createSvelteKitServer } from '@bussolabs/closeyourit-js/sveltekit/server'
import { building, version, framework } from './profile.js'

const records = []
let client
let integration
export function proof() {
  if (building) return null
  if (!client) {
    client =
      getClient() ??
      init({
        endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
        token: process.env.CYI_PROOF_TOKEN,
        projectId: process.env.CYI_PROOF_PROJECT,
        environment: 'certification',
        release: process.env.CYI_PROOF_RELEASE || 'sveltekit-local',
        enabled: process.env.CYI_PROOF_ENABLED === '1',
        autoInstall: false,
        slowMethodThresholdMs: 1,
        logsFlushIntervalMs: 100,
        tracePropagationTargets: ['http://127.0.0.1'],
        beforeSend(payload) {
          if (records.length < 1000)
            records.push({
              event_id: payload.event_id,
              sample_id: payload.sample_id,
              trace_id: payload.trace_id,
              kind: payload.kind ?? (payload.exception ? 'error' : 'log'),
              release: payload.release,
              route: payload.label ?? payload.contexts?.sveltekit?.route,
            })
          return process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1' ? null : payload
        },
      })
    integration = createSvelteKitServer(client, { version })
    if (process.env.CYI_PROOF_UNINSTALL === '1') integration.uninstall()
  }
  return { client, integration }
}
export async function status() {
  const state = proof()
  await state?.client.flush()
  return {
    version: framework,
    enabled: state?.client.enabled ?? false,
    construction_only: process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1',
    observations: records,
    stats: state?.client.stats.toObject(),
  }
}
export function configuration() {
  return {
    endpointUrl: process.env.CYI_PROOF_ENDPOINT || 'http://127.0.0.1:1',
    publicKey: process.env.CYI_PROOF_PUBLIC_KEY,
    projectId: process.env.CYI_PROOF_PROJECT,
    environment: 'certification',
    release: process.env.CYI_PROOF_RELEASE || 'sveltekit-local',
    enabled: process.env.CYI_PROOF_ENABLED === '1',
    constructionOnly: process.env.CYI_PROOF_CONSTRUCTION_ONLY === '1',
  }
}
