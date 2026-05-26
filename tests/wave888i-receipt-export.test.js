// W888-I ship-gate check #10 — Receipt export works across formats.
//
// Pin `kolm receipts export --format <jsonl|json|csv>` to produce a file that
// downstream readers can parse round-trip, with the right row count.
//
// The /v1/receipts/list endpoint projects observation rows that carry a
// receipt_id. We seed three observations into the on-disk store so the export
// has rows to fold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const KOLM_CLI = path.join(ROOT, 'cli', 'kolm.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

let serverProc = null;
let serverBase = null;
let serverApiKey = null;
let scratchDir = null;

test('W888-I #10 setup — boot server with seeded receipts', async () => {
  const PORT = await freePort();
  serverBase = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-w888i-rcexport-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(scratchDir, 'exports'), { recursive: true });

  const tenantId = 't_w888i_rcexport';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: 'w888i-rcexport',
      email: 'w888i-rcexport@example.com',
      plan: 'enterprise',
      quota: 50_000_000,
      seats: 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  serverApiKey = 'ks_w888i_rcexport_smoke_key_cccccccccccccccccccccccccccc';
  const crypto = await import('node:crypto');
  const keyHash = crypto.createHash('sha256').update(serverApiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_w888i_rcexport',
      tenant_id: tenantId,
      hash: keyHash,
      label: 'w888i-rcexport',
      kind: 'user',
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  ]), 'utf8');

  // Seed three observations with receipt_id set so /v1/receipts/list picks them up.
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: `obs_rc_${i}`,
      tenant_id: tenantId,
      corpus_namespace: 'default',
      provider: i === 2 ? 'local' : 'openai',
      model: 'gpt-4o-mini',
      review_status: 'approved',
      risk_score: 0.0,
      redaction_applied: [],
      confidence: 0.9,
      latency_ms: 120 + i,
      cost_usd: 0.0002,
      variable_input: `seed prompt ${i}`,
      response: `seed response ${i}`,
      input_tokens: 10 + i,
      output_tokens: 20 + i,
      created_at: new Date(now + i * 1000).toISOString(),
      receipt_id: `rcpt_w888i_export_${i}`,
    });
  }
  fs.writeFileSync(path.join(dataDir, 'observations.json'), JSON.stringify(rows), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      DEFAULT_TENANT: 'w888i-rcexport',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(serverBase);
});

test('W888-I #10 — receipts export --format jsonl produces newline-delimited JSON', () => {
  const out = path.join(scratchDir, 'exports', 'rcs.jsonl');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'receipts', 'export', '--format', 'jsonl', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `jsonl export exit=${r.status} stderr=${(r.stderr||'').slice(0,200)} stdout=${(r.stdout||'').slice(0,200)}`);
  const lines = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 3, 'jsonl must hold 3 receipt rows');
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.ok(obj.receipt_id, 'each receipt row must carry receipt_id');
  }
});

test('W888-I #10 — receipts export --format json produces an array', () => {
  const out = path.join(scratchDir, 'exports', 'rcs.json');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'receipts', 'export', '--format', 'json', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `json export exit=${r.status} stderr=${(r.stderr||'').slice(0,200)}`);
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(Array.isArray(arr) && arr.length === 3, 'json must be array of 3');
});

test('W888-I #10 — receipts export --format csv produces RFC-4180 file with header + rows', () => {
  const out = path.join(scratchDir, 'exports', 'rcs.csv');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'receipts', 'export', '--format', 'csv', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `csv export exit=${r.status} stderr=${(r.stderr||'').slice(0,200)}`);
  const text = fs.readFileSync(out, 'utf8');
  const lines = text.split(/\r\n/).filter(Boolean);
  // 1 header + 3 data rows.
  assert.equal(lines.length, 4, 'csv must have 1 header + 3 data rows');
  // Header must list canonical kolm-audit-1 columns.
  const header = lines[0].split(',');
  assert.ok(header.includes('schema_version'), 'csv header must include schema_version');
  assert.ok(header.includes('receipt_id'), 'csv header must include receipt_id');
  assert.ok(header.includes('route_decision'), 'csv header must include route_decision');
  // Every data row should have the same column count as the header (no
  // unescaped commas snuck in).
  for (let i = 1; i < lines.length; i++) {
    // Naive split is OK because the seeded rows contain no commas in their
    // values. RFC-4180 escaping is tested by the wrapper-cli unit tests.
    const cells = lines[i].split(',');
    assert.equal(cells.length, header.length, `row ${i} column count mismatch`);
  }
});

test('W888-I #10 teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});
