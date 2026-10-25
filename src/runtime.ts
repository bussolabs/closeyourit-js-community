// Detection of the execution environment. The browser branch wins over Node:
// under jsdom (tests) both `window` and `process` exist, and the correct
// behavior is the browser one.

/// `true` in a browser (or browser-like, e.g. jsdom) environment.
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/// `true` in plain Node.js (no DOM).
export function isNode(): boolean {
  return (
    !isBrowser() &&
    typeof process !== 'undefined' &&
    typeof process.versions?.node === 'string'
  )
}

/// The event's `contexts.runtime`: `{name:'browser'}` or
/// `{name:'node', version: process.version}`.
export function runtimeContext(): Record<string, unknown> {
  if (isNode()) return { name: 'node', version: process.version }
  return { name: 'browser' }
}

/// Machine hostname in Node (`os.hostname()`) → the event's `server_name`
/// field, in parity with the Ruby gem. `undefined` in the browser, if `os` is
/// unreachable or on an empty hostname (do not emit an empty field).
///
/// Browser-safe dynamic-require guard: `os` is NOT imported statically —
/// it would break the browser bundle (the `<script>` IIFE has no Node builtins). It
/// is resolved at runtime via `process.getBuiltinModule`, which the bundler does not
/// link and the browser never reaches (`isNode` gate). Requires Node ≥20.16 —
/// the minimum declared in `engines` (see `package.json`).
export function serverName(): string | undefined {
  if (!isNode()) return undefined
  try {
    const host = nodeOs()?.hostname?.()
    return typeof host === 'string' && host.length > 0 ? host : undefined
  } catch {
    return undefined
  }
}

/// A valid semver release: optional leading `v`, `MAJOR.MINOR.PATCH`, with an
/// optional pre-release/build suffix. Same rule as the Ruby gem (CYRB-9):
/// it drops non-version values (`unknown`, branch names) that must not end up
/// as a release.
const SEMVER_RELEASE = /^v?\d+\.\d+\.\d+([-+.].+)?$/

/// Auto-detects the release from the deploy — ONLY on a real Node runtime (SSR/backend),
/// in tag-first parity with the Ruby gem. The deploy's semver tag takes precedence
/// (`APP_GIT_TAG` then `GIT_TAG`, accepted only if valid semver), then the deploy
/// SHA (`KAMAL_VERSION` then `GIT_SHA`) as fallback.
///
/// `undefined` in the browser: the `isNode()` gate requires `process.versions.node` and
/// excludes window/jsdom, so a `process` polyfilled into the browser bundle does not
/// trigger auto-detect (no access to process variables on the browser side).
/// Isomorphic SDK: only ENV is read, NEVER a git subprocess. In the browser the
/// release must be passed explicitly in the options (build-time inject).
export function detectRelease(): string | undefined {
  if (!isNode()) return undefined
  const env = process.env
  const tag = env.APP_GIT_TAG || env.GIT_TAG
  if (tag && SEMVER_RELEASE.test(tag)) return tag
  return env.KAMAL_VERSION || env.GIT_SHA || undefined
}

interface NodeOs {
  hostname?: () => string
}

interface ProcessWithBuiltin {
  getBuiltinModule?: (id: string) => unknown
}

// Node's `os` module without a static import (the browser bundle must not contain
// 'os'). `getBuiltinModule` is the Node API for accessing builtins from universal
// libraries; guaranteed by `engines.node >=20.16`. The guard stays as defense in
// depth: `undefined` (never a crash) on a runtime that did not expose it.
function nodeOs(): NodeOs | undefined {
  const getBuiltin = (process as ProcessWithBuiltin).getBuiltinModule
  if (typeof getBuiltin !== 'function') return undefined
  return getBuiltin('os') as NodeOs
}
