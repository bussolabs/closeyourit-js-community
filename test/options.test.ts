import { describe, expect, it } from 'vitest'
import {
  disabledReason,
  endpointHost,
  eventsUri,
  isEnabled,
  isSecretToken,
  logsUri,
  metricsUri,
  pageviewsUri,
  resolveOptions,
  resolvedOptionsEqual,
  resolveTransportAuth,
  storeUri,
  webVitalsUri,
} from '../src/options'

const base = {
  endpointUrl: 'https://www.closeyour.it',
  token: 'cyi_abc',
  projectId: 'proj-1',
}

const PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('resolveOptions', () => {
  it('applies the defaults', () => {
    const opts = resolveOptions(base)
    expect(opts.environment).toBe('production')
    expect(opts.sampleRate).toBe(1)
    expect(opts.maxBreadcrumbs).toBe(50)
    expect(opts.breadcrumbs).toBe(true)
    expect(opts.autoInstall).toBe(true)
  })

  it('resolves sendServerName (default true, override false)', () => {
    expect(resolveOptions(base).sendServerName).toBe(true)
    expect(resolveOptions({ ...base, sendServerName: false }).sendServerName).toBe(
      false,
    )
  })

  it('resolves tracePropagationTargets (default [], keeps strings and RegExp)', () => {
    expect(resolveOptions(base).tracePropagationTargets).toEqual([])
    const targets = ['api.example.com', /^https:\/\/x\./]
    expect(
      resolveOptions({ ...base, tracePropagationTargets: targets })
        .tracePropagationTargets,
    ).toEqual(targets)
  })

  it('normalizes publicKey (default empty, trim)', () => {
    expect(resolveOptions(base).publicKey).toBe('')
    expect(resolveOptions({ ...base, publicKey: `  ${PUBLIC_KEY} ` }).publicKey).toBe(
      PUBLIC_KEY,
    )
  })

  it('removes the trailing slash from endpointUrl', () => {
    expect(
      resolveOptions({ ...base, endpointUrl: 'https://x.it///' }).endpointUrl,
    ).toBe('https://x.it')
  })

  it('clamps sampleRate to [0,1]', () => {
    expect(resolveOptions({ ...base, sampleRate: 2 }).sampleRate).toBe(1)
    expect(resolveOptions({ ...base, sampleRate: -1 }).sampleRate).toBe(0)
    expect(resolveOptions({ ...base, sampleRate: NaN }).sampleRate).toBe(1)
    expect(resolveOptions({ ...base, sampleRate: 0.3 }).sampleRate).toBe(0.3)
  })

  it('resolves slowExternalThresholdMs (default 1000, 0 disables, negative→default)', () => {
    expect(resolveOptions(base).slowExternalThresholdMs).toBe(1000)
    expect(
      resolveOptions({ ...base, slowExternalThresholdMs: 500 }).slowExternalThresholdMs,
    ).toBe(500)
    expect(
      resolveOptions({ ...base, slowExternalThresholdMs: 0 }).slowExternalThresholdMs,
    ).toBe(0)
    expect(
      resolveOptions({ ...base, slowExternalThresholdMs: -5 }).slowExternalThresholdMs,
    ).toBe(1000)
    expect(
      resolveOptions({ ...base, slowExternalThresholdMs: NaN }).slowExternalThresholdMs,
    ).toBe(1000)
  })

  it('applies the parity defaults (PII, queue, logs, metrics, perf)', () => {
    const opts = resolveOptions(base)
    expect(opts.sendPii).toBe(false)
    expect(opts.maxQueue).toBe(30)
    expect(opts.excludedExceptions).toEqual([])
    expect(opts.captureRequest).toBe(true)
    expect(opts.trackPageviews).toBe(false)
    expect(opts.logsEnabled).toBe(true)
    expect(opts.logsSampleRate).toBe(1)
    expect(opts.logsBatchSize).toBe(50)
    expect(opts.logsFlushIntervalMs).toBe(5000)
    expect(opts.logsMinLevel).toBe('info')
    expect(opts.slowMethodThresholdMs).toBe(200)
    expect(opts.captureMethodArguments).toBe(false)
    expect(opts.detectPerformanceIssues).toBe(false)
    expect(opts.captureExternalHttp).toBe(true)
    expect(opts.repeatedHttpThreshold).toBe(5)
    expect(opts.repeatedHttpWindowMs).toBe(5000)
    expect(opts.detectJank).toBe(true)
    expect(opts.jankThresholdMs).toBe(100)
  })

  it('autoBreadcrumbs: all active by default, partial merge', () => {
    expect(resolveOptions(base).autoBreadcrumbs).toEqual({
      click: true,
      navigation: true,
      console: true,
      http: true,
    })
    expect(
      resolveOptions({ ...base, autoBreadcrumbs: { console: false } }).autoBreadcrumbs,
    ).toEqual({ click: true, navigation: true, console: false, http: true })
  })

  it('clamps logsSampleRate to [0,1] and logsBatchSize ≥ 1', () => {
    expect(resolveOptions({ ...base, logsSampleRate: 7 }).logsSampleRate).toBe(1)
    expect(resolveOptions({ ...base, logsSampleRate: -1 }).logsSampleRate).toBe(0)
    expect(resolveOptions({ ...base, logsBatchSize: 0 }).logsBatchSize).toBe(50)
    expect(resolveOptions({ ...base, logsBatchSize: -3 }).logsBatchSize).toBe(50)
    expect(resolveOptions({ ...base, logsBatchSize: 10 }).logsBatchSize).toBe(10)
  })

  it('normalizes logsMinLevel (warn→warning, unknown→info)', () => {
    expect(
      resolveOptions({ ...base, logsMinLevel: 'warn' as never }).logsMinLevel,
    ).toBe('warning')
    expect(resolveOptions({ ...base, logsMinLevel: 'boh' as never }).logsMinLevel).toBe(
      'info',
    )
  })

  it('trackPageviews is opt-in (default false, can be enabled)', () => {
    expect(resolveOptions(base).trackPageviews).toBe(false)
    expect(resolveOptions({ ...base, trackPageviews: true }).trackPageviews).toBe(true)
  })

  it('trackWebVitals and captureResourceErrors are opt-in (CYJS-12)', () => {
    const off = resolveOptions(base)
    expect(off.trackWebVitals).toBe(false)
    expect(off.captureResourceErrors).toBe(false)

    const on = resolveOptions({
      ...base,
      trackWebVitals: true,
      captureResourceErrors: true,
    })
    expect(on.trackWebVitals).toBe(true)
    expect(on.captureResourceErrors).toBe(true)
  })

  it('clamps webVitalsSampleRate to [0,1] (default 1)', () => {
    expect(resolveOptions(base).webVitalsSampleRate).toBe(1)
    expect(
      resolveOptions({ ...base, webVitalsSampleRate: 0.25 }).webVitalsSampleRate,
    ).toBe(0.25)
    expect(
      resolveOptions({ ...base, webVitalsSampleRate: 7 }).webVitalsSampleRate,
    ).toBe(1)
    expect(
      resolveOptions({ ...base, webVitalsSampleRate: -1 }).webVitalsSampleRate,
    ).toBe(0)
  })
})

describe('isSecretToken', () => {
  it('recognizes the secret bearer from the cyi_ prefix', () => {
    expect(isSecretToken('cyi_abc')).toBe(true)
    expect(isSecretToken(PUBLIC_KEY)).toBe(false)
    expect(isSecretToken('')).toBe(false)
  })
})

describe('resolveTransportAuth (CYJS-1)', () => {
  it('server: bearer with the token; fallback to the public key if it is the only one', () => {
    expect(resolveTransportAuth(resolveOptions(base), false)).toEqual({
      kind: 'bearer',
      secret: 'cyi_abc',
    })
    const onlyKey = resolveOptions({ ...base, token: '', publicKey: PUBLIC_KEY })
    expect(resolveTransportAuth(onlyKey, false)).toEqual({
      kind: 'dsn',
      publicKey: PUBLIC_KEY,
    })
    expect(
      resolveTransportAuth(resolveOptions({ ...base, token: '' }), false),
    ).toBeNull()
  })

  it('browser: ONLY the DSN public key, never the secret bearer', () => {
    // Even with the bearer present, in the browser only the public key wins/is allowed.
    const both = resolveOptions({ ...base, publicKey: PUBLIC_KEY })
    expect(resolveTransportAuth(both, true)).toEqual({
      kind: 'dsn',
      publicKey: PUBLIC_KEY,
    })
    // Only the secret bearer → no browser-safe credential.
    expect(resolveTransportAuth(resolveOptions(base), true)).toBeNull()
  })
})

describe('disabledReason / isEnabled', () => {
  it('server active with the bearer, browser active with the publicKey', () => {
    expect(disabledReason(resolveOptions(base), false)).toBeNull()
    expect(isEnabled(resolveOptions(base), false)).toBe(true)
    const withKey = resolveOptions({ ...base, publicKey: PUBLIC_KEY })
    expect(isEnabled(withKey, true)).toBe(true)
  })

  it('browser: the secret cyi_ bearer is not enough, the DSN public key is needed', () => {
    const opts = resolveOptions(base)
    expect(disabledReason(opts, true)).toContain('publicKey missing')
    expect(isEnabled(opts, true)).toBe(false)
  })

  it('server: without credentials it is disabled (token missing)', () => {
    expect(disabledReason(resolveOptions({ ...base, token: '' }), false)).toBe(
      'token missing',
    )
  })

  it('disabled if endpointUrl or projectId is missing', () => {
    expect(disabledReason(resolveOptions({ ...base, endpointUrl: '' }), false)).toBe(
      'endpointUrl missing',
    )
    expect(disabledReason(resolveOptions({ ...base, projectId: '' }), false)).toBe(
      'projectId missing',
    )
  })

  it('disabled with enabled:false', () => {
    expect(isEnabled(resolveOptions({ ...base, enabled: false }), false)).toBe(false)
  })

  it('rejects http:// in production', () => {
    const opts = resolveOptions({
      ...base,
      endpointUrl: 'http://x.it',
      environment: 'production',
    })
    expect(disabledReason(opts, false)).toContain('http://')
  })

  it('allows http:// outside production', () => {
    const opts = resolveOptions({
      ...base,
      endpointUrl: 'http://localhost:3000',
      environment: 'development',
    })
    expect(isEnabled(opts, false)).toBe(true)
  })
})

describe('URI builders', () => {
  it('composes the ingest endpoints', () => {
    const opts = resolveOptions(base)
    expect(eventsUri(opts)).toBe(
      'https://www.closeyour.it/api/v1/projects/proj-1/events',
    )
    expect(logsUri(opts)).toBe('https://www.closeyour.it/api/v1/projects/proj-1/logs')
    expect(metricsUri(opts)).toBe(
      'https://www.closeyour.it/api/v1/projects/proj-1/metrics',
    )
    expect(pageviewsUri(opts)).toBe(
      'https://www.closeyour.it/api/v1/projects/proj-1/pageviews',
    )
    expect(webVitalsUri(opts)).toBe(
      'https://www.closeyour.it/api/v1/projects/proj-1/web_vitals',
    )
  })

  it('storeUri is the Sentry drop-in (DSN public key) for the events', () => {
    expect(storeUri(resolveOptions(base))).toBe(
      'https://www.closeyour.it/api/proj-1/store',
    )
  })

  it('endpointHost extracts the host', () => {
    expect(endpointHost(resolveOptions(base))).toBe('www.closeyour.it')
  })
})

describe('resolvedOptionsEqual — init idempotency (CYJS-8)', () => {
  it('true for equivalent resolved options (distinct objects)', () => {
    expect(
      resolvedOptionsEqual(resolveOptions({ ...base }), resolveOptions({ ...base })),
    ).toBe(true)
  })

  it('false if endpointUrl changes', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions(base),
        resolveOptions({ ...base, endpointUrl: 'https://other.example' }),
      ),
    ).toBe(false)
  })

  it('false if token changes', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions(base),
        resolveOptions({ ...base, token: 'cyi_different' }),
      ),
    ).toBe(false)
  })

  it('false if release changes', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, release: 'v1' }),
        resolveOptions({ ...base, release: 'v2' }),
      ),
    ).toBe(false)
  })

  it('compares beforeSend by reference', () => {
    const hook = (payload: Record<string, unknown>): Record<string, unknown> => payload
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, beforeSend: hook }),
        resolveOptions({ ...base, beforeSend: hook }),
      ),
    ).toBe(true)
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, beforeSend: (p) => p }),
        resolveOptions({ ...base, beforeSend: (p) => p }),
      ),
    ).toBe(false)
  })

  it('false if a nested autoBreadcrumbs flag changes', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions(base),
        resolveOptions({ ...base, autoBreadcrumbs: { http: false } }),
      ),
    ).toBe(false)
  })

  it('false if excludedExceptions changes', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions(base),
        resolveOptions({ ...base, excludedExceptions: ['AbortError'] }),
      ),
    ).toBe(false)
  })

  it('compares tracePropagationTargets including the RegExps (source+flags)', () => {
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, tracePropagationTargets: [/api/i] }),
        resolveOptions({ ...base, tracePropagationTargets: [/api/i] }),
      ),
    ).toBe(true)
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, tracePropagationTargets: [/api/] }),
        resolveOptions({ ...base, tracePropagationTargets: [/api/i] }),
      ),
    ).toBe(false)
    expect(
      resolvedOptionsEqual(
        resolveOptions({ ...base, tracePropagationTargets: ['a'] }),
        resolveOptions({ ...base, tracePropagationTargets: ['b'] }),
      ),
    ).toBe(false)
  })
})
