// Per-async-flow context storage on Node: `AsyncLocalStorage` keeps the current
// request's scope apart from that of concurrent requests (CYJS-7). In the browser
// it does not exist (and is useless: single-thread) → `undefined`, and the
// `Client` falls back to a simple synchronous stack.
//
// `async_hooks` is NOT imported statically: it would break the browser bundle (the
// `<script>` IIFE has no Node builtins). It is resolved at runtime via
// `process.getBuiltinModule`, which the bundler does not link and the browser
// never reaches (`isNode` gate) — same guard as `nodeOs` in `runtime.ts`.
// Requires Node ≥20.16, the minimum declared in `engines` (see `package.json`).

import { isNode } from './runtime'
import type { Scope } from './scope'

/// Subset of `AsyncLocalStorage` used by the client (avoids depending on the
/// `@types/node` types in the public signature and keeps the module isomorphic).
export interface ScopeStorage {
  getStore(): Scope | undefined
  run<T>(store: Scope, callback: () => T): T
}

interface AsyncLocalStorageCtor {
  new (): ScopeStorage
}

interface AsyncHooks {
  AsyncLocalStorage?: AsyncLocalStorageCtor
}

interface ProcessWithBuiltin {
  getBuiltinModule?: (id: string) => unknown
}

/// Creates the scope storage on Node, or `undefined` in the browser / if
/// `async_hooks` is unreachable (defense in depth: never a crash).
export function createScopeStorage(): ScopeStorage | undefined {
  if (!isNode()) return undefined
  try {
    const ctor = nodeAsyncHooks()?.AsyncLocalStorage
    return typeof ctor === 'function' ? new ctor() : undefined
  } catch {
    return undefined
  }
}

function nodeAsyncHooks(): AsyncHooks | undefined {
  const getBuiltin = (process as ProcessWithBuiltin).getBuiltinModule
  if (typeof getBuiltin !== 'function') return undefined
  return getBuiltin('async_hooks') as AsyncHooks
}
