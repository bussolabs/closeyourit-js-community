# Standalone Vue proof

This technical fixture exercises `instrumentVue`, independently of the Nuxt adapter.
Vue 3.5.43 and Vite 8.3.2 are pinned. Install the exact candidate SDK archive into
an isolated copy with `npm install --no-save --package-lock=false <archive>` after
`npm ci`. Run `npm run build`, then `PORT=<owned-port> node server.mjs` on Node 24.21.0.
Do not run against a backend until the certification coordinator supplies an isolated run.

The production build has no credentials. The loopback server reads
`CYI_PROOF_ENDPOINT`, `CYI_PROOF_PROJECT`, `CYI_PROOF_PUBLIC_KEY`,
`CYI_PROOF_RELEASE`, and `CYI_PROOF_ENABLED` from the process environment.
Only this public-key configuration is served at `/api/config`; no bearer is accepted
or exposed. Never save that response, environment, or full HTML as evidence.

Read proof before any error: attempts, handler calls and observations must be zero.
Click **Fail Vue event**, then **Read proof**: one real Vue event must produce one
event ID and invoke the existing application handler once. Repeat twice, checking
three distinct IDs and three handler calls. Every error has a distinct message;
the observer returns the original payload and does not suppress transport.

Click **Uninstall adapter**, then **Fail Vue event**, **Use application**, and
**Read proof**. Attempts and previous-handler calls increase to four, observations
remain at three, `previous_handler_restored` is true, and the application remains
usable. The client stays enabled and owned by the application.

Run a separate server with `CYI_PROOF_ENABLED=0`. Three error clicks still invoke
the previous handler and preserve application behavior, but produce zero SDK
observations or backend events. `Read proof` flushes pending transport and exposes
only bounded event identities, counters, release metadata and SDK statistics.
Its `construction_only:false` does not itself prove delivery: authenticated Rails
readback must match every observed ID and the run-wide count.

Build/install evidence and browser/backend proof are separate. This fixture adds
no SDK source change and must consume the immutable CYRA-965 candidate archive.
