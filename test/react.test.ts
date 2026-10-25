import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from '../src/client'
import { ErrorBoundary, createReactErrorHandlers } from '../src/react'
import type { EventPayload } from '../src/types'

const roots: ReturnType<typeof createRoot>[] = []
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterAll(() => vi.unstubAllGlobals())
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount())
  document.body.replaceChildren()
})

function setup() {
  const events: EventPayload[] = []
  const client = new Client({
    endpointUrl: 'https://localhost.invalid',
    projectId: 'react-proof',
    publicKey: '0123456789abcdef0123456789abcdef',
    autoInstall: false,
    beforeSend: (event) => {
      events.push(event)
      return null
    },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container, createReactErrorHandlers(client))
  roots.push(root)
  return { client, events, container, root }
}

describe('React integration with the actual renderer', () => {
  it('preserves the boundary fallback and deduplicates root and boundary capture', async () => {
    const { client, events, container, root } = setup()
    const failure = new Error('React render failure')
    function Broken(): never {
      throw failure
    }
    await act(() =>
      root.render(
        createElement(
          ErrorBoundary,
          {
            client,
            fallback: createElement('p', null, 'Application fallback'),
          },
          createElement(Broken),
        ),
      ),
    )
    expect(container.textContent).toBe('Application fallback')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      exception: { values: [{ mechanism: { handled: true } }] },
    })
    client.captureException(failure)
    expect(events).toHaveLength(1)
    await client.close()
  })

  it('does not capture successful rendering or close the application client on unmount', async () => {
    const { client, events, container, root } = setup()
    await act(() =>
      root.render(createElement(ErrorBoundary, { client, fallback: null }, 'Healthy')),
    )
    expect(container.textContent).toBe('Healthy')
    expect(events).toHaveLength(0)
    await act(() => root.unmount())
    roots.pop()
    client.captureException(new Error('Application retains its client'))
    expect(events).toHaveLength(1)
    await client.close()
  })

  it('keeps recoverable errors opt-in and preserves uncaught classification', async () => {
    const { client, events } = setup()
    const handlers = createReactErrorHandlers(client)
    handlers.onRecoverableError(new Error('Recovered hydration'), {
      componentStack: '',
    })
    expect(events).toHaveLength(0)
    handlers.onUncaughtError(new Error('Uncaught renderer failure'), {
      componentStack: '',
    })
    expect(events[0]).toMatchObject({
      exception: { values: [{ mechanism: { handled: false } }] },
    })
    createReactErrorHandlers(client, {
      captureRecoverableErrors: true,
    }).onRecoverableError(new Error('Opted in recovery'), { componentStack: '' })
    expect(events).toHaveLength(2)
    await client.close()
  })
})
