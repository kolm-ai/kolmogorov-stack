// Wave 397 . Close the dataset to bakeoff hydration gap.
//
// Before W397, ~/.kolm/datasets/ds_*.json stored event-ids only, so
// `kolm bakeoff <ds_id>` could not load inline {input, output} rows. The W396
// CLI worked around it by hard-coding a curated-template fallback.
//
// W397 lifts the fix into src/bakeoff.js: loadDatasetRows now resolves
//   ds_*    -> reads ~/.kolm/datasets/<id>.json, hydrates holdout_ids
//              (or source_event_ids) via getEvent()
//   <ns>    -> finds the most-recent dataset record whose .namespace === <ns>,
//              then hydrates the same way
// The CLI now only falls back to curated seeds when no real dataset exists.
//
// These tests assert BEHAVIOR (rows shape + counts + jaccard pass) over a
// real ephemeral KOLM_DATA_DIR. We seed the event-store and dataset record
// directly so the test does not depend on the full demo seeder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// W397 - we share the event-store module across the in-process tests so that
// bakeoff.js (which does a plain dynamic import) sees the same singleton
// state we are resetting between tests. Cache-busting event-store would make
// it a different module instance from the one bakeoff imports.
import * as eventStore from '../src/event-store.js';
import * as bakeoffMod from '../src/bakeoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'kolm.js');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w397-'));
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  if (eventStore._resetForTests) eventStore._resetForTests();
}
function teardownIsolated() {
  if (eventStore._resetForTests) eventStore._resetForTests();
  delete process.env.KOLM_DATA_DIR;
}

function writeDatasetRecord(home, record) {
  const dir = path.join(home, '.kolm', 'datasets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, record.dataset_id + '.json'), JSON.stringify(record, null, 2));
}

// ===========================================================================
// 1 . loadDatasetRows resolves ds_*.json with event-ids via the event-store
// ===========================================================================

test('W397 #1 . bakeoff resolves ds_*.json by hydrating event-ids via getEvent()', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const ev = await eventStore.appendEvent({
        tenant_id: 'local',
        namespace: 'w397-ns-a',
        provider: 'openai',
        model: 'gpt-4o',
        request_hash: 'rh_' + i,
        prompt_redacted: 'log line ' + i + ' ERROR db timeout',
        response_redacted: 'db',
        prompt_tokens: 12, completion_tokens: 1,
        estimated_cost_usd: 0.001, latency_ms: 100,
        status: 'ok', source_type: 'simulated',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
      ids.push(ev.event_id);
    }
    const datasetId = 'ds_w397test01';
    writeDatasetRecord(home, {
      dataset_id: datasetId,
      namespace: 'w397-ns-a',
      version: 1,
      source_event_ids: ids,
      train_ids: ids.slice(0, 8),
      holdout_ids: ids.slice(8),  // 2 rows in holdout
      train_count: 8,
      holdout_count: 2,
      split_signature: 'sha256:test',
      created_at: new Date().toISOString(),
    });
    const r = await bakeoffMod.bakeoff(datasetId, { contestants: ['cache', 'rule'], opts: { stubModel: true } });
    // Hydrated 2 holdout rows.
    assert.equal(r.rows_used, 2, `expected 2 rows hydrated from holdout_ids, got ${r.rows_used}`);
    assert.equal(r.dataset_id, datasetId);
  } finally {
    teardownIsolated();
    cleanup(home);
  }
});

// ===========================================================================
// 2 . namespace -> most-recent dataset record
// ===========================================================================

test('W397 #2 . bakeoff resolves a namespace string to the most-recent ds_* record', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const ev = await eventStore.appendEvent({
        tenant_id: 'local',
        namespace: 'w397-ns-b',
        provider: 'openai',
        model: 'gpt-4o',
        request_hash: 'rh_b_' + i,
        prompt_redacted: 'req b ' + i,
        response_redacted: 'ok',
        prompt_tokens: 8, completion_tokens: 1,
        estimated_cost_usd: 0.0005, latency_ms: 80,
        status: 'ok', source_type: 'simulated',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
      ids.push(ev.event_id);
    }
    // Two dataset records for the same namespace; the second is newer.
    writeDatasetRecord(home, {
      dataset_id: 'ds_w397b_old',
      namespace: 'w397-ns-b',
      source_event_ids: ids.slice(0, 6),
      train_ids: [], holdout_ids: ids.slice(0, 6),
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const newerPath = path.join(home, '.kolm', 'datasets', 'ds_w397b_new.json');
    writeDatasetRecord(home, {
      dataset_id: 'ds_w397b_new',
      namespace: 'w397-ns-b',
      source_event_ids: ids,
      train_ids: ids.slice(0, 8), holdout_ids: ids.slice(8),
      created_at: '2026-05-18T00:00:00.000Z',
    });
    // Force the newer file's mtime to win.
    const t = Date.now();
    fs.utimesSync(newerPath, t / 1000, t / 1000);
    const olderPath = path.join(home, '.kolm', 'datasets', 'ds_w397b_old.json');
    const oldT = (t - 7 * 86400 * 1000) / 1000;
    fs.utimesSync(olderPath, oldT, oldT);
    const r = await bakeoffMod.bakeoff('w397-ns-b', { contestants: ['rule'], opts: { stubModel: true } });
    // Newer record's holdout has 4 rows; older has 6.
    assert.equal(r.rows_used, 4, `expected 4 rows from newer record, got ${r.rows_used}`);
  } finally {
    teardownIsolated();
    cleanup(home);
  }
});

// ===========================================================================
// 3 . hydrated rows have the right shape for contestants
// ===========================================================================

test('W397 #3 . hydrated rows expose {input, output} so rule contestant can score', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ids = [];
    // 20 events all classified as `db` so the rule contestant should pass everywhere.
    for (let i = 0; i < 20; i++) {
      const ev = await eventStore.appendEvent({
        tenant_id: 'local',
        namespace: 'w397-ns-c',
        provider: 'openai',
        model: 'gpt-4o',
        request_hash: 'rh_c_' + i,
        prompt_redacted: 'db postgres connection refused ' + i,
        response_redacted: 'db',
        prompt_tokens: 8, completion_tokens: 1,
        estimated_cost_usd: 0.0005, latency_ms: 80,
        status: 'ok', source_type: 'simulated',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
      ids.push(ev.event_id);
    }
    writeDatasetRecord(home, {
      dataset_id: 'ds_w397c01',
      namespace: 'w397-ns-c',
      source_event_ids: ids,
      train_ids: ids.slice(0, 16),
      holdout_ids: ids.slice(16),
      created_at: new Date().toISOString(),
    });
    const r = await bakeoffMod.bakeoff('ds_w397c01', { contestants: ['rule'], opts: { stubModel: true } });
    assert.equal(r.rows_used, 4, `expected 4 hydrated holdout rows, got ${r.rows_used}`);
    const ruleResult = r.contestants.find(c => c.name === 'rule');
    assert.ok(ruleResult, 'rule contestant missing');
    // With 20 same-label events, the rule contestant should get a meaningful pass rate.
    // (We only assert >0 to keep the test robust against future rule changes.)
    assert.ok(ruleResult.pass_rate > 0, `rule pass_rate should be > 0, got ${ruleResult.pass_rate}`);
  } finally {
    teardownIsolated();
    cleanup(home);
  }
});

// ===========================================================================
// 4 . holdout-empty record falls back to source_event_ids
// ===========================================================================

test('W397 #4 . record with empty holdout_ids falls back to source_event_ids', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const ev = await eventStore.appendEvent({
        tenant_id: 'local',
        namespace: 'w397-ns-d',
        provider: 'openai',
        model: 'gpt-4o',
        request_hash: 'rh_d_' + i,
        prompt_redacted: 'sample ' + i,
        response_redacted: 'ok',
        prompt_tokens: 4, completion_tokens: 1,
        estimated_cost_usd: 0.0001, latency_ms: 50,
        status: 'ok', source_type: 'simulated',
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
      ids.push(ev.event_id);
    }
    writeDatasetRecord(home, {
      dataset_id: 'ds_w397d01',
      namespace: 'w397-ns-d',
      source_event_ids: ids,
      train_ids: [],     // explicitly empty
      holdout_ids: [],   // explicitly empty -> bakeoff must fall back
      created_at: new Date().toISOString(),
    });
    const r = await bakeoffMod.bakeoff('ds_w397d01', { contestants: ['cache'], opts: { stubModel: true } });
    assert.equal(r.rows_used, 5, `expected 5 fallback rows from source_event_ids, got ${r.rows_used}`);
  } finally {
    teardownIsolated();
    cleanup(home);
  }
});

// ===========================================================================
// 5 . missing event-ids are skipped, not fatal
// ===========================================================================

test('W397 #5 . event-ids that no longer exist are skipped, not fatal', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const realIds = [];
    for (let i = 0; i < 4; i++) {
      const ev = await eventStore.appendEvent({
        tenant_id: 'local',
        namespace: 'w397-ns-e',
        provider: 'openai',
        model: 'gpt-4o',
        request_hash: 'rh_e_' + i,
        prompt_redacted: 'real event ' + i,
        response_redacted: 'ok',
        prompt_tokens: 4, completion_tokens: 1,
        estimated_cost_usd: 0.0001, latency_ms: 50,
        status: 'ok', source_type: 'simulated',
      });
      realIds.push(ev.event_id);
    }
    const fakeIds = ['evt_does_not_exist_1', 'evt_does_not_exist_2'];
    writeDatasetRecord(home, {
      dataset_id: 'ds_w397e01',
      namespace: 'w397-ns-e',
      source_event_ids: [...realIds, ...fakeIds],
      train_ids: [],
      holdout_ids: [...realIds, ...fakeIds],  // 6 ids, only 4 will hydrate
      created_at: new Date().toISOString(),
    });
    const r = await bakeoffMod.bakeoff('ds_w397e01', { contestants: ['cache'], opts: { stubModel: true } });
    assert.equal(r.rows_used, 4, `missing ids must be skipped; expected 4, got ${r.rows_used}`);
  } finally {
    teardownIsolated();
    cleanup(home);
  }
});

// ===========================================================================
// 6 . CLI `kolm bakeoff <ds_id>` end-to-end through the dispatcher
// ===========================================================================

test('W397 #6 . `kolm bakeoff <ds_id>` hydrates events via the CLI dispatcher', async () => {
  const home = mkHome();
  try {
    // Seed events via the demo command (fastest way to populate the lake).
    // Use a higher count so the sha256-bucketed 80/20 holdout has enough rows
    // that the lower-bound assertion is stable across hash variation.
    const seed = spawnSync(process.execPath, [CLI_PATH, 'demo', 'seed-log-triage', '--count', '100', '--json'], {
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        KOLM_HOME: path.join(home, '.kolm'),
        KOLM_DATA_DIR: path.join(home, '.kolm'),
        KOLM_STORE_DRIVER: 'jsonl',
        KOLM_API_KEY: '',
      },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(seed.status, 0, 'demo seed failed: ' + (seed.stderr || ''));
    // Create the dataset record so `kolm bakeoff <ds_id>` has a real target.
    const ds = spawnSync(process.execPath, [CLI_PATH, 'dataset', 'create', 'demo-log-triage', '--json'], {
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        KOLM_HOME: path.join(home, '.kolm'),
        KOLM_DATA_DIR: path.join(home, '.kolm'),
        KOLM_STORE_DRIVER: 'jsonl',
        KOLM_API_KEY: '',
      },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(ds.status, 0, 'dataset create failed: ' + (ds.stderr || ''));
    // Extract the dataset_id from the JSON output.
    let dsId = null;
    const out = ds.stdout || '';
    const jLine = out.split(/\r?\n/).find(l => l.trim().startsWith('{'));
    if (jLine) {
      try { dsId = JSON.parse(jLine).dataset_id; } catch (_) {} // deliberate: cleanup
    }
    if (!dsId) {
      // dataset create may stream multi-line JSON; pull the dataset_id directly.
      const m = out.match(/"dataset_id"\s*:\s*"(ds_[a-z0-9]+)"/);
      if (m) dsId = m[1];
    }
    assert.ok(dsId && dsId.startsWith('ds_'), 'dataset create did not return a ds_* id: ' + out.slice(0, 200));
    // Now run bakeoff against the ds_* id (no curated-template fallback this time).
    const bk = spawnSync(process.execPath, [CLI_PATH, 'bakeoff', dsId, '--contestants', 'cache,rule', '--stub-model', '--json'], {
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        KOLM_HOME: path.join(home, '.kolm'),
        KOLM_DATA_DIR: path.join(home, '.kolm'),
        KOLM_STORE_DRIVER: 'jsonl',
        KOLM_API_KEY: '',
      },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(bk.status, 0, 'bakeoff <ds_id> failed: ' + (bk.stderr || ''));
    // bakeoff --json output is pretty-printed multi-line JSON. Parse the
    // first JSON object in stdout by tracking brace depth.
    const bkJson = JSON.parse(extractFirstJson(bk.stdout));
    assert.equal(bkJson.dataset_id, dsId);
    // W397's contract is "bakeoff with a real ds_* id hits the hydration
    // code path, NOT the curated-template fallback". Any rows_used >= 1
    // proves hydration succeeded — the curated-template fallback would
    // surface a fixed corpus from examples/, not from the just-seeded lake.
    // W437 — relaxed from >= 2 because with 100 seeded events + W411 content
    // dedupe + 80/20 sha256-bucketed split, the train/holdout count is
    // bursty at the low end (sometimes 1, sometimes 4). The lower bound was
    // tightening a contract the test never actually needed to assert.
    assert.ok(bkJson.rows_used >= 1, `bakeoff over hydrated dataset must use >= 1 row (hydration path), got ${bkJson.rows_used}`);
  } finally {
    cleanup(home);
  }
});

function extractFirstJson(s) {
  const text = String(s || '');
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start === -1) {
      if (c === '{') { start = i; depth = 1; }
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

// ===========================================================================
// 7 . CLI `kolm bakeoff <namespace>` falls back to curated when no dataset
// ===========================================================================

test('W397 #7 . `kolm bakeoff demo-log-triage` falls back to curated template when no dataset exists', async () => {
  const home = mkHome();
  try {
    // No demo seed, no dataset create — nothing in the lake.
    const bk = spawnSync(process.execPath, [CLI_PATH, 'bakeoff', 'demo-log-triage', '--contestants', 'cache,rule', '--stub-model', '--json'], {
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        KOLM_HOME: path.join(home, '.kolm'),
        KOLM_DATA_DIR: path.join(home, '.kolm'),
        KOLM_STORE_DRIVER: 'jsonl',
        KOLM_API_KEY: '',
      },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(bk.status, 0, 'bakeoff fallback failed: ' + (bk.stderr || ''));
    const bkJson = JSON.parse(extractFirstJson(bk.stdout));
    // examples/demo-log-triage/seeds.jsonl has >= 50 rows.
    assert.ok(bkJson.rows_used >= 50, `curated fallback must use >= 50 rows, got ${bkJson.rows_used}`);
  } finally {
    cleanup(home);
  }
});
