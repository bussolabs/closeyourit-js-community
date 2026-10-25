import { error, redirect } from '@sveltejs/kit'
import { proof } from '../../../../proof.server.js'
export async function POST(event) {
  const id = event.params.id
  if (id === 'expected') error(404, 'Expected application response')
  if (id === 'redirect') redirect(307, '/')
  await new Promise((resolve) => setTimeout(resolve, 8))
  const { client } = proof()
  client.log('info', 'SvelteKit request observed', { route: '/api/work/[id]' })
  if (['one', 'two', 'three'].includes(id))
    throw new Error('SvelteKit server failure ' + id)
  return Response.json({
    trace_id: client.scope.traceId,
    body_unchanged: (await event.request.text()) === 'private-body',
  })
}
