// W790 - direct contract test for packages/browser-extension/popup.js.
//
// This pins the browser-extension popup atom: bounded storage rendering,
// extension-storage failure tolerance, safe timestamp handling, and direct
// depth verification.

import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const POPUP_REL = 'packages/browser-extension/popup.js';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

async function runPopup({
  storage = {},
  now = 1_700_000_000_000,
  withChrome = true,
} = {}) {
  const storageCalls = [];
  const nodes = {
    ikey: { textContent: 'checking...', className: '' },
    last: { textContent: 'never', className: '' },
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const context = {
    document: {
      getElementById(id) {
        return nodes[id] || null;
      },
    },
    Date: FakeDate,
    chrome: withChrome
      ? {
          storage: {
            local: {
              async get(keys) {
                storageCalls.push(Array.from(keys));
                return storage;
              },
            },
          },
        }
      : undefined,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read(POPUP_REL), context, { filename: POPUP_REL });
  await context.KOLM_POPUP_READY;
  return { nodes, contract: context.KOLM_POPUP_CONTRACT, storageCalls };
}

test('W790 browser extension popup is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('packages/browser-extension/manifest.json');
  const source = read(POPUP_REL);

  assert.equal(
    pkg.scripts['verify:browser-extension-popup'],
    'node --test --test-concurrency=1 tests/wave790-browser-extension-popup-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && npm run verify:eval-safety-harnesses && npm run verify:worker-safety-contracts && npm run verify:compute-backends && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.match(source, /w790-browser-extension-popup-v1/);
  assert.match(source, /POPUP_LIMITS/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('W790 popup renders bounded issuer and last-verification status', async () => {
  const longKid = `issuer-${'x'.repeat(200)}`;
  const { nodes, contract, storageCalls } = await runPopup({
    now: 10_000,
    storage: {
      'kolm-issuer-pubkey-cache': { key: { kid: longKid }, ts: 9_000 },
      'kolm-last-verify': { ok: true, ts: 8_600, src: 'https://example.test/private.kolm' },
    },
  });

  assert.equal(contract.version, 'w790-browser-extension-popup-v1');
  assert.deepEqual(storageCalls, [['kolm-issuer-pubkey-cache', 'kolm-last-verify']]);
  assert.equal(contract.secret_values_included, false);
  assert.equal(Object.isFrozen(contract.limits), true);
  assert.equal(nodes.ikey.className, 'ok');
  assert.equal(nodes.ikey.textContent.length, contract.limits.max_kid_chars);
  assert.equal(nodes.last.textContent, '1s ago (OK)');
  assert.equal(nodes.last.className, 'ok');
  assert.doesNotMatch(JSON.stringify(nodes), /private\.kolm/);
});

test('W790 popup rejects malformed storage without rendering hostile values', async () => {
  const { nodes } = await runPopup({
    now: 10_000,
    storage: {
      'kolm-issuer-pubkey-cache': { key: { kid: 'good\u0000bad' }, ts: 9_000 },
      'kolm-last-verify': { ok: true, ts: 10_000 + 120_000 },
    },
  });

  assert.equal(nodes.ikey.textContent, 'baked-fallback');
  assert.equal(nodes.ikey.className, 'bad');
  assert.equal(nodes.last.textContent, 'never');
  assert.equal(nodes.last.className, '');
  assert.doesNotMatch(JSON.stringify(nodes), /good\u0000bad|120000/);
});

test('W790 popup fails closed when extension storage is unavailable', async () => {
  const { nodes, contract } = await runPopup({ withChrome: false });

  assert.equal(contract.version, 'w790-browser-extension-popup-v1');
  assert.deepEqual(Array.from(contract.storage_keys), ['kolm-issuer-pubkey-cache', 'kolm-last-verify']);
  assert.equal(nodes.ikey.textContent, 'storage-unavailable');
  assert.equal(nodes.ikey.className, 'bad');
  assert.equal(nodes.last.textContent, 'never');
});
