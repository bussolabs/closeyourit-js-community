import { browser } from '../../profile.js'
export function load() {
  if (browser) throw new Error('SvelteKit client load failure')
  return {}
}
