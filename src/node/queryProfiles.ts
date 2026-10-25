import { AsyncLocalStorage } from 'node:async_hooks'

type Report = (count: number, totalMs: number) => void
export type ProfileLimit = 'profile_limit' | 'group_limit' | 'query_limit'
interface Group {
  count: number
  totalMs: number
  report: Report
}
interface Profile {
  ended: boolean
  truncated: boolean
  started: number
  groups: Map<string, Group>
}

/** Request-local counters with bounded groups, operations and concurrent profiles. */
export class QueryProfiles {
  private readonly storage = new AsyncLocalStorage<Profile | undefined>()
  private readonly active = new Set<Profile>()
  private enabled = true

  constructor(
    private readonly threshold: number,
    private readonly limited: (reason: ProfileLimit) => void = () => {},
  ) {
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 1000)
      throw new RangeError('Repeated query threshold must be an integer from 2 to 1000')
  }

  profile<T>(operation: () => T): T {
    if (this.storage.getStore() && !this.storage.getStore()!.ended) return operation()
    return this.request((end) => {
      try {
        const result = operation()
        if (result instanceof Promise)
          return result.then(
            (value: unknown) => {
              end()
              return value
            },
            (error: unknown) => {
              end()
              throw error
            },
          ) as T
        end()
        return result
      } catch (error) {
        end()
        throw error
      }
    })
  }

  request<T>(operation: (end: () => void) => T): T {
    if (!this.enabled || this.active.size >= 64) {
      if (this.enabled) this.noteLimit('profile_limit')
      return this.storage.run(undefined, () => operation(() => {}))
    }
    const state: Profile = {
      ended: false,
      truncated: false,
      started: 0,
      groups: new Map(),
    }
    this.active.add(state)
    const end = () => this.finish(state)
    return this.storage.run(state, () => {
      try {
        return operation(end)
      } catch (error) {
        end()
        throw error
      }
    })
  }

  track(key: string, report: Report): ((durationMs: number) => void) | undefined {
    const state = this.storage.getStore()
    if (!this.enabled || !state || state.ended || key.length > 512) return
    if (state.started >= 1000) {
      state.truncated = true
      this.noteLimit('query_limit')
      return
    }
    let group = state.groups.get(key)
    if (!group) {
      if (state.groups.size >= 64) {
        state.truncated = true
        this.noteLimit('group_limit')
        return
      }
      group = { count: 0, totalMs: 0, report }
      state.groups.set(key, group)
    }
    state.started++
    let completed = false
    return (durationMs) => {
      if (completed || state.ended || !this.enabled) return
      completed = true
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      group.count++
      group.totalMs += durationMs
    }
  }

  uninstall(): void {
    this.enabled = false
    for (const state of this.active) this.finish(state)
  }

  private noteLimit(reason: ProfileLimit): void {
    try {
      this.limited(reason)
    } catch {
      /* Optional diagnostics cannot change business operations. */
    }
  }

  private finish(state: Profile): void {
    if (state.ended) return
    state.ended = true
    this.active.delete(state)
    if (this.enabled && !state.truncated)
      for (const group of state.groups.values()) {
        if (group.count < this.threshold) continue
        try {
          group.report(group.count, group.totalMs)
        } catch {
          /* Telemetry never changes request completion. */
        }
      }
    state.groups.clear()
  }
}
