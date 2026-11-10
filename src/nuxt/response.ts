/** H3/Nuxt expected redirect and client-error responses are not application failures. */
export function expectedResponse(error: unknown): boolean {
  try {
    const status = statusOf(error)
    return status >= 300 && status < 500
  } catch {
    return false
  }
}

/** H3 1 errors carry `statusCode`; H3 2's HTTPError exposes `status` only. */
function statusOf(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0
  const source = error as { statusCode?: unknown; status?: unknown }
  for (const value of [source.statusCode, source.status])
    if (typeof value === 'number' && Number.isInteger(value)) return value
  return 0
}
