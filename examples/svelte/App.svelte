<script>
  import { onMount, tick } from 'svelte'
  import { Client } from '@bussolabs/closeyourit-js'
  import { createSvelteBoundaryHandler } from '@bussolabs/closeyourit-js/svelte'
  import Failure from './Failure.svelte'
  let ready = $state(false)
  let failure = $state(0)
  let count = $state(0)
  let policies = $state(0)
  let removed = $state(false)
  let output = $state('')
  let client
  let integration
  const records = []
  onMount(() => {
    fetch('/api/config').then((response) => response.json()).then((config) => {
      client = new Client({ ...config, autoInstall: false, captureRequest: false, beforeSend(payload) {
            if (records.length < 1000)
              records.push({ event_id: payload.event_id, trace_id: payload.trace_id })
        return config.constructionOnly ? null : payload
      } })
      integration = createSvelteBoundaryHandler(client, () => { policies++ })
      ready = true
    })
    return () => { integration?.uninstall(); void client?.close() }
  })
  function onerror(error, reset) { return integration.onError(error, reset) }
  function fail() { count++; failure = count }
  async function recover(reset) { failure = 0; await tick(); reset() }
  async function inspect() { await client.flush(); output = JSON.stringify({ version: '5.57.1', errors: count, policies, removed, observations: records, stats: client.stats.toObject() }) }
  function uninstall() { integration.uninstall(); removed = true }
</script>
<h1>Standalone Svelte integration proof</h1>
<p>{ready ? 'Instrumentation ready' : 'Starting'}</p>
{#if ready}
  <button onclick={fail}>Fail render</button>
  <button onclick={inspect}>Read event identity</button>
  <button onclick={uninstall} disabled={removed}>Uninstall instrumentation</button>
  <svelte:boundary {onerror}>
    <Failure {failure} />
    {#snippet failed(error, reset)}
      <p>Application fallback remains usable</p>
      <button onclick={() => recover(reset)}>Recover content</button>
    {/snippet}
  </svelte:boundary>
{/if}
<output>{output}</output>
