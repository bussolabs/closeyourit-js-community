'use client'
export default function ErrorPage({ reset }) {
  // Server errors are reported by onRequestError, not recaptured from the redacted digest.
  return (
    <main>
      <p>Application error fallback</p>
      <button onClick={reset}>Reset application</button>
    </main>
  )
}
