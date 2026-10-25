import { integration } from '../../../proof-server'
export async function GET(request) {
  return integration.withRequest(
    request,
    { routerKind: 'App Router', routePath: '/api/route-error', routeType: 'route' },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const supplied = new URL(request.url).searchParams.get('case')
      const scenario = ['one', 'two', 'three'].includes(supplied) ? supplied : 'one'
      throw new Error(`Next route failure ${scenario}`)
    },
  )
}
