/** H3/Nuxt expected redirect and client-error responses are not application failures. */
export function expectedResponse(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || !('statusCode' in error))
      return false
    return (
      typeof error.statusCode === 'number' &&
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 300 &&
      error.statusCode < 500
    )
  } catch {
    return false
  }
}
