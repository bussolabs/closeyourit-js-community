import { status } from '../../../proof.server.js'
export const GET = async () => Response.json(await status())
