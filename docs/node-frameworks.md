# Express, Fastify and Nest HTTP monitoring

These optional entries accept an existing CloseYourIt `Client` and an
application-owned OpenTelemetry tracer. They do not install process listeners,
replace global providers, register a context manager, close clients, or patch HTTP.
The default browser entry does not import these frameworks or OpenTelemetry.

## Observed package profiles

The local consumer pins Express **5.2.1**, Fastify **5.12.5**, and Nest **12.1.2**
with each of those HTTP adapters, RxJS **7.8.2**, OpenTelemetry API **1.9.1** and
Node SDK **2.11.0**. The framework proof runs on Node **24.21.0**. The SDK's
Node 20.16 minimum is not a claim that every optional framework profile runs there.
The local candidate passed real backend persistence checks described below. This is
implementation evidence for these exact tuples, not a registry release or a
universal certification. The candidate retains package version `0.12.0`, but its
Node adapter code is newer than the published `0.12.0` artifact; identify it by digest.

The published npm `0.12.0` package does **not** expose these Node adapters.
Until a later release includes them, install the verified local archive explicitly:

```sh
npm install /absolute/path/to/candidate-merged/bussolabs-closeyourit-js-0.12.0.tgz
```

Check the archive digest against the evidence below; its filename alone cannot
distinguish it from the older published version. Registry support is not claimed
before the planned `0.13.0` release actually succeeds.

Install only the peers needed by your chosen entry. Express/Fastify require
`@opentelemetry/api`; Nest additionally requires `@nestjs/common` and `rxjs`.
The application chooses its provider, exporter, resource metadata and shutdown.
For third-party instrumentation to see the active span, the application also
registers its OpenTelemetry context manager. The adapter's own native scope and
explicit fetch propagation do not depend on a global registration.

## Express

```ts
import { createExpressMonitoring } from '@bussolabs/closeyourit-js/express'

const monitoring = createExpressMonitoring(client, {
  tracer: provider.getTracer('application'),
  propagationTargets: ['https://internal.example.test:443'],
})
app.use(monitoring.middleware) // Before the observed routes.
app.get('/orders/:id', orderHandler)
app.use(monitoring.wrapErrorHandler(applicationErrorHandler))
```

`wrapErrorHandler` preserves the original error, receiver, return value and response
policy and marks the captured error handled. Alternatively, put `monitoring.errors`
before your error handler to observe unhandled errors and pass the same error to
`next`. Choose one surface: if both see the same error, the first capture wins.
Express 5 already forwards rejected route promises; no second promise wrapper is
installed. Existing `headersSent` handling remains the application's responsibility.

Only the registered leaf `request.route.path` is collected. A mounted router's
dynamic `baseUrl` is not copied. Before routing, or without a safe string template,
the span uses `/unknown`; an error observer and response completion update it once
the route is available. An explicit application log emitted earlier can still have
the initial route metadata.

## Fastify

```ts
import { createFastifyMonitoring } from '@bussolabs/closeyourit-js/fastify'

const monitoring = createFastifyMonitoring(client, { tracer })
app.register(async (scope) => {
  monitoring.install(scope) // Before routes, ready or listen.
  scope.get('/orders/:id', orderHandler)
})
```

The `onRequest` and `onError` hooks follow Fastify encapsulation. They never call
`reply.send`, replace the error handler, or mix callback and async hook styles.
Repeated installation on the same instance is ignored. Uninstall makes the
registered hooks inert; Fastify does not offer a public hook removal API.

## Nest with Express or Fastify

Create the corresponding HTTP monitor above and install it before Nest initializes
its routes. Pass `httpMonitoring.context` to `createNestMonitoring` from
`@bussolabs/closeyourit-js/nest`, then register its `interceptor` with
`app.useGlobalInterceptors`. Wrap your selected exception filter with
`nestMonitoring.wrapFilter(applicationFilter)` before registering it.

The interceptor preserves the cold Observable, subscribes once, forwards each value,
completion and original error, and returns the actual subscription for teardown.
The filter wrapper delegates catch, accessors and methods to the original instance
and preserves constructor metadata. The wrapper has a separate object identity;
this is not a promise of universal proxy/reflection transparency. Frozen filters
and own read-only methods are supported through a separate forwarding target;
own-property enumeration and descriptors describe the wrapper, not the filter. The
same error observed by both paths is captured once. Interceptor errors are marked
unhandled; an error first observed by the chosen filter is marked handled.

Guards execute before interceptors, so their errors require the wrapped filter.
A route/controller filter that handles an error first cannot be observed by a global
filter. Wrap that chosen filter explicitly if needed. RPC, WebSocket and GraphQL
execution contexts are outside this HTTP profile. The adapter does not add an HTTP
disconnect-to-Observable cancellation policy that Nest itself does not provide.

## Spans, propagation and privacy

`spanMode` is `create` by default and requires a tracer. It creates a SERVER span
from an incoming valid W3C `traceparent`, correlates native error/log trace IDs, and
ends the span exactly once at response finish or close. Streaming bytes are not
read, buffered or rewritten. A close before completion records `response_closed`.
Already started spans finish even after uninstall; new requests are unobserved.

With pre-existing HTTP auto-instrumentation, choose `spanMode: 'existing'` to reuse
its active span without renaming or ending it; application context keys remain intact. Choose `none` for native signals
only. These explicit ownership modes avoid creating duplicate SERVER spans.

`monitoring.fetch` is an explicit wrapper around the real global fetch. It creates
a CLIENT span only for an allowed exact origin, using the application's active
child span when present (otherwise the request span), and injects that span's actual
identity only when `traceparent` is absent and the effective Request redirect mode
is `manual` or `error`. The default `follow` mode still follows redirects with the
application's original semantics, but adds no carrier, so downstream correlation
is not automatic. This prevents an automatic redirect from forwarding an SDK
carrier outside the exact-origin allowlist. Choose `redirect: 'error'` only for
application calls that must reject redirects; `manual` returns the redirect response
for application handling. The adapter never changes that policy. Existing headers/carriers remain
unchanged, and a disallowed origin is passed through without constructing or
consuming a new Request. Cancellation and errors propagate unchanged. CLIENT
duration ends when response headers arrive, not when its body is consumed.

The adapter records only method, a static route template, response status and
allowed destination host/port. It does not collect request/response bodies, URL
query values, cookies, authorization, baggage or tracestate. Application-provided
span attributes, exporter resources and explicit log fields remain the application's
responsibility. Expected 4xx errors are excluded by default; the explicit
`captureExpectedErrors` option captures a stable `HTTP <status>` message without
validation details. Native SDK error deduplication still applies.

Call each adapter's `uninstall()`, drain/close the application's HTTP server, then
close the application-owned `client` and tracer provider. Neither uninstall closes another component's resources.

## Reproducible local evidence

`pnpm test` explicitly limits Vitest to two workers. The shared CI hosts run eight
runners; unbounded local concurrency delayed an unrelated Next timer beyond its
200 ms slow-method threshold and changed that test's observed signal count.
No Next assertions or timing thresholds were weakened. The standard command now
uses the same resource limit as the successful full-suite run.

`pnpm smoke:node-frameworks` installs the packed SDK outside the checkout and runs
all four real framework profiles in enabled, disabled, uninstalled and refused-transport modes.
It exercises concurrent POST requests, a two-level error, streamed responses,
loopback CLIENT/SERVER propagation, original responses, and Nest subscription
teardown. It verifies zero initial observations and exact producer identities/counts.
This smoke uses `beforeSend` dropping and an in-memory span observer; its report
identifies construction-only phases separately from refused real HTTP exports, and
keeps `delivery_verified: false`. The outage phase requires all native events and
all span exports to fail visibly while business responses stay unchanged.
The consumer also supports real native and OTLP exporters for the separately
coordinated Rails proof. Credentials are provided only through the child process
environment, and `/proof-status` exposes bounded public identities, never tokens.

## Backend evidence and coverage matrix

Local run `9680000000000201` on **2026-10-04, 21:43:38–21:54:56 UTC** passed
**68 assertions** across sixteen real processes: enabled, disabled, uninstalled
and unavailable transport for each profile. Installed SDK files were compared
byte-for-byte with the candidate archive before use; the fixture lock, installed
packages, backend and harness sources remained unchanged throughout the run.

| Profile        | Exact version   | Persisted enabled signals          | Other observed modes                                     |
| -------------- | --------------- | ---------------------------------- | -------------------------------------------------------- |
| Express        | 5.2.1           | 1 error, 3 logs, 7 spans, 5 traces | Disabled: zero; uninstalled: 3 logs; outage: zero stored |
| Fastify        | 5.12.5          | 1 error, 3 logs, 7 spans, 5 traces | Disabled: zero; uninstalled: 3 logs; outage: zero stored |
| Nest / Express | 12.1.2 / 5.2.1  | 1 error, 3 logs, 7 spans, 5 traces | Disabled: zero; uninstalled: 3 logs; outage: zero stored |
| Nest / Fastify | 12.1.2 / 5.12.5 | 1 error, 3 logs, 7 spans, 5 traces | Disabled: zero; uninstalled: 3 logs; outage: zero stored |

Authenticated reads recovered exactly **4 errors, 24 logs, 28 spans and 20 traces**,
with no native metrics or OTLP series. Checks compared event/span identities,
parents, nanosecond timestamps, status, environment, release and resource service;
errors retained both causes and their stack frames. Each concurrent request had
its own trace. Uninstall leaves the application's Client active: the three explicit
logs retain its base trace ID and have no matching request spans.

Other-project lists were empty; direct foreign trace-span and error-event reads
returned 404. Missing credentials returned 401 and ingest-only credentials returned
403 on three lists and both detail routes. Private body/query/cookie/baggage/state
markers and credentials were absent from producer metadata and persisted signals.
JetStream acknowledged **28** messages, with no pending messages or dead letters;
workers finished with no failed jobs. All owned processes stopped and **8** temporary
credentials were revoked. Native events followed the normal direct HTTP path;
this proof does not exercise the gateway's native fallback queue.

The same candidate passed **829 SDK tests**, lint/build/size, and sixteen packaged
construction/refused-transport smoke phases. Separate Labs checks passed **16 real
local examples** plus **9 contract rejection examples based on actual observations**.
On every profile, a real client closed `/stream` after its first chunk, a subsequent
request still received the complete body, and exactly two stream spans finished.
That local check proves socket cancellation and continued HTTP operation; it does
not prove cancellation of a Nest Observable in progress, nor backend persistence
of the cancelled span. The backend phases check complete stream bodies.

The candidate came from SDK checkpoint `83ad3ce03fd906444e649022f0ccc36da3767e42`
and normal merge `6bc70533dc87ce3dcb20a520ccedab694d44d88b` with the published
release metadata. Archive SHA-256:
`a2ffab245a4e36554f79b4d0c26e9992a53131efa7df82797c07f12b47e61e93`.
Backend report SHA-256:
`a0b09a089fcd81b5c03189c0547d89aff657c4f3d848df89287195c4a45bdf4e`.
Rails source: `337ae8db8b4e1e71e792539fdcd453a765cc73f0`, Ruby **4.0.6**,
Rails **8.1.3.1**. Gateway source: `dec2ba5530aab0d1347db4cdd63186633736b966`.
The Labs runner is `bin/certify-node-frameworks`; it requires a separately prepared,
isolated run slot and never prepares or resets one itself. No registry publication,
production deployment, durable SDK recovery, other Node versions, RPC, WebSocket
or GraphQL support is implied. Default `fetch` redirects still do not inject a
carrier; choose the application redirect policy explicitly as documented above.

Sources: [Express error handling](https://expressjs.com/en/guide/error-handling.html),
[Fastify hooks](https://fastify.dev/docs/latest/Reference/Hooks/),
[Nest interceptors](https://docs.nestjs.com/interceptors),
[Nest exception filters](https://docs.nestjs.com/exception-filters),
[Nest request lifecycle](https://docs.nestjs.com/faq/request-lifecycle),
[OpenTelemetry JavaScript instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/),
and [Node HTTP response lifecycle](https://nodejs.org/api/http.html).
