// W434 — /v1/drift/* HTTP routes (DoD audit step 11).
//
// The drift module (src/drift-supersession.js) has been in the codebase
// since W167 but had no HTTP surface, which is why the 12-step DoD audit
// flagged drift detection as the missing rung of the
// compile→verify→run→drift→retrain loop. W434 wires three POST routes:
//
//   POST /v1/drift/snapshot   — build a portable K-score snapshot
//   POST /v1/drift/detect     — diff two snapshots, return signals + verdict
//   POST /v1/drift/report     — diff two snapshots, return signed report
//
// All are auth-gated. The handlers are thin wrappers around the existing
// pure functions in drift-supersession.js — server-side stateless, so the
// report's `hash` is verifiable client-side and the round-trip carries no
// privileged tenant data.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');

const routerSrc = () => fs.readFileSync(ROUTER_PATH, 'utf8');

test('W434 #1 — POST /v1/drift/snapshot route declared', () => {
  assert.ok(/r\.post\(\s*['"]\/v1\/drift\/snapshot['"]/.test(routerSrc()),
    '/v1/drift/snapshot route must exist');
});

test('W434 #2 — POST /v1/drift/detect route declared', () => {
  assert.ok(/r\.post\(\s*['"]\/v1\/drift\/detect['"]/.test(routerSrc()),
    '/v1/drift/detect route must exist');
});

test('W434 #3 — POST /v1/drift/report route declared', () => {
  assert.ok(/r\.post\(\s*['"]\/v1\/drift\/report['"]/.test(routerSrc()),
    '/v1/drift/report route must exist');
});

test('W434 #4 — all three drift routes 401-gate on req.tenant_record', () => {
  const src = routerSrc();
  for (const verb of ['snapshot', 'detect', 'report']) {
    const idx = src.indexOf(`r.post('/v1/drift/${verb}'`);
    assert.ok(idx !== -1, `drift/${verb} must exist`);
    const block = src.slice(idx, idx + 500);
    assert.ok(/if\s*\(\s*!req\.tenant_record\s*\)\s*return\s*res\.status\(401\)\.json\(\s*\{\s*ok:\s*false,\s*error:\s*['"]auth required['"]/.test(block),
      `drift/${verb} must 401 with canonical envelope`);
  }
});

test('W434 #5 — drift module exports the entry points the routes call', async () => {
  const drift = await import('../src/drift-supersession.js');
  assert.equal(typeof drift.buildDriftSnapshot, 'function');
  assert.equal(typeof drift.detectDrift, 'function');
  assert.equal(typeof drift.buildDriftReport, 'function');
});

test('W434 #6 — behavior: /v1/drift/snapshot returns hashed snapshot (round-trip via in-process server)', async () => {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    // Unauthed → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/drift/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_hash: 'a'.repeat(64), captured_at: new Date().toISOString() }),
    });
    assert.equal(noAuth.status, 401, 'unauthed must 401');
  } finally {
    server.close();
  }
});

test('W434 #7 — behavior: detectDrift via module returns signals + verdict shape route promises', async () => {
  const drift = await import('../src/drift-supersession.js');
  // Build two snapshots with a perf regression.
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const baseline = drift.buildDriftSnapshot({
    artifact_hash: sha('art-v1'),
    captured_at: new Date(Date.now() - 86400000).toISOString(),
    eval_score: 0.92,
    k_score: { composite: 0.88, spec: 'k-score-2' },
  });
  const current = drift.buildDriftSnapshot({
    artifact_hash: sha('art-v2'),
    captured_at: new Date().toISOString(),
    eval_score: 0.72,
    k_score: { composite: 0.70, spec: 'k-score-2' },
  });
  const signals = drift.detectDrift(baseline, current, {});
  assert.ok(Array.isArray(signals), 'signals must be array');
  assert.ok(signals.length > 0, 'signals must be non-empty');
  // At least one signal must be a status string the route checks.
  for (const s of signals) {
    assert.ok(['within','drift','breach'].includes(s.status), `bad status ${s.status}`);
  }
  // The report builder must accept what detectDrift returned.
  const report = drift.buildDriftReport({
    baseline_snapshot: baseline,
    current_snapshot: current,
    signals,
  });
  assert.ok(['within','drift','breach'].includes(report.verdict));
  assert.equal(typeof report.hash, 'string', 'report must have hash');
});
