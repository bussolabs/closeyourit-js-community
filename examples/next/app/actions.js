'use server'
export async function failAction() {
  throw new Error('Next server action failure')
}
