# Svelte and SvelteKit adapters

These optional entries observe an application's chosen error policy and request lifecycle. They do not install themselves, own the injected Client, or change responses. The base SDK does not import Svelte or SvelteKit.

## Observed local profiles

| Profile         | Exact framework/build tuple                                                               | Runtime                              |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| Svelte boundary | Svelte 5.57.1, Vite 8.3.2, plugin 7.3.1                                                   | Node 24.21.0 build; Chromium browser |
| SvelteKit 2     | Kit 2.70.3, Svelte 5.57.1, adapter-node 5.5.7, Vite 7.3.6, plugin 6.2.4, TypeScript 6.0.3 | Node 24.21.0                         |
| SvelteKit 3     | Kit 3.0.0, Svelte 5.57.1, adapter-node 6.0.0, Vite 8.3.2, plugin 7.3.1, TypeScript 6.0.3  | Node 24.21.0                         |

These are local unpublished candidate observations, not a registry release or a claim for all compatible peer versions. Kit 3 requires Node >=22.17; the selected Kit 2 build tools require Node 20.19 or an admitted newer branch. The SDK's own Node 20.16 minimum does not imply framework support on that runtime. Svelte 4, edge runtimes, other adapters and remote functions are not included.

Local production builds and packaged type checks passed for both Kit versions. Real adapter-node requests exercised three concurrent errors with separate trace identities, request logs and handler-duration metrics, an SSR error, a correlated deferred error, expected errors, redirects, streamed bytes, disabled/uninstalled modes and an unavailable collector. Real `event.fetch` calls reached a separate loopback HTTP server and preserved POST bodies, application headers, an existing traceparent and cancellation; new propagation was restricted to the allowed destination. These construction runs dropped payloads in `beforeSend`; the outage run used a refused loopback port. Browser construction separately exercised standalone Svelte boundary recovery/uninstall and Kit navigation, a correlated POST and client-load fallback. Backend persistence/readback is a separate pending proof.

## Svelte boundary

Svelte's boundary catches rendering and effect errors. Event handlers, timers and other asynchronous work outside rendering are different surfaces; this helper does not make the boundary catch them. Pass an explicit application callback so its reset/error policy is preserved:

```svelte
<script>
  import { createSvelteBoundaryHandler } from '@bussolabs/closeyourit-js/svelte'
  import { onDestroy } from 'svelte'

  const monitoring = createSvelteBoundaryHandler(client, (error, reset) => {
    applicationErrorHandler(error, reset)
  })
  onDestroy(monitoring.uninstall)
</script>

<svelte:boundary onerror={monitoring.onError}>
  <ApplicationContent />
  {#snippet failed(error, reset)}
    <button onclick={reset}>Try again</button>
  {/snippet}
</svelte:boundary>
```

The original arguments, receiver, return value and thrown exception are preserved. Boundary captures have `mechanism.handled: true` and `contexts.svelte.phase: boundary`. Uninstall stops reporting and still invokes the application's callback. It does not close the Client.

## SvelteKit server

Create one factory for the app-owned Client and use it in the server hook module. Keep the bearer token exclusively in server runtime configuration. Do not initialize during prerender/build. Kit 3 imports `building` from `$app/env`; Kit 2 uses `$app/environment`.

```ts
// hooks.server.ts, Kit 3
import { building } from '$app/env'
import type { Handle, HandleServerError, HandleFetch } from '@sveltejs/kit/hooks'
import { createSvelteKitServer } from '@bussolabs/closeyourit-js/sveltekit/server'

const monitoring = createSvelteKitServer(client, { version: 3 })
const observed = monitoring.wrapHandle<Parameters<Handle>[0]>(({ event, resolve }) =>
  resolve(event),
)
export const handle: Handle = (input) =>
  building ? input.resolve(input.event) : observed(input)

export const handleError: HandleServerError =
  monitoring.wrapHandleError(applicationHandleError)
export const handleFetch: HandleFetch = monitoring.wrapHandleFetch(
  async ({ request, fetch }) => fetch(request),
)
```

For Kit 2 use `version: 2` and import the hook types from `@sveltejs/kit`. Wrap an existing `handle` instead of replacing it, including its `resolve` options. Reporting never invokes business work twice if instrumentation fails. The adapter observes completion of `handle`, producing `slow_method` with a route-template label and the configured release. It returns the same Response and does not read, clone or buffer its body. This metric is **handler duration**, not full response-stream duration.

The Node scope is distinct per Web Request, including concurrent requests without an incoming carrier. A WeakMap retains the scope snapshot by Request identity because SvelteKit copies event objects. On the exact profiles above, the official error hook reused that Request for both normal and deferred errors, preserving correlation after the initial handler returned. No URL/time heuristic is used. Request context contains only bounded method and `event.route.id`; parameters, query, cookies, body and event locals are never copied.

Only incoming `traceparent` is continued. `handleFetch` adds traceparent only to an allowed destination and only if the application has not set one. Existing headers, request body, credentials and cancellation signal remain under application control. It does not add baggage or vendor tracestate. Configure `tracePropagationTargets` explicitly for server destinations.

### Different error contracts

Kit 2 passes `status` and only invokes `handleError` for unexpected errors; this adapter reports statuses 500–599. Kit 3 passes `kind`; only `unknown` is reported. `app`, `framework` and `validation` are excluded, including validation issues and arbitrary expected-error data. Redirect control flow is left to the framework. Error captures from these hooks are `handled: false`, with `contexts.sveltekit.runtime`, `phase` and route template.

An application's handler still receives its original input and returns its original value, including custom status/message fields. The wrapper contains reporting faults but does not hide faults thrown by the application's handler. Follow SvelteKit's requirement that the application's `handleError` itself should not throw.

The existing SDK deduplicates the same Error object and identical type/message/top-frame bursts within five seconds. These adapters do not add a message-based registry or change that shared policy. Different request contexts do not disable the existing burst suppression.

## SvelteKit browser

Create an app-owned browser Client with a public DSN key, never a server bearer. Use the matching Kit major version:

```ts
import { createSvelteKitClient } from '@bussolabs/closeyourit-js/sveltekit/client'
export const monitoring = createSvelteKitClient(client, { version: 3 })
export const handleError = monitoring.wrapHandleError(applicationHandleError)
```

Register navigation during a layout component's initialization:

```svelte
<script>
  import { afterNavigate } from '$app/navigation'
  afterNavigate(monitoring.afterNavigate)
</script>
```

SvelteKit removes that lifecycle subscription when the component is destroyed. The adapter records only bounded `from.route.id`/`to.route.id` as navigation breadcrumbs; missing or invalid routes become `/unknown`. It does not install a history patch or claim pageview collection. Use existing `client.getTraceHeaders(target)` for an explicitly correlated browser request. Do not spread headers into an untrusted destination.

## Lifecycle, privacy and verification

`uninstall()` is idempotent and stops new observations; in-flight requests already being measured may complete. No hook replaces the application's singleton Client or closes a Client it does not own. The application can flush/close its owned Client at shutdown; adapter-node documents an asynchronous `sveltekit:shutdown` event. Request bodies, cookies, query values and validation issues must not be copied into manual contexts by application code.

The fixtures in `examples/sveltekit` and `examples/sveltekit2` use production adapter-node output behind a small owned loopback HTTP server. Both pinned adapters assume HTTPS unless a trusted protocol header/origin is configured; the fixture overwrites its private protocol header with `http` and keeps SvelteKit's CSRF check active. This laboratory server is not production proxy configuration.

Run `pnpm smoke:sveltekit` after building the package. It installs an immutable tarball into isolated consumers, compiles standalone Svelte and both Kit applications, type-checks their official hook contracts and runs real Node requests. `SMOKE_PACKAGE_ARTIFACT` plus `SMOKE_PACKAGE_SHA256` uses an existing candidate; `SMOKE_KEEP_WORKSPACE=1` retains its compiled proof apps. No backend delivery is claimed by this script. Unit tests also compile and mount a real Svelte boundary and exercise real SDK scope/capture behavior.

Kit 3 can apply source maps to stacks itself. Inspect the actual raw frame and build artifact before claiming a backend map lookup; an already-mapped framework frame is not proof of a CLI-uploaded source map.

Primary references: [Svelte boundaries](https://svelte.dev/docs/svelte/svelte-boundary), [Kit hooks](https://svelte.dev/docs/kit/hooks), [navigation](https://svelte.dev/docs/kit/$app-navigation), [streaming](https://svelte.dev/docs/kit/load#Streaming-with-promises), [Kit 3 migration](https://svelte.dev/docs/kit/migrating-to-sveltekit-3), [Node shutdown](https://svelte.dev/docs/kit/adapter-node#Graceful-shutdown). Exact registry package metadata and source inspection were verified on 2026-10-04.
