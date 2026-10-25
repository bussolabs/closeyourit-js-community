import type { Client } from '../client'
import { expectedResponse } from './response'

export interface NuxtClientHooks {
  hook(
    name: 'vue:error',
    callback: (error: unknown, instance: unknown, info: string) => void,
  ): () => void
  hook(name: 'app:error', callback: (error: unknown) => void): () => void
}
interface Route {
  matched: ReadonlyArray<{ path: string }>
}
export interface NuxtClientRouter {
  afterEach(callback: (to: Route, from: Route, failure?: unknown) => void): () => void
}
type NuxtClient = Pick<Client, 'captureException' | 'addBreadcrumb'>
const installations = new WeakMap<
  NuxtClientHooks,
  {
    client: NuxtClient
    router?: NuxtClientRouter
    integration: { uninstall(): void }
  }
>()

/** Register in a client-only Nuxt plugin; Nuxt retains ownership of Vue's error policy. */
export function instrumentNuxtClient(
  hooks: NuxtClientHooks,
  client: NuxtClient,
  router?: NuxtClientRouter,
) {
  const existing = installations.get(hooks)
  if (existing) {
    if (existing.client !== client || existing.router !== router)
      throw new Error(
        'Nuxt instrumentation configuration conflicts with the active installation',
      )
    return existing.integration
  }
  let active = true
  const removers: Array<() => void> = []
  const integration = {
    uninstall(): void {
      active = false
      for (const remove of removers.splice(0)) remove()
      if (installations.get(hooks)?.integration === integration)
        installations.delete(hooks)
    },
  }
  try {
    removers.push(
      hooks.hook('vue:error', (error, _instance, info) => {
        if (active) capture(client, error, 'vue:error', info)
      }),
    )
    removers.push(
      hooks.hook('app:error', (error) => {
        if (active) capture(client, error, 'app:error')
      }),
    )
    if (router)
      removers.push(
        router.afterEach((to, from, failure) => {
          if (!active || failure) return
          try {
            client.addBreadcrumb({
              category: 'navigation',
              data: { from: template(from), to: template(to) },
            })
          } catch {
            // No navigation failure is introduced by reporting.
          }
        }),
      )
  } catch (error) {
    integration.uninstall()
    throw error
  }
  installations.set(hooks, { client, router, integration })
  return integration
}

function capture(
  client: NuxtClient,
  error: unknown,
  phase: string,
  info?: string,
): void {
  if (expectedResponse(error)) return
  try {
    client.captureException(error, {
      handled: false,
      contexts: {
        nuxt: { runtime: 'client', phase },
        vue: { info: typeof info === 'string' ? info.slice(0, 128) : undefined },
      },
    })
  } catch {
    // Preserve Nuxt's own error handling when reporting is unavailable.
  }
}

function template(route: Route): string {
  const value = route.matched[route.matched.length - 1]?.path
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./\[\]():@+*?\\-]*$/.test(value)
    ? value
    : '/unknown'
}
