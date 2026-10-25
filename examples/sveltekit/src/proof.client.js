import { init } from '@bussolabs/closeyourit-js'
import { createSvelteKitClient } from '@bussolabs/closeyourit-js/sveltekit/client'
import { version } from './profile.js'
let state
export async function initialize() {
  if (state) return state
  const config = await (await fetch('/api/config')).json()
  const records = []
  const client = init({
    ...config,
    autoInstall: false,
    captureRequest: false,
    beforeSend(payload) {
      if (records.length < 1000)
        records.push({
          event_id: payload.event_id,
          trace_id: payload.trace_id,
          kind: payload.kind ?? 'error',
        })
      return config.constructionOnly ? null : payload
    },
  })
  state = {
    client,
    integration: createSvelteKitClient(client, { version }),
    records,
    policies: 0,
  }
  return state
}
export function current() {
  return state
}
export async function metadata() {
  await state?.client.flush()
  return {
    observations: state?.records ?? [],
    stats: state?.client.stats.toObject(),
    policies: state?.policies ?? 0,
  }
}
