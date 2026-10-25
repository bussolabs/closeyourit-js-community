import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createHooks } from 'hookable'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '../src/client'
import type { EventPayload } from '../src/types'
import { instrumentVue } from '../src/vue'
import { instrumentNuxtClient } from '../src/nuxt/client'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  document.body.replaceChildren()
})

function setup(enabled = true) {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'https://localhost.invalid',
    projectId: 'vue-proof',
    publicKey: '0123456789abcdef0123456789abcdef',
    autoInstall: false,
    enabled,
    beforeSend(event) {
      events.push(event)
      return null
    },
  })
  cleanup.push(() => client.close())
  return { client, events }
}

describe('Vue instrumentation with the actual renderer and router', () => {
  it('requires an explicit application error policy and restores absence after uninstall', () => {
    const { client, events } = setup()
    const app = createApp({})
    expect(() => instrumentVue(app, client)).toThrow('explicit onUnhandledError')
    expect(app.config.errorHandler).toBeUndefined()
    const failure = new Error('Application chooses rethrow')
    const policy = () => {
      throw failure
    }
    const integration = instrumentVue(app, client, { onUnhandledError: policy })
    expect(() => app.config.errorHandler!(failure, null, 'setup')).toThrow(failure)
    expect(events).toHaveLength(1)
    expect(() =>
      instrumentVue(app, client, { onUnhandledError: () => undefined }),
    ).toThrow('policy conflicts')
    integration.uninstall()
    expect(app.config.errorHandler).toBeUndefined()
  })
  it('preserves rendering and reports each distinct event handler failure once', async () => {
    const { client, events } = setup()
    const errors = [
      new Error('First button'),
      new Error('Second button'),
      new Error('Third button'),
    ]
    let count = 0
    const app = createApp({
      render: () =>
        h(
          'button',
          {
            onClick: () => {
              throw errors[count++]
            },
          },
          'Fail',
        ),
    })
    const handled: unknown[] = []
    app.config.errorHandler = (error) => handled.push(error)
    const previous = app.config.errorHandler
    const integration = instrumentVue(app, client)
    expect(instrumentVue(app, client)).toBe(integration)
    const container = document.createElement('div')
    document.body.append(container)
    app.mount(container)
    cleanup.push(() => app.unmount())
    expect(events).toHaveLength(0)
    for (const error of errors) {
      container.querySelector('button')!.click()
      await nextTick()
      client.captureException(error)
    }
    expect(events).toHaveLength(3)
    expect(handled).toEqual(errors)
    expect(container.textContent).toBe('Fail')
    expect(events[0]).toMatchObject({
      exception: { values: [{ mechanism: { handled: false } }] },
    })
    integration.uninstall()
    expect(app.config.errorHandler).toBe(previous)
  })

  it('preserves a foreign replacement and never closes the application client', () => {
    const { client, events } = setup()
    const app = createApp({ render: () => h('div') })
    const integration = instrumentVue(app, client, {
      onUnhandledError: () => undefined,
    })
    const foreign = () => undefined
    app.config.errorHandler = foreign
    expect(() => instrumentVue(app, client)).toThrow('replaced')
    integration.uninstall()
    expect(app.config.errorHandler).toBe(foreign)
    client.captureException(new Error('Still owned by application'))
    expect(events).toHaveLength(1)
  })

  it('keeps original callback arguments and exceptions, and rejects another client', () => {
    const { client } = setup()
    const other = setup().client
    const app = createApp({})
    const failure = new Error('Foreign handler failure')
    let observed: unknown[] = []
    app.config.errorHandler = function (...args) {
      observed = [this, ...args]
      throw failure
    }
    const integration = instrumentVue(app, client)
    expect(() => instrumentVue(app, other)).toThrow('different client')
    const error = new Error('Original')
    expect(() =>
      app.config.errorHandler!.call(app.config, error, null, 'render'),
    ).toThrow(failure)
    expect(observed).toEqual([app.config, error, null, 'render'])
    integration.uninstall()
  })

  it('uses Nuxt hooks without replacing Vue handlers and stores template navigation only', async () => {
    const { client, events } = setup()
    const hooks = createHooks()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => h('p', 'Home') } },
        { path: '/items/:id', component: { render: () => h('p', 'Item') } },
      ],
    })
    const integration = instrumentNuxtClient(hooks, client, router)
    expect(instrumentNuxtClient(hooks, client, router)).toBe(integration)
    cleanup.push(() => integration.uninstall())
    await hooks.callHook(
      'app:error',
      Object.assign(new Error('Expected missing route'), { statusCode: 404 }),
    )
    expect(events).toHaveLength(0)
    await router.push('/')
    await router.push('/items/private-person?token=private-secret#private-fragment')
    await router.push('/items/other-person')
    const error = new Error('Nuxt render failure')
    await hooks.callHook('vue:error', error, { privateProp: 'never-read' }, 'render')
    await hooks.callHook('app:error', error)
    client.captureException(error)
    expect(events).toHaveLength(1)
    expect(events[0]?.contexts?.nuxt).toEqual({ runtime: 'client', phase: 'vue:error' })
    const encoded = JSON.stringify(events)
    expect(encoded).toContain('/items/:id')
    for (const secret of [
      'private-person',
      'private-secret',
      'private-fragment',
      'other-person',
      'privateProp',
      'never-read',
    ])
      expect(encoded).not.toContain(secret)
    expect(
      events[0]?.breadcrumbs?.values?.filter(
        (entry) => entry.category === 'navigation',
      ),
    ).toHaveLength(3)
    integration.uninstall()
    await hooks.callHook('app:error', new Error('After uninstall'))
    expect(events).toHaveLength(1)
  })

  it('preserves disabled client behavior through real Vue dispatch', async () => {
    const { client, events } = setup(false)
    let handled = 0
    const app = createApp({
      render: () =>
        h(
          'button',
          {
            onClick: () => {
              throw new Error('Disabled')
            },
          },
          'Work',
        ),
    })
    const previous = (app.config.errorHandler = () => {
      handled++
    })
    instrumentVue(app, client)
    const container = document.createElement('div')
    document.body.append(container)
    app.mount(container)
    container.querySelector('button')!.click()
    await nextTick()
    app.unmount()
    expect(app.config.errorHandler).toBe(previous)
    expect(handled).toBe(1)
    expect(events).toHaveLength(0)
  })

  it('keeps the application callback when the actual SDK beforeSend fails', async () => {
    const client = new Client({
      endpointUrl: 'https://localhost.invalid',
      projectId: 'vue',
      publicKey: '0123456789abcdef0123456789abcdef',
      autoInstall: false,
      beforeSend() {
        throw new Error('Reporting unavailable')
      },
    })
    cleanup.push(() => client.close())
    let handled = 0
    const app = createApp({})
    app.config.errorHandler = () => {
      handled++
    }
    const integration = instrumentVue(app, client)
    app.config.errorHandler!(new Error('Application failure'), null, 'render')
    expect(handled).toBe(1)
    expect(client.stats.toObject().dropped).toBeGreaterThan(0)
    integration.uninstall()
  })
})
