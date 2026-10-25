import { init } from '@bussolabs/closeyourit-js'
import { instrumentNuxtClient } from '@bussolabs/closeyourit-js/nuxt/client'
export default defineNuxtPlugin(async (app) => {
  const configuration = await $fetch('/api/config')
  const observations = []
  const client = init({
    ...configuration,
    autoInstall: false,
    beforeSend(payload) {
      if (observations.length < 1000)
        observations.push({ event_id: payload.event_id, trace_id: payload.trace_id })
      return payload
    },
  })
  const integration = instrumentNuxtClient(app.hooks, client, useRouter())
  return { provide: { proof: { client, integration, observations } } }
})
