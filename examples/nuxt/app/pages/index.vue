<script setup>
const failed = ref(false)
const result = ref('')
const app = useNuxtApp()
async function correlated() {
  const response = await fetch('/api/work/ok', {
    headers: app.$proof.client.getTraceHeaders(location.origin),
  })
  result.value = JSON.stringify(await response.json())
}
function fail() {
  failed.value = true
  throw new Error('Nuxt browser failure')
}
async function inspect() {
  await app.$proof.client.flush()
  result.value = JSON.stringify(app.$proof.observations)
}
</script>
<template>
  <main>
    <h1>Nuxt integration proof</h1>
    <NuxtLink to="/items/private-value?private=query">Navigate to item</NuxtLink>
    <button @click="correlated">Send correlated request</button>
    <button @click="fail">Fail browser event</button>
    <button @click="inspect">Read event identity</button>
    <p v-if="failed">Application remains usable</p>
    <output>{{ result }}</output>
  </main>
</template>
