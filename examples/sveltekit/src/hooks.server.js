import { proof } from './proof.server.js'
export const handle = (input) => {
  const state = proof()
  const execute = ({ event, resolve }) => resolve(event)
  return state && !['/api/config', '/api/proof-status'].includes(input.event.route.id)
    ? state.integration.wrapHandle(execute)(input)
    : execute(input)
}
export const handleError = (input) => {
  const policy = () => ({ message: 'Application server fallback' })
  return proof()?.integration.wrapHandleError(policy)(input) ?? policy()
}
export const handleFetch = (input) => {
  const execute = ({ request, fetch }) => fetch(request)
  return proof()?.integration.wrapHandleFetch(execute)(input) ?? execute(input)
}
