// W888-I ship-gate check #9 — Capture export works across formats.
//
// Pin `kolm captures export --format <jsonl|json|parquet|hf>` to:
//   1. Stream the live /v1/captures/list page set into the requested format.
//   2. Produce an output file the format's canonical reader can parse.
//   3. Report a row count that matches what the server returned.
//
// We seed three real observations into the on-disk store so the export has
// real rows to fold; the format-specific readers (line-split for jsonl,
// JSON.parse for json, parquetjs-lite ParquetReader for parquet, apache-arrow
// RecordBatchFileReader for hf) verify the file shape.

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

function seedCaptureRows(dataDir, tenantId) {
  // capture-store JSON driver writes to data/observations.json. The shape we
  // emit matches the columns the captures/list handler projects (id,
  // created_at, namespace, provider, model, status, risk_score, etc.).
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: `obs_w888i_export_${i}`,
      tenant_id: tenantId,
      corpus_namespace: 'default',
      provider: 'openai',
      model: 'gpt-4o-mini',
      review_status: 'pending',
      risk_score: 0.0,
      redaction_applied: [],
      confidence: 0.9,
      latency_ms: 100 + i,
      cost_usd: 0.0001,
      variable_input: `seed prompt ${i}`,
      response: `seed response ${i}`,
      created_at: new Date(now + i * 1000).toISOString(),
      receipt_id: `rcpt_w888i_export_${i}`,
    });
  }
  fs.writeFileSync(path.join(dataDir, 'observations.json'), JSON.stringify(rows), 'utf8');
}

let serverProc = null;
let serverBase = null;
let serverApiKey = null;
let scratchDir = null;

test('W888-I #9 setup — boot server with seeded captures', async (t) => {
  const PORT = await freePort();
  serverBase = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-w888i-capexport-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  const exportDir = path.join(scratchDir, 'exports');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  const tenantId = 't_w888i_capexport';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    {
      id: tenantId,
      name: 'w888i-capexport',
      email: 'w888i-capexport@example.com',
      plan: 'enterprise',
      quota: 50_000_000,
      seats: 1,
      created_at: new Date().toISOString(),
    },
  ]), 'utf8');

  serverApiKey = 'ks_w888i_capexport_smoke_key_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const crypto = await import('node:crypto');
  const keyHash = crypto.createHash('sha256').update(serverApiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    {
      id: 'apik_w888i_capexport',
      tenant_id: tenantId,
      hash: keyHash,
      label: 'w888i-capexport',
      kind: 'user',
      created_at: new Date().toISOString(),
      revoked_at: null,
    },
  ]), 'utf8');

  seedCaptureRows(dataDir, tenantId);

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
      DEFAULT_TENANT: 'w888i-capexport',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  await waitForHealth(serverBase);
});

test('W888-I #9 — captures export --format jsonl produces newline-delimited JSON file', async () => {
  const out = path.join(scratchDir, 'exports', 'caps.jsonl');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'captures', 'export', '--format', 'jsonl', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `export exit=${r.status} stderr=${(r.stderr||'').slice(0,200)} stdout=${(r.stdout||'').slice(0,200)}`);
  assert.ok(fs.existsSync(out), 'jsonl file must exist');
  const lines = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 3, 'jsonl must contain exactly the 3 seeded rows');
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.ok(obj.id, 'row must carry id');
    assert.ok(obj.timestamp, 'row must carry timestamp');
  }
});

test('W888-I #9 — captures export --format json produces an array of rows', async () => {
  const out = path.join(scratchDir, 'exports', 'caps.json');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'captures', 'export', '--format', 'json', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `export exit=${r.status} stderr=${(r.stderr||'').slice(0,200)}`);
  assert.ok(fs.existsSync(out), 'json file must exist');
  const arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(Array.isArray(arr), 'json output must be an array');
  assert.equal(arr.length, 3, 'json must contain 3 seeded rows');
});

test('W888-I #9 — captures export --format parquet produces a parquetjs-lite-readable file', async () => {
  const out = path.join(scratchDir, 'exports', 'caps.parquet');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'captures', 'export', '--format', 'parquet', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `parquet export exit=${r.status} stderr=${(r.stderr||'').slice(0,400)}`);
  assert.ok(fs.existsSync(out), 'parquet file must exist');
  // Read back via parquetjs-lite to verify the file is structurally valid.
  let pq;
  try {
    const mod = await import('parquetjs-lite');
    pq = mod && mod.ParquetReader ? mod : mod.default;
  } catch (e) {
    assert.fail('parquetjs-lite not installed; cannot validate parquet export: ' + e.message);
  }
  const reader = await pq.ParquetReader.openFile(out);
  let rowCount = 0;
  const cursor = reader.getCursor();
  // eslint-disable-next-line no-await-in-loop
  while ((await cursor.next())) rowCount++;
  await reader.close();
  assert.equal(rowCount, 3, 'parquet file must contain the 3 seeded rows');
});

test('W888-I #9 — captures export --format hf produces an apache-arrow-readable file', async () => {
  const out = path.join(scratchDir, 'exports', 'caps.arrow');
  const r = spawnSync(process.execPath, [
    KOLM_CLI, 'captures', 'export', '--format', 'hf', '--out', out, '--limit', '100',
  ], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_BASE_URL: serverBase, KOLM_API_KEY: serverApiKey, KOLM_HOME: path.join(scratchDir, 'home') },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `hf export exit=${r.status} stderr=${(r.stderr||'').slice(0,400)}`);
  assert.ok(fs.existsSync(out), 'hf (arrow) file must exist');
  let arrow;
  try {
    const mod = await import('apache-arrow');
    arrow = mod && (mod.tableFromIPC || mod.RecordBatchFileReader) ? mod : mod.default;
  } catch (e) {
    assert.fail('apache-arrow not installed; cannot validate hf export: ' + e.message);
  }
  const buf = fs.readFileSync(out);
  // tableFromIPC handles both file + stream formats.
  const table = arrow.tableFromIPC(buf);
  assert.equal(table.numRows, 3, 'hf arrow table must contain 3 seeded rows');
});

test('W888-I #9 teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});
