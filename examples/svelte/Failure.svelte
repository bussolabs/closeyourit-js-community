<script>
  let { failure } = $props()
  function render(value) { if (value > 0) throw new Error(`Svelte render failure ${value}`); return 'Application content' }
</script>
<p>{render(failure)}</p>
