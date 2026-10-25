#!/usr/bin/env node
// Gate on the browser bundle size (CYJS-28). The measured file is
// `dist/closeyourit.min.js`, the one the snippet loads from jsDelivr: every byte
// added there is downloaded by ALL the visitors of ALL the sites that
// installed the SDK, even those who know nothing about the function just
// added. Without a committed cap the growth is invisible — no diff
// line says "+3 KB for everyone" — and the weight is noticed only from someone
// else's charts.
//
// The caps live in `bundle-budget.json`, next to the code: raising them is a
// decision, and as such goes through a review. Both the raw file and
// its brotli version, which is what really travels over the network, are measured.
//
// To be run AFTER `pnpm build` (in CI it is the step right after).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/// Path of the committed budget, relative to the repository root.
export const BUDGET_FILE = 'bundle-budget.json'

/// Raw and compressed (brotli) size of [bytes]. Brotli is what
/// counts: it is the form in which the CDN serves the file.
export function measureBundle(bytes) {
  return { raw: bytes.length, brotli: brotliCompressSync(bytes).length }
}

/// Compares the measurements with the declared caps and returns the list of
/// overruns (empty = everything within budget). [actual] and [limits] are
/// `{ raw, brotli }` maps; a measurement without a matching cap is not an
/// overrun, but it is not silenced either: `checkBundleSizes` reports it.
export function overBudget(file, actual, limits) {
  return Object.entries(limits)
    .filter(([kind, limit]) => actual[kind] > limit)
    .map(([kind, limit]) => ({
      file,
      kind,
      actual: actual[kind],
      limit,
      excess: actual[kind] - limit,
    }))
}

/// Measures every file of the budget and returns `{ rows, failures }`. Throws if a
/// declared file does not exist: a gate that stays silent when the artifact is missing is a
/// gate that protects nothing.
export function checkBundleSizes(root = repoRoot) {
  const budget = JSON.parse(readFileSync(join(root, BUDGET_FILE), 'utf8'))
  const rows = []
  const failures = []

  for (const [file, limits] of Object.entries(budget.files)) {
    const path = join(root, file)
    if (!existsSync(path)) {
      throw new Error(`${file} does not exist: run \`pnpm build\` first`)
    }
    const actual = measureBundle(readFileSync(path))
    rows.push({ file, actual, limits })
    failures.push(...overBudget(file, actual, limits))
  }

  return { rows, failures }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`
}

// Run directly (`pnpm size`), not imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { rows, failures } = checkBundleSizes()

    for (const { file, actual, limits } of rows) {
      for (const kind of Object.keys(limits)) {
        const headroom = limits[kind] - actual[kind]
        process.stdout.write(
          `• ${file} (${kind}): ${kb(actual[kind])} / ${kb(limits[kind])}` +
            ` — ${headroom >= 0 ? `${kb(headroom)} of headroom` : `${kb(-headroom)} over`}\n`,
        )
      }
    }

    if (failures.length > 0) {
      for (const { file, kind, actual, limit, excess } of failures) {
        console.error(
          `\n✗ ${file} (${kind}) weighs ${kb(actual)}, the cap is ${kb(limit)}: ${kb(excess)} too much.`,
        )
      }
      console.error(
        `\nEvery byte here is downloaded by every visitor of every site that installed the SDK.` +
          `\nIf the growth is intended and justified, raise the cap in ${BUDGET_FILE} in the same commit that introduces it.`,
      )
      process.exitCode = 1
    } else {
      console.log(`\n✓ bundle within the budget declared in ${BUDGET_FILE}`)
    }
  } catch (err) {
    console.error(`\n✗ bundle measurement FAILED: ${err.message}`)
    process.exitCode = 1
  }
}
