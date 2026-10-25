import { describe, expect, it } from 'vitest'
import { templatizePath } from '../src/templatize'

describe('templatizePath', () => {
  it('replaces uuids with <uuid>', () => {
    expect(
      templatizePath('/v1/users/6f9619ff-8b86-4d01-b42d-00cf4fc964ff/orders'),
    ).toBe('/v1/users/<uuid>/orders')
  })

  it('replaces numeric runs of ≥3 digits with <n>', () => {
    expect(templatizePath('/v1/charges/12345')).toBe('/v1/charges/<n>')
    expect(templatizePath('/v2/items/42')).toBe('/v2/items/42') // 2 digits stay
  })

  it('combines uuids and numbers in the same path', () => {
    expect(templatizePath('/api/6f9619ff-8b86-4d01-b42d-00cf4fc964ff/rows/98765')).toBe(
      '/api/<uuid>/rows/<n>',
    )
  })

  it('leaves paths without ids untouched', () => {
    expect(templatizePath('/v1/charges')).toBe('/v1/charges')
  })
})
