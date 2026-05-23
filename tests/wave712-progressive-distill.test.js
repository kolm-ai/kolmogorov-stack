// W712 — progressive distillation + capability gating tests.
//
// Atomic items pinned:
//
//   1) PROGRESSIVE_VERSION exported and matches the w712-v1 contract.
//   2) PASS_GATES has all 3 passes with axis + threshold.
//   3) filterCapturesForPass(captures, 1) returns all rows verbatim.
//   4) filterCapturesForPass(captures, 2) filters by reasoning_trace OR
//      token_count > 200 (multi-step proxy).
//   5) filterCapturesForPass(captures, 3) honors caller-supplied failures
//      passthrough (the pass-2 failure slice).
//   6) evaluateGate(1, {F: 0.7}) returns ok:true with advanced_to_pass:2.
//   7) evaluateGate(2, {R: 0.4}) returns ok:false with need_more:{class, count}.
//   8) evaluateGate(3, {E: 0.6}) returns ok:true and graduated (no next pass).
//   9) buildGateEnvelope shape contract for both pass and fail paths.
//  10) CLI `kolm distill --progressive` with no python falls back to the
//      honest envelope (trainer_not_invoked:true, exit 0).
//
// Concurrency 1 (per W711/W713 sibling-wave convention). KOLM_DATA_DIR
// isolated per-test via freshDir() so the event-store doesn't leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROGRESSIVE_VERSION,
  PASS_GATES,
  filterCapturesForPass,
  evaluateGate,
  buildGateEnvelope,
} from '../src/progressive-distill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w712-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// =============================================================================
// 1) PROGRESSIVE_VERSION exported.
// =============================================================================

test('W712 #1 — PROGRESSIVE_VERSION exported as w712-v1', () => {
  assert.equal(PROGRESSIVE_VERSION, 'w712-v1');
});

// =============================================================================
// 2) PASS_GATES shape.
// =============================================================================

test('W712 #2 — PASS_GATES has all 3 passes with axis + threshold', () => {
  assert.ok(PASS_GATES && typeof PASS_GATES === 'object');
  for (const passN of [1, 2, 3]) {
    const spec = PASS_GATES[passN];
    assert.ok(spec, `PASS_GATES[${passN}] present`);
    assert.ok(typeof spec.axis === 'string' && spec.axis.length === 1,
      `PASS_GATES[${passN}].axis is a single-letter K-Score axis`);
    assert.ok(typeof spec.threshold === 'number' && spec.threshold > 0 && spec.threshold < 1,
      `PASS_GATES[${passN}].threshold in (0,1)`);
  }
  // Order: pass-1 threshold > pass-2 > pass-3 (curriculum gets stricter
  // criteria as you go because the gate is being applied to a smaller, more
  // specialized slice — we expect lower absolute scores on harder slices).
  assert.ok(PASS_GATES[1].threshold > PASS_GATES[2].threshold);
  assert.ok(PASS_GATES[2].threshold > PASS_GATES[3].threshold);
});

// =============================================================================
// 3) filterCapturesForPass — pass 1 returns all.
// =============================================================================

test('W712 #3 — filterCapturesForPass(captures, 1) returns all rows', () => {
  const captures = [
    { id: 'a', prompt: 'p1', response: 'r1' },
    { id: 'b', prompt: 'p2', response: 'r2' },
    { id: 'c', prompt: 'p3', response: 'r3' },
  ];
  const out = filterCapturesForPass(captures, 1);
  assert.equal(out.length, captures.length);
  // Returned array is a fresh array (defensive copy), not the original ref.
  assert.notEqual(out, captures);
  // Each capture preserved.
  for (let i = 0; i < captures.length; i++) {
    assert.deepEqual(out[i], captures[i]);
  }
  // Tolerates null/undefined input without throwing.
  assert.deepEqual(filterCapturesForPass(null, 1), []);
  assert.deepEqual(filterCapturesForPass(undefined, 1), []);
});

// =============================================================================
// 4) filterCapturesForPass — pass 2 filters multi-step.
// =============================================================================

test('W712 #4 — filterCapturesForPass(captures, 2) filters by reasoning_trace or token>200', () => {
  // Build a capture with > 200 tokens.
  const longResponse = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ');
  const shortResponse = 'just a few words.';
  const captures = [
    { id: 'short', prompt: 'p', response: shortResponse },                     // OUT
    { id: 'long', prompt: 'p', response: longResponse },                       // IN (>200 tokens)
    { id: 'trace', prompt: 'p', response: shortResponse, reasoning_trace: { text: 'thought...' } }, // IN (trace)
    { id: 'tc', prompt: 'p', response: shortResponse, token_count: 500 },      // IN (explicit count)
    { id: 'tc-low', prompt: 'p', response: shortResponse, token_count: 10 },   // OUT
  ];
  const out = filterCapturesForPass(captures, 2);
  const outIds = new Set(out.map(c => c.id));
  assert.ok(outIds.has('long'), 'long-response capture kept');
  assert.ok(outIds.has('trace'), 'reasoning_trace capture kept');
  assert.ok(outIds.has('tc'), 'explicit token_count>200 kept');
  assert.ok(!outIds.has('short'), 'short capture dropped');
  assert.ok(!outIds.has('tc-low'), 'low token_count dropped');
  assert.equal(out.length, 3);
});

// =============================================================================
// 5) filterCapturesForPass — pass 3 passthrough of failures slice.
// =============================================================================

test('W712 #5 — filterCapturesForPass pass 3 honors caller-supplied failures', () => {
  const captures = [
    { id: 'a', prompt: 'p', response: 'r' },
    { id: 'b', prompt: 'p', response: 'r' },
  ];
  const failures = [{ id: 'fail1', prompt: 'p', response: 'wrong' }];
  // With failures opts.
  const out = filterCapturesForPass(captures, 3, { failures });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'fail1');
  // Without failures opts — passes captures through (CLI side handled the
  // filter; the function is a passthrough by design so it stays pure).
  const out2 = filterCapturesForPass(captures, 3);
  assert.equal(out2.length, captures.length);
});

// =============================================================================
// 6) evaluateGate pass path.
// =============================================================================

test('W712 #6 — evaluateGate(1, {F: 0.7}) returns ok:true with advanced_to_pass:2', () => {
  const r = evaluateGate(1, { F: 0.7 });
  assert.equal(r.ok, true);
  assert.equal(r.pass, 1);
  assert.equal(r.axis, 'F');
  assert.equal(r.score, 0.7);
  assert.equal(r.threshold, PASS_GATES[1].threshold);
  assert.equal(r.advanced_to_pass, 2);
});

// =============================================================================
// 7) evaluateGate fail path with need_more envelope.
// =============================================================================

test('W712 #7 — evaluateGate(2, {R: 0.4}) returns ok:false with need_more', () => {
  const r = evaluateGate(2, { R: 0.4 });
  assert.equal(r.ok, false);
  assert.equal(r.pass, 2);
  assert.equal(r.axis, 'R');
  assert.equal(r.score, 0.4);
  assert.equal(r.threshold, PASS_GATES[2].threshold);
  assert.ok(r.need_more && typeof r.need_more === 'object', 'need_more present');
  assert.ok(typeof r.need_more.class === 'string' && r.need_more.class.length > 0,
    'need_more.class is a non-empty string');
  assert.ok(typeof r.need_more.count === 'number' && r.need_more.count >= 50,
    `need_more.count is a positive int >= 50; got ${r.need_more.count}`);
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0, 'hint present');
});

// =============================================================================
// 8) evaluateGate pass 3 graduates (no advanced_to_pass).
// =============================================================================

test('W712 #8 — evaluateGate(3, {E: 0.6}) graduates with no next pass', () => {
  const r = evaluateGate(3, { E: 0.6 });
  assert.equal(r.ok, true);
  assert.equal(r.pass, 3);
  assert.equal(r.axis, 'E');
  assert.equal(r.score, 0.6);
  assert.equal(r.advanced_to_pass, null,
    `pass-3 success should advance to null (graduated); got ${r.advanced_to_pass}`);
});

// =============================================================================
// 9) buildGateEnvelope shape contract.
// =============================================================================

test('W712 #9 — buildGateEnvelope wraps both pass and fail results', () => {
  // Pass path.
  const passResult = evaluateGate(1, { F: 0.8 });
  const passEnv = buildGateEnvelope(passResult, { captures_remaining: 42 });
  assert.equal(passEnv.ok, true);
  assert.equal(passEnv.progressive_version, PROGRESSIVE_VERSION);
  assert.equal(passEnv.pass, 1);
  assert.equal(passEnv.gate_score, 0.8);
  assert.equal(passEnv.threshold, PASS_GATES[1].threshold);
  assert.equal(passEnv.advanced_to_pass, 2);
  assert.equal(passEnv.captures_remaining, 42);

  // Fail path.
  const failResult = evaluateGate(2, { R: 0.3 });
  const failEnv = buildGateEnvelope(failResult);
  assert.equal(failEnv.ok, false);
  assert.equal(failEnv.progressive_version, PROGRESSIVE_VERSION);
  assert.equal(failEnv.pass, 2);
  assert.equal(failEnv.gate_score, 0.3);
  assert.ok(failEnv.need_more && failEnv.need_more.class && failEnv.need_more.count,
    'need_more present on fail envelope');
  assert.ok(typeof failEnv.hint === 'string' && failEnv.hint.length > 0);

  // Graduated path.
  const gradResult = evaluateGate(3, { E: 0.7 });
  const gradEnv = buildGateEnvelope(gradResult);
  assert.equal(gradEnv.ok, true);
  assert.equal(gradEnv.graduated, true);
  assert.equal(gradEnv.advanced_to_pass, null);

  // Bad-input path.
  const badEnv = buildGateEnvelope(null);
  assert.equal(badEnv.ok, false);
  assert.ok(badEnv.error && /no_gate_result/.test(badEnv.error));
});

// =============================================================================
// 10) CLI honest fallback when no python trainer reachable.
// =============================================================================

test('W712 #10 — CLI `kolm distill --progressive` honest fallback', () => {
  const tmp = freshDir();
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w712', base: 'http://127.0.0.1:1' }),
  );
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_TENANT_ID: 'tenant_w712_10',
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w712',
    // Force the trainer-probe path to fail so we exercise the honest
    // trainer_not_invoked envelope regardless of whether python is on PATH.
    KOLM_DISABLE_TRAINER_PROBE: '1',
    // Point KOLM_TRAINER_BIN at a non-existent file so the existsSync check
    // also fails up front.
    KOLM_TRAINER_BIN: path.join(tmp, 'definitely-not-a-real-trainer-binary'),
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', '--progressive',
    '--namespace', 'ns_w712_10',
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.trainer_not_invoked, true);
  // Honest envelope must regex-match w712-v1 (anti-brittleness via version-pattern).
  assert.ok(/^w712/.test(parsed.progressive_version),
    `progressive_version starts with w712; got ${parsed.progressive_version}`);
  assert.equal(parsed.namespace, 'ns_w712_10');
  assert.ok(typeof parsed.captures_jsonl_written === 'string'
    && parsed.captures_jsonl_written.length > 0,
    'envelope carries captures_jsonl_written path');
  assert.ok(fs.existsSync(parsed.captures_jsonl_written),
    `captures JSONL must exist at ${parsed.captures_jsonl_written}`);
  assert.ok(parsed.hint && /pip install|KOLM_TRAINER_BIN/.test(parsed.hint),
    `envelope hint mentions install path; got ${parsed.hint}`);
  assert.equal(r.status, 0, `exit 0 expected; got ${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
});
