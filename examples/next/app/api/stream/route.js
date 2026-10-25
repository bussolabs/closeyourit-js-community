import { integration } from '../../../proof-server'
export async function GET(request) {
  return integration.withRequest(
    request,
    { routerKind: 'App Router', routePath: '/api/stream', routeType: 'route' },
    () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('first'))
            await new Promise((resolve) => setTimeout(resolve, 30))
            controller.enqueue(encoder.encode(':second'))
            controller.close()
          },
        }),
      )
    },
  )
}
