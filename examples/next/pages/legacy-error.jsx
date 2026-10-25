export async function getServerSideProps() {
  throw new Error('Next Pages SSR failure')
}
export default function LegacyError() {
  return <p>Unreachable</p>
}
