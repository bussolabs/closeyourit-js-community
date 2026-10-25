import { proof } from '../../../proof.server.js'

export async function POST(event) {
  const target = new URL(process.env.CYI_PROOF_FETCH_TARGET)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    throw new Error('An owned loopback fetch target is required')
  const mode = event.url.searchParams.get('mode')
  if (mode === 'untrusted') target.hostname = 'localhost'
  if (mode === 'abort') target.searchParams.set('delay', '1')
  const controller = new AbortController()
  const headers = new Headers({ 'X-Proof-Header': 'application-header' })
  if (mode === 'existing')
    headers.set('traceparent', '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01')
  const request = new Request(target, {
    method: 'POST',
    body: await event.request.text(),
    headers,
    signal: controller.signal,
  })
  const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 20) : null
  try {
    const response = await event.fetch(request)
    return Response.json({
      received: await response.json(),
      trace_id: proof().client.scope.traceId,
    })
  } catch (error) {
    if (mode === 'abort' && error?.name === 'AbortError')
      return Response.json({ aborted: true })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
