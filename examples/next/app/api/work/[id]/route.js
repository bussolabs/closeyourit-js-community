import { client, integration } from '../../../../proof-server'

export const dynamic = 'force-dynamic'
export async function GET(request, context) {
  return integration.withRequest(
    request,
    { routerKind: 'App Router', routePath: '/api/work/[id]', routeType: 'route' },
    async () => {
      const { id } = await context.params
      if (!['one', 'two', 'three'].includes(id))
        return Response.json({ unknown: true }, { status: 404 })
      await new Promise((resolve) => setTimeout(resolve, id === 'one' ? 15 : 5))
      client.log('info', 'Next request completed')
      const traceId = client.scope.traceId
      await client.flush()
      return Response.json({ id, trace_id: traceId })
    },
  )
}

export const POST = GET
