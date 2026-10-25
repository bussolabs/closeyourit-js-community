'use strict'
// Stand-in for node-forge in the Nuxt 3 example (CYJS-54). listhen imports it when
// the dev server module loads, but only uses it to create HTTPS certificates.
// Loading must succeed so that `nuxt build` keeps working; any real use fails with
// an explicit error instead. The getters are not enumerable, so interop helpers
// that copy properties do not trigger them.
const message =
  'node-forge is an empty stub in the CloseYourIt Nuxt 3 example, so the HTTPS ' +
  'development server is not available here. Remove the node-forge override ' +
  'from examples/nuxt3/package.json once a fixed node-forge release exists.'
const namespaces = [
  'asn1',
  'cipher',
  'hmac',
  'md',
  'md5',
  'pem',
  'pkcs12',
  'pkcs5',
  'pkcs7',
  'pki',
  'random',
  'rsa',
  'sha1',
  'sha256',
  'sha512',
  'ssh',
  'tls',
  'util',
]
const forge = {}
for (const name of namespaces)
  Object.defineProperty(forge, name, {
    enumerable: false,
    get() {
      throw new Error(message)
    },
  })
module.exports = forge
