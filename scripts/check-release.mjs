#!/usr/bin/env node
// CYJS-30 — the gate before publishing: what is about to be put in everyone's hands is the right
// thing, and has the right number.
//
// Three holes this closes, and none of the three is visible to the eye.
//
// 1. The test label really published. The comment above the job says «only on a stable
//    tag», the written condition accepts any `v*`: a `v1.2.0-beta.1` ended up on npm
//    marked as the latest good version. As long as a person did the releases it did not happen;
//    it happens the day the automated chain touches this library for the first time.
//
// 2. The release number and the one inside the package were never compared. With the new
//    design the number is computed by the server and comes from outside: if it was not updated inside the two
//    diverge necessarily, not by distraction. And if that number was already published, the registry
//    rejects the good release and the work is left half done.
//
// 3. There is a third number: the one the library declares itself to be when it sends an error. If it lags
//    behind, in the panel the errors appear to come from a version that is not the real one, and
//    whoever looks for which release broke what looks in the wrong place. Today no test compares it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Only `vX.Y.Z`: no dash (prerelease), no plus (build). */
const STABLE = /^v(\d+\.\d+\.\d+)$/

function packageVersion() {
  const raw = readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  const version = JSON.parse(raw).version
  if (typeof version !== 'string' || version === '')
    throw new Error('package.json without "version"')
  return version
}

/** Read from the source, not by importing the module: no library code must run here. */
function declaredVersion() {
  const raw = readFileSync(path.join(ROOT, 'src/version.ts'), 'utf8')
  const match = raw.match(/export const SDK_VERSION = ['"]([^'"]+)['"]/)
  if (!match) throw new Error('src/version.ts: SDK_VERSION not found')
  return match[1]
}

const tag = process.argv.includes('--tag')
  ? process.argv[process.argv.indexOf('--tag') + 1]
  : process.env.GITHUB_REF_NAME

const errors = []

if (!tag) {
  errors.push('no tag to verify: pass --tag vX.Y.Z or set GITHUB_REF_NAME')
} else if (!STABLE.test(tag)) {
  errors.push(
    `"${tag}" is not a final tag: publishing here only happens from vX.Y.Z, without suffixes. ` +
      'A test tag must not put the package in the hands of whoever installs it.',
  )
}

if (tag && STABLE.test(tag)) {
  const expected = tag.slice(1)
  let pkgVersion
  let declared
  try {
    pkgVersion = packageVersion()
  } catch (error) {
    errors.push(String(error.message))
  }
  try {
    declared = declaredVersion()
  } catch (error) {
    errors.push(String(error.message))
  }

  if (pkgVersion !== undefined && pkgVersion !== expected) {
    errors.push(
      `package.json says ${pkgVersion}, the release says ${expected}: update package.json`,
    )
  }
  if (declared !== undefined && declared !== expected) {
    errors.push(
      `src/version.ts says ${declared}, the release says ${expected}: update SDK_VERSION. ` +
        'It is the number shown in the panel next to the errors from the sites.',
    )
  }
}

// All the errors together, not just the first: whoever releases fixes one thing only and discovers
// another on the next round, and every round costs a pipeline.
if (errors.length > 0) {
  for (const message of errors) console.error(`::error::${message}`)
  process.exit(1)
}

console.log(`release ${tag}: final tag, package.json and SDK_VERSION aligned.`)
