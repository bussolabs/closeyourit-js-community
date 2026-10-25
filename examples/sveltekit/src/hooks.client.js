import { current } from './proof.client.js'
export const handleError = (input) => {
  const state = current()
  const policy = () => {
    if (state) state.policies++
    return { message: 'Application client fallback' }
  }
  return state ? state.integration.wrapHandleError(policy)(input) : policy()
}
