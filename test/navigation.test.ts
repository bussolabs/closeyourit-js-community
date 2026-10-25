import { afterEach, describe, expect, it } from 'vitest'
import { subscribeNavigation } from '../src/integrations/browser/navigation'

let unsubs: Array<() => void> = []
afterEach(() => {
  unsubs.forEach((off) => off())
  unsubs = []
})

interface Tracked {
  events: Array<{ to: string; from: string | null }>
  off: () => void
}

function track(): Tracked {
  const events: Array<{ to: string; from: string | null }> = []
  const off = subscribeNavigation((to, from) => events.push({ to, from }))
  unsubs.push(off)
  return { events, off }
}

describe('subscribeNavigation — shared patch', () => {
  it('installs a single monkey-patch even with several subscribers', () => {
    const original = history.pushState
    const a = track()
    const patched = history.pushState
    expect(patched).not.toBe(original) // installed at the first subscriber
    const b = track()
    expect(history.pushState).toBe(patched) // NOT re-patched at the second

    history.pushState({}, '', '/one')
    // A single patch → each listener notified ONLY once.
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(1)
    expect(a.events[0]!.to).toContain('/one')
  })

  it('restores history.pushState when the last subscriber unsubscribes', () => {
    const original = history.pushState
    const a = track()
    const b = track()
    expect(history.pushState).not.toBe(original)
    a.off()
    expect(history.pushState).not.toBe(original) // b is still active
    b.off()
    expect(history.pushState).toBe(original) // restored at the last one
  })

  it('a second subscribe/unsubscribe cycle re-installs and restores', () => {
    const original = history.pushState
    const first = track()
    first.off()
    expect(history.pushState).toBe(original)
    const second = track()
    expect(history.pushState).not.toBe(original)
    second.off()
    expect(history.pushState).toBe(original)
  })
})

describe('subscribeNavigation — dedup and from/to', () => {
  it('does not notify if the href does not change (lastHref dedup)', () => {
    history.pushState({}, '', '/start')
    const { events } = track()
    history.pushState({}, '', '/start') // same href → dedup
    expect(events).toHaveLength(0)
    history.pushState({}, '', '/next') // changes → notify
    expect(events).toHaveLength(1)
  })

  it('passes from = previous href and to = new href', () => {
    history.pushState({}, '', '/from')
    const { events } = track()
    history.pushState({}, '', '/a')
    expect(events).toHaveLength(1)
    expect(events[0]!.from).toContain('/from')
    expect(events[0]!.to).toContain('/a')
  })

  it('reacts to replaceState', () => {
    history.pushState({}, '', '/p0')
    const { events } = track()
    history.replaceState({}, '', '/p1')
    expect(events).toHaveLength(1)
    expect(events[0]!.to).toContain('/p1')
  })

  it('handles popstate: without an href change it dedups (no event)', () => {
    history.pushState({}, '', '/pp')
    const { events } = track()
    window.dispatchEvent(new PopStateEvent('popstate')) // href unchanged
    expect(events).toHaveLength(0)
  })

  it('notifies every subscriber when the href changes', () => {
    history.pushState({}, '', '/multi0')
    const a = track()
    const b = track()
    history.pushState({}, '', '/multi1')
    expect(a.events.at(-1)!.to).toContain('/multi1')
    expect(b.events.at(-1)!.to).toContain('/multi1')
  })
})
