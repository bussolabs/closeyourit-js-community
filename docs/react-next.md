# React and Next.js adapters

These optional entry points are local candidate implementation work for CYRA-964.
They are not evidence of a new registry release. The core package does not import
React or Next.js at runtime. Install React separately in applications that import
`@bussolabs/closeyourit-js/react`.

## React

```tsx
import { createRoot } from 'react-dom/client'
import { init } from '@bussolabs/closeyourit-js'
import {
  ErrorBoundary,
  createReactErrorHandlers,
} from '@bussolabs/closeyourit-js/react'

const client = init({
  endpointUrl: publicConfiguration.endpointUrl,
  publicKey: publicConfiguration.publicKey,
  projectId: publicConfiguration.projectId,
  environment: 'production',
  release: applicationVersion,
})

// React 19 only: optional root callbacks also cover errors outside a boundary.
const root = createRoot(container, createReactErrorHandlers(client))
root.render(
  <ErrorBoundary client={client} fallback={<ApplicationFallback />}>
    <App />
  </ErrorBoundary>,
)
```

The boundary works with React 18.3.1 and React 19. It captures handled render
errors and preserves the application's fallback and optional `onError` callback.
Changing the boundary's React `key` resets its failed state. The adapter does not
catch event-handler errors or asynchronous work started outside React rendering.
Existing SDK global handlers can capture those failures.

Pass the **same Client** to global handlers, the boundary and React 19 callbacks:
the SDK deduplicates the same Error object. Its existing five-second fingerprint
window also suppresses separate identical errors. Recoverable hydration errors
are opt-in with `createReactErrorHandlers(client, { captureRecoverableErrors: true })`.
The component stack is bounded to 8,192 characters and passes through the SDK's
existing privacy pipeline. Unmounting a boundary never closes an application-owned
client. Remove the boundary/root callbacks to uninstall the adapter; the
application decides when to call SDK `close()`.

Never provide a bearer token to browser code or a public Next environment variable.
Only the project's public DSN key may be included in browser configuration.

## Next.js Node runtime

Use Next 15 or newer for the official `onRequestError` hook. This adapter does not
support the Edge runtime. It uses AsyncLocalStorage on Node 20.16 or newer.

Externalize the SDK so instrumentation and independently bundled route entry
points resolve the **same Node module and Client**:

```js
// next.config.mjs
export default {
  serverExternalPackages: ['@bussolabs/closeyourit-js'],
}
```

Initialize lazily from runtime instrumentation, not from build-time configuration.
The application owns this one client. `getClient()` only returns the existing
facade client; it never creates or replaces one and returns null after facade close.
It is not a liveness check: calling `client.close()` directly does not clear that
facade reference. For a client created by `init`, use the package's `close()` at
application shutdown. A client constructed with `new Client` remains entirely
application-owned and is not registered with this accessor.

```ts
// monitoring.server.ts, imported only by Node instrumentation/routes
import { getClient, init } from '@bussolabs/closeyourit-js'
import { createNextInstrumentation } from '@bussolabs/closeyourit-js/next/server'

const client =
  getClient() ??
  init({
    endpointUrl: process.env.CLOSEYOURIT_ENDPOINT_URL,
    token: process.env.CLOSEYOURIT_TOKEN,
    projectId: process.env.CLOSEYOURIT_PROJECT_ID,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    autoInstall: false,
  })
export const monitoring = createNextInstrumentation(client)
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./monitoring.server')
}

export async function onRequestError(error, request, context) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { monitoring } = await import('./monitoring.server')
  await monitoring.onRequestError(error, request, context)
}
```

The hook covers failures Next reports from App Router rendering, route handlers,
server actions and Pages Router. It captures an unhandled error in a fresh scope
and flushes its client because Next awaits this hook. Redirect/not-found/access
control digests are excluded; the adapter never consumes their control flow.
Do not capture the same server failure again from `error.tsx`: production Next
may expose only a sanitized Error and digest there.

Wrap Node handlers to isolate application context and measure their completion:

```ts
export async function GET(request: Request) {
  const { monitoring } = await import('../../../monitoring.server')
  return monitoring.withRequest(
    request,
    {
      routerKind: 'App Router',
      routePath: '/api/items/[id]',
      routeType: 'route',
    },
    async () => applicationHandler(request),
  )
}
```

Use a static route template, never the incoming URL. The wrapper retains only the
HTTP method, route template, router/type and valid W3C `traceparent`. It does not
read request bodies, cookies, authorization, arbitrary headers, query strings or
baggage. Existing SDK scrubbing and `beforeSend` still apply. Release identifiers
must be version identifiers free of personal data; the existing credential
scrubber also applies to the new duration release field.

`withRequest` invokes the application exactly once and preserves its result or
exception. It returns streaming responses untouched, without reading/buffering
their bodies. The `slow_method` duration ends when the handler resolves, **not when
the stream finishes**. Request context remains available to async work created
inside the scope, including deferred stream work. Cancellation behavior belongs
to the application and is unchanged. There is no automatic stream-completion metric.

When Next reports a wrapped failure outside the original async context, the adapter
can recover that request's trace from the original Error object's identity or a
bounded cause chain (10 objects). WeakMap entries do not retain errors. Reusing
one Error object across requests makes that identity ambiguous and disables this
recovery. There is no correlation by URL, error text, timestamp or digest. A new
unrelated Error reported without a trace carrier cannot be correlated safely.
For browser/server propagation, use the same browser client and its
`getTraceHeaders(target)` on explicitly allowed destinations. Browser error events
remain distinct from server events even when they share a trace.

Factories called again with the same Client return the same adapter. `uninstall()`
disables its new hooks without closing the Client, replacing global handlers or
cancelling in-flight application work. A subsequent factory call creates a new
active adapter. Stop app traffic before final application-owned flush/close.

## Evidence and reproducibility

`pnpm build`, `pnpm smoke` and `pnpm smoke:frameworks` consume packed SDK artifacts
outside the checkout. The framework smoke uses frozen fixture dependency locks,
real production Next builds and owned loopback servers. It verifies disabled-host
behavior, independent concurrent traces, Error/duration identity and release, and
React 18 boundary rendering and package declaration resolution. Its construction
profile drops events in `beforeSend`; **it does not verify backend delivery**.

Exact tuples are intentionally separate: React 18.3.1's test renderer;
React 19.3.0's DOM renderer; Next 15.5.27 + React 19.3.0; Next 16.3.8 + React 19.3.0.
They do not imply every React/Next combination. Next 16's fixture explicitly uses
Webpack; Turbopack is not covered by this proof. CI consumes on Node 20.16.0 and
24.21.0 while the build toolchain remains Node 24.21.0. The fixture browser page is
a technical test surface, not product UI.

The separate end-to-end run `9640000000000001` passed **126/126 assertions** on
2026-10-04, 13:40:18–13:47:42 UTC. Both Next tuples above ran on Node 24.21.0 with
Chrome 152.0.7977.54. Real browser/server HTTP, Solid Queue processing and private
Rails readback confirmed 14 errors, 16 duration metrics and 10 logs, with no failed
jobs. The proof includes concurrent error/duration correlation, browser propagation,
SSR/Pages/server-action failures, handled browser fallback, explicit CLI source-map
upload and resolution, tenant isolation, disabled telemetry and an unavailable
backend. All eight temporary credentials were revoked; cleanup completed.

This used the local SDK candidate `0.11.4`, SHA-256
`610cb4c8f0bd231b4c62f89adda88d33a3bdbf9674b88db0a7d071fdb3f3f0b1`,
against Rails source `45b800017d548013f4b55dd4b3c151006782ca34` (clean at observation).
The immutable report is `/tmp/cyi-next-9640000000000001/report.json`, SHA-256
`04c7ad23d5172de6abe1f2e25b2e35550583a51307305ff66794824e17c240c4`.
Its claim remains `implemented`: this does not attest registry publication or a
reproducible build. Native errors/logs/duration metrics are covered, not OTLP
distributed span storage, Edge, Turbopack or stream-completion duration.

Source maps remain an explicit separate upload through the CLI's source-map
artifact workflow. The observed application map was uploaded and resolved in this
run; merely including a map in the SDK package does not establish that result for
another application's release.

Primary API references checked for these pins:

- [React Component / componentDidCatch](https://react.dev/reference/react/Component#componentdidcatch)
- [React createRoot callbacks](https://react.dev/reference/react-dom/client/createRoot)
- [Next instrumentation and onRequestError](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)
- [Next serverExternalPackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
- [Next unstable_rethrow and control flow](https://nextjs.org/docs/app/api-reference/functions/unstable_rethrow)
