export function load() {
  return {
    later: new Promise((resolve) => setTimeout(() => resolve('Deferred content'), 20)),
  }
}
