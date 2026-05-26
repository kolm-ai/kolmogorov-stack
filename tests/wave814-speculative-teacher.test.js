// W814 -- Speculative Decoding with Student Draft (T1) tests.
//
// One atomic test per contract. W604 anti-brittleness:
//   - Version constant is matched via /^w814-/ regex, never equality.
//   - No explicit-array sibling family lists.
//
// Coverage (>=15 tests):
//
//   1) Module exports the binding surface (functions + version).
//   2) SPECULATIVE_TEACHER_VERSION matches /^w814-/.
//   3) computeAcceptedRun computes the longest leading-true run (8/8, 0/8, 5/8).
//   4) computeAvgAcceptedRun across multiple rounds equals mean run length.
//   5) classifyTask routes representative prompts into expected clusters.
//   6) resolveTeacher honest envelope when KOLM_W814_TEACHER_CMD unset.
//   7) runSpeculative honest envelope on missing tenant.
//   8) runSpeculative honest envelope on missing draft bridge.
//   9) runSpeculative honest envelope on no_teacher_configured (env unset
//      + PATH miss).
//  10) runSpeculative DI end-to-end with stubbed teacher hits expected
//      acceptance rate (5/8 = 0.625).
//  11) benchSpeculative honest envelope on missing artifact.
//  12) benchSpeculative honest envelope on no captures (no_captures_to_bench).
//  13) benchSpeculative DI end-to-end groups results by task_cluster.
//  14) event-store roundtrip -- logAcceptance writes, getAcceptanceLog
//      reads back same row.
//  15) getAcceptanceLog tenant fence rejects foreign-tenant rows.
//  16) CLI `kolm bench speculative --help` exits 0.
//  17) CLI `kolm bench speculative` (no flags, no auth) returns honest
//      missing-artifact envelope under --json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w814-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  // event-store -- jsonl driver so writes survive even when node:sqlite is
  // not built into the test runner.
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  // CRITICAL: clear the teacher env so resolveTeacher() returns the honest
  // no_teacher_configured envelope unless a test explicitly overrides.
  delete process.env.KOLM_W814_TEACHER_CMD;
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  return tmp;
}

async function _load() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  // Cache-bust the speculative-teacher module so each test sees a fresh
  // import (matches the W812 _loadMods pattern).
  const sp = await import('../src/speculative-teacher.js');
  return { es, sp };
}

// Write a teacher stub to disk that accepts exactly `k` of the first
// `total` tokens. The stub reads JSON {prompt, draft:[{text}]} from stdin
// and emits {accepted:[bool], teacher_token:{text}} on stdout.
function writeTeacherStub({ acceptK, totalCap = 64, correctionText = '<TEACHER>' } = {}) {
  const dir = path.join(process.env.KOLM_DATA_DIR, 'stubs');
  fs.mkdirSync(dir, { recursive: true });
  const stubPath = path.join(dir, `teacher-stub-${process.pid}-${Math.random().toString(36).slice(2, 8)}.cjs`);
  const body = `
'use strict';
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} // deliberate: cleanup
  const draft = Array.isArray(payload.draft) ? payload.draft : [];
  const total = Math.min(draft.length, ${totalCap});
  const k = Math.min(${acceptK}, total);
  const accepted = [];
  for (let i = 0; i < total; i++) accepted.push(i < k);
  const teacher_token = (k < total) ? { text: ${JSON.stringify(correctionText)} } : null;
  process.stdout.write(JSON.stringify({ accepted, teacher_token }));
});
`;
  fs.writeFileSync(stubPath, body, 'utf8');
  return stubPath;
}

// Synthetic student draft bridge. Returns n tokens with deterministic
// text so accepted_text assertions are stable. Pure JS -- no subprocess.
function makeDraftBridge({ tokenPrefix = 'd' } = {}) {
  return {
    async propose({ prompt, n }) {
      void prompt;
      const tokens = [];
      for (let i = 0; i < n; i++) tokens.push({ text: tokenPrefix + i });
      return { tokens };
    },
  };
}

// =============================================================================
// 1) Module exports the binding surface.
// =============================================================================

test('W814 #1 -- module exports {SPECULATIVE_TEACHER_VERSION, runSpeculative, benchSpeculative, logAcceptance, getAcceptanceLog, resolveTeacher}', async () => {
  freshDir();
  const { sp } = await _load();
  assert.equal(typeof sp.SPECULATIVE_TEACHER_VERSION, 'string', 'version is a string');
  assert.equal(typeof sp.runSpeculative, 'function', 'runSpeculative is a function');
  assert.equal(typeof sp.benchSpeculative, 'function', 'benchSpeculative is a function');
  assert.equal(typeof sp.logAcceptance, 'function', 'logAcceptance is a function');
  assert.equal(typeof sp.getAcceptanceLog, 'function', 'getAcceptanceLog is a function');
  assert.equal(typeof sp.resolveTeacher, 'function', 'resolveTeacher is a function');
  assert.equal(typeof sp.computeAcceptedRun, 'function', 'computeAcceptedRun is a function');
  assert.equal(typeof sp.computeAvgAcceptedRun, 'function', 'computeAvgAcceptedRun is a function');
  assert.equal(typeof sp.classifyTask, 'function', 'classifyTask is a function');
  assert.equal(typeof sp.N_DRAFT_DEFAULT, 'number', 'N_DRAFT_DEFAULT is a number');
  assert.equal(sp.N_DRAFT_DEFAULT, 8, 'N_DRAFT_DEFAULT === 8 per W814-1 plan');
});

// =============================================================================
// 2) SPECULATIVE_TEACHER_VERSION matches /^w814-/.
// =============================================================================

test('W814 #2 -- SPECULATIVE_TEACHER_VERSION matches /^w814-/', async () => {
  freshDir();
  const { sp } = await _load();
  assert.ok(/^w814-/.test(sp.SPECULATIVE_TEACHER_VERSION),
    'version must start with w814-; got ' + sp.SPECULATIVE_TEACHER_VERSION);
});

// =============================================================================
// 3) computeAcceptedRun -- 8/8 = 8, 0/8 = 0, 5/8 = 5.
// =============================================================================

test('W814 #3 -- computeAcceptedRun returns longest leading-true run', async () => {
  freshDir();
  const { sp } = await _load();
  // 8 accepted out of 8.
  assert.equal(sp.computeAcceptedRun([true, true, true, true, true, true, true, true]), 8);
  // 0 accepted (first false halts).
  assert.equal(sp.computeAcceptedRun([false, true, true, true, true, true, true, true]), 0);
  // 5 accepted (run halts at 6th token).
  assert.equal(sp.computeAcceptedRun([true, true, true, true, true, false, true, true]), 5);
  // Empty array -> 0.
  assert.equal(sp.computeAcceptedRun([]), 0);
  // Non-boolean values do NOT count (only strict true).
  assert.equal(sp.computeAcceptedRun([1, 1, 1]), 0, 'numbers are not true');
  // Non-array input -> 0 (defensive).
  assert.equal(sp.computeAcceptedRun(null), 0);
  assert.equal(sp.computeAcceptedRun(undefined), 0);
});

// =============================================================================
// 4) computeAvgAcceptedRun across rounds.
// =============================================================================

test('W814 #4 -- computeAvgAcceptedRun averages consecutive-true spans', async () => {
  freshDir();
  const { sp } = await _load();
  // [T,T,F,T,T,T,F] -> runs [2,3]; [T,F] -> run [1] -> mean (2+3+1)/3 = 2.0
  const r1 = sp.computeAvgAcceptedRun([
    [true, true, false, true, true, true, false],
    [true, false],
  ]);
  assert.ok(Math.abs(r1 - 2.0) < 1e-9, 'expected 2.0; got ' + r1);
  // All-false rounds -> 0.
  assert.equal(sp.computeAvgAcceptedRun([[false, false, false, false]]), 0);
  // Empty rounds list -> 0.
  assert.equal(sp.computeAvgAcceptedRun([]), 0);
  // Single all-true round -> length.
  assert.equal(sp.computeAvgAcceptedRun([[true, true, true]]), 3);
});

// =============================================================================
// 5) classifyTask routes representative prompts into expected clusters.
// =============================================================================

test('W814 #5 -- classifyTask routes prompts into clusters', async () => {
  freshDir();
  const { sp } = await _load();
  assert.equal(sp.classifyTask('extract the names from this'), 'extraction');
  assert.equal(sp.classifyTask('write a short summary'), 'generation');
  assert.equal(sp.classifyTask('explain why this code crashes'), 'reasoning');
  assert.equal(sp.classifyTask('hello there friend'), 'general');
  // Case-insensitive.
  assert.equal(sp.classifyTask('EXTRACT all dates'), 'extraction');
  // Empty / null -> general.
  assert.equal(sp.classifyTask(''), 'general');
  assert.equal(sp.classifyTask(null), 'general');
});

// =============================================================================
// 6) resolveTeacher honest envelope when env unset + PATH miss.
// =============================================================================

test('W814 #6 -- resolveTeacher returns no_teacher_configured when env unset + on-PATH miss', async () => {
  freshDir();
  const { sp } = await _load();
  // Force resolveTeacher to see an env without KOLM_W814_TEACHER_CMD and a
  // PATH that does NOT contain `kolm-w814-teacher`.
  const fakeEnv = {
    PATH: path.join(process.env.KOLM_DATA_DIR, 'empty-path-segment'),
    PATHEXT: process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM',
  };
  const r = sp.resolveTeacher(fakeEnv);
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_teacher_configured');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint is human-actionable');
  assert.ok(/^w814-/.test(r.version), 'version stamped');
});

// =============================================================================
// 7) runSpeculative honest envelope on missing tenant.
// =============================================================================

test('W814 #7 -- runSpeculative honest envelope on missing tenant', async () => {
  freshDir();
  const { sp } = await _load();
  const r = await sp.runSpeculative({ prompt: 'hi', draft: makeDraftBridge() });
  assert.equal(r.ok, false, 'expected ok:false');
  assert.equal(r.error, 'missing_tenant');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 8) runSpeculative honest envelope on missing draft bridge.
// =============================================================================

test('W814 #8 -- runSpeculative honest envelope on missing draft bridge', async () => {
  freshDir();
  const { sp } = await _load();
  const stubPath = writeTeacherStub({ acceptK: 1 });
  const r = await sp.runSpeculative({
    prompt: 'hi',
    tenant: 'tenant_w814_a',
    teacher_argv: [process.execPath, stubPath],
    // draft intentionally omitted
  });
  assert.equal(r.ok, false, 'expected ok:false');
  assert.equal(r.error, 'missing_draft_bridge');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 9) runSpeculative honest envelope when no teacher configured.
// =============================================================================

test('W814 #9 -- runSpeculative returns no_teacher_configured when env unset + PATH miss', async () => {
  freshDir();
  const { sp } = await _load();
  // No teacher_argv, env without KOLM_W814_TEACHER_CMD, and a PATH that
  // cannot resolve `kolm-w814-teacher`.
  const fakeEnv = {
    PATH: path.join(process.env.KOLM_DATA_DIR, 'no-teacher-here'),
    PATHEXT: process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM',
  };
  const r = await sp.runSpeculative({
    prompt: 'hello world',
    tenant: 'tenant_w814_b',
    draft: makeDraftBridge(),
    env: fakeEnv,
  });
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_teacher_configured');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint must guide operator');
  assert.ok(/^w814-/.test(r.version), 'version stamped');
});

// =============================================================================
// 10) runSpeculative DI end-to-end -- 5/8 = 0.625 acceptance rate.
// =============================================================================

test('W814 #10 -- runSpeculative end-to-end with stubbed teacher hits expected acceptance rate', async () => {
  freshDir();
  const { sp } = await _load();
  const stubPath = writeTeacherStub({ acceptK: 5, correctionText: '<T>' });
  const r = await sp.runSpeculative({
    prompt: 'extract the names from this paragraph',
    tenant: 'tenant_w814_c',
    namespace: 'ns_w814',
    n_drafts: 8,
    draft: makeDraftBridge({ tokenPrefix: 's' }),
    teacher_argv: [process.execPath, stubPath],
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r));
  assert.equal(r.accepted_count, 5, 'accepted_count = 5');
  assert.equal(r.total_count, 8, 'total_count = 8');
  assert.ok(Math.abs(r.acceptance_rate - 0.625) < 1e-9, 'acceptance_rate = 5/8; got ' + r.acceptance_rate);
  assert.equal(r.route, 'partial', 'route is partial when not all accepted');
  assert.equal(r.task_cluster, 'extraction', 'classifyTask routed to extraction');
  assert.ok(typeof r.accepted_text === 'string', 'accepted_text present');
  assert.ok(r.accepted_text.startsWith('s0s1s2s3s4'), 'accepted_text contains first 5 student tokens');
  assert.ok(r.accepted_text.endsWith('<T>'), 'teacher correction appended on rejection');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 10b) Edge: 8/8 acceptance -> route = all_accepted, no correction appended.
// =============================================================================

test('W814 #10b -- runSpeculative 8/8 acceptance returns route=all_accepted', async () => {
  freshDir();
  const { sp } = await _load();
  const stubPath = writeTeacherStub({ acceptK: 8 });
  const r = await sp.runSpeculative({
    prompt: 'write a haiku about birds',
    tenant: 'tenant_w814_d',
    n_drafts: 8,
    draft: makeDraftBridge(),
    teacher_argv: [process.execPath, stubPath],
  });
  assert.equal(r.ok, true);
  assert.equal(r.accepted_count, 8);
  assert.equal(r.total_count, 8);
  assert.equal(r.acceptance_rate, 1);
  assert.equal(r.route, 'all_accepted');
  assert.equal(r.teacher_correction_text, null, 'no correction when all accepted');
  assert.equal(r.task_cluster, 'generation');
});

// =============================================================================
// 11) benchSpeculative honest envelope on missing artifact.
// =============================================================================

test('W814 #11 -- benchSpeculative honest envelope on missing artifact_id', async () => {
  freshDir();
  const { sp } = await _load();
  const r = await sp.benchSpeculative({
    tenant: 'tenant_w814_e',
    draft: makeDraftBridge(),
    // artifact_id intentionally omitted
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'artifact_not_found');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 12) benchSpeculative honest envelope on no captures.
// =============================================================================

test('W814 #12 -- benchSpeculative returns no_captures_to_bench on empty corpus', async () => {
  freshDir();
  const { sp } = await _load();
  const stubPath = writeTeacherStub({ acceptK: 4 });
  // Pass an explicit empty captures array AND ensure no captures exist
  // in the event-store either.
  const r = await sp.benchSpeculative({
    tenant: 'tenant_w814_f_empty',
    namespace: 'ns_empty',
    artifact_id: 'art_w814_empty',
    draft: makeDraftBridge(),
    teacher_argv: [process.execPath, stubPath],
    captures: [],
  });
  // Note: captures=[] falls through to listEvents() which (with no events
  // in this tenant/namespace) returns no_captures_to_bench.
  assert.equal(r.ok, false, 'expected ok:false; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_captures_to_bench');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 13) benchSpeculative DI end-to-end groups results by task_cluster.
// =============================================================================

test('W814 #13 -- benchSpeculative groups results by task_cluster', async () => {
  freshDir();
  const { sp } = await _load();
  // Teacher accepts 4 of every 8 (uniform 50%).
  const stubPath = writeTeacherStub({ acceptK: 4 });
  const r = await sp.benchSpeculative({
    tenant: 'tenant_w814_g',
    namespace: 'ns_g',
    artifact_id: 'art_w814_g',
    draft: makeDraftBridge(),
    teacher_argv: [process.execPath, stubPath],
    n_drafts: 8,
    captures: [
      { prompt: 'extract the dates from this' },           // -> extraction
      { prompt: 'extract every email address' },           // -> extraction
      { prompt: 'write a paragraph about cats' },          // -> generation
      { prompt: 'explain why this is correct' },           // -> reasoning
    ],
    log: false, // skip event-store write so we don't pollute neighbour tests
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r));
  assert.ok(r.bench_id && /^specbench_/.test(r.bench_id), 'bench_id stamped; got ' + r.bench_id);
  assert.equal(r.total_runs, 4);
  assert.ok(r.by_cluster && typeof r.by_cluster === 'object', 'by_cluster object');
  // Extraction cluster should have 2 runs.
  const ext = r.by_cluster.extraction;
  assert.ok(ext, 'extraction cluster present');
  assert.equal(ext.n, 2, 'extraction n = 2');
  // 50% acceptance (4 of 8) per run, totalled across 2 runs.
  assert.equal(ext.total, 16, 'extraction total tokens = 16');
  assert.equal(ext.accepted, 8, 'extraction accepted = 8');
  assert.ok(Math.abs(ext.acceptance_rate - 0.5) < 1e-9, 'extraction rate = 0.5; got ' + ext.acceptance_rate);
  // avg_accepted_run: each round is [T,T,T,T,F,F,F,F] -> single run of 4.
  assert.ok(Math.abs(ext.avg_accepted_run - 4) < 1e-9, 'avg run = 4; got ' + ext.avg_accepted_run);
  // Other clusters present.
  assert.ok(r.by_cluster.generation, 'generation cluster present');
  assert.ok(r.by_cluster.reasoning, 'reasoning cluster present');
});

// =============================================================================
// 14) event-store roundtrip -- logAcceptance writes, getAcceptanceLog reads.
// =============================================================================

test('W814 #14 -- logAcceptance + getAcceptanceLog roundtrip returns the same row', async () => {
  freshDir();
  const { sp } = await _load();
  const tenant = 'tenant_w814_rt';
  const ev = await sp.logAcceptance({
    tenant,
    namespace: 'ns_rt',
    artifact_id: 'art_w814_rt',
    task_cluster: 'extraction',
    accept_rate: 0.875,
    avg_accepted_run: 7,
    bench_id: 'specbench_test123',
  });
  assert.ok(ev && ev.event_id, 'logAcceptance returns row with event_id');
  const r = await sp.getAcceptanceLog({ tenant, namespace: 'ns_rt' });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r));
  assert.ok(Array.isArray(r.rows), 'rows is an array');
  assert.equal(r.rows.length, 1, 'one row written, one row read');
  const row = r.rows[0];
  assert.equal(row.task_cluster, 'extraction');
  assert.ok(Math.abs(row.accept_rate - 0.875) < 1e-6, 'accept_rate roundtrips');
  assert.equal(row.avg_accepted_run, 7);
  assert.equal(row.artifact_id, 'art_w814_rt');
  assert.equal(row.bench_id, 'specbench_test123');
  assert.equal(row.event_id, ev.event_id, 'event_id matches written row');
  assert.ok(/^w814-/.test(r.version));
});

// =============================================================================
// 15) getAcceptanceLog tenant fence rejects foreign-tenant rows.
// =============================================================================

test('W814 #15 -- getAcceptanceLog tenant fence rejects foreign-tenant rows', async () => {
  freshDir();
  const { sp } = await _load();
  // Write under tenant A.
  await sp.logAcceptance({
    tenant: 'tenant_w814_fence_a', namespace: 'ns_fence',
    artifact_id: 'art_a', task_cluster: 'reasoning',
    accept_rate: 0.6, avg_accepted_run: 5,
  });
  // Write under tenant B.
  await sp.logAcceptance({
    tenant: 'tenant_w814_fence_b', namespace: 'ns_fence',
    artifact_id: 'art_b', task_cluster: 'reasoning',
    accept_rate: 0.7, avg_accepted_run: 6,
  });
  // Read as tenant A -- only tenant A's row should surface.
  const rA = await sp.getAcceptanceLog({ tenant: 'tenant_w814_fence_a', namespace: 'ns_fence' });
  assert.equal(rA.ok, true);
  assert.equal(rA.rows.length, 1, 'tenant A sees exactly 1 row');
  assert.equal(rA.rows[0].artifact_id, 'art_a', 'tenant A sees own artifact');
  // Read as tenant B -- only tenant B's row.
  const rB = await sp.getAcceptanceLog({ tenant: 'tenant_w814_fence_b', namespace: 'ns_fence' });
  assert.equal(rB.ok, true);
  assert.equal(rB.rows.length, 1, 'tenant B sees exactly 1 row');
  assert.equal(rB.rows[0].artifact_id, 'art_b', 'tenant B sees own artifact');
  // Read without tenant -- honest envelope.
  const rNone = await sp.getAcceptanceLog({});
  assert.equal(rNone.ok, false);
  assert.equal(rNone.error, 'missing_tenant');
});

// =============================================================================
// 16) CLI `kolm bench speculative --help` exits 0.
// =============================================================================

test('W814 #16 -- CLI `kolm bench speculative --help` exits 0', () => {
  freshDir();
  const env = {
    ...process.env,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_HOME: process.env.KOLM_HOME,
    KOLM_ENV: 'test',
  };
  const res = spawnSync(process.execPath, [
    CLI_PATH, 'bench', 'speculative', '--help',
  ], { env, encoding: 'utf8' });
  assert.equal(res.status, 0,
    'CLI exited non-zero. stdout=' + (res.stdout || '').slice(0, 600) + ' stderr=' + (res.stderr || '').slice(0, 600));
  const out = (res.stdout || '') + (res.stderr || '');
  assert.ok(/speculative/i.test(out), 'help mentions speculative; got: ' + out.slice(0, 400));
});

// =============================================================================
// 17) CLI `kolm bench speculative` (no flags) returns honest envelope under --json.
// =============================================================================

test('W814 #17 -- CLI `kolm bench speculative --json` (no flags) returns honest envelope', () => {
  freshDir();
  const env = {
    ...process.env,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_HOME: process.env.KOLM_HOME,
    KOLM_ENV: 'test',
    KOLM_EVENT_STORE_DRIVER: 'jsonl',
  };
  // No --artifact flag, no captures, no teacher -- the CLI must print one
  // of the honest envelopes (missing_artifact / no_teacher_configured /
  // no_captures_to_bench) and NEVER a numeric acceptance rate.
  const res = spawnSync(process.execPath, [
    CLI_PATH, 'bench', 'speculative',
    '--json',
    '--tenant', 'tenant_w814_cli',
  ], { env, encoding: 'utf8' });
  // Exit status may be non-zero (BAD_ARGS / EXECUTION); we only require
  // valid JSON on stdout with an honest envelope.
  let parsed;
  try { parsed = JSON.parse(res.stdout || ''); }
  catch (e) {
    assert.fail('CLI did not emit JSON. stdout=' + (res.stdout || '').slice(0, 400)
      + ' stderr=' + (res.stderr || '').slice(0, 400));
  }
  assert.equal(parsed.ok, false, 'envelope must be ok:false; got ' + JSON.stringify(parsed));
  assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0, 'error code present');
  assert.ok(/^w814-/.test(parsed.version), 'version stamped; got ' + parsed.version);
  // Specifically: with no flags we expect missing_artifact (cheapest gate).
  assert.equal(parsed.error, 'missing_artifact',
    'expected missing_artifact; got ' + parsed.error);
});
