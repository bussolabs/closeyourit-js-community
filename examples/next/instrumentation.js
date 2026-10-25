export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./proof-server')
}

export async function onRequestError(error, request, context) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { integration } = await import('./proof-server')
  await integration.onRequestError(error, request, context)
}
