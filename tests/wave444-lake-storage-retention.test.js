// W444 — kolm lake storage + retention CLI verbs.
//
// Audit item P1-6 in the 2026-05-19 north-star plan: "Telemetry lake truth +
// kolm lake CLI" called for a first-class `storage` verb and ongoing retention
// controls. W409l shipped stats/tail/export/inspect/purge/sync; W444 adds:
//
//   kolm lake storage                                 [--json]   -- read-only
//   kolm lake retention show                          [--json]   -- read config
//   kolm lake retention set --days <N>                [--json]   -- write config
//   kolm lake retention apply [--yes]                 [--json]   -- enforce
//
// All four assert BEHAVIOR (config round-trips, purge actually deletes /
// dry-runs by default, the storage envelope tracks driver+path+disk+count) —
// not page copy or stderr strings.
//
// Same harness pattern as W409l: isolated HOME so the test never touches the
// developer's real ~/.kolm. Event-store autodetects sqlite vs jsonl on its
// own; we do NOT pin KOLM_STORE_DRIVER (that flag belongs to capture-store).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

import * as eventStore from '../src/event-store.js';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w444-'));
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}
function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (eventStore._resetForTests) eventStore._resetForTests();
}
function teardownIsolated(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  delete process.env.KOLM_DATA_DIR;
  cleanup(home);
}
function runCli(args, env = {}) {
  const merged = { ...process.env, ...env };
  delete merged.KOLM_API_KEY;
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: merged,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function seedOne(namespace, opts = {}) {
  const ev = await eventStore.appendEvent({
    tenant_id: opts.tenant_id || 'w444-tenant',
    namespace,
    provider: 'openai',
    model: 'gpt-4o',
    prompt_redacted: opts.prompt || 'w444 retention probe',
    response_redacted: 'ok',
    status: 'ok',
    source_type: 'real',
    created_at: opts.created_at || new Date().toISOString(),
  });
  return ev.event_id;
}

// =============================================================================
// 1) kolm lake storage --json returns canonical envelope
// =============================================================================

test('W444 #1 — kolm lake storage --json returns driver+path+disk+count envelope', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const ns = 'w444_storage_' + Date.now().toString(36);
    await seedOne(ns);
    await seedOne(ns);
    await seedOne(ns);

    const result = runCli(['lake', 'storage', '--json'], {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(result.status, 0, 'kolm lake storage must exit 0: stderr=' + result.stderr);
    const parsed = JSON.parse(result.stdout);

    // Required fields the script-parseable envelope must always carry.
    assert.ok(typeof parsed.driver === 'string' && parsed.driver.length > 0,
      'storage.driver must be a non-empty string (sqlite|jsonl)');
    assert.ok(['sqlite', 'jsonl'].includes(parsed.driver),
      'storage.driver must be sqlite or jsonl, got ' + parsed.driver);
    assert.ok(typeof parsed.path === 'string' && parsed.path.length > 0,
      'storage.path must be a non-empty string');
    assert.ok(String(parsed.path).includes('events'),
      'storage.path must live under ~/.kolm/events/, got ' + parsed.path);
    assert.ok(typeof parsed.disk_used_bytes === 'number',
      'disk_used_bytes must be numeric');
    assert.ok(parsed.disk_used_bytes > 0,
      'disk_used_bytes must be > 0 after seeding events');
    assert.equal(parsed.event_count, 3,
      'event_count must reflect the 3 seeded events');
    assert.ok(parsed.cloud_sync === false || parsed.cloud_sync === true,
      'cloud_sync must be boolean');
    // retention_days defaults to null (unset) on a fresh config.
    assert.equal(parsed.retention_days, null,
      'retention_days must be null on a fresh config');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 2) kolm lake retention show / set round-trips through config
// =============================================================================

test('W444 #2 — kolm lake retention set + show round-trip through config', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const env = {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    };

    // Fresh state: show reports null.
    let result = runCli(['lake', 'retention', 'show', '--json'], env);
    assert.equal(result.status, 0, 'retention show (fresh) must exit 0');
    assert.equal(JSON.parse(result.stdout).lake_retention_days, null,
      'fresh config must have retention=null');

    // Set --days 14.
    result = runCli(['lake', 'retention', 'set', '--days', '14', '--json'], env);
    assert.equal(result.status, 0, 'retention set --days 14 must exit 0: stderr=' + result.stderr);
    const setOut = JSON.parse(result.stdout);
    assert.equal(setOut.ok, true, 'set must return ok:true');
    assert.equal(setOut.lake_retention_days, 14, 'set must echo days=14');

    // Read back.
    result = runCli(['lake', 'retention', 'show', '--json'], env);
    assert.equal(result.status, 0, 'retention show after set must exit 0');
    assert.equal(JSON.parse(result.stdout).lake_retention_days, 14,
      'show must read back days=14');

    // set --days 0 clears.
    result = runCli(['lake', 'retention', 'set', '--days', '0', '--json'], env);
    assert.equal(result.status, 0, 'retention set --days 0 must exit 0');
    assert.equal(JSON.parse(result.stdout).lake_retention_days, null,
      'set --days 0 must clear the policy');

    // Negative days rejected.
    result = runCli(['lake', 'retention', 'set', '--days', '-5'], env);
    assert.notEqual(result.status, 0, 'negative --days must exit non-zero');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 3) kolm lake retention apply enforces the policy (dry-run by default)
// =============================================================================

test('W444 #3 — kolm lake retention apply purges events older than the policy', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const env = {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    };
    const ns = 'w444_apply_' + Date.now().toString(36);

    // Two old events (40 days back) + two fresh (today).
    const oldIso = new Date(Date.now() - 40 * 86400e3).toISOString();
    await seedOne(ns, { created_at: oldIso, prompt: 'old-1' });
    await seedOne(ns, { created_at: oldIso, prompt: 'old-2' });
    await seedOne(ns, { prompt: 'fresh-1' });
    await seedOne(ns, { prompt: 'fresh-2' });

    // Set 7-day retention.
    let result = runCli(['lake', 'retention', 'set', '--days', '7', '--json'], env);
    assert.equal(result.status, 0, 'set --days 7 must exit 0');

    // Apply without --yes is dry-run by default (the safety gate).
    result = runCli(['lake', 'retention', 'apply', '--json'], env);
    assert.equal(result.status, 0, 'apply (dry-run default) must exit 0: stderr=' + result.stderr);
    const dryOut = JSON.parse(result.stdout);
    assert.equal(dryOut.dry_run, true, 'apply without --yes must be dry-run');
    assert.equal(dryOut.would_delete, 2, 'dry-run must surface 2 events past 7 days');
    assert.equal(dryOut.deleted, 0, 'dry-run must NOT delete');
    assert.equal(dryOut.lake_retention_days, 7);
    assert.ok(typeof dryOut.cutoff === 'string' && dryOut.cutoff.includes('T'),
      'cutoff must be an ISO timestamp');

    // Storage still shows 4 events.
    result = runCli(['lake', 'storage', '--json'], env);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).event_count, 4,
      'dry-run must leave the lake untouched');

    // Now apply for real.
    result = runCli(['lake', 'retention', 'apply', '--yes', '--json'], env);
    assert.equal(result.status, 0, 'apply --yes must exit 0: stderr=' + result.stderr);
    const realOut = JSON.parse(result.stdout);
    assert.equal(realOut.dry_run, false, 'apply --yes must NOT be dry-run');
    assert.equal(realOut.deleted, 2, 'apply --yes must delete 2 old events');

    // Storage now reflects 2 remaining.
    result = runCli(['lake', 'storage', '--json'], env);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).event_count, 2,
      'storage must reflect 2 remaining events after purge');
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 4) retention apply without a policy refuses to run
// =============================================================================

test('W444 #4 — kolm lake retention apply with no policy refuses', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const env = {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    };
    const result = runCli(['lake', 'retention', 'apply'], env);
    assert.notEqual(result.status, 0,
      'apply with no retention policy must exit non-zero, not silently no-op');
    assert.ok(/retention.*unset|set --days/i.test(result.stderr),
      'stderr must point user at `retention set --days N`, got: ' + result.stderr);
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// 5) storage envelope reports retention_days once set
// =============================================================================

test('W444 #5 — kolm lake storage reports retention_days after set', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const env = {
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      HOME: home,
      USERPROFILE: home,
    };
    runCli(['lake', 'retention', 'set', '--days', '30', '--json'], env);
    const result = runCli(['lake', 'storage', '--json'], env);
    assert.equal(result.status, 0, 'storage must exit 0');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.retention_days, 30,
      'storage envelope must reflect the configured retention policy');
  } finally {
    teardownIsolated(home);
  }
});
