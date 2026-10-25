import { integration } from '../utils/proof.js'
export default defineNitroPlugin((app) => {
  if (process.env.CYI_PROOF_UNINSTALL !== '1') integration.install(app.hooks)
})
