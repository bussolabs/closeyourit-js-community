import { AsyncLocalStorage } from 'node:async_hooks'
import { patchMethod } from './patch'

export type DriverMode = 'pg' | 'mysql-callback' | 'mysql-promise'
export interface DriverObserver {
  begin(args: readonly unknown[], mode: DriverMode): (() => void) | undefined
  skipped(reason: 'unsupported_query' | 'instance_limit' | 'unpatchable'): void
}

const owners = new WeakMap<object, DatabaseDriverHooks>()

/** Explicit instances only. No global prototypes, event listeners or driver ownership. */
export class DatabaseDriverHooks {
  private active = true
  private readonly nested = new AsyncLocalStorage<boolean>()
  private readonly installed = new WeakSet<object>()
  private readonly restores = new Set<() => void>()

  constructor(private readonly observer: DriverObserver) {}

  install(target: object, mode: DriverMode): void {
    if (!this.active || this.installed.has(target)) return
    if (owners.has(target)) {
      this.skipped('unpatchable')
      return
    }
    if (this.restores.size >= 256) {
      this.skipped('instance_limit')
      return
    }
    const hooks = this
    const owned: (() => void)[] = []
    const methods = mode === 'pg' ? ['query'] : ['query', 'execute']
    for (const method of methods) {
      const restore = patchMethod(
        target,
        method,
        (original) =>
          function (...args) {
            if (!hooks.active || hooks.nested.getStore())
              return Reflect.apply(original, this, args)
            const callbackIndex = args.length - 1
            const callback = args[callbackIndex]
            const hasCallback = typeof callback === 'function'
            if (
              unsupportedQuery(args[0]) ||
              (mode === 'mysql-callback' && !hasCallback)
            ) {
              hooks.skipped('unsupported_query')
              return Reflect.apply(original, this, args)
            }
            const finish = hooks.begin(args, mode)
            if (!finish) return Reflect.apply(original, this, args)
            const run = AsyncLocalStorage.snapshot()
            if (hasCallback) {
              args[callbackIndex] = function (this: unknown, ...values: unknown[]) {
                finish()
                return run(() => Reflect.apply(callback, this, values))
              }
            }
            try {
              const result: unknown = hooks.nested.run(true, () =>
                Reflect.apply(original, this, args),
              )
              if (hasCallback) return result
              if (result instanceof Promise)
                return result.then(
                  (value: unknown) => {
                    finish()
                    return value
                  },
                  (error: unknown) => {
                    finish()
                    throw error
                  },
                )
              // Unknown driver extensions retain their original return and event semantics.
              hooks.skipped('unsupported_query')
              return result
            } catch (error) {
              finish()
              throw error
            }
          },
      )
      if (restore) owned.push(restore)
      else this.skipped('unpatchable')
    }
    if (!owned.length) return
    const borrow = mode === 'pg' ? 'connect' : 'getConnection'
    const restoreBorrow = patchMethod(
      target,
      borrow,
      (original) =>
        function (...args) {
          if (!hooks.active) return Reflect.apply(original, this, args)
          const callback = args[0]
          if (typeof callback === 'function') {
            const run = AsyncLocalStorage.snapshot()
            args[0] = function (this: unknown, ...values: unknown[]) {
              if (!values[0] && isObject(values[1])) hooks.install(values[1], mode)
              return run(() => Reflect.apply(callback, this, values))
            }
            return Reflect.apply(original, this, args)
          }
          const result: unknown = Reflect.apply(original, this, args)
          if (!(result instanceof Promise)) return result
          return result.then((value: unknown) => {
            if (isObject(value)) hooks.install(value, mode)
            return value
          })
        },
    )
    if (restoreBorrow) owned.push(restoreBorrow)
    this.installed.add(target)
    owners.set(target, this)
    this.restores.add(() => {
      for (const restore of owned) restore()
      if (owners.get(target) === this) owners.delete(target)
    })
  }

  uninstall(): void {
    this.active = false
    for (const restore of this.restores) restore()
    this.restores.clear()
  }

  private begin(args: readonly unknown[], mode: DriverMode): (() => void) | undefined {
    try {
      const complete = this.observer.begin(args, mode)
      if (!complete) return
      let ended = false
      return () => {
        if (ended || !this.active) return
        ended = true
        try {
          complete()
        } catch {
          /* Telemetry must preserve business completion. */
        }
      }
    } catch {
      return
    }
  }

  private skipped(reason: Parameters<DriverObserver['skipped']>[0]): void {
    try {
      this.observer.skipped(reason)
    } catch {
      /* Diagnostics are optional. */
    }
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

function unsupportedQuery(value: unknown): boolean {
  if (typeof value === 'string') return false
  if (!isObject(value)) return true
  try {
    // Custom Query/cursor/stream instances and accessors remain application-owned.
    if (Object.getPrototypeOf(value) !== Object.prototype) return true
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return (
      Object.values(descriptors).some((descriptor) => !('value' in descriptor)) ||
      'callback' in descriptors ||
      'submit' in descriptors ||
      'onResult' in descriptors
    )
  } catch {
    return true
  }
}
