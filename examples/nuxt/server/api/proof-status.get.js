import { client, observations } from '../utils/proof.js'
export default defineEventHandler(async () => {
  await client.flush()
  return observations()
})
