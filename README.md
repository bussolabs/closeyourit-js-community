# CloseYourIt JavaScript SDK

Official JavaScript SDK for [CloseYourIt](https://closeyour.it), the open source tracker for errors,
logs, uptime and servers. One package for the browser and Node 20.16+, written in TypeScript, with a
single runtime dependency ([`web-vitals`](https://github.com/GoogleChrome/web-vitals)).

In the browser it captures unhandled exceptions, promise rejections, structured logs and breadcrumbs
(clicks, navigation, console, HTTP requests). On Node it hooks `uncaughtException` and
`unhandledRejection` and flushes on `beforeExit` and `SIGTERM`. PII is scrubbed on the client and
sending is fire-and-forget: the SDK never crashes its host.

## Credentials: server and browser

- **`token`**: the secret bearer `cyi_…`. Server-only. It must never reach a browser bundle.
- **`publicKey`**: the DSN public key. It is not secret and is the only credential for the browser.

In the browser, configure `publicKey`. If only the secret bearer is given, the SDK stays a no-op and
warns in the console instead of exposing it. Both credentials are on the project page of your
CloseYourIt.

## Install

```bash
npm install @bussolabs/closeyourit-js
```

Browser:

```ts
import * as CloseYourIt from '@bussolabs/closeyourit-js'

CloseYourIt.init({
  endpointUrl: 'https://app.closeyour.it',
  publicKey: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  projectId: '00000000-0000-0000-0000-000000000000',
  environment: 'production',
  release: 'web@1.4.2',
})
```

Node:

```ts
import * as CloseYourIt from '@bussolabs/closeyourit-js'

CloseYourIt.init({
  endpointUrl: 'https://app.closeyour.it',
  token: process.env.CLOSEYOURIT_TOKEN!,
  projectId: process.env.CLOSEYOURIT_PROJECT_ID!,
  environment: process.env.NODE_ENV ?? 'production',
})
```

On a self-hosted installation, `endpointUrl` is the address of your own CloseYourIt.

Full guide, with the `<script>` build, framework recipes, performance, Web Vitals, tracing and every
option: [closeyour.it/docs/sdk-javascript](https://closeyour.it/docs/sdk-javascript).

## Development

The toolchain is pinned with [mise](https://mise.jdx.dev) in `mise.toml`.

```bash
mise install
mise exec -- pnpm install
mise exec -- pnpm format:check
mise exec -- pnpm lint
mise exec -- pnpm build
mise exec -- pnpm size
mise exec -- pnpm test
```

## Contributing

Pull requests are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md). This
repository is a published copy: accepted changes are applied to the upstream source and come back
here with the next release. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

MIT, see `LICENSE`.
