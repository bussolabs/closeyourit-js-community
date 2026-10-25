// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { compile } from 'svelte/compiler'
import { expect, it } from 'vitest'

it('preserves the real compiled Svelte boundary fallback and reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cyi-svelte-render-'))
  const source = `<script>
    let { onerror } = $props(); let failure = $state(0);
    export function fail() { failure++; }
    function render(value) { if (value) throw new Error('Actual Svelte render ' + value); return 'usable'; }
  </script>
  <svelte:boundary {onerror}><p>{render(failure)}</p>
  {#snippet failed(error, reset)}<button onclick={() => { failure = 0; reset(); }}>recover</button>{/snippet}
  </svelte:boundary>`
  const code = compile(source, {
    filename: 'ActualBoundary.svelte',
    generate: 'client',
    dev: false,
    discloseVersion: false,
  }).js.code.replace(
    /from 'svelte\/internal\/client'/g,
    `from '${import.meta.resolve('svelte/internal/client')}'`,
  )
  writeFileSync(join(directory, 'component.mjs'), code)
  const script = `
import assert from 'node:assert/strict';
import { JSDOM } from ${JSON.stringify(import.meta.resolve('jsdom'))};
const dom = new JSDOM('<main></main>', { url: 'https://example.invalid', pretendToBeVisual: true });
for (const name of ['window','document','navigator','Node','Element','HTMLElement','HTMLButtonElement','Text','Comment','Event','CustomEvent','MutationObserver']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
const { mount, unmount, flushSync } = await import(${JSON.stringify(pathToFileURL(resolve('node_modules/svelte/src/index-client.js')).href)});
const { createSvelteBoundaryHandler } = await import(${JSON.stringify(pathToFileURL(resolve('src/svelte.ts')).href)});
const { default: Component } = await import('./component.mjs');
const captured = []; let policies = 0;
const integration = createSvelteBoundaryHandler({ captureException(error, hint) { captured.push({ message: error.message, hint }); } }, () => { policies++; });
const target = document.querySelector('main');
const instance = mount(Component, { target, props: { onerror: integration.onError } });
flushSync(); assert.equal(target.textContent, 'usable');
flushSync(() => instance.fail()); assert.equal(target.textContent, 'recover');
assert.equal(policies, 1); assert.equal(captured.length, 1); assert.equal(captured[0].message, 'Actual Svelte render 1'); assert.equal(captured[0].hint.handled, true);
flushSync(() => target.querySelector('button').click()); assert.equal(target.textContent, 'usable');
integration.uninstall(); flushSync(() => instance.fail()); assert.equal(target.textContent, 'recover');
assert.equal(policies, 2); assert.equal(captured.length, 1);
await unmount(instance); dom.window.close(); console.log(JSON.stringify({ policies, captured: captured.length }));
`
  writeFileSync(join(directory, 'render.mjs'), script)
  try {
    const output = execFileSync(process.execPath, [join(directory, 'render.mjs')], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64_000,
    })
    expect(JSON.parse(output)).toEqual({ policies: 2, captured: 1 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
