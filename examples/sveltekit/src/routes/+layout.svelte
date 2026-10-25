<script>
  import { onMount } from 'svelte'
  import { afterNavigate } from '$app/navigation'
  import { initialize, current, metadata } from '../proof.client.js'
  let { children } = $props()
  let ready = $state(false)
  let result = $state('')
  onMount(() => { initialize().then(() => { ready = true }) })
  afterNavigate((input) => current()?.integration.afterNavigate(input))
  async function inspect() { result = JSON.stringify(await metadata()) }
</script>
<nav><a href="/">Home</a> <a href="/items/private-item?private=private-query">Navigate to item</a> <a href="/client-error">Fail client load</a></nav>
<p>{ready ? 'Instrumentation ready' : 'Starting'}</p>
{@render children()}
<button onclick={inspect}>Read event identity</button>
<output>{result}</output>
