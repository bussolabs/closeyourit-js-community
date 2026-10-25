import { describe, expect, it } from 'vitest'
import { parseStack } from '../src/stackTrace'

describe('parseStack', () => {
  it('returns [] for a missing stack', () => {
    expect(parseStack(undefined)).toEqual([])
    expect(parseStack('')).toEqual([])
  })

  it('extracts V8/Chrome frames with function and position', () => {
    const stack = [
      'Error: boom',
      '    at handleClick (https://app.example.com/main.js:10:15)',
      '    at https://app.example.com/vendor.js:20:5',
    ].join('\n')

    const frames = parseStack(stack)
    // Sentry: oldest-first, crash last.
    expect(frames).toHaveLength(2)
    expect(frames[1]).toEqual({
      filename: 'main.js',
      abs_path: 'https://app.example.com/main.js',
      function: 'handleClick',
      lineno: 10,
      colno: 15,
      in_app: true,
    })
    expect(frames[0]!.function).toBeUndefined()
    expect(frames[0]!.filename).toBe('vendor.js')
  })

  it('extracts Firefox/Safari frames (fn@url)', () => {
    const stack = [
      'handleClick@https://app.example.com/main.js:10:15',
      '@https://app.example.com/vendor.js:20:5',
    ].join('\n')

    const frames = parseStack(stack)
    expect(frames[1]!.function).toBe('handleClick')
    expect(frames[1]!.lineno).toBe(10)
    expect(frames[0]!.function).toBeUndefined()
  })

  it('marks node_modules as not in_app', () => {
    const stack = 'at fn (https://app.example.com/node_modules/lib/index.js:1:1)'
    const frames = parseStack(stack)
    expect(frames[0]!.in_app).toBe(false)
  })

  it('handles URLs with a port without confusing line/col', () => {
    const stack = 'at fn (http://localhost:3000/app.js:42:7)'
    const frames = parseStack(stack)
    expect(frames[0]!.abs_path).toBe('http://localhost:3000/app.js')
    expect(frames[0]!.lineno).toBe(42)
    expect(frames[0]!.colno).toBe(7)
  })

  it('strips the query string from the filename', () => {
    const stack = 'at fn (https://app.example.com/main.js?v=2:10:15)'
    const frames = parseStack(stack)
    expect(frames[0]!.filename).toBe('main.js')
  })

  it('removes the async/new prefixes from the function name', () => {
    const stack = [
      'at async loadData (https://app.example.com/a.js:1:1)',
      'at new Widget (https://app.example.com/b.js:2:2)',
    ].join('\n')
    const frames = parseStack(stack)
    expect(frames.map((f) => f.function)).toEqual(['Widget', 'loadData'])
  })
})
