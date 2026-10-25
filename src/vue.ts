import type { App } from 'vue'
import type { Client } from './client'

export type VueClient = Pick<Client, 'captureException'>
export type VueErrorHandler = NonNullable<App['config']['errorHandler']>
export interface VueInstrumentation {
  uninstall(): void
}

const installations = new WeakMap<
  App,
  {
    client: VueClient
    handler: VueErrorHandler
    fallback?: VueErrorHandler
    integration: VueInstrumentation
  }
>()

/** The application chooses its error policy; this wrapper only observes it. */
export function instrumentVue(
  app: App,
  client: VueClient,
  options: { onUnhandledError?: VueErrorHandler } = {},
): VueInstrumentation {
  const existing = installations.get(app)
  if (existing) {
    if (existing.client !== client)
      throw new Error('Vue instrumentation already uses a different client')
    if (app.config.errorHandler !== existing.handler)
      throw new Error('Vue error handler was replaced; uninstall before reinstalling')
    if (options.onUnhandledError !== existing.fallback)
      throw new Error(
        'Vue instrumentation error policy conflicts with the active installation',
      )
    return existing.integration
  }
  const previous = app.config.errorHandler
  const delegate = previous ?? options.onUnhandledError
  if (!delegate)
    throw new Error(
      'Vue instrumentation requires an existing errorHandler or explicit onUnhandledError policy',
    )
  let active = true
  const handler: VueErrorHandler = function (this: unknown, error, instance, info) {
    if (active) captureVueError(client, error, info)
    return delegate.call(this, error, instance, info)
  }
  const integration = {
    uninstall(): void {
      active = false
      if (app.config.errorHandler === handler) app.config.errorHandler = previous
      if (installations.get(app)?.integration === integration) installations.delete(app)
    },
  }
  app.config.errorHandler = handler
  installations.set(app, {
    client,
    handler,
    fallback: options.onUnhandledError,
    integration,
  })
  app.onUnmount(integration.uninstall)
  return integration
}

export function captureVueError(
  client: VueClient,
  error: unknown,
  info?: string,
): void {
  try {
    client.captureException(error, {
      handled: false,
      contexts: {
        vue: { info: typeof info === 'string' ? info.slice(0, 128) : undefined },
      },
    })
  } catch {
    // Reporting cannot replace the application's handler or its exception.
  }
}
