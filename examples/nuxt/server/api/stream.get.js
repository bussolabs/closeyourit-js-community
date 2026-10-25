import { client, integration } from '../utils/proof.js'
export default defineEventHandler((event) =>
  integration.withRequest(event, '/api/stream', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first\n'))
        setTimeout(() => {
          client.log('info', 'Nuxt deferred stream', { route: '/api/stream' })
          controller.enqueue(new TextEncoder().encode('last\n'))
          controller.close()
        }, 10)
      },
    })
  }),
)
