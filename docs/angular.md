# Angular adapters

The optional `@bussolabs/closeyourit-js/angular` entry observes an application's
existing ErrorHandler, successful router navigation and HttpClient subscriptions.
It never creates or closes the application's SDK client. Angular and RxJS remain
optional peer dependencies; importing the base SDK does not import either.

## Installation and ownership

Use one client per browser application and the browser-safe project public key.
Install before the operations you want to observe. Angular's official
`provideBrowserGlobalErrorListeners()` can forward browser errors to ErrorHandler;
`autoInstall: false` avoids installing a second generic network observer.

```ts
import { ErrorHandler, NgZone } from '@angular/core'
import { Router } from '@angular/router'
import { Client } from '@bussolabs/closeyourit-js'
import {
  instrumentAngularErrorHandler,
  instrumentAngularRouter,
} from '@bussolabs/closeyourit-js/angular'

const client = new Client({
  endpointUrl: configuration.endpointUrl,
  projectId: configuration.projectId,
  publicKey: configuration.publicKey,
  environment: 'production',
  autoInstall: false,
  captureRequest: false,
})
// app is the ApplicationRef returned by bootstrapApplication.
const options = { zone: app.injector.get(NgZone) }
const errors = instrumentAngularErrorHandler(
  app.injector.get(ErrorHandler),
  client,
  options,
)
const navigation = instrumentAngularRouter(app.injector.get(Router), client, options)
app.onDestroy(() => {
  errors.uninstall()
  navigation.uninstall()
  // The application decides when to flush/close its client.
})
```

This example starts observation after bootstrap; it does not capture bootstrap
failures. An application may install through its own initializer if it needs an
earlier boundary. Do not replace Angular's error policy with a generic console
fallback: the adapter calls the exact previous method with its original receiver,
argument, return value and thrown exception. Repeated installation with the same
handler/client/options is idempotent; conflicting ownership fails explicitly.
Uninstall restores only the method still owned by the adapter. An existing foreign
replacement is preserved, and stale wrapper references stop reporting.

Ordinary Error objects share the SDK's identity-based deduplication. An escaped
HttpErrorResponse is reported once through a cached, sanitized Error containing
only its bounded HTTP status. Its dynamic URL, response body and HTTP error stack
are excluded; the original object is still passed unchanged to the application.
This does not cover manually capturing the raw HttpErrorResponse through a separate
SDK call. Reporting failures never replace business exceptions.

## Router templates

Only successful NavigationEnd events create navigation breadcrumbs. Paths come
from the activated primary-outlet route configuration, including nested paths such
as `/teams/:team/items/:id`; parameter values, URL/query strings, fragment, route
data and component properties are not inspected. Cancelled/skipped navigation is
not reported. The adapter does not emit page views or capture every NavigationError.
Custom matchers without a declared path, cyclic/deeper-than-32 snapshots and paths
longer than 256 characters use `/unknown`. Named outlets are not modeled.

## HttpClient

```ts
import { HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http'
import {
  ANGULAR_HTTP_TEMPLATE,
  createAngularHttpInterceptor,
} from '@bussolabs/closeyourit-js/angular'

const httpTelemetry = createAngularHttpInterceptor(client)
// Include this provider in the application's existing HttpClient configuration.
const httpProvider = provideHttpClient(withInterceptors([httpTelemetry.interceptor]))
const context = new HttpContext().set(ANGULAR_HTTP_TEMPLATE, '/api/items/:id')
http.get(actualUrl, { context })
// Stop new observations; an already active subscription still finishes its metric.
httpTelemetry.uninstall()
```

Each subscription, including each retry attempt, produces a `slow_method` duration
when it exceeds the client's `slowMethodThresholdMs`. The label is
`angular.http METHOD /declared/template`. The template is explicitly supplied by
the application; never put a concrete URL, user identifier or secret into it.
Missing/invalid templates use `/unknown`. This is an HTTP subscription duration,
not an OTLP span or an Angular render/SSR duration.

With the existing opt-in `captureMethodArguments`, the metric also carries bounded
status and `success`, `error` or `cancelled` outcome. No request/response body,
arbitrary headers or query string is recorded. A handled RxJS HTTP error remains
an Observable error; it is not automatically promoted to an unhandled exception.
Responses, progress events, error objects, retry behavior and cancellation are
preserved. Unsubscribe finalizes the duration without manufacturing a response.

The existing `tracePropagationTargets` allowlist controls outgoing trace headers.
An existing request traceparent is preserved. Only traceparent/tracestate are added;
the adapter never adds baggage. Do not also enable generic fetch/XHR duration
monitoring for the same requests unless duplicate observations are intentional.

Pass `{ zone: app.injector.get(NgZone) }` when installing within a zone-based
application to perform reporting outside Angular's zone. The business handler,
Observable and router are not moved into a different execution context.

## Exact validation scope

Pinned builds and browser construction probes on Node 24.21.0:

- Angular 21.2.25, CLI/build 21.2.24, TypeScript 5.9.3, RxJS 7.8.2 and Zone.js 0.16.3.
- Angular 22.2.1, CLI/build 22.2.1, TypeScript 6.0.2 and RxJS 7.8.2, zoneless.

The Angular 21 proof has since moved to CLI/build 21.2.25 (piscina 5.3.2). Its
build is checked by `pnpm smoke:angular`, which CI runs only in the smoke job of
a release tag, not on pull requests. On 2026-10-09 that script built both proofs
from these lockfiles on Node 24.21.0 (Angular 21.2.25 with Zone.js, Angular 22.2.1
zoneless), against the published 0.14.2 SDK, SHA-256
`22bd16208ef0d0428eadbbbadad220ff5d4471d5458c83c6d7d8cb2e5417cacf`. The browser
probes below have not been rerun on it; the results below were recorded on
CLI/build 21.2.24.

Both production CLI builds ran in isolated consumers using an actual packed SDK.
Both browser probes constructed three errors and four duration metrics, preserved
retry/cancellation and restored the application handler after uninstall. Those
initial probes dropped all seven events in beforeSend and did not prove delivery.

The separate backend run `9660000000000001` passed **83/83 checks** on 2026-10-04.
It installed candidate SHA-256
`89d5655e8614b01166f7e1ac0a699f7adccb4f71aacd2de080327622d1f1381f`
and privately read exactly six errors and eight duration samples matching browser IDs.
Each tuple passed enabled, disabled and unreachable-endpoint phases. The latter
reported seven failed sends (four timeouts, three network failures), zero successful
sends and an operational application. Disabled mode constructed no events. Uninstall
restored the handler and preserved the application-owned client. Navigation templates,
retry, cancellation, real HTTP carrier and outcome metadata were verified.

All eight test credentials were revoked; 14 worker jobs finished without failures,
28 recorded commands exited zero, and source/artifact hashes remained stable.
An independent report audit passed 177 checks with no findings; it did not rerun
the database after cleanup. Report SHA-256:
`a6b8aa48d415cb775b901b791ffc90094b4cff2a05c7cf9de26781f59c88521d`.
Final review is covered by the user's standing approval; the package remains unpublished.

The core SDK's Node 20.16 minimum is not an Angular framework claim. Angular 21's
declared runtime range starts at Node 20.19; Angular 22 requires Node 22.22.3,
24.15 or 26 depending on its major line. Only Node 24.21 was exercised here.
SSR, hydration/event replay, request-scoped server instrumentation, other Angular
versions and other browser engines are not claimed by these tests. No registry
release or universal certification is implied.

Primary sources checked on 2026-10-04: [version compatibility](https://angular.dev/reference/versions),
[error handling](https://angular.dev/best-practices/error-handling),
[router lifecycle](https://angular.dev/guide/routing/lifecycle-and-events),
[HTTP interceptors](https://angular.dev/guide/http/interceptors),
[zoneless](https://angular.dev/guide/zoneless), [SSR](https://angular.dev/guide/ssr)
and [hydration](https://angular.dev/guide/hydration). Exact signatures and peer ranges
were additionally checked in the installed pinned official packages.
