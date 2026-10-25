const assert = require('node:assert/strict')
const React = require('react')
const renderer = require('react-test-renderer')
const { Client } = require('@bussolabs/closeyourit-js')
const { ErrorBoundary } = require('@bussolabs/closeyourit-js/react')

async function main() {
  const events = []
  const client = new Client({
    endpointUrl: 'http://127.0.0.1:1',
    publicKey: '0123456789abcdef0123456789abcdef',
    projectId: 'construction-only',
    environment: 'certification',
    autoInstall: false,
    beforeSend: (event) => {
      events.push(event)
      return null
    },
  })
  let root
  try {
    renderer.act(() => {
      root = renderer.create(
        React.createElement(
          ErrorBoundary,
          { client, fallback: 'Recovered', key: 'healthy' },
          'Healthy',
        ),
      )
    })
    assert.equal(root.toJSON(), 'Healthy')
    assert.equal(events.length, 0)
    for (const id of ['one', 'two', 'three']) {
      const failure = new Error(`React ${id}`)
      function Broken() {
        throw failure
      }
      renderer.act(() => {
        root.update(
          React.createElement(
            ErrorBoundary,
            { client, fallback: 'Recovered', key: id },
            React.createElement(Broken),
          ),
        )
      })
      assert.equal(root.toJSON(), 'Recovered')
      client.captureException(failure)
    }
    assert.equal(events.length, 3)
    for (const event of events)
      assert.equal(event.exception.values[0].mechanism.handled, true)
    renderer.act(() => root.update(React.createElement('p', null, 'Uninstalled')))
    assert.equal(root.toJSON().children[0], 'Uninstalled')
    assert.equal(client.enabled, true)
    process.stdout.write(
      JSON.stringify({
        react: React.version,
        errors: events.length,
        delivery_verified: false,
      }),
    )
  } finally {
    if (root) renderer.act(() => root.unmount())
    await client.close()
  }
}
main().catch((error) => {
  process.stderr.write(`React package proof failed: ${error.message}\n`)
  process.exitCode = 1
})
