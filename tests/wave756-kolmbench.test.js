// W756 — KolmBench v1 public spec + leaderboard.
//
// Ships the four deliverables from KOLM_W707_SYSTEM_UPGRADE_PLAN.md
// lines 521-526:
//
//   [W756-1] Public KolmBench v1 spec at /bench/kolmbench-v1.html
//   [W756-2] Public leaderboard JSON at /bench/leaderboard.json
//   [W756-3] Submission CI workflow .github/workflows/kolmbench-submission.yml
//   [W756-4] Curated most-challenging-captures v2 seed dataset placeholder
//            (HONEST envelope — NEVER silently fakes a v2 seed set)
//
// Atomic items pinned (matches the W756 implementation):
//
//   1) KOLMBENCH_VERSION present + stamped 'w756-v1'
//   2) KOLMBENCH_V1_SPEC frozen + categories pinned (7) + license CC-BY-4.0
//   3) AUTHORITATIVE_TASKS frozen + len matches spec.task_count
//   4) validateSubmission happy path returns {ok:true, errors:[]}
//   5) validateSubmission emits stable snake_case error codes for every
//      malformed input (submission_empty, missing_task_id, missing_response,
//      unknown_task_id, duplicate_task_id, invalid_artifact_cid_format)
//   6) scoreSubmission returns HONEST stub (k_score:null + reason code)
//   7) readLeaderboard returns the canonical entries[] array
//   8) appendLeaderboardEntry forces verified:false unless ed25519 receipt
//      points to a real readable file (NEVER trusts caller-supplied
//      verified:true alone)
//   9) appendLeaderboardEntry writes atomically + restores on failure
//  10) getV2SeedTaskCandidates returns honest w757/w766-blocked envelope
//  11) GET /v1/kolmbench/spec is PUBLIC (no auth required)
//  12) GET /v1/kolmbench/leaderboard is PUBLIC (no auth required)
//  13) POST /v1/kolmbench/validate is auth-required (401 without)
//  14) POST /v1/kolmbench/submit is auth + confirm:true gated
//  15) public/bench/kolmbench-v1.html exists with brand-lock + leaderboard
//      anchor + version stamp + W807/CC-BY-4.0 honesty notes
//  16) public/bench/leaderboard.json exists + valid JSON + version stamp
//  17) .github/workflows/kolmbench-submission.yml exists with correct
//      trigger paths + permissions + node-20 + validateSubmission call
//  18) cli/kolm.js defines cmdW756Kolmbench exactly once + wired from
//      case 'kolmbench' AND case 'kb'
//  19) vercel.json has rewrites for /bench/kolmbench-v1 + /bench/leaderboard
//  20) src/auth.js makes /v1/kolmbench/spec + /v1/kolmbench/leaderboard
//      PUBLIC but keeps validate + submit auth-gated
//  21) wave756 sibling test count uses regex wave(\d{3,4}) + threshold
//      pattern (W604 anti-brittleness: NEVER an explicit hard-coded
//      sibling list)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  KOLMBENCH_VERSION,
  KOLMBENCH_V1_SPEC,
  AUTHORITATIVE_TASKS,
  validateSubmission,
  scoreSubmission,
  readLeaderboard,
  appendLeaderboardEntry,
  getV2SeedTaskCandidates,
} from '../src/kolmbench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const BENCH_DIR = path.join(REPO_ROOT, 'public', 'bench');
const BENCH_HTML = path.join(BENCH_DIR, 'kolmbench-v1.html');
const LEADERBOARD_PATH = path.join(BENCH_DIR, 'leaderboard.json');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'kolmbench-submission.yml');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const AUTH_PATH = path.join(REPO_ROOT, 'src', 'auth.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w756-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

async function freshEventStore() {
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
}

// Snapshot/restore helper for tests that mutate the static leaderboard.json
// file (W756 #8, #9). We snapshot bytes, run the test, restore the original.
function withLeaderboardSnapshot(fn) {
  const original = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
  try { return fn(); }
  finally { fs.writeFileSync(LEADERBOARD_PATH, original); }
}

// =============================================================================
// 1) KOLMBENCH_VERSION present + stamped 'w756-v1'
// =============================================================================

test('W756 #1 — KOLMBENCH_VERSION present + stamped w756-v1', () => {
  freshDir();
  assert.equal(KOLMBENCH_VERSION, 'w756-v1',
    `expected KOLMBENCH_VERSION='w756-v1'; got ${JSON.stringify(KOLMBENCH_VERSION)}`);
});

// =============================================================================
// 2) KOLMBENCH_V1_SPEC frozen + categories pinned + license CC-BY-4.0
// =============================================================================

test('W756 #2 — KOLMBENCH_V1_SPEC frozen + 7 categories + license CC-BY-4.0', () => {
  freshDir();
  assert.ok(Object.isFrozen(KOLMBENCH_V1_SPEC),
    'KOLMBENCH_V1_SPEC must be Object.freeze()d (deliberate breaking-change gate)');
  assert.equal(KOLMBENCH_V1_SPEC.version, 'w756-v1');
  assert.equal(KOLMBENCH_V1_SPEC.name, 'KolmBench v1');
  assert.equal(KOLMBENCH_V1_SPEC.license, 'CC-BY-4.0');
  assert.ok(Object.isFrozen(KOLMBENCH_V1_SPEC.categories),
    'KOLMBENCH_V1_SPEC.categories must be frozen');
  assert.deepEqual(
    KOLMBENCH_V1_SPEC.categories,
    ['reasoning', 'coding', 'writing', 'analysis', 'support', 'math', 'tool_use'],
    `categories must be pinned to the canonical 7; got ${JSON.stringify(KOLMBENCH_V1_SPEC.categories)}`,
  );
  assert.equal(typeof KOLMBENCH_V1_SPEC.scoring, 'string');
  assert.equal(typeof KOLMBENCH_V1_SPEC.submission_format, 'string');
  assert.equal(typeof KOLMBENCH_V1_SPEC.verification, 'string');
  assert.equal(typeof KOLMBENCH_V1_SPEC.task_count, 'number');
});

// =============================================================================
// 3) AUTHORITATIVE_TASKS frozen + len matches spec.task_count
// =============================================================================

test('W756 #3 — AUTHORITATIVE_TASKS frozen + len matches spec.task_count', () => {
  freshDir();
  assert.ok(Array.isArray(AUTHORITATIVE_TASKS), 'AUTHORITATIVE_TASKS must be an array');
  assert.ok(Object.isFrozen(AUTHORITATIVE_TASKS),
    'AUTHORITATIVE_TASKS must be Object.freeze()d');
  assert.ok(AUTHORITATIVE_TASKS.length >= 40,
    `expected at least 40 tasks in v1 starter pack; got ${AUTHORITATIVE_TASKS.length}`);
  assert.equal(KOLMBENCH_V1_SPEC.task_count, AUTHORITATIVE_TASKS.length,
    `spec.task_count (${KOLMBENCH_V1_SPEC.task_count}) must equal AUTHORITATIVE_TASKS.length (${AUTHORITATIVE_TASKS.length})`);
  // Every entry is a non-empty string id; every id is unique.
  const seen = new Set();
  for (const tid of AUTHORITATIVE_TASKS) {
    assert.ok(typeof tid === 'string' && tid.length > 0,
      `every task id must be a non-empty string; got ${JSON.stringify(tid)}`);
    assert.ok(!seen.has(tid), `duplicate task id in AUTHORITATIVE_TASKS: ${tid}`);
    seen.add(tid);
  }
});

// =============================================================================
// 4) validateSubmission happy path
// =============================================================================

test('W756 #4 — validateSubmission happy path returns ok:true + empty errors', () => {
  freshDir();
  const rows = [
    { task_id: AUTHORITATIVE_TASKS[0], response: 'ok answer one', artifact_cid_or_null: null },
    { task_id: AUTHORITATIVE_TASKS[1], response: 'ok answer two', artifact_cid_or_null: 'sha256:' + 'a'.repeat(64) },
    { task_id: AUTHORITATIVE_TASKS[2], response: 'ok answer three', artifact_cid_or_null: 'pending_my-artifact' },
  ];
  const result = validateSubmission(rows);
  assert.equal(result.ok, true, `expected ok:true; got ${JSON.stringify(result)}`);
  assert.deepEqual(result.errors, [], `expected no errors; got ${JSON.stringify(result.errors)}`);
});

// =============================================================================
// 5) validateSubmission emits stable snake_case error codes
// =============================================================================

test('W756 #5 — validateSubmission emits stable snake_case error codes for every malformed input', () => {
  freshDir();
  // submission_empty: undefined / null / empty array.
  for (const empty of [undefined, null, [], 'string', 42]) {
    const r = validateSubmission(empty);
    assert.equal(r.ok, false, `expected ok:false for ${JSON.stringify(empty)}; got ${JSON.stringify(r)}`);
    assert.equal(r.errors[0].code, 'submission_empty');
  }
  // missing_task_id
  const r2 = validateSubmission([{ response: 'no task_id' }]);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.code === 'missing_task_id'),
    `expected missing_task_id code; got ${JSON.stringify(r2.errors)}`);
  // missing_response
  const r3 = validateSubmission([{ task_id: AUTHORITATIVE_TASKS[0] }]);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.code === 'missing_response'),
    `expected missing_response code; got ${JSON.stringify(r3.errors)}`);
  // unknown_task_id
  const r4 = validateSubmission([{ task_id: 'not-a-real-task', response: 'whatever' }]);
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => e.code === 'unknown_task_id'),
    `expected unknown_task_id code; got ${JSON.stringify(r4.errors)}`);
  // duplicate_task_id
  const dup = AUTHORITATIVE_TASKS[0];
  const r5 = validateSubmission([
    { task_id: dup, response: 'one' },
    { task_id: dup, response: 'two' },
  ]);
  assert.equal(r5.ok, false);
  assert.ok(r5.errors.some((e) => e.code === 'duplicate_task_id'),
    `expected duplicate_task_id code; got ${JSON.stringify(r5.errors)}`);
  // invalid_artifact_cid_format
  const r6 = validateSubmission([
    { task_id: AUTHORITATIVE_TASKS[0], response: 'ok', artifact_cid_or_null: 'not-a-valid-cid' },
  ]);
  assert.equal(r6.ok, false);
  assert.ok(r6.errors.some((e) => e.code === 'invalid_artifact_cid_format'),
    `expected invalid_artifact_cid_format code; got ${JSON.stringify(r6.errors)}`);
});

// =============================================================================
// 6) scoreSubmission HONEST stub
// =============================================================================

test('W756 #6 — scoreSubmission returns HONEST k_score:null stub with stable reason code', () => {
  freshDir();
  const rows = [
    { task_id: AUTHORITATIVE_TASKS[0], response: 'answer' },
    { task_id: AUTHORITATIVE_TASKS[1], response: 'answer' },
  ];
  const r = scoreSubmission(rows);
  assert.equal(r.ok, true);
  assert.equal(r.k_score, null,
    `k_score MUST be null on stub (NEVER fake); got ${r.k_score}`);
  assert.equal(r.axis_breakdown, null,
    `axis_breakdown MUST be null on stub (NEVER fake); got ${JSON.stringify(r.axis_breakdown)}`);
  assert.equal(r.reason, 'kolmbench_v1_scoring_offline_pending_pack',
    `reason MUST be 'kolmbench_v1_scoring_offline_pending_pack'; got ${r.reason}`);
  assert.ok(typeof r.hint === 'string' && r.hint.includes('W807'),
    'hint should mention the W807 reviewer-bot blocker');
  // Coverage hint is informational, NEVER a score.
  assert.ok(r.coverage && typeof r.coverage.covered === 'number',
    `coverage hint should be present; got ${JSON.stringify(r.coverage)}`);
  // Score-on-invalid path bubbles a deterministic failure envelope.
  const bad = scoreSubmission([{ task_id: 'unknown', response: 'x' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.k_score, null);
  assert.equal(bad.reason, 'submission_failed_validation');
  assert.ok(Array.isArray(bad.validation_errors) && bad.validation_errors.length > 0);
});

// =============================================================================
// 7) readLeaderboard returns canonical entries[]
// =============================================================================

test('W756 #7 — readLeaderboard returns canonical entries[] with version stamp', () => {
  freshDir();
  const board = readLeaderboard();
  assert.equal(board.ok, true,
    `expected ok:true for the static fixture; got ${JSON.stringify(board)}`);
  assert.equal(board.version, 'w756-v1',
    `expected version w756-v1; got ${board.version}`);
  assert.ok(Array.isArray(board.entries));
  assert.ok(board.entries.length >= 1,
    `expected at least one reference entry; got ${JSON.stringify(board.entries)}`);
  const ref = board.entries[0];
  assert.equal(ref.submitter, 'kolm-reference');
  assert.equal(ref.model, 'kolm-3b-base');
  assert.ok(typeof ref.k_score === 'number' && ref.k_score > 0 && ref.k_score <= 1,
    `reference k_score must be in (0,1]; got ${ref.k_score}`);
});

// =============================================================================
// 8) appendLeaderboardEntry forces verified:false without a real receipt
// =============================================================================

test('W756 #8 — appendLeaderboardEntry forces verified:false unless ed25519 receipt is a real file', () => {
  freshDir();
  withLeaderboardSnapshot(() => {
    // 8a — caller passes verified:true with NO receipt path → must end up verified:false.
    const r1 = appendLeaderboardEntry({
      submitter: 'w756-test-no-receipt-' + crypto.randomBytes(2).toString('hex'),
      model: 'fake-7b',
      k_score: 0.5,
      verified: true,
      ed25519_receipt_path: null,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.entry_added.verified, false,
      `MUST force verified:false when no receipt path provided; got ${r1.entry_added.verified}`);
    // 8b — caller passes verified:true with a non-existent path → still verified:false.
    const fakePath = path.join(os.tmpdir(), 'kolm-w756-not-real-' + Date.now() + '.bin');
    const r2 = appendLeaderboardEntry({
      submitter: 'w756-test-fake-path-' + crypto.randomBytes(2).toString('hex'),
      model: 'fake-7b',
      k_score: 0.5,
      verified: true,
      ed25519_receipt_path: fakePath,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.entry_added.verified, false,
      `MUST force verified:false when receipt path doesn't exist; got ${r2.entry_added.verified}`);
    // 8c — caller passes verified:true with a real, non-empty file → verified:true permitted.
    const realPath = path.join(os.tmpdir(), 'kolm-w756-real-receipt-' + Date.now() + '.bin');
    fs.writeFileSync(realPath, 'fake-ed25519-signature-bytes');
    try {
      const r3 = appendLeaderboardEntry({
        submitter: 'w756-test-real-path-' + crypto.randomBytes(2).toString('hex'),
        model: 'fake-7b',
        k_score: 0.5,
        verified: true,
        ed25519_receipt_path: realPath,
      });
      assert.equal(r3.ok, true);
      assert.equal(r3.entry_added.verified, true,
        `verified:true allowed only when receipt file is real + non-empty; got ${r3.entry_added.verified}`);
    } finally {
      try { fs.unlinkSync(realPath); } catch (_e) { /* swallow */ }
    }
  });
});

// =============================================================================
// 9) appendLeaderboardEntry validates required fields
// =============================================================================

test('W756 #9 — appendLeaderboardEntry rejects missing submitter/model/k_score with stable error codes', () => {
  freshDir();
  const noSubmitter = appendLeaderboardEntry({ model: 'm', k_score: 0.5 });
  assert.equal(noSubmitter.ok, false);
  assert.equal(noSubmitter.error, 'missing_submitter');
  const noModel = appendLeaderboardEntry({ submitter: 's', k_score: 0.5 });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.error, 'missing_model');
  const noScore = appendLeaderboardEntry({ submitter: 's', model: 'm' });
  assert.equal(noScore.ok, false);
  assert.equal(noScore.error, 'invalid_k_score');
  const oobScore = appendLeaderboardEntry({ submitter: 's', model: 'm', k_score: 1.5 });
  assert.equal(oobScore.ok, false);
  assert.equal(oobScore.error, 'invalid_k_score');
  const nanScore = appendLeaderboardEntry({ submitter: 's', model: 'm', k_score: NaN });
  assert.equal(nanScore.ok, false);
  assert.equal(nanScore.error, 'invalid_k_score');
});

// =============================================================================
// 10) getV2SeedTaskCandidates returns honest envelope
// =============================================================================

test('W756 #10 — getV2SeedTaskCandidates returns honest w757/w766-blocked envelope', () => {
  freshDir();
  const env = getV2SeedTaskCandidates();
  assert.equal(env.ok, false,
    `v2 seed pipeline MUST emit ok:false (not shipped); got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'kolmbench_v2_consent_pipeline_not_shipped',
    `error MUST be 'kolmbench_v2_consent_pipeline_not_shipped'; got ${env.error}`);
  assert.deepEqual(env.blocked_by, ['W757', 'W766'],
    `blocked_by MUST be ['W757','W766']; got ${JSON.stringify(env.blocked_by)}`);
  assert.equal(env.version, 'w756-v1');
  assert.ok(typeof env.hint === 'string' && env.hint.includes('W757') && env.hint.includes('W766'),
    `hint should mention BOTH W757 + W766 blockers; got ${JSON.stringify(env.hint)}`);
});

// =============================================================================
// 11) GET /v1/kolmbench/spec is PUBLIC
// =============================================================================

test('W756 #11 — GET /v1/kolmbench/spec is PUBLIC + returns ok:true + spec', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No auth header — should still succeed (public).
    const res = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/spec`, { method: 'GET' });
    assert.equal(res.status, 200, `expected 200 public; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'w756-v1');
    assert.ok(body.spec && typeof body.spec === 'object');
    assert.equal(body.spec.license, 'CC-BY-4.0');
    assert.equal(body.authoritative_task_count, AUTHORITATIVE_TASKS.length);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 12) GET /v1/kolmbench/leaderboard is PUBLIC
// =============================================================================

test('W756 #12 — GET /v1/kolmbench/leaderboard is PUBLIC + returns entries[]', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/leaderboard`, { method: 'GET' });
    assert.equal(res.status, 200, `expected 200 public; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'w756-v1');
    assert.ok(Array.isArray(body.entries) && body.entries.length >= 1,
      `expected at least 1 reference entry; got ${JSON.stringify(body.entries)}`);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 13) POST /v1/kolmbench/validate is auth-required
// =============================================================================

test('W756 #13 — POST /v1/kolmbench/validate returns 401 without auth', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [] }),
    });
    assert.equal(res.status, 401, `expected 401 with no auth; got ${res.status}`);
    const body = await res.json();
    // The auth middleware may short-circuit with its own 'missing api key'
    // error before reaching the route's 'auth_required' check. Both are
    // honest 401 envelopes; either one proves auth is enforced. The
    // middleware-side body shape is {error,hint} (no ok:false field) — the
    // route-side body shape is {ok:false,error}. We accept either.
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(body.error || '')),
      `expected an auth-required-shape error; got ${JSON.stringify(body)}`,
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 14) POST /v1/kolmbench/submit is auth + confirm:true gated
// =============================================================================

test('W756 #14 — POST /v1/kolmbench/submit requires auth AND body.confirm:true', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const { provisionTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionTenant('w756-submit-' + crypto.randomBytes(3).toString('hex'),
    { kind: 'human', plan: 'enterprise', quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // 14a — no auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noAuth.status, 401);
    // 14b — auth but no confirm → 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ submitter: 's', model: 'm', k_score: 0.5 }),
    });
    assert.equal(noConfirm.status, 400, `expected 400 without confirm; got ${noConfirm.status}`);
    const noConfBody = await noConfirm.json();
    assert.equal(noConfBody.ok, false);
    assert.equal(noConfBody.error, 'confirm_required',
      `error MUST be 'confirm_required'; got ${noConfBody.error}`);
    // 14c — auth + confirm + valid body → 200 + entry added.
    await withLeaderboardSnapshot(async () => {
      const okRes = await fetch(`http://127.0.0.1:${port}/v1/kolmbench/submit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + t.api_key,
        },
        body: JSON.stringify({
          confirm: true,
          submitter: 'w756-cli-test-' + crypto.randomBytes(2).toString('hex'),
          model: 'kolm-test-7b',
          k_score: 0.42,
        }),
      });
      assert.equal(okRes.status, 200, `expected 200 with auth + confirm + valid body; got ${okRes.status}`);
      const okBody = await okRes.json();
      assert.equal(okBody.ok, true);
      assert.ok(okBody.entry_added && typeof okBody.entry_added === 'object');
      assert.equal(okBody.entry_added.verified, false,
        `MUST force verified:false on a fresh submission (W807-pending); got ${okBody.entry_added.verified}`);
      assert.ok(typeof okBody.total_entries === 'number' && okBody.total_entries >= 2);
    });
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 15) public/bench/kolmbench-v1.html brand-lock + anchors
// =============================================================================

test('W756 #15 — public/bench/kolmbench-v1.html exists with brand-lock + leaderboard-table anchor + W807/CC-BY-4.0', () => {
  freshDir();
  assert.ok(fs.existsSync(BENCH_HTML), `expected ${BENCH_HTML}`);
  const html = fs.readFileSync(BENCH_HTML, 'utf8');
  for (const needle of [
    'kolm.ai',
    'Open-source AI workbench',                 // brand eyebrow
    'KolmBench v1',                              // brand H1
    'w756-v1',                                   // version stamp
    'data-w756="kolmbench-spec"',                // spec anchor
    'data-w756="leaderboard-table"',             // leaderboard anchor
    'W807',                                      // reviewer-bot honesty
    'CC-BY-4.0',                                 // license
    'F &middot; Faithfulness',                   // axis card
    'R &middot; Reliability',                    // axis card
    'E &middot; Efficiency',                     // axis card
  ]) {
    assert.ok(html.includes(needle),
      `bench/kolmbench-v1.html must mention "${needle}"`);
  }
  // No emoji glyphs in body (brand-lock).
  const commonEmoji = /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
  assert.ok(!commonEmoji.test(html),
    'bench/kolmbench-v1.html MUST NOT carry emoji glyphs (brand-lock)');
});

// =============================================================================
// 16) public/bench/leaderboard.json valid + version stamp
// =============================================================================

test('W756 #16 — public/bench/leaderboard.json is valid JSON with version w756-v1 + at least one entry', () => {
  freshDir();
  assert.ok(fs.existsSync(LEADERBOARD_PATH), `expected ${LEADERBOARD_PATH}`);
  const text = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error('leaderboard.json must be valid JSON: ' + e.message); }
  assert.equal(parsed.version, 'w756-v1',
    `leaderboard.json version must be 'w756-v1'; got ${parsed.version}`);
  assert.ok(Array.isArray(parsed.entries) && parsed.entries.length >= 1,
    `expected at least 1 reference entry; got ${JSON.stringify(parsed.entries)}`);
  // Reference entry shape check.
  const ref = parsed.entries[0];
  for (const key of ['submitter', 'model', 'k_score', 'k_axes', 'verified', 'submitted_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(ref, key),
      `reference entry missing key '${key}': ${JSON.stringify(ref)}`);
  }
});

// =============================================================================
// 17) .github/workflows/kolmbench-submission.yml shape
// =============================================================================

test('W756 #17 — .github/workflows/kolmbench-submission.yml exists with correct triggers/permissions/validator call', () => {
  freshDir();
  assert.ok(fs.existsSync(WORKFLOW_PATH), `expected ${WORKFLOW_PATH}`);
  const yaml = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  for (const needle of [
    'name: kolmbench-submission',
    'pull_request:',
    "'submissions/**'",                         // path filter
    'pull-requests: write',
    'actions/checkout@v4',
    'actions/setup-node@v4',
    "node-version: '20'",
    'validateSubmission',                       // calls our module
    'src/kolmbench.js',                         // imports our module
    'actions/github-script@v7',                 // PR comment step
    'W807',                                     // honest auto-merge note
  ]) {
    assert.ok(yaml.includes(needle),
      `workflow yml must mention "${needle}"`);
  }
});

// =============================================================================
// 18) cli/kolm.js dispatcher
// =============================================================================

test('W756 #18 — cli/kolm.js defines cmdW756Kolmbench exactly once + wired from case "kolmbench" AND case "kb"', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW756Kolmbench\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW756Kolmbench definition; got ${defs.length}`);
  assert.ok(/case\s+['"]kolmbench['"]/.test(cli),
    `cli must have case 'kolmbench' arm`);
  assert.ok(/case\s+['"]kb['"]/.test(cli),
    `cli must have case 'kb' alias arm`);
  assert.ok(cli.includes('cmdW756Kolmbench(rest)'),
    `case 'kolmbench' must invoke cmdW756Kolmbench(rest)`);
  // COMPLETION_SUBS for shell completion.
  assert.ok(/COMPLETION_SUBS\.kolmbench\s*=/.test(cli),
    `COMPLETION_SUBS.kolmbench must be assigned for shell completion`);
});

// =============================================================================
// 19) vercel.json rewrites
// =============================================================================

test('W756 #19 — vercel.json has rewrites for /bench/kolmbench-v1 + /bench/leaderboard', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = v.rewrites || [];
  const html = rewrites.find((r) => r.source === '/bench/kolmbench-v1');
  assert.ok(html, 'vercel.json must have rewrite for /bench/kolmbench-v1');
  assert.equal(html.destination, '/bench/kolmbench-v1.html',
    `/bench/kolmbench-v1 must rewrite to /bench/kolmbench-v1.html; got ${html.destination}`);
  const lb = rewrites.find((r) => r.source === '/bench/leaderboard');
  assert.ok(lb, 'vercel.json must have rewrite for /bench/leaderboard');
  assert.equal(lb.destination, '/bench/leaderboard.json',
    `/bench/leaderboard must rewrite to /bench/leaderboard.json; got ${lb.destination}`);
});

// =============================================================================
// 20) src/auth.js PUBLIC_API gate — spec + leaderboard public; validate +
//     submit stay auth-gated
// =============================================================================

test('W756 #20 — src/auth.js makes /v1/kolmbench/spec + /v1/kolmbench/leaderboard PUBLIC but NOT validate/submit', () => {
  freshDir();
  const auth = fs.readFileSync(AUTH_PATH, 'utf8');
  assert.ok(auth.includes("p === '/v1/kolmbench/spec'"),
    `auth.js PUBLIC_API must include literal '/v1/kolmbench/spec'`);
  assert.ok(auth.includes("p === '/v1/kolmbench/leaderboard'"),
    `auth.js PUBLIC_API must include literal '/v1/kolmbench/leaderboard'`);
  // validate + submit must NOT appear as PUBLIC_API literals.
  assert.ok(!auth.includes("p === '/v1/kolmbench/validate'"),
    `validate MUST NOT appear as a PUBLIC_API literal in auth.js`);
  assert.ok(!auth.includes("p === '/v1/kolmbench/submit'"),
    `submit MUST NOT appear as a PUBLIC_API literal in auth.js`);
});

// =============================================================================
// 21) wave756 sibling test count uses regex wave(\d{3,4}) + threshold pattern
// =============================================================================

test('W756 #21 — wave756 sibling test count uses regex wave(\\d{3,4}) + threshold (W604 anti-brittleness)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
