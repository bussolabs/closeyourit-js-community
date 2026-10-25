<script>let { data } = $props()</script>
<h1>Initial content</h1>
{#await data.later}<p>Waiting</p>{:then value}<p>{value}</p>{:catch}<p>Deferred fallback</p>{/await}
