'use client'
import { useEffect, useState } from 'react'
import { init } from '@bussolabs/closeyourit-js'
import { ErrorBoundary } from '@bussolabs/closeyourit-js/react'

function Broken() {
  throw new Error('Next browser render failure')
}

export default function ProofClient({ configuration }) {
  const [client, setClient] = useState(null)
  const [broken, setBroken] = useState(false)
  const [result, setResult] = useState('Not requested')
  const [events, setEvents] = useState([])
  useEffect(() => {
    setClient(
      init({
        ...configuration,
        beforeSend(payload) {
          if (payload.event_id)
            setEvents((previous) => [
              ...previous.slice(-9),
              { event_id: payload.event_id, trace_id: payload.trace_id },
            ])
          return payload
        },
      }),
    )
  }, [configuration])
  if (!client) return <p>Waiting for browser initialization</p>
  async function request() {
    const response = await fetch('/api/work/one', {
      headers: client.getTraceHeaders(location.origin + '/api/work/one'),
    })
    const value = await response.json()
    setResult(JSON.stringify(value))
  }
  return (
    <section>
      <button onClick={() => setBroken(true)}>Fail browser render</button>
      <button onClick={request}>Send correlated request</button>
      <output>{result}</output>
      <output data-browser-events>{JSON.stringify(events)}</output>
      <ErrorBoundary client={client} fallback={<p>Application fallback</p>}>
        {broken ? <Broken /> : <p>Healthy browser render</p>}
      </ErrorBoundary>
    </section>
  )
}
