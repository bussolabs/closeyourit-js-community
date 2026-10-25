import { publicConfiguration } from '../proof-server'
import ProofClient from './proof-client'
import { failAction } from './actions'

export const dynamic = 'force-dynamic'
export default function Page() {
  return (
    <main>
      <h1>React and Next SDK laboratory</h1>
      <ProofClient configuration={publicConfiguration()} />
      <form action={failAction}>
        <button type="submit">Fail server action</button>
      </form>
    </main>
  )
}
