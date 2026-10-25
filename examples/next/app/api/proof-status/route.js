import { client, observations } from '../../../proof-server'
export const dynamic = 'force-dynamic'
export async function GET() {
  await client.flush()
  return Response.json(observations())
}
