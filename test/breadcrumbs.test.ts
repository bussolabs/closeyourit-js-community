import { describe, expect, it } from 'vitest'
import { Breadcrumb, BreadcrumbBuffer } from '../src/breadcrumbs'
import { FILTERED } from '../src/scrubber'

describe('Breadcrumb', () => {
  it('uses the defaults (type/level) and serializes only the keys that have a value', () => {
    const json = new Breadcrumb({ message: 'hello' }).toJSON()
    expect(json['type']).toBe('default')
    expect(json['level']).toBe('info')
    expect(json['message']).toBe('hello')
    expect(json).not.toHaveProperty('category')
    expect(json).not.toHaveProperty('data')
    expect(typeof json['timestamp']).toBe('string')
  })

  it('scrubs the data at construction', () => {
    const json = new Breadcrumb({
      message: 'x',
      data: { url: '/a', token: 'abc' },
    }).toJSON()
    expect(json['data']).toEqual({ url: '/a', token: FILTERED })
  })

  it('scrubs the message like an error message', () => {
    const json = new Breadcrumb({
      category: 'console',
      message: 'request sent with Authorization: Bearer x',
    }).toJSON()
    expect(json['message']).toBe(`request sent with Authorization: ${FILTERED}`)
  })

  it('omits data when empty', () => {
    const json = new Breadcrumb({ message: 'x', data: {} }).toJSON()
    expect(json).not.toHaveProperty('data')
  })
})

describe('BreadcrumbBuffer', () => {
  it('keeps only the last maxSize', () => {
    const buffer = new BreadcrumbBuffer(2)
    buffer.add(new Breadcrumb({ message: '1' }))
    buffer.add(new Breadcrumb({ message: '2' }))
    buffer.add(new Breadcrumb({ message: '3' }))
    expect(buffer.length).toBe(2)
    expect(buffer.toList().map((c) => c.message)).toEqual(['2', '3'])
  })

  it('with maxSize <= 0 it does not accumulate', () => {
    const buffer = new BreadcrumbBuffer(0)
    buffer.add(new Breadcrumb({ message: 'x' }))
    expect(buffer.length).toBe(0)
    expect(buffer.toJSON()).toBeNull()
  })

  it('toJSON is null when empty, {values:[...]} otherwise', () => {
    const buffer = new BreadcrumbBuffer(5)
    expect(buffer.toJSON()).toBeNull()
    buffer.add(new Breadcrumb({ message: 'x' }))
    const json = buffer.toJSON()
    expect(json).not.toBeNull()
    expect(Array.isArray((json as { values: unknown[] }).values)).toBe(true)
  })

  it('clear empties the buffer', () => {
    const buffer = new BreadcrumbBuffer(5)
    buffer.add(new Breadcrumb({ message: 'x' }))
    buffer.clear()
    expect(buffer.length).toBe(0)
  })
})
