// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { patchMethod } from '../src/node/patch'

describe('instance method ownership', () => {
  it('preserves the receiver, arguments, return value and inherited descriptor', () => {
    const target = new EventEmitter()
    const original = target.emit
    let observed = 0
    let received = ''
    target.on('data', (value: string) => {
      received = value
    })
    const restore = patchMethod(
      target,
      'emit',
      (method) =>
        function (...args) {
          observed++
          return Reflect.apply(method, this, args)
        },
    )
    expect(restore).toBeTypeOf('function')
    expect(target.emit('data', 'application value')).toBe(true)
    expect(received).toBe('application value')
    expect(observed).toBe(1)
    restore!()
    restore!()
    expect(target.emit).toBe(original)
    expect(Object.hasOwn(target, 'emit')).toBe(false)
  })

  it('restores an own descriptor exactly', () => {
    const target = new EventEmitter()
    Object.defineProperty(target, 'emit', {
      value: target.emit,
      writable: true,
      configurable: false,
    })
    const before = Object.getOwnPropertyDescriptor(target, 'emit')
    const restore = patchMethod(
      target,
      'emit',
      (method) =>
        function (...args) {
          return Reflect.apply(method, this, args)
        },
    )
    restore!()
    expect(Object.getOwnPropertyDescriptor(target, 'emit')).toEqual(before)
  })

  it('never invokes an accessor or modifies a frozen instance', () => {
    const target = new EventEmitter()
    let reads = 0
    Object.defineProperty(target, 'emit', {
      get() {
        reads++
        return EventEmitter.prototype.emit
      },
    })
    expect(patchMethod(target, 'emit', (method) => method)).toBeUndefined()
    expect(reads).toBe(0)
    expect(
      patchMethod(Object.freeze(new EventEmitter()), 'emit', (method) => method),
    ).toBeUndefined()
  })

  it('preserves a later application replacement during uninstall', () => {
    const target = new EventEmitter()
    const restore = patchMethod(
      target,
      'emit',
      (method) =>
        function (...args) {
          return Reflect.apply(method, this, args)
        },
    )
    const replacement = EventEmitter.prototype.emit.bind(target)
    target.emit = replacement
    restore!()
    expect(target.emit).toBe(replacement)
  })
})
