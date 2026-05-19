// W436 — artifact verify manifest_hash_mismatch envelope (DoD step 9 closer).
//
// The 2026-05-19 audit named this as a P0-DoD gap: /v1/verify/:cid returned
// `verified:true` for any registered artifact without ever recomputing the
// content-addressed CID from the manifest's hashes block. An auditor could
// not tell from the response whether the bytes still match the claimed CID.
//
// W436 wires real verification:
//   #1 /v1/verify/:cid uses cidFromManifestHashes when registry row carries
//      a manifest hashes block.
//   #2 Mismatch returns 200 + verified:false + error:'manifest_hash_mismatch'
//      + expected_cid + actual_cid.
//   #3 Match returns verified:true + manifest_hash_verified:true.
//   #4 New stateless POST /v1/artifact/verify-manifest endpoint:
//      - body {cid, hashes} → recompute + compare.
//      - mismatch → 200 + verified:false + error:'manifest_hash_mismatch'.
//      - match    → 200 + verified:true.
//      - missing inputs → 400 with explicit error.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { cidFromManifestHashes } from '../src/cid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');

// Synthetic hashes block — 5 required parts, each a 64-char hex sha256.
function fakeHashes(seed) {
  const h = (s) => {
    // deterministic 64-hex from a seed string
    let acc = '';
    let v = 0;
    for (let i = 0; i < s.length; i++) v = (v * 31 + s.charCodeAt(i)) >>> 0;
    for (let i = 0; i < 8; i++) {
      v = (v * 1103515245 + 12345) >>> 0;
      acc += v.toString(16).padStart(8, '0');
    }
    return acc.slice(0, 64);
  };
  return {
    model_pointer: h(seed + ':model'),
    recipes_json:  h(seed + ':recipes'),
    lora_bin:      h(seed + ':lora'),
    index_bin:     h(seed + ':index'),
    evals_json:    h(seed + ':evals'),
  };
}

test('W436 #1 — router imports cidFromManifestHashes from ./cid.js', () => {
  const src = routerSrc();
  assert.ok(
    /cidFromManifestHashes\s*,?\s*[^}]*\}\s*from\s*['"]\.\/cid\.js['"]/.test(src) ||
    /from\s*['"]\.\/cid\.js['"][^;]*cidFromManifestHashes/.test(src),
    'router must import cidFromManifestHashes from ./cid.js'
  );
});

test('W436 #2 — /v1/verify/:cid recomputes hash when manifest hashes present', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.get('/v1/verify/:cid'");
  assert.ok(idx !== -1, '/v1/verify/:cid route must exist');
  const block = src.slice(idx, idx + 4000);
  assert.ok(/cidFromManifestHashes\s*\(\s*hashes\s*\)/.test(block),
    'verify handler must call cidFromManifestHashes(hashes)');
  assert.ok(/manifest_hash_mismatch/.test(block),
    'verify handler must surface manifest_hash_mismatch envelope');
  assert.ok(/expected_cid:\s*recomputed/.test(block),
    'mismatch envelope must include expected_cid');
  assert.ok(/actual_cid:\s*normalized/.test(block),
    'mismatch envelope must include actual_cid');
});

test('W436 #3 — POST /v1/artifact/verify-manifest route declared', () => {
  const src = routerSrc();
  assert.ok(/r\.post\(\s*['"]\/v1\/artifact\/verify-manifest['"]/.test(src),
    'POST /v1/artifact/verify-manifest must exist');
});

test('W436 #4 — verify-manifest handler validates inputs and computes hash', () => {
  const src = routerSrc();
  const idx = src.indexOf("r.post('/v1/artifact/verify-manifest'");
  const block = src.slice(idx, idx + 2000);
  assert.ok(/cidFromManifestHashes\s*\(\s*hashes\s*\)/.test(block),
    'must compute recomputed cid via cidFromManifestHashes');
  assert.ok(/manifest_hash_mismatch/.test(block),
    'must return manifest_hash_mismatch on disagreement');
  assert.ok(/verified:\s*true/.test(block),
    'match path must return verified:true');
});

test('W436 #5 — behavior: verify-manifest returns verified:true when cid matches', async () => {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const hashes = fakeHashes('match-case');
    const correctCid = cidFromManifestHashes(hashes);
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/artifact/verify-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: correctCid, hashes }),
    });
    assert.equal(r1.status, 200, 'match case must 200');
    const body = await r1.json();
    assert.equal(body.verified, true, 'verified must be true on match');
    assert.equal(body.cid, correctCid, 'echo back the cid');
    assert.equal(body.expected_cid, correctCid);
    assert.equal(body.actual_cid, correctCid);
    assert.equal(body.manifest_hash_verified, true);
  } finally {
    server.close();
  }
});

test('W436 #6 — behavior: verify-manifest returns manifest_hash_mismatch on disagreement', async () => {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const hashes = fakeHashes('mismatch-case-a');
    const otherHashes = fakeHashes('mismatch-case-b');
    const claimedCid = cidFromManifestHashes(otherHashes); // mismatch
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/artifact/verify-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: claimedCid, hashes }),
    });
    assert.equal(r1.status, 200, 'mismatch case still 200 (it is a verdict, not an error)');
    const body = await r1.json();
    assert.equal(body.verified, false, 'verified must be false on mismatch');
    assert.equal(body.error, 'manifest_hash_mismatch');
    assert.ok(body.expected_cid && body.expected_cid !== body.actual_cid,
      'expected_cid (recomputed) must differ from actual_cid (claimed)');
    assert.equal(body.actual_cid, claimedCid);
  } finally {
    server.close();
  }
});

test('W436 #7 — behavior: verify-manifest 400s on missing inputs', async () => {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    // Missing both cid + hashes.
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/artifact/verify-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r1.status, 400);
    const b1 = await r1.json();
    assert.equal(b1.ok, false);
    // Missing hashes only.
    const r2 = await fetch(`http://127.0.0.1:${port}/v1/artifact/verify-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: 'cidv1:sha256:' + 'a'.repeat(64) }),
    });
    assert.equal(r2.status, 400);
    // Invalid hashes (missing required parts).
    const r3 = await fetch(`http://127.0.0.1:${port}/v1/artifact/verify-manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: 'cidv1:sha256:' + 'a'.repeat(64), hashes: { incomplete: 'yes' } }),
    });
    assert.equal(r3.status, 400);
    const b3 = await r3.json();
    assert.equal(b3.error, 'invalid_hashes');
  } finally {
    server.close();
  }
});
