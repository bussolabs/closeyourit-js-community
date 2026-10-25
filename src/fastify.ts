import type { FastifyInstance } from 'fastify'
import { NodeHttpMonitoring } from './node/request'
import type { NodeHttpClient, NodeHttpOptions } from './node/request'
export type { NodeHttpClient, NodeHttpOptions } from './node/request'

export function createFastifyMonitoring(
  client: NodeHttpClient,
  options: NodeHttpOptions,
) {
  const monitoring = new NodeHttpMonitoring(client, options)
  const installed = new WeakSet<FastifyInstance>()
  return {
    context: monitoring,
    fetch: monitoring.fetch,
    install(instance: FastifyInstance): void {
      if (installed.has(instance)) return
      instance.addHook('onRequest', (request, reply, done) => {
        monitoring.begin(request.raw, reply.raw, () => request.routeOptions.url)
        monitoring.run(request.raw, done)
      })
      instance.addHook('onError', (request, _reply, error, done) => {
        monitoring.capture(request.raw, error, 'fastify')
        done()
      })
      installed.add(instance)
    },
    uninstall: () => monitoring.uninstall(),
  }
}
