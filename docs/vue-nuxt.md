# Vue and Nuxt adapters

CYRA-965 adds optional entries `@bussolabs/closeyourit-js/vue`, `/nuxt/client`
and `/nuxt/server`. The core package imports none of Vue, Nuxt or Nitro.
These are local candidate implementations, not a registry release. The application
injects and owns its Client; adapters never initialize or close it.

## Vue 3.5

```ts
import { createApp } from 'vue'
import { init } from '@bussolabs/closeyourit-js'
import { instrumentVue } from '@bussolabs/closeyourit-js/vue'

const app = createApp(App)
const client = init({ ...publicConfiguration, autoInstall: false })
app.config.errorHandler = applicationErrorHandler
const monitoring = instrumentVue(app, client)
app.mount('#app')
```

An existing `app.config.errorHandler` is required, or pass an explicit
`{ onUnhandledError: applicationErrorHandler }`. Vue's built-in development and
production defaults differ; the SDK does not guess the application's desired
throw/log policy. Missing policy is a configuration error before installation.
The wrapper preserves the previous handler's arguments, `this`, return and thrown
exception. Capture failure cannot replace that handler. Component props and
instances are never inspected. Only the framework's bounded error-source `info`
is added. These are errors escaping Vue component boundaries, marked unhandled.

Repeated installation with the same app/client/policy is idempotent. A conflicting
client/policy or a subsequently replaced handler requires explicit uninstall before
reinstallation. `monitoring.uninstall()` restores the original handler only when
the wrapper still owns that slot, preserving a later foreign replacement. Vue's
`app.onUnmount` also invokes uninstall. The application closes its client separately.

## Nuxt client plugin

Use this adapter instead of wrapping Nuxt's own Vue error handler:

```ts
// app/plugins/monitoring.client.ts (srcDir: 'app' in the Nuxt 3 fixture)
import { init } from '@bussolabs/closeyourit-js'
import { instrumentNuxtClient } from '@bussolabs/closeyourit-js/nuxt/client'

export default defineNuxtPlugin((app) => {
  const config = useRuntimeConfig()
  const client = init({
    endpointUrl: config.public.monitoringEndpoint,
    projectId: config.public.monitoringProject,
    publicKey: config.public.monitoringPublicKey,
    environment: config.public.applicationEnvironment,
    release: config.public.applicationVersion,
    autoInstall: false,
  })
  const monitoring = instrumentNuxtClient(app.hooks, client, useRouter())
  app.vueApp.onUnmount(monitoring.uninstall)
})
```

Only the public DSN key belongs in browser configuration, never a bearer token.
The adapter observes official `vue:error` and `app:error` hooks without changing
Nuxt's fallback or error handler. Use the same Client for any additional global
capture: the SDK deduplicates the same Error object, plus its existing five-second
fingerprint window. Nuxt/H3 errors with integer status codes 300–499 are expected
responses and excluded. Other failures are marked unhandled; `contexts.nuxt`
identifies client/Nitro origin.

Successful router navigations append bounded **breadcrumbs**, not page-view events.
Only the matched route template is retained; route parameters, query, hash, route
names, component props and bodies are not read. Failed/duplicate navigations are
ignored. The optional router can be omitted. Uninstall removes only the adapter's
own hooks and router callback; it never alters navigation or closes the Client.

## Nitro 2 Node plugin and request wrapper

The tested Nuxt versions use Nitro 2.13.4/H3 1.15.11. The newest standalone Nitro
documentation describes a different H3 API; those hooks are not interchangeable.
This entry is **Node-only**, not Edge or a browser plugin.

```ts
// server/utils/monitoring.ts
import { getClient, init } from '@bussolabs/closeyourit-js'
import { createNitroInstrumentation } from '@bussolabs/closeyourit-js/nuxt/server'

export const client =
  getClient() ??
  init({
    endpointUrl: process.env.CLOSEYOURIT_ENDPOINT_URL,
    token: process.env.CLOSEYOURIT_TOKEN,
    projectId: process.env.CLOSEYOURIT_PROJECT_ID,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    autoInstall: false,
  })
export const monitoring = createNitroInstrumentation(client)
```

```ts
// server/plugins/monitoring.ts
import { monitoring } from '../utils/monitoring'
export default defineNitroPlugin((app) => monitoring.install(app.hooks))
```

Initialize lazily at server runtime, never with credentials in build configuration.
The fixture declares `nitro.externals.external: ['@bussolabs/closeyourit-js']` so
separate framework entries resolve the same Client and adapter. Repeat factory
calls for the same Client return that adapter. `install` returns an unregister
function; `uninstall` disables all its installed hooks and future wrappers, without
cancelling in-flight application work. A new factory call can then reinstall.

```ts
// server/api/items/[id].ts
import { monitoring } from '../../utils/monitoring'
export default defineEventHandler((event) =>
  monitoring.withRequest(event, '/api/items/:id', () => applicationHandler(event)),
)
```

Provide a static route template explicitly. Invalid templates become `/unknown`;
the adapter never derives one from a request URL. Request hooks establish a fresh
scope associated with the exact H3 event in a WeakMap. `withRequest` enters that
scope through Node AsyncLocalStorage and measures **handler completion**, including
failure. The error hook can re-enter the same scope outside the original async
context. Event keys are weak: no registry retains completed request objects.
Only valid bounded `traceparent` is adopted, not baggage, cookies, authorization,
arbitrary headers or request bodies.

The `request` hook by itself does **not** surround downstream application execution.
Use `withRequest` for logs, outgoing request correlation and custom scope in server
handlers. Unwrapped SSR failures still receive an isolated error scope with
`/unknown`; there is no automatic whole-render duration. To forward Vue SSR errors
that Nuxt handles internally, the fixture uses an additional server Nuxt plugin:

```ts
export default defineNuxtPlugin((app) => {
  app.hook('vue:error', (error) => {
    app.ssrContext?.event.captureError(error, { tags: ['vue'] })
  })
})
```

Responses and streams pass through untouched, with no body read/buffering.
Async work created inside a wrapped handler retains scope, but duration ends when
the handler returns, not when its stream completes. Application cancellation and
response status are preserved. No automatic HTTP client patch or OTLP spans are
introduced. Explicit browser requests can use `client.getTraceHeaders(target)` for
allowed destinations; browser and server errors remain separate events.

## Reproducible scope and current limits

`pnpm smoke:nuxt` installs the packed SDK outside the checkout, uses frozen fixture
locks, builds production Nuxt applications and starts owned loopback servers.
`SMOKE_PACKAGE_ARTIFACT` plus `SMOKE_PACKAGE_SHA256` reuses an immutable candidate.
Construction profiles drop events in `beforeSend`; a separate real refused-loopback
transport checks failure diagnostics without pretending to be backend delivery.

Observed construction and backend/browser tuples: Vue 3.5.43 with Nuxt 3.21.11/Vue Router 4.6.4 and
Nuxt 4.5.2/Vue Router 5.3.1, on Node 24.21.0. The actual Vue renderer/router unit
profiles use Vue 3.5.43 and Router 4.6.4. Nuxt 3's upstream Node requirement is
`^20.19.0 || >=22.12.0`; Nuxt 4's is `^22.19.0 || ^24.11.0 || >=26.0.0`.
Those lower framework runtimes are requirements, not observed test tuples.
The core SDK's Node 20.16 minimum is unchanged and does not override framework engines.

Real construction checks cover three concurrent error/log/duration traces,
one SSR failure, disabled collection, uninstall, unchanged stream bytes and an
unavailable transport. The separate coordinated backend/browser run
`9650000000000003` passed **106/106** assertions: 10 errors, 10 duration metrics
and 12 logs persisted through actual SDK HTTP transport and were read back through
authenticated Rails APIs. It also checked browser navigation/error correlation,
source maps against an independent Node oracle, tenant isolation and unchanged
application behavior. The pinned router generators emit `/items/:id()`; the
private parameter and query values are excluded. Eight temporary credentials were
revoked and cleanup completed without failures.

Standalone `instrumentVue` has its own production browser/backend proof,
`9650000000000005`: **34/34** assertions on Vue 3.5.43/Vite 8.3.2/Node 24.21.0.
Zero/one/two/three observations matched exactly three persisted errors. The existing
application handler still received every error; uninstall restored it and a fourth
application error produced no fourth telemetry event. Disabled collection emitted
nothing. With an unavailable endpoint, three attempted sends produced one timeout
and two network failures, no deliveries, and the application remained usable.
All eight temporary credentials were revoked; cleanup had no failures. Browser
evidence reports the observed reduced Chrome user agent `152.0.0.0`, not a full
browser patch-version matrix.

Both proofs consumed the same unpublished SDK 0.11.4 archive, SHA-256
`85413d6ffeb7d71526acaaaf5e0fc8fcfe137beec9d52e2ba4427f7bdb45de5e`.
The final Nuxt report SHA-256 is
`99f57d0854733a950ca99a78c04ed2c1388cec62cdd54c223076ea608f8f7b34`;
the standalone Vue report is
`4ff9d794a6f5815199628f3dbaa3e0872000635f59af77c8f6199d354db3ed1f`.
Earlier failed attempts remain separate: the Nuxt harness initially expected a
different template spelling; Rails rejected equivalent duplicate compiler-map
positions; the Vue harness initially excluded valid timeout diagnostics. Those
corrections did not rebuild or modify the SDK archive. This is local implementation
evidence approved on 2026-10-04, not publication or universal certification.

No registry release, every Vue/Nuxt combination, Nitro 3, Edge, automatic whole-SSR
instrumentation, stream-completion duration or standalone page-view delivery is claimed.

Primary sources checked on 2026-10-04:

- [Vue application errorHandler and onUnmount](https://vuejs.org/api/application.html)
- [Nuxt 4 error handling](https://nuxt.com/docs/4.x/getting-started/error-handling)
- [Nuxt runtime hooks](https://nuxt.com/docs/4.x/api/advanced/hooks)
- [Nitro 2 plugins](https://v2.nitro.build/guide/plugins)
- Registry source archives: Nuxt 3.21.11, Nuxt 4.5.2, Vue 3.5.43,
  `@nuxt/nitro-server` 3.21.11/4.5.2 and Nitro 2.13.4. The pinned Nitro
  `dist/runtime/internal/app.mjs` confirms request/error hook dispatch and lifetime.
