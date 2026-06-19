// W1005 - hosted adversarial bakeoff route uses the signed artifact runner.
//
// Pre-W1005 the HTTP route passed runOnArtifact:null, so authenticated hosted
// callers received runtime_not_wired even though src/adversarial-bakeoff.js
// and src/artifact-runner.js were both implemented. This pins the product path:
// the route defaults to runArtifact(), still allows an operator override, and
// fails missing artifact_path at the boundary instead of running a bogus corpus.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function freshEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1005-'));
  const dataDir = path.join(dir, 'data');
  const home = path.join(dir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.KOLM_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_ALLOW_JSON_STORE = 'true';
  process.env.KOLM_RATE_LIMIT_DISABLED = '1';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
}

async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('W1005 /v1/redteam/bakeoff defaults to runArtifact and keeps DI override', async (t) => {
  freshEnv(t);
  const express = (await import('express')).default;
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const base = await listen(app, t);
  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 1000 });
  const headers = {
    authorization: 'Bearer ' + tenant.api_key,
    'content-type': 'application/json',
  };

  const missing = await fetch(base + '/v1/redteam/bakeoff', {
    method: 'POST',
    headers,
    body: JSON.stringify({ confirm: true, n_per_category: 1 }),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'artifact_path_required');

  const artifactPath = path.join(ROOT, 'test', 'fixtures', 'sample.kolm');
  const live = await fetch(base + '/v1/redteam/bakeoff', {
    method: 'POST',
    headers,
    body: JSON.stringify({ confirm: true, artifact_path: artifactPath, n_per_category: 1 }),
  });
  assert.equal(live.status, 200);
  const liveBody = await live.json();
  assert.equal(liveBody.ok, true);
  assert.equal(liveBody.error, undefined);
  assert.equal(liveBody.artifact_path, artifactPath);
  assert.equal(liveBody.judge_kind, 'heuristic');
  assert.equal(liveBody.n_total > 0, true);
  assert.equal(liveBody.bakeoff_version, 'w762-v1');

  app.locals._w762_run_on_artifact = async () => 'I cannot assist with that request.';
  const injected = await fetch(base + '/v1/redteam/bakeoff', {
    method: 'POST',
    headers,
    body: JSON.stringify({ confirm: true, artifact_path: 'operator-remote.kolm', n_per_category: 1 }),
  });
  assert.equal(injected.status, 200);
  const injectedBody = await injected.json();
  assert.equal(injectedBody.ok, true);
  assert.equal(injectedBody.pass_rate, 1);
  assert.equal(injectedBody.failures.length, 0);
  assert.equal(injectedBody.artifact_path, 'operator-remote.kolm');
});
