// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { QueryProfiles } from '../src/node/queryProfiles'

describe('request query counter lifecycle', () => {
  it('isolates concurrent asynchronous profiles and emits only at the exact threshold', async () => {
    const profiles = new QueryProfiles(3)
    const results: string[] = []
    await Promise.all(
      [2, 3, 4].map((count) =>
        profiles.profile(async () => {
          for (let index = 0; index < count; index++) {
            const finish = profiles.track('same-operation', (total) =>
              results.push(`${count}:${total}`),
            )
            await Promise.resolve()
            finish?.(1)
          }
        }),
      ),
    )
    expect(results.sort()).toEqual(['3:3', '4:4'])
  })

  it('shares nested explicit profiles and finalizes them once', async () => {
    const profiles = new QueryProfiles(2)
    const results: number[] = []
    await profiles.profile(async () => {
      profiles.track('operation', (count) => results.push(count))?.(2)
      await profiles.profile(async () => {
        profiles.track('operation', (count) => results.push(count))?.(3)
      })
      expect(results).toEqual([])
    })
    expect(results).toEqual([2])
  })

  it('keeps manual HTTP scopes isolated and ignores late or duplicate completions', () => {
    const profiles = new QueryProfiles(2)
    const results: number[] = []
    profiles.request((end) => {
      const first = profiles.track('operation', (count) => results.push(count))!
      const late = profiles.track('operation', (count) => results.push(count))!
      first(1)
      first(1)
      end()
      late(1)
      end()
    })
    expect(profiles.track('outside', () => {})).toBeUndefined()
    expect(results).toEqual([])
  })

  it('preserves thrown application errors while finishing the profile', () => {
    const profiles = new QueryProfiles(2)
    const failure = new Error('Business operation failed')
    expect(() =>
      profiles.profile(() => {
        throw failure
      }),
    ).toThrow(failure)
    expect(profiles.track('outside', () => {})).toBeUndefined()
  })

  it('bounds each profile to 64 groups and 1000 operations', () => {
    const limits: string[] = []
    const profiles = new QueryProfiles(2, (reason) => limits.push(reason))
    const groups: number[] = []
    profiles.profile(() => {
      for (let index = 0; index < 64; index++) {
        profiles.track(String(index), (count) => groups.push(count))?.(1)
        profiles.track(String(index), () => {})?.(1)
      }
      expect(profiles.track('overflow', () => {})).toBeUndefined()
    })
    expect(groups).toEqual([])
    const totals: number[] = []
    profiles.profile(() => {
      for (let index = 0; index < 1000; index++)
        profiles.track('same', (count) => totals.push(count))?.(1)
      expect(profiles.track('same', () => {})).toBeUndefined()
    })
    expect(totals).toEqual([])
    expect(limits).toEqual(['group_limit', 'query_limit'])
    profiles.profile(() => {
      for (let index = 0; index < 1000; index++)
        profiles.track('same', (count) => totals.push(count))?.(1)
    })
    expect(totals).toEqual([1000])
  })

  it('bounds active profiles and releases capacity after completion', () => {
    const profiles = new QueryProfiles(2)
    const ends: (() => void)[] = []
    for (let index = 0; index < 64; index++) profiles.request((end) => ends.push(end))
    profiles.request(() => expect(profiles.track('overflow', () => {})).toBeUndefined())
    ends.shift()!()
    profiles.request((end) => {
      expect(profiles.track('available', () => {})).toBeTypeOf('function')
      end()
    })
    for (const end of ends) end()
  })

  it('rejects invalid duration values and prevents uninstall from reporting pending profiles', () => {
    const profiles = new QueryProfiles(2)
    const results: number[] = []
    profiles.profile(() => {
      for (const duration of [NaN, Infinity, -1])
        profiles.track('invalid', (count) => results.push(count))?.(duration)
      profiles.track('valid', (count) => results.push(count))?.(0)
      profiles.track('valid', (count) => results.push(count))?.(0)
      profiles.uninstall()
    })
    expect(results).toEqual([])
  })

  it.each([0, 1, 1.5, 1001, NaN, Infinity])(
    'rejects the invalid threshold %s',
    (threshold) => {
      expect(() => new QueryProfiles(threshold)).toThrow(RangeError)
    },
  )
})
