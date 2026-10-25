import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../src/client'
import type { BreadcrumbInput } from '../src/breadcrumbs'
import {
  installBreadcrumbs,
  stripUrl,
  syntheticSelector,
} from '../src/integrations/browser/breadcrumbs'

interface Harness {
  client: Client
  crumbs: BreadcrumbInput[]
}

function harness(
  auto: Partial<{ click: boolean; navigation: boolean; console: boolean }> = {},
): Harness {
  const crumbs: BreadcrumbInput[] = []
  const client = {
    addBreadcrumb: (input: BreadcrumbInput) => crumbs.push(input),
    options: {
      autoBreadcrumbs: {
        click: auto.click ?? true,
        navigation: auto.navigation ?? true,
        console: auto.console ?? true,
        http: true,
      },
    },
  } as unknown as Client
  return { client, crumbs }
}

let uninstall: () => void = () => {}
afterEach(() => {
  uninstall()
  uninstall = () => {}
  document.body.replaceChildren()
})

describe('helper', () => {
  it('syntheticSelector: tag + id + classes + data-testid, without text', () => {
    const el = document.createElement('button')
    el.id = 'submit'
    el.className = 'btn btn-primary extra fourth'
    el.setAttribute('data-testid', 'checkout')
    el.textContent = 'Paga ora'
    expect(syntheticSelector(el)).toBe(
      'button#submit.btn.btn-primary.extra[data-testid="checkout"]',
    )
  })

  it('stripUrl removes query and hash', () => {
    expect(stripUrl('https://app.test/path?q=1#frag')).toBe('https://app.test/path')
  })
})

describe('installBreadcrumbs — click', () => {
  it('records a ui.click breadcrumb with a synthetic selector', () => {
    const { client, crumbs } = harness()
    uninstall = installBreadcrumbs(client)

    const button = document.createElement('button')
    button.id = 'go'
    document.body.appendChild(button)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const click = crumbs.find((c) => c.category === 'ui.click')
    expect(click?.message).toBe('button#go')
  })

  it('autoBreadcrumbs.click:false disables clicks', () => {
    const { client, crumbs } = harness({ click: false })
    uninstall = installBreadcrumbs(client)

    const button = document.createElement('button')
    document.body.appendChild(button)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(crumbs.find((c) => c.category === 'ui.click')).toBeUndefined()
  })
})

describe('installBreadcrumbs — navigation', () => {
  it('records a navigation breadcrumb on pushState', () => {
    const { client, crumbs } = harness()
    uninstall = installBreadcrumbs(client)

    history.pushState({}, '', '/dashboard')

    const nav = crumbs.find((c) => c.category === 'navigation')
    expect(nav).toBeDefined()
    expect((nav?.data as { to: string }).to).toContain('/dashboard')
  })

  it('autoBreadcrumbs.navigation:false disables navigation', () => {
    const { client, crumbs } = harness({ navigation: false })
    uninstall = installBreadcrumbs(client)

    history.pushState({}, '', '/altro')

    expect(crumbs.find((c) => c.category === 'navigation')).toBeUndefined()
  })
})

describe('installBreadcrumbs — console', () => {
  it('records console.warn/error and calls the original', () => {
    const original = vi.fn()
    console.warn = original
    const { client, crumbs } = harness()
    uninstall = installBreadcrumbs(client)

    console.warn('attenzione', { a: 1 })

    const crumb = crumbs.find((c) => c.category === 'console')
    expect(crumb?.level).toBe('warning')
    expect(crumb?.message).toContain('attenzione')
    expect(original).toHaveBeenCalled()
    console.warn = original // explicit restore after the uninstall in afterEach
  })

  it('autoBreadcrumbs.console:false does not patch console', () => {
    const original = console.warn
    const { client } = harness({ console: false })
    uninstall = installBreadcrumbs(client)
    expect(console.warn).toBe(original)
  })
})

describe('installBreadcrumbs — uninstall', () => {
  it('restores console', () => {
    const originalWarn = console.warn
    const { client } = harness()
    const off = installBreadcrumbs(client)
    expect(console.warn).not.toBe(originalWarn)
    off()
    expect(console.warn).toBe(originalWarn)
  })
})
