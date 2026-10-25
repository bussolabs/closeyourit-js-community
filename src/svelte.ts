import type { Client } from './client'

/** The application supplies its boundary policy; reporting never replaces it. */
export function createSvelteBoundaryHandler<T>(
  client: Pick<Client, 'captureException'>,
  handler: (this: unknown, error: unknown, reset: () => void) => T,
) {
  let active = true
  return {
    onError(this: unknown, error: unknown, reset: () => void): T {
      if (active) {
        try {
          client.captureException(error, {
            handled: true,
            contexts: { svelte: { phase: 'boundary' } },
          })
        } catch {
          // Preserve the application's error and reset policy.
        }
      }
      return handler.call(this, error, reset)
    },
    uninstall(): void {
      active = false
    },
  }
}
