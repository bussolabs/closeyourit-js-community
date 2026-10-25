import { client, integration } from '../proof-server'
export async function getServerSideProps(context) {
  return integration.withRequest(
    context.req,
    { routerKind: 'Pages Router', routePath: '/legacy', routeType: 'render' },
    async () => {
      client.log('info', 'Next Pages SSR completed')
      await client.flush()
      return { props: { traceId: client.scope.traceId ?? null } }
    },
  )
}
export default function Legacy({ traceId }) {
  return (
    <p>
      Pages SSR <output>{traceId}</output>
    </p>
  )
}
