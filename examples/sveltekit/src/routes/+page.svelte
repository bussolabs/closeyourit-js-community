<script>
  import { current } from '../proof.client.js'
  let result = $state('')
  async function correlated() {
    const response = await fetch('/api/work/browser', { method: 'POST', body: 'private-body', headers: current().client.getTraceHeaders(location.origin) })
    result = JSON.stringify(await response.json())
  }
</script>
<h1>SvelteKit integration proof</h1>
<button onclick={correlated}>Send correlated request</button>
<output id="request-identity">{result}</output>
