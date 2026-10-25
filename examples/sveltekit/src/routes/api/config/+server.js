import { configuration } from '../../../proof.server.js'
export const GET = () => Response.json(configuration())
