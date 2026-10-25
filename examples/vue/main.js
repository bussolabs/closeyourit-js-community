import { createApp, h, ref, version } from 'vue'
import { init } from '@bussolabs/closeyourit-js'
import { instrumentVue } from '@bussolabs/closeyourit-js/vue'

const configurationResponse = await fetch('/api/config')
if (!configurationResponse.ok) throw new Error('Proof configuration unavailable')
const configuration = await configurationResponse.json()
const observations = []
const expectedErrors = new WeakSet()
let previousCalls = 0
let previousArgumentsPreserved = true
let attempts = 0
let active = true
let applicationActions = 0
let integration
const output = ref('')
const usable = ref(false)

const client = init({
  ...configuration,
  autoInstall: false,
  beforeSend(payload) {
    if (observations.length < 20)
      observations.push({
        event_id: payload.event_id,
        trace_id: payload.trace_id,
        release: payload.release,
      })
    return payload
  },
})

function previousHandler(error, instance, info) {
  previousCalls += 1
  previousArgumentsPreserved &&=
    expectedErrors.has(error) && instance !== null && typeof info === 'string'
}

async function readProof() {
  await client.flush()
  output.value = JSON.stringify({
    framework: 'vue',
    version,
    construction_only: false,
    enabled: client.enabled,
    active,
    attempts,
    previous_calls: previousCalls,
    previous_arguments_preserved: previousArgumentsPreserved,
    previous_handler_restored: app.config.errorHandler === previousHandler,
    application_actions: applicationActions,
    usable: usable.value,
    observations,
    stats: client.stats.toObject(),
  })
}

const app = createApp({
  setup() {
    return () =>
      h('main', [
        h('h1', 'Vue standalone integration proof'),
        h(
          'button',
          {
            onClick() {
              attempts += 1
              usable.value = true
              const error = new Error(`Vue standalone proof ${attempts}`)
              expectedErrors.add(error)
              throw error
            },
          },
          'Fail Vue event',
        ),
        h('button', { onClick: readProof }, 'Read proof'),
        h(
          'button',
          {
            onClick() {
              integration.uninstall()
              active = false
            },
          },
          'Uninstall adapter',
        ),
        h(
          'button',
          {
            onClick() {
              applicationActions += 1
              usable.value = true
            },
          },
          'Use application',
        ),
        usable.value ? h('p', 'Application remains usable') : null,
        h('output', output.value),
      ])
  },
})
app.config.errorHandler = previousHandler
integration = instrumentVue(app, client)
app.mount('#app')
