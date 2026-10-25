// @vitest-environment node
// NON-mocked consumer/contract E2E of the browser transports (CYJS-6).
//
// The bug: the browser tests (see browserAuth.test.ts) assert URL + `?sentry_key=`
// with a mocked `fetch`, but they do not discover that the Rails backend REJECTS the DSN public
// key on the v1 paths — `TokenAuthentication` accepts the secret Bearer only on the
// server side; the public key is valid only on the Sentry drop-in (`/store`, `/envelope`).
// Here we start a real local HTTP server as a "test backend" and send EVERY
// browser channel with a real `fetch`: CI finds out right away if a channel changes
// contract (path, project_id, credential) or if a channel accepted today goes back to
// unauthorized.
//
// The test backend replicates the auth of the real backend and — key point — is
// VERIFIED against the `public_dsn` fixtures of
// contracts/ingest/v1/fixtures/http/auth-cases.json (dedicated test further below),
// so it is not a free copy that would stay green while the contract changes:
//   - public_dsn on /api/:pid/store (+ /envelope)  → ACCEPTED (errors, messages)
//   - public_dsn on /api/v1/projects/:pid/pageviews → 401 (fixture
//     public-pageviews-rejected); logs/metrics/replays follow the same v1 rule
//     (no dedicated public_dsn fixture) → 401 pending the backend
//     (CYRA-108/111).
// The expected statuses of the channels are DERIVED from the fixtures, not copied: if
// auth-cases.json changes, the anchoring test fails until the test backend is
// updated too. When the backend enables a v1 channel, the fixture will change
// and the matrix will update accordingly.
//
// Why the `node` environment and not `jsdom`: here we want the REAL transport, i.e.
// NATIVE and consistent `fetch` and `AbortController` (in jsdom `fetch` is undici while
// `AbortController` comes from jsdom, and undici rejects a jsdom signal — friction that does not
// exist in a real browser). We activate the SDK's browser branch with a minimal DOM
// (window/document/location/navigator), just as much as the payload builders
// need; no mocked `fetch`, it is a real E2E against a server on 127.0.0.1.

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Client } from '../src/client'
import * as CloseYourIt from '../src/index'
import { buildReplayChunk } from '../src/replay'

const PROJECT_ID = 'proj_e2e'
const PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' // 32 hex, DSN public key style
const WRONG_KEY = 'ffffffffffffffffffffffffffffffff'

type ChannelId = 'errors' | 'messages' | 'log' | 'metrics' | 'pageview' | 'replay'

interface Received {
  channel: ChannelId | 'unknown'
  method: string
  pathname: string
  projectId: string | null
  sentryKey: string | null
  hasBearer: boolean
  status: number
  accepted: boolean
}

interface AuthCase {
  id: string
  channel: string
  credential: string
  endpoint: string
  status: number
}

// Source of truth of the auth contract (shared with the other SDKs). The test
// backend MUST reproduce its `public_dsn` cases: a dedicated test verifies it, so
// the matrix is not a free copy that could stay green while the real contract
// changes.
const AUTH_CASES = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'contracts',
      'ingest',
      'v1',
      'fixtures',
      'http',
      'auth-cases.json',
    ),
    'utf8',
  ),
) as AuthCase[]

const PUBLIC_DSN_CASES = AUTH_CASES.filter((c) => c.credential === 'public_dsn')

// Documented status for a browser endpoint (public_dsn), if present in the
// fixtures. `undefined` for the channels the fixtures do not yet cover with the public
// key (logs/metrics/replays): they follow the `public-pageviews-rejected` rule —
// v1 path with public key → 401 until the backend enables them.
function fixtureStatus(endpoint: string): number | undefined {
  return PUBLIC_DSN_CASES.find((c) => c.endpoint === endpoint)?.status
}

const STORE_ENDPOINT = '/api/{project_id}/store'
const v1Endpoint = (channel: string): string =>
  `/api/v1/projects/{project_id}/${channel}`

// Endpoint (template) of each browser channel. The expected statuses are derived
// from the public_dsn fixtures where documented (store→200, pageviews→401), with a
// 401 fallback on the v1 paths not yet covered (logs/metrics/replays).
const CHANNEL_ENDPOINTS: Record<ChannelId, string> = {
  errors: STORE_ENDPOINT,
  messages: STORE_ENDPOINT,
  log: v1Endpoint('logs'),
  metrics: v1Endpoint('metrics'),
  pageview: v1Endpoint('pageviews'),
  replay: v1Endpoint('replays'),
}

function expectedFor(endpoint: string): {
  pathname: string
  status: number
  accepted: boolean
} {
  const status = fixtureStatus(endpoint) ?? 401
  return {
    pathname: endpoint.replace('{project_id}', PROJECT_ID),
    status,
    accepted: status >= 200 && status < 300,
  }
}

let server: Server
let base: string
let received: Received[] = []

// Map `v1 channel → logical id` (the `events` endpoint is never used by the browser,
// which sends errors to the `/store` drop-in).
const V1_CHANNELS: Record<string, ChannelId> = {
  logs: 'log',
  metrics: 'metrics',
  pageviews: 'pageview',
  replays: 'replay',
  events: 'errors',
}

// Models the auth of the real backend: the public key (?sentry_key=) is valid ONLY on the
// Sentry drop-in (`/store`, `/envelope`); on the v1 paths the backend requires the secret
// Bearer, so a browser request (which never carries it) gets 401.
function route(
  pathname: string,
): { kind: 'dropin' | 'v1'; projectId: string; v1channel?: ChannelId } | null {
  const dropin = pathname.match(/^\/api\/([^/]+)\/(store|envelope)$/)
  if (dropin) return { kind: 'dropin', projectId: dropin[1]! }

  const v1 = pathname.match(
    /^\/api\/v1\/projects\/([^/]+)\/(events|logs|metrics|pageviews|replays)$/,
  )
  if (v1) return { kind: 'v1', projectId: v1[1]!, v1channel: V1_CHANNELS[v1[2]!] }

  return null
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const url = new URL(req.url ?? '/', base)
      const sentryKey = url.searchParams.get('sentry_key')
      const hasBearer = (req.headers.authorization ?? '').startsWith('Bearer ')
      const matched = route(url.pathname)

      let status = 404
      let channel: ChannelId | 'unknown' = 'unknown'

      if (matched && matched.projectId === PROJECT_ID) {
        if (matched.kind === 'dropin') {
          // errors and messages share the drop-in: the body tells them apart.
          const payload = safeJson(raw)
          channel = payload && 'exception' in payload ? 'errors' : 'messages'
          status = sentryKey === PUBLIC_KEY ? 200 : 401
        } else {
          channel = matched.v1channel ?? 'unknown'
          // The browser never carries the Bearer: the public key on v1 is rejected.
          status = hasBearer ? 202 : 401
        }
      }
      // A project_id that does not match or an unknown route stay 404.

      const accepted = status >= 200 && status < 300
      received.push({
        channel,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        projectId: matched?.projectId ?? null,
        sentryKey,
        hasBearer,
        status,
        accepted,
      })

      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(
        accepted
          ? JSON.stringify({ ok: true })
          : JSON.stringify({
              error: { code: 'R401-AUTH-001', message: 'unauthorized' },
            }),
      )
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// Minimal DOM to make the SDK enter the browser branch (isBrowser() === true) and give
// the payload builders the page values they read (location/referrer/UA).
function stubBrowserDom(): void {
  vi.stubGlobal('window', { innerWidth: 1280 })
  vi.stubGlobal('document', { referrer: '' })
  vi.stubGlobal('navigator', { userAgent: 'closeyourit-e2e' })
  vi.stubGlobal('location', {
    href: 'https://app.test/pricing',
    origin: 'https://app.test',
    hostname: 'app.test',
    pathname: '/pricing',
    search: '',
  })
}

beforeEach(() => {
  received = []
  stubBrowserDom()
})

afterEach(async () => {
  await CloseYourIt.close()
  vi.unstubAllGlobals()
})

// Browser-safe config (DSN public key) towards the test backend. `autoInstall:
// false` so we drive every channel ourselves; `environment: 'test'` to allow
// the local http:// endpoint (forbidden only in production).
function initBrowser(publicKey: string): Client {
  return CloseYourIt.init({
    endpointUrl: base,
    publicKey,
    projectId: PROJECT_ID,
    environment: 'test',
    autoInstall: false,
    sampleRate: 1,
    logsSampleRate: 1,
    logsMinLevel: 'debug',
    detectPerformanceIssues: true, // enables recordJank → metrics channel
    detectJank: true,
  })
}

// Exercises the six browser channels once each and waits for the in-flight sends.
async function sendAllChannels(client: Client): Promise<void> {
  client.captureException(new Error('e2e boom'))
  client.captureMessage('e2e message', 'warning')
  client.log('error', 'e2e log')
  client.recordJank(500, '/e2e')
  client.capturePageview({ path: '/e2e' })
  client.captureReplayChunk(
    buildReplayChunk({
      replaySessionId: 'sess-e2e',
      seq: 0,
      startedAt: Date.now(),
      events: [{ type: 2, data: {} }],
      path: '/e2e',
    }),
  )
  await CloseYourIt.flush()
}

describe('E2E browser channels against a test backend (CYJS-6)', () => {
  it('the test backend reproduces the public_dsn cases of the contract (auth-cases.json)', async () => {
    // If the fixtures diverge from the test backend, the test matrix is invalid:
    // this anchors one to the other. At least store/envelope (accepted) and pageviews
    // (rejected) are documented as public_dsn.
    expect(PUBLIC_DSN_CASES.length).toBeGreaterThan(0)

    for (const authCase of PUBLIC_DSN_CASES) {
      const path = authCase.endpoint.replace('{project_id}', PROJECT_ID)
      const res = await fetch(`${base}${path}?sentry_key=${PUBLIC_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(res.status, authCase.id).toBe(authCase.status)
    }
  })

  it('with the valid public key it exercises every channel and verifies its contract and outcome', async () => {
    const client = initBrowser(PUBLIC_KEY)
    expect(CloseYourIt.isEnabled()).toBe(true)

    await sendAllChannels(client)

    // Every channel reached the test backend exactly once.
    expect(received).toHaveLength(6)

    for (const channel of Object.keys(CHANNEL_ENDPOINTS) as ChannelId[]) {
      const expected = expectedFor(CHANNEL_ENDPOINTS[channel])
      const req = received.find((r) => r.channel === channel)
      expect(req, `channel ${channel} not received`).toBeDefined()
      // Contract: correct path (drop-in or v1) and associated project.
      expect(req!.pathname, channel).toBe(expected.pathname)
      expect(req!.projectId, channel).toBe(PROJECT_ID)
      expect(req!.method, channel).toBe('POST')
      // Browser-safe credential present, secret bearer NEVER sent.
      expect(req!.sentryKey, channel).toBe(PUBLIC_KEY)
      expect(req!.hasBearer, channel).toBe(false)
      // Real outcome from the test backend, expectation derived from the fixtures.
      expect(req!.status, channel).toBe(expected.status)
      expect(req!.accepted, channel).toBe(expected.accepted)
    }
  })

  it('today it accepts errors and messages and leaves logs, metrics, pageviews and replays pending', async () => {
    const client = initBrowser(PUBLIC_KEY)
    await sendAllChannels(client)

    const accepted = received
      .filter((r) => r.accepted)
      .map((r) => r.channel)
      .sort()
    const rejected = received
      .filter((r) => !r.accepted)
      .map((r) => r.channel)
      .sort()

    expect(accepted).toEqual(['errors', 'messages'])
    expect(rejected).toEqual(['log', 'metrics', 'pageview', 'replay'])
    // Every channel not yet enabled is explicitly rejected with 401.
    for (const r of received.filter((x) => !x.accepted)) {
      expect(r.status).toBe(401)
    }
  })

  it('with the wrong public key even the accepted channels come back unauthorized', async () => {
    const client = initBrowser(WRONG_KEY)
    // Configured (public key present): the error comes from the backend, not from the client.
    expect(CloseYourIt.isEnabled()).toBe(true)

    client.captureException(new Error('e2e boom'))
    client.captureMessage('e2e message', 'warning')
    await CloseYourIt.flush()

    const storePath = expectedFor(STORE_ENDPOINT).pathname
    const store = received.filter((r) => r.pathname === storePath)
    expect(store).toHaveLength(2)
    for (const r of store) {
      expect(r.sentryKey).toBe(WRONG_KEY)
      expect(r.status).toBe(401)
      expect(r.accepted).toBe(false)
    }
  })

  it('without a browser credential the SDK stays disabled and sends nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = CloseYourIt.init({
      endpointUrl: base,
      projectId: PROJECT_ID,
      environment: 'test',
      autoInstall: false,
    })
    warn.mockRestore()

    expect(CloseYourIt.isEnabled()).toBe(false)
    client.captureException(new Error('boom'))
    client.captureMessage('hello')
    await CloseYourIt.flush()

    expect(received).toHaveLength(0)
  })
})
