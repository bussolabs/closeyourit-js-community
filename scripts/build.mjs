import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
// A per-entry tsup clean can delete another entry's declarations while workers run.
rmSync(join(root, 'dist'), { recursive: true, force: true })
execFileSync(process.execPath, [require.resolve('tsup/dist/cli-default.js')], {
  cwd: root,
  stdio: 'inherit',
})
