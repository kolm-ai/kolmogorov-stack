// W720 — self-improvement loop tests.
//
// Atomic items pinned:
//
//   1) SELF_IMPROVEMENT_VERSION + IMPROVEMENT_VERSION exported and match w720-*
//   2) detectUnderperformingCaptures honest envelope when no telemetry
//   3) detectUnderperformingCaptures positive: synthetic failing events ->
//      candidates returned with stable shape
//   4) detectUnderperformingCaptures tenant fence: foreign tenant events
//      filtered out at the row level
//   5) orchestrateImprovement returns run_id immediately (non-blocking) and
//      writes a run-meta stub atomically before any worker spawn
//   6) orchestrateImprovement stamps self_improvement.round + base_artifact +
//      telemetry_seed on the run-meta
//   7) compareAndDecide 'promote' decision (positive delta beats min_kscore_delta)
//   8) compareAndDecide 'hold' decision (close call inside the delta band)
//   9) compareAndDecide 'rollback' decision (candidate regresses)
//  10) compareAndDecide honest envelope when K-Score missing on either artifact
//  11) compareAndDecide --auto-promote writes promoted.json atomically
//  12) CLI `kolm distill improve --detect --json` exits 0 with stable JSON shape
//      against a mocked event store
//  13) CLI `kolm distill improve` with no mode flag exits 1 + honest envelope
//
// W604 anti-brittleness: no explicit array lock-ins, all version checks use
// regex /^w720-/ so a v1.x bump in the same wave does not force a coordinated
// test-rev.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

// Each test seeds an isolated KOLM_DATA_DIR + HOME so the event-store does
// not leak rows across tests and the registry directory is private.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w720-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

async function _loadMods() {
  // Reset event-store driver state between tests (per-process module caching
  // means the SQLite handle would otherwise point at a previous test's tmp).
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const si = await import('../src/self-improvement.js');
  const orch = await import('../src/improvement-orchestrator.js');
  const schema = await import('../src/event-schema.js');
  return { es, si, orch, schema };
}

async function _seedFailureRun(es, schema, opts = {}) {
  // Seed N failure events + M success events for the same request_hash so the
  // detection logic can compute a failure_rate.
  //
  // NOTE: numeric `successes` / `failures` use `??` not `||` because 0 is a
  // valid value (passing successes:0 means "no successes seeded"). `||` treats
  // 0 as falsy and would silently revert to the default. W604 trap class.
  const tenant = opts.tenant || 'tenant_w720';
  const namespace = opts.namespace || 'ns_w720';
  const requestHash = opts.request_hash || 'req_w720_aaa';
  const failures = opts.failures ?? 5;
  const successes = opts.successes ?? 1;
  const artifactId = opts.artifact_id || 'art_w720_base';
  for (let i = 0; i < failures; i++) {
    await es.appendEvent(schema.newEvent({
      tenant_id: tenant,
      namespace,
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt_redacted: 'q-' + i,
      response_redacted: 'r-' + i,
      status: 'error',
      error_type: 'mock_failure',
      request_hash: requestHash,
      workflow_id: artifactId,
      event_id: 'evt_w720_fail_' + i + '_' + Math.random().toString(36).slice(2, 8),
    }));
  }
  for (let i = 0; i < successes; i++) {
    await es.appendEvent(schema.newEvent({
      tenant_id: tenant,
      namespace,
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt_redacted: 'q-ok-' + i,
      response_redacted: 'r-ok-' + i,
      status: 'ok',
      request_hash: requestHash,
      workflow_id: artifactId,
      event_id: 'evt_w720_ok_' + i + '_' + Math.random().toString(36).slice(2, 8),
    }));
  }
}

// =============================================================================
// 1) Version constants
// =============================================================================

test('W720 #1 — SELF_IMPROVEMENT_VERSION + IMPROVEMENT_VERSION match w720-* contract', async () => {
  freshDir();
  const { si, orch } = await _loadMods();
  // Anti-brittleness: regex, not literal equality (W604 standing directive).
  assert.ok(typeof si.SELF_IMPROVEMENT_VERSION === 'string', 'SELF_IMPROVEMENT_VERSION is a string');
  assert.ok(/^w720-/.test(si.SELF_IMPROVEMENT_VERSION),
    `SELF_IMPROVEMENT_VERSION starts with w720-; got ${si.SELF_IMPROVEMENT_VERSION}`);
  assert.ok(typeof orch.IMPROVEMENT_VERSION === 'string', 'IMPROVEMENT_VERSION is a string');
  assert.ok(/^w720-/.test(orch.IMPROVEMENT_VERSION),
    `IMPROVEMENT_VERSION starts with w720-; got ${orch.IMPROVEMENT_VERSION}`);
});

// =============================================================================
// 2) detectUnderperformingCaptures honest envelope (no telemetry)
// =============================================================================

test('W720 #2 — detectUnderperformingCaptures honest envelope when no telemetry', async () => {
  freshDir();
  const { si } = await _loadMods();
  const r = await si.detectUnderperformingCaptures({
    tenant_id: 'tenant_w720_empty',
    namespace: 'ns_w720_empty',
    window_days: 7,
  });
  assert.equal(r.ok, false, 'expected ok:false envelope; got ' + JSON.stringify(r));
  assert.equal(r.error, 'no_route_telemetry');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint must be human-actionable');
  assert.ok(/^w720-/.test(r.self_improvement_version),
    `self_improvement_version stamped; got ${r.self_improvement_version}`);
});

// =============================================================================
// 3) detectUnderperformingCaptures positive — synthetic failing events
// =============================================================================

test('W720 #3 — detectUnderperformingCaptures returns candidates with stable shape', async () => {
  freshDir();
  const { es, si, schema } = await _loadMods();
  await _seedFailureRun(es, schema, {
    tenant: 'tenant_w720_pos',
    namespace: 'ns_w720_pos',
    request_hash: 'req_w720_pos_aaa',
    failures: 6,
    successes: 1,
    artifact_id: 'art_w720_pos_base',
  });
  const r = await si.detectUnderperformingCaptures({
    tenant_id: 'tenant_w720_pos',
    namespace: 'ns_w720_pos',
    window_days: 7,
    min_failure_rate: 0.10,
  });
  assert.equal(r.ok, true, 'expected ok:true; got ' + JSON.stringify(r).slice(0, 400));
  assert.ok(Array.isArray(r.candidates), 'candidates must be an array');
  assert.ok(r.candidates.length >= 1, 'at least one candidate (6 failures of 7 events)');
  const c = r.candidates[0];
  // Stable shape — load-bearing fields, not exact equality.
  assert.ok(typeof c.capture_id === 'string' && c.capture_id.length > 0, 'capture_id is non-empty string');
  assert.ok('current_artifact_id' in c, 'current_artifact_id key present');
  assert.ok('observed_kscore' in c, 'observed_kscore key present (may be null)');
  assert.ok(Number.isFinite(c.failure_rate) && c.failure_rate >= 0 && c.failure_rate <= 1,
    `failure_rate in [0,1]; got ${c.failure_rate}`);
  assert.ok(Number.isFinite(c.route_events_count) && c.route_events_count >= 1,
    `route_events_count >= 1; got ${c.route_events_count}`);
  // Failure rate should be approximately 6/7 ~= 0.857.
  assert.ok(c.failure_rate > 0.5, `failure_rate > 0.5 with 6/7 failures; got ${c.failure_rate}`);
});

// =============================================================================
// 4) detectUnderperformingCaptures tenant fence
// =============================================================================

test('W720 #4 — detectUnderperformingCaptures tenant fence filters foreign-tenant rows', async () => {
  freshDir();
  const { es, si, schema } = await _loadMods();
  // Seed two tenants under the SAME namespace + request_hash. The detection
  // call scoped to tenant_a must NOT see tenant_b rows.
  await _seedFailureRun(es, schema, {
    tenant: 'tenant_w720_a',
    namespace: 'ns_w720_fence',
    request_hash: 'req_w720_fence_aaa',
    failures: 4,
    successes: 0,
    artifact_id: 'art_a',
  });
  await _seedFailureRun(es, schema, {
    tenant: 'tenant_w720_b',
    namespace: 'ns_w720_fence',
    request_hash: 'req_w720_fence_bbb',
    failures: 8,
    successes: 0,
    artifact_id: 'art_b',
  });
  const rA = await si.detectUnderperformingCaptures({
    tenant_id: 'tenant_w720_a',
    namespace: 'ns_w720_fence',
  });
  assert.equal(rA.ok, true);
  // All candidate capture_ids must belong to tenant_a's seed (request_hash aaa).
  for (const c of rA.candidates) {
    assert.equal(c.capture_id, 'req_w720_fence_aaa',
      `tenant_a query must not surface tenant_b request_hash; got ${c.capture_id}`);
  }
  // Total events scanned should match tenant_a's 4 failures, not the combined 12.
  assert.equal(rA.events_scanned, 4, `tenant_a events_scanned must be 4; got ${rA.events_scanned}`);
});

// =============================================================================
// 5) orchestrateImprovement returns run_id immediately (non-blocking)
// =============================================================================

test('W720 #5 — orchestrateImprovement returns run_id immediately + writes run-meta stub', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const start = Date.now();
  const r = await orch.orchestrateImprovement({
    tenant_id: 'tenant_w720_orch',
    namespace: 'ns_w720_orch',
    candidates: [
      { capture_id: 'req_w720_orch_a', current_artifact_id: 'art_w720_orch_base', failure_rate: 0.8, route_events_count: 10 },
      { capture_id: 'req_w720_orch_b', current_artifact_id: 'art_w720_orch_base', failure_rate: 0.6, route_events_count: 5 },
    ],
    opts: { use_council: false, skip_spawn: true }, // skip spawn so the test is deterministic
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, true, 'orchestrate must succeed; got ' + JSON.stringify(r));
  assert.ok(typeof r.run_id === 'string' && /^run_si_/.test(r.run_id),
    `run_id matches run_si_*; got ${r.run_id}`);
  assert.ok(typeof r.candidate_artifact_id === 'string' && /^art_si_/.test(r.candidate_artifact_id),
    `candidate_artifact_id matches art_si_*; got ${r.candidate_artifact_id}`);
  assert.equal(r.base_artifact_id, 'art_w720_orch_base');
  assert.ok(r.plan && r.plan.curriculum_enabled === true, 'curriculum_enabled should default true');
  assert.equal(r.plan.teacher_council, false);
  assert.equal(r.plan.candidate_count, 2);
  assert.ok(r.poll_url.startsWith('/v1/distill/runs/'));
  // Non-blocking: should return well under a worker's spawn time.
  assert.ok(elapsed < 5000, `orchestrate should return promptly; took ${elapsed}ms`);
  // Run-meta stub must exist on disk.
  const metaPath = path.join(r.run_dir, 'run-meta.json');
  assert.ok(fs.existsSync(metaPath), 'run-meta.json stub must be written immediately');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.tenant_id, 'tenant_w720_orch');
  assert.equal(meta.namespace, 'ns_w720_orch');
});

// =============================================================================
// 6) orchestrateImprovement stamps self_improvement metadata on run-meta
// =============================================================================

test('W720 #6 — orchestrateImprovement stamps self_improvement.round + base_artifact + telemetry_seed', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const r = await orch.orchestrateImprovement({
    tenant_id: 'tenant_w720_meta',
    namespace: 'ns_w720_meta',
    candidates: [
      { capture_id: 'req_w720_meta_a', current_artifact_id: 'art_w720_meta_base' },
      { capture_id: 'req_w720_meta_b', current_artifact_id: 'art_w720_meta_base' },
      { capture_id: 'req_w720_meta_c', current_artifact_id: null },
    ],
    opts: { use_council: true, skip_spawn: true },
  });
  assert.equal(r.ok, true);
  const meta = JSON.parse(fs.readFileSync(path.join(r.run_dir, 'run-meta.json'), 'utf8'));
  assert.ok(meta.self_improvement && typeof meta.self_improvement === 'object',
    'self_improvement block must be present');
  assert.equal(meta.self_improvement.round, 1, 'first round defaults to 1');
  assert.equal(meta.self_improvement.base_artifact, 'art_w720_meta_base');
  assert.ok(Array.isArray(meta.self_improvement.telemetry_seed),
    'telemetry_seed must be an array');
  // telemetry_seed contains the capture_ids in input order, including null-art candidates.
  assert.ok(meta.self_improvement.telemetry_seed.includes('req_w720_meta_a'));
  assert.ok(meta.self_improvement.telemetry_seed.includes('req_w720_meta_b'));
  assert.equal(meta.self_improvement.candidate_count, 3);
  assert.equal(meta.self_improvement.use_curriculum, true);
  assert.equal(meta.self_improvement.use_council, true);
  // Top-level convenience fields preserved for older readers.
  assert.equal(meta.self_improvement_round, 1);
  assert.equal(meta.base_artifact, 'art_w720_meta_base');
});

// =============================================================================
// 7) compareAndDecide 'promote' (positive delta)
// =============================================================================

test('W720 #7 — compareAndDecide promote decision (candidate beats base by >= delta)', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const r = await orch.compareAndDecide({
    tenant_id: 'tenant_w720_promote',
    base_artifact_id: 'art_w720_base_promote',
    candidate_artifact_id: 'art_w720_cand_promote',
    base_kscore: 0.80,
    candidate_kscore: 0.88,
    gate: { min_kscore_delta: 0.02, max_regression_classes: 0, auto_promote: false },
  });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'promote');
  assert.ok(Math.abs(r.delta - 0.08) < 1e-6, `delta == 0.08; got ${r.delta}`);
  assert.equal(r.base_kscore, 0.80);
  assert.equal(r.candidate_kscore, 0.88);
  assert.equal(r.promoted_path, null, 'no promoted.json without --auto-promote');
});

// =============================================================================
// 8) compareAndDecide 'hold' decision (close call)
// =============================================================================

test('W720 #8 — compareAndDecide hold decision (within delta band)', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const r = await orch.compareAndDecide({
    tenant_id: 'tenant_w720_hold',
    base_artifact_id: 'art_w720_base_hold',
    candidate_artifact_id: 'art_w720_cand_hold',
    base_kscore: 0.80,
    candidate_kscore: 0.805,
    gate: { min_kscore_delta: 0.02 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'hold', `expected hold; got ${r.decision} (delta=${r.delta})`);
  assert.ok(r.delta < 0.02 && r.delta > -0.02, 'delta within band');
});

// =============================================================================
// 9) compareAndDecide 'rollback' decision (candidate regresses)
// =============================================================================

test('W720 #9 — compareAndDecide rollback decision (candidate worse than base)', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const r = await orch.compareAndDecide({
    tenant_id: 'tenant_w720_roll',
    base_artifact_id: 'art_w720_base_roll',
    candidate_artifact_id: 'art_w720_cand_roll',
    base_kscore: 0.85,
    candidate_kscore: 0.70,
    gate: { min_kscore_delta: 0.02 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'rollback');
  assert.ok(r.delta < -0.02, `delta strictly negative beyond band; got ${r.delta}`);
});

// =============================================================================
// 10) compareAndDecide honest envelope when K-Score missing
// =============================================================================

test('W720 #10 — compareAndDecide honest envelope when K-Score missing on either artifact', async () => {
  freshDir();
  const { orch } = await _loadMods();
  // No registry stub on disk + no override -> missing K-Score on the base side.
  const r = await orch.compareAndDecide({
    tenant_id: 'tenant_w720_miss',
    base_artifact_id: 'art_w720_base_miss',
    candidate_artifact_id: 'art_w720_cand_miss',
    // Provide candidate override but NOT base — exercises the missing-base branch.
    candidate_kscore: 0.90,
    gate: { min_kscore_delta: 0.02 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_kscore_on_artifact');
  assert.equal(r.which, 'base');
  assert.ok(typeof r.hint === 'string' && /kolm bench|distill --eval/.test(r.hint),
    'hint must point at kolm bench or distill --eval');
});

// =============================================================================
// 11) compareAndDecide --auto-promote writes promoted.json atomically
// =============================================================================

test('W720 #11 — compareAndDecide auto_promote writes promoted.json with stable shape', async () => {
  freshDir();
  const { orch } = await _loadMods();
  const r = await orch.compareAndDecide({
    tenant_id: 'tenant_w720_auto',
    base_artifact_id: 'art_w720_base_auto',
    candidate_artifact_id: 'art_w720_cand_auto',
    base_kscore: 0.80,
    candidate_kscore: 0.90,
    gate: { min_kscore_delta: 0.02, auto_promote: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'promote');
  assert.ok(r.promoted_path && fs.existsSync(r.promoted_path),
    'promoted_path must exist on disk; got ' + r.promoted_path);
  const p = JSON.parse(fs.readFileSync(r.promoted_path, 'utf8'));
  assert.equal(p.decision, 'promote');
  assert.equal(p.tenant_id, 'tenant_w720_auto');
  assert.equal(p.base_artifact_id, 'art_w720_base_auto');
  assert.equal(p.candidate_artifact_id, 'art_w720_cand_auto');
  assert.ok(Math.abs(p.delta - 0.10) < 1e-6);
  assert.ok(typeof p.decision_at === 'string' && Date.parse(p.decision_at),
    'decision_at must be a parseable ISO timestamp');
  // No leftover .tmp from the atomic write.
  const regDir = path.dirname(r.promoted_path);
  const stragglers = fs.readdirSync(regDir).filter((f) => f.includes('.tmp.'));
  assert.equal(stragglers.length, 0, 'no .tmp stragglers from atomic write; got ' + stragglers.join(','));
});

// =============================================================================
// 12) CLI `kolm distill improve --detect --json` exits 0 with stable JSON
// =============================================================================

test('W720 #12 — CLI distill improve --detect --json exits 0 + stable shape against seeded store', async () => {
  const tmp = freshDir();
  // Seed an isolated event store so the CLI's child process picks it up via
  // KOLM_DATA_DIR + HOME env vars.
  const { es, schema } = await _loadMods();
  await _seedFailureRun(es, schema, {
    tenant: 'tenant_w720_cli',
    namespace: 'ns_w720_cli',
    request_hash: 'req_w720_cli_aaa',
    failures: 8,
    successes: 2,
    artifact_id: 'art_w720_cli_base',
  });
  // Pre-create the kolm config (required by some upstream loadConfig consumers
  // even though cmdDistillImprove itself does not call loadConfig).
  fs.mkdirSync(path.join(tmp, '.kolm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.kolm', 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w720', base: 'http://127.0.0.1:1' }, null, 2));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w720',
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', 'improve',
    '--detect',
    '--tenant', 'tenant_w720_cli',
    '--namespace', 'ns_w720_cli',
    '--window-days', '7',
    '--min-failure-rate', '0.10',
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0,
    `expected exit 0; got ${r.status} stdout=${(r.stdout || '').slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; got ${stdout.slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.candidates), 'candidates is array');
  assert.ok(parsed.candidates.length >= 1, 'at least one candidate (8/10 failure rate)');
  assert.ok(/^w720-/.test(parsed.self_improvement_version),
    `version stamped; got ${parsed.self_improvement_version}`);
  assert.equal(parsed.tenant_id, 'tenant_w720_cli');
  assert.equal(parsed.namespace, 'ns_w720_cli');
});

// =============================================================================
// 13) CLI `kolm distill improve` with no mode flag exits 1 + honest envelope
// =============================================================================

test('W720 #13 — CLI distill improve without mode flag exits 1 + honest envelope', async () => {
  const tmp = freshDir();
  fs.mkdirSync(path.join(tmp, '.kolm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.kolm', 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w720', base: 'http://127.0.0.1:1' }, null, 2));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w720',
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', 'improve', '--json',
  ], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.status, 1,
    `expected exit 1 (BAD_ARGS); got ${r.status} stdout=${(r.stdout || '').slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0, 'expected JSON envelope on stdout');
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'no_mode_flag');
  assert.ok(/detect|orchestrate|decide/.test(parsed.hint), 'hint mentions the three modes');
});
