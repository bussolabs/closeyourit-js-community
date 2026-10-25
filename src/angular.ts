import { HttpContextToken, HttpErrorResponse, HttpResponse } from '@angular/common/http'
import type { HttpInterceptorFn } from '@angular/common/http'
import type { NgZone } from '@angular/core'
import { NavigationEnd, PRIMARY_OUTLET } from '@angular/router'
import type { ActivatedRouteSnapshot, Router } from '@angular/router'
import { defer, finalize, tap } from 'rxjs'
import type { Client } from './client'

export interface AngularInstrumentation {
  uninstall(): void
}
export interface AngularOptions {
  zone?: Pick<NgZone, 'runOutsideAngular'>
}
export type AngularErrorClient = Pick<Client, 'captureException'>
export type AngularHttpClient = Pick<Client, 'measure' | 'getTraceHeaders'>
export type AngularRouterClient = Pick<Client, 'addBreadcrumb'>

function observe(options: AngularOptions, operation: () => void): void {
  try {
    if (options.zone) options.zone.runOutsideAngular(operation)
    else operation()
  } catch {
    // Telemetry must not replace application behavior.
  }
}

const handlers = new WeakMap<
  object,
  {
    client: AngularErrorClient
    zone: AngularOptions['zone']
    wrapper: (error: unknown) => unknown
    integration: AngularInstrumentation
  }
>()
const httpErrors = new WeakMap<HttpErrorResponse, Error>()

/** Wrap the application's actual handler, including its return/throw policy. */
export function instrumentAngularErrorHandler(
  handler: { handleError(error: unknown): unknown },
  client: AngularErrorClient,
  options: AngularOptions = {},
): AngularInstrumentation {
  const existing = handlers.get(handler)
  if (existing) {
    if (
      existing.client !== client ||
      existing.zone !== options.zone ||
      handler.handleError !== existing.wrapper
    )
      throw new Error(
        'Angular error handler installation conflicts with the active owner',
      )
    return existing.integration
  }
  const previous = handler.handleError
  let active = true
  const wrapper = function (this: unknown, error: unknown): unknown {
    if (active)
      observe(options, () => {
        let reported = error
        if (error instanceof HttpErrorResponse) {
          let safe = httpErrors.get(error)
          if (!safe) {
            const status =
              Number.isInteger(error.status) && error.status >= 0 && error.status <= 599
                ? error.status
                : 0
            safe = new Error(`Angular HTTP request failed (status ${status})`)
            safe.name = 'HttpErrorResponse'
            httpErrors.set(error, safe)
          }
          reported = safe
        }
        client.captureException(reported, {
          handled: false,
          contexts: { angular: { integration: 'error_handler' } },
        })
      })
    return previous.call(this, error)
  }
  const integration = {
    uninstall(): void {
      active = false
      if (handler.handleError === wrapper) handler.handleError = previous
      if (handlers.get(handler)?.integration === integration) handlers.delete(handler)
    },
  }
  handler.handleError = wrapper
  handlers.set(handler, { client, zone: options.zone, wrapper, integration })
  return integration
}

/** Set an application-owned static route template, never a concrete request URL. */
export const ANGULAR_HTTP_TEMPLATE = new HttpContextToken<string>(() => '/unknown')

function template(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 256 &&
    !/[?#\r\n]/.test(value)
    ? value
    : '/unknown'
}

function routeTemplate(root: ActivatedRouteSnapshot): string {
  const paths: string[] = []
  const visited = new Set<ActivatedRouteSnapshot>()
  let node: ActivatedRouteSnapshot | undefined = root
  while (node) {
    if (visited.has(node) || visited.size >= 32) return '/unknown'
    visited.add(node)
    if (node.routeConfig) {
      if (typeof node.routeConfig.path !== 'string') return '/unknown'
      if (node.routeConfig.path) paths.push(node.routeConfig.path)
    }
    node = node.children.find((child) => child.outlet === PRIMARY_OUTLET)
  }
  return template('/' + paths.join('/'))
}

const routers = new WeakMap<
  Router,
  {
    client: AngularRouterClient
    zone: AngularOptions['zone']
    integration: AngularInstrumentation
  }
>()

/** Observe successful primary-outlet navigation, not concrete URLs or page views. */
export function instrumentAngularRouter(
  router: Router,
  client: AngularRouterClient,
  options: AngularOptions = {},
): AngularInstrumentation {
  const existing = routers.get(router)
  if (existing) {
    if (existing.client !== client || existing.zone !== options.zone)
      throw new Error('Angular router installation conflicts with the active owner')
    return existing.integration
  }
  let from = '/unknown'
  let active = true
  const subscription = router.events.subscribe((event) => {
    if (!active || !(event instanceof NavigationEnd)) return
    observe(options, () => {
      const to = routeTemplate(router.routerState.snapshot.root)
      if (to !== from)
        client.addBreadcrumb({ category: 'navigation', data: { from, to } })
      from = to
    })
  })
  const integration = {
    uninstall(): void {
      active = false
      subscription.unsubscribe()
      if (routers.get(router)?.integration === integration) routers.delete(router)
    },
  }
  routers.set(router, { client, zone: options.zone, integration })
  return integration
}

/** Each subscription/retry is measured separately; handled RxJS errors stay handled. */
export function createAngularHttpInterceptor(
  client: AngularHttpClient,
  options: AngularOptions = {},
): AngularInstrumentation & { interceptor: HttpInterceptorFn } {
  let active = true
  const interceptor: HttpInterceptorFn = (request, next) =>
    defer(() => {
      if (!active) return next(request)
      let forwarded = request
      let complete: (() => void) | undefined
      const outcome: { status?: number; outcome: string } = { outcome: 'cancelled' }
      observe(options, () => {
        if (!request.headers.has('traceparent')) {
          const carrier = client.getTraceHeaders(request.url)
          const headers: Record<string, string> = {}
          for (const name of ['traceparent', 'tracestate'])
            if (carrier[name]) headers[name] = carrier[name]
          if (Object.keys(headers).length)
            forwarded = request.clone({ setHeaders: headers })
        }
        const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method)
          ? request.method
          : 'OTHER'
        const completion = new Promise<void>((resolve) => {
          complete = resolve
        })
        const measured = client.measure(
          `angular.http ${method} ${template(request.context.get(ANGULAR_HTTP_TEMPLATE))}`,
          () => completion,
          { args: outcome },
        )
        void measured.catch(() => undefined)
      })
      // Keep next inside defer: synchronous failures become the same Observable error.
      return defer(() => next(forwarded)).pipe(
        tap({
          next(event) {
            if (event instanceof HttpResponse) {
              outcome.status = event.status
              outcome.outcome = 'success'
            }
          },
          error(error: unknown) {
            outcome.outcome = 'error'
            if (error instanceof HttpErrorResponse) outcome.status = error.status
          },
        }),
        finalize(() => observe(options, () => complete?.())),
      )
    })
  return {
    interceptor,
    uninstall() {
      active = false
    },
  }
}
