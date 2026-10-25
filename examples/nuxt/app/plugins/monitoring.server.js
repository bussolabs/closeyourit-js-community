export default defineNuxtPlugin((app) => {
  app.hook('vue:error', (error) => {
    app.ssrContext?.event.captureError(error, { tags: ['vue'] })
  })
})
