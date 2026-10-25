import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express'
import { NodeHttpMonitoring } from './node/request'
import type { NodeHttpClient, NodeHttpOptions } from './node/request'
export type { NodeHttpClient, NodeHttpOptions } from './node/request'

export function createExpressMonitoring(
  client: NodeHttpClient,
  options: NodeHttpOptions,
) {
  const monitoring = new NodeHttpMonitoring(client, options)
  function middleware(request: Request, response: Response, next: NextFunction): void {
    monitoring.begin(request, response, () => request.route?.path)
    monitoring.run(request, () => next())
  }
  function errors(
    error: unknown,
    request: Request,
    _response: Response,
    next: NextFunction,
  ): void {
    monitoring.capture(request, error, 'express')
    next(error)
  }
  return {
    middleware,
    errors,
    context: monitoring,
    fetch: monitoring.fetch,
    wrapErrorHandler(handler: ErrorRequestHandler): ErrorRequestHandler {
      return function (this: unknown, error: unknown, request, response, next) {
        monitoring.capture(request, error, 'express', true)
        return handler.call(this, error, request, response, next)
      }
    },
    uninstall: () => monitoring.uninstall(),
  }
}
