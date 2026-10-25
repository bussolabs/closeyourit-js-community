import type {
  ArgumentsHost,
  CallHandler,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common'
import type { IncomingMessage } from 'node:http'
import { Observable } from 'rxjs'
import type { NodeHttpMonitoring } from './node/request'

/** Compose with the application's selected Express/Fastify request monitor and exception policy. */
export function createNestMonitoring(monitoring: NodeHttpMonitoring) {
  let active = true
  function request(host: ArgumentsHost): IncomingMessage {
    const value = host
      .switchToHttp()
      .getRequest<IncomingMessage | { raw: IncomingMessage }>()
    return 'raw' in value ? value.raw : value
  }
  const interceptor: NestInterceptor = {
    intercept<T>(host: ExecutionContext, next: CallHandler<T>): Observable<T> {
      if (!active || host.getType() !== 'http') return next.handle()
      const raw = request(host)
      return new Observable<T>((subscriber) =>
        monitoring.run(raw, () =>
          next.handle().subscribe({
            next: (value) => monitoring.run(raw, () => subscriber.next(value)),
            error: (error: unknown) => {
              if (active) monitoring.capture(raw, error, 'nest')
              monitoring.run(raw, () => subscriber.error(error))
            },
            complete: () => monitoring.run(raw, () => subscriber.complete()),
          }),
        ),
      )
    },
  }
  return {
    interceptor,
    wrapFilter<T extends ExceptionFilter>(handler: T): T {
      // Forward through a separate target: frozen application properties must not
      // constrain the observed methods through Proxy's own-property invariants.
      const target = Object.create(Object.getPrototypeOf(handler)) as T
      const methods = new WeakMap<Function, Function>()
      return new Proxy(target, {
        get(_target, key) {
          if (key !== 'catch') {
            const value = Reflect.get(handler, key, handler)
            if (key === 'constructor' || typeof value !== 'function') return value
            let bound = methods.get(value)
            if (!bound) {
              bound = value.bind(handler)
              methods.set(value, bound!)
            }
            return bound
          }
          return function (error: unknown, host: ArgumentsHost) {
            if (active && host.getType() === 'http')
              monitoring.capture(request(host), error, 'nest', true)
            return handler.catch(error, host)
          }
        },
        set(_target, key, value) {
          return Reflect.set(handler, key, value, handler)
        },
      })
    },
    uninstall(): void {
      active = false
    },
  }
}
