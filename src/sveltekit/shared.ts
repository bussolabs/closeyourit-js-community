import type { Client } from '../client'

export interface KitOptions {
  version: 2 | 3
}
export interface KitRoute {
  route: { id: string | null }
}
export interface KitError {
  error: unknown
  event: KitRoute
  kind?: string
  status?: number
}
export type KitClient = Pick<Client, 'captureException' | 'addBreadcrumb'>

export function routeTemplate(value: string | null | undefined): string {
  return typeof value === 'string' &&
    value.length <= 256 &&
    /^\/[A-Za-z0-9_./\[\]():@+*=~-]*$/.test(value)
    ? value
    : '/unknown'
}

export function captureError(
  client: Pick<Client, 'captureException'>,
  input: KitError,
  version: 2 | 3,
  runtime: 'client' | 'node',
): void {
  if (
    version === 3
      ? input.kind !== 'unknown'
      : !Number.isInteger(input.status) || input.status! < 500 || input.status! > 599
  )
    return
  client.captureException(input.error, {
    handled: false,
    contexts: {
      sveltekit: {
        runtime,
        phase: 'handleError',
        route: routeTemplate(input.event.route.id),
      },
    },
  })
}
