export async function load() {
  // Keep real handler work above the configured 1 ms reporting threshold.
  await new Promise((resolve) => setTimeout(resolve, 8))
  return {
    later: new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SvelteKit deferred failure')), 20),
    ),
  }
}
