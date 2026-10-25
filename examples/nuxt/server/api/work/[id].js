import { client, integration } from '../../utils/proof.js'
export default defineEventHandler((event) =>
  integration.withRequest(event, '/api/work/:id', async () => {
    const id = getRouterParam(event, 'id')
    await new Promise((resolve) => setTimeout(resolve, 10))
    client.log('info', `Nuxt work ${id}`, { route: '/api/work/:id' })
    if (id !== 'ok') throw new Error(`Nuxt work failure ${id}`)
    return { ok: true, trace_id: client.scope.traceId }
  }),
)
