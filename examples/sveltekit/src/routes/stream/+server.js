export function GET() {
  let timeout
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first\n'))
        timeout = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('last\n'))
          controller.close()
        }, 20)
      },
      cancel() {
        clearTimeout(timeout)
      },
    }),
    { headers: { 'content-type': 'text/plain' } },
  )
}
