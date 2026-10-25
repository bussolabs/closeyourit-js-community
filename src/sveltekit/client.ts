import { captureError, routeTemplate } from './shared'
import type { KitClient, KitError, KitOptions, KitRoute } from './shared'

export interface KitNavigation {
  from: KitRoute | null
  to: KitRoute | null
}

/** Register afterNavigate during component initialization; Svelte owns its lifecycle. */
export function createSvelteKitClient(client: KitClient, options: KitOptions) {
  let active = true
  return {
    wrapHandleError<I extends KitError, T>(handler: (input: I) => T): (input: I) => T {
      return function (this: unknown, input): T {
        if (active) {
          try {
            captureError(client, input, options.version, 'client')
          } catch {
            // Reporting must not change the application's App.Error response.
          }
        }
        return handler.call(this, input)
      }
    },
    afterNavigate(input: KitNavigation): void {
      if (!active) return
      try {
        client.addBreadcrumb({
          category: 'navigation',
          data: {
            from: routeTemplate(input.from?.route.id),
            to: routeTemplate(input.to?.route.id),
          },
        })
      } catch {
        // Observing navigation cannot block or cancel it.
      }
    },
    uninstall(): void {
      active = false
    },
  }
}
