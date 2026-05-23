// W718 — Teacher Council (multi-teacher ensemble blending) tests.
//
// Atomic items pinned:
//
//   1) TEACHER_COUNCIL_VERSION === 'w718-v1'
//   2) GAMMA_DEFAULTS shape contract (6 named gammas, all positive)
//   3) computeTeacherWeights softmax sums to 1.0 within float epsilon
//   4) High domain_reliability teacher gets higher weight (monotonicity)
//   5) High cost teacher gets lower weight (cost penalty works)
//   6) TeacherReliabilityTable defaults to 0.5 for unknown teacher
//   7) TeacherReliabilityTable persist/load roundtrip
//   8) selectTeacherForCapture returns an explanation string
//   9) blendTargets argmax for text + weighted mean for numbers
//  10) CLI --teachers a,b,c --weights auto with no captures exits 3 + envelope
//
// Concurrency 1 (per W711/W712 sibling-wave convention). KOLM_DATA_DIR
// isolated per-test via freshDir() so persisted tables / captures don't leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TEACHER_COUNCIL_VERSION,
  GAMMA_DEFAULTS,
  computeTeacherWeights,
  selectTeacherForCapture,
  blendTargets,
} from '../src/teacher-council.js';
import {
  TeacherReliabilityTable,
  runMiniBakeoff,
  defaultPersistPath,
  DEFAULT_RELIABILITY,
} from '../src/teacher-weights.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w718-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// =============================================================================
// 1) TEACHER_COUNCIL_VERSION
// =============================================================================

test('W718 #1 — TEACHER_COUNCIL_VERSION === w718-v1', () => {
  assert.equal(TEACHER_COUNCIL_VERSION, 'w718-v1');
});

// =============================================================================
// 2) GAMMA_DEFAULTS shape contract
// =============================================================================

test('W718 #2 — GAMMA_DEFAULTS shape contract', () => {
  assert.ok(GAMMA_DEFAULTS && typeof GAMMA_DEFAULTS === 'object');
  const expected = ['domain', 'task', 'verifier', 'human', 'cost', 'risk'];
  for (const k of expected) {
    assert.ok(k in GAMMA_DEFAULTS, `GAMMA_DEFAULTS missing key: ${k}`);
    assert.equal(typeof GAMMA_DEFAULTS[k], 'number', `GAMMA_DEFAULTS.${k} should be number`);
    assert.ok(GAMMA_DEFAULTS[k] > 0, `GAMMA_DEFAULTS.${k} should be positive`);
  }
  // Frozen so an accidental write throws.
  const before = GAMMA_DEFAULTS.domain;
  try { GAMMA_DEFAULTS.domain = 999; } catch (_) {}
  assert.equal(GAMMA_DEFAULTS.domain, before, 'GAMMA_DEFAULTS should be immutable');
});

// =============================================================================
// 3) computeTeacherWeights softmax sums to 1.0
// =============================================================================

test('W718 #3 — computeTeacherWeights softmax sums to 1.0', () => {
  const teachers = ['claude-opus-4-7', 'gpt-4o', 'gemini-2-pro'];
  const capture = { domain: 'code', task: 'generation' };
  const weights = computeTeacherWeights(teachers, capture, null);
  assert.equal(weights.length, 3);
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum should be 1.0, got ${sum}`);
  // Empty input -> [].
  assert.deepEqual(computeTeacherWeights([], capture, null), []);
});

// =============================================================================
// 4) High domain_reliability teacher gets higher weight (monotonicity)
// =============================================================================

test('W718 #4 — high domain reliability => higher weight (monotonicity)', () => {
  const teachers = ['high-rel', 'low-rel'];
  const reliability = new TeacherReliabilityTable();
  reliability.setReliability('high-rel', 'code', 'generation', { domain: 0.95, task: 0.5 });
  reliability.setReliability('low-rel', 'code', 'generation', { domain: 0.05, task: 0.5 });
  const capture = { domain: 'code', task: 'generation' };
  const weights = computeTeacherWeights(teachers, capture, reliability);
  const hi = weights.find((w) => w.teacher === 'high-rel');
  const lo = weights.find((w) => w.teacher === 'low-rel');
  assert.ok(hi.weight > lo.weight, `high-rel (${hi.weight}) should beat low-rel (${lo.weight})`);
  // contributions block exposes the dominant reliability score.
  assert.equal(hi.contributions.domain_reliability, 0.95);
  assert.equal(lo.contributions.domain_reliability, 0.05);
});

// =============================================================================
// 5) High cost teacher gets lower weight (cost penalty works)
// =============================================================================

test('W718 #5 — high-cost teacher gets lower weight (cost penalty)', () => {
  const teachers = ['cheap', 'expensive'];
  // No reliability table -> both at 0.5; cost is the only differentiator.
  const capture = { domain: 'default', task: 'generation' };
  const weights = computeTeacherWeights(teachers, capture, null, {
    cost_table: { cheap: 0.0001, expensive: 0.10 },
    // Crank gamma_cost so cost dominates the uniform reliability prior.
    gamma: { cost: 5.0 },
  });
  const cheap = weights.find((w) => w.teacher === 'cheap');
  const expensive = weights.find((w) => w.teacher === 'expensive');
  assert.ok(cheap.weight > expensive.weight,
    `cheap (${cheap.weight}) should beat expensive (${expensive.weight}) when gamma_cost dominates`);
  // The cost_penalty contribution is negative for expensive (max normalized cost = 1.0).
  assert.ok(expensive.contributions.cost_penalty < 0);
  assert.ok(cheap.contributions.cost_penalty <= 0);
});

// =============================================================================
// 6) TeacherReliabilityTable defaults to 0.5 for unknown
// =============================================================================

test('W718 #6 — TeacherReliabilityTable defaults to 0.5 for unknown', () => {
  const t = new TeacherReliabilityTable();
  const r = t.getReliability('never-seen', 'never-seen', 'never-seen');
  assert.equal(r.domain, DEFAULT_RELIABILITY);
  assert.equal(r.task, DEFAULT_RELIABILITY);
  assert.equal(DEFAULT_RELIABILITY, 0.5);
});

// =============================================================================
// 7) TeacherReliabilityTable persist/load roundtrip
// =============================================================================

test('W718 #7 — TeacherReliabilityTable persist/load roundtrip', () => {
  freshDir();
  const t = new TeacherReliabilityTable();
  t.setReliability('gpt-4o', 'code', 'generation', { domain: 0.85, task: 0.75 });
  t.setReliability('claude-opus-4-7', 'reasoning', 'generation', { domain: 0.92, task: 0.88 });
  const filePath = path.join(process.env.KOLM_DATA_DIR, 'tr.json');
  t.persist(filePath);
  assert.ok(fs.existsSync(filePath));
  const t2 = TeacherReliabilityTable.load(filePath);
  const r1 = t2.getReliability('gpt-4o', 'code', 'generation');
  assert.equal(r1.domain, 0.85);
  assert.equal(r1.task, 0.75);
  const r2 = t2.getReliability('claude-opus-4-7', 'reasoning', 'generation');
  assert.equal(r2.domain, 0.92);
  assert.equal(r2.task, 0.88);
  // Unknown teacher still gets default after load.
  const r3 = t2.getReliability('unknown', 'unknown', 'unknown');
  assert.equal(r3.domain, DEFAULT_RELIABILITY);
  // Missing file -> empty table (no throw).
  const t3 = TeacherReliabilityTable.load('/nonexistent/path/abc.json');
  assert.equal(t3.size(), 0);
});

// =============================================================================
// 8) selectTeacherForCapture returns explanation string
// =============================================================================

test('W718 #8 — selectTeacherForCapture returns explanation string', () => {
  const teachers = ['claude-opus-4-7', 'gpt-4o'];
  const capture = { domain: 'code', task: 'generation' };
  const reliability = new TeacherReliabilityTable();
  reliability.setReliability('gpt-4o', 'code', 'generation', { domain: 0.95, task: 0.95 });
  const sel = selectTeacherForCapture(teachers, capture, reliability);
  assert.ok(sel.teacher, 'should pick a winner');
  assert.equal(sel.teacher, 'gpt-4o', 'gpt-4o should win on code');
  assert.equal(typeof sel.explanation, 'string');
  assert.ok(sel.explanation.length > 10);
  assert.ok(sel.explanation.includes('gpt-4o'));
  assert.ok(Array.isArray(sel.weights));
  assert.equal(sel.weights.length, 2);
  // Empty teachers -> honest envelope.
  const empty = selectTeacherForCapture([], capture, reliability);
  assert.equal(empty.teacher, null);
  assert.ok(empty.explanation.includes('no_teachers') || empty.explanation.length > 0);
});

// =============================================================================
// 9) blendTargets — argmax for text, weighted mean for numbers
// =============================================================================

test('W718 #9 — blendTargets argmax for text / weighted-mean for numbers', () => {
  // Text mode: returns highest-weighted teacher's string verbatim.
  const textOut = blendTargets(['cheap answer', 'expensive answer', 'middle answer'], [0.1, 0.7, 0.2]);
  assert.equal(textOut, 'expensive answer', 'text mode picks argmax');
  // Number mode: weighted mean.
  const numOut = blendTargets([0.0, 1.0], [0.25, 0.75]);
  assert.ok(Math.abs(numOut - 0.75) < 1e-9, `weighted mean of 0,1 with [0.25,0.75] should be 0.75; got ${numOut}`);
  // Vector mode: element-wise weighted mean.
  const vecOut = blendTargets([[1, 2, 3], [4, 5, 6]], [0.5, 0.5]);
  assert.deepEqual(vecOut, [2.5, 3.5, 4.5]);
  // Mixed types -> argmax fallback (safer than mixing).
  const mixed = blendTargets(['text', 42], [0.3, 0.7]);
  assert.equal(mixed, 42, 'mixed type signals fall back to argmax (heaviest weight)');
  // Empty -> null.
  assert.equal(blendTargets([], []), null);
});

// =============================================================================
// 10) CLI --teachers a,b,c --weights auto with no captures exits 3 + envelope
// =============================================================================

test('W718 #10 — CLI --teachers --weights auto with no captures exits 3 + honest envelope', () => {
  freshDir();
  // Pre-stage a config so the CLI doesn't fail at the loadConfig() check
  // (cmdDistill exits 3 'not logged in' before reaching council dispatch).
  const cfgDir = process.env.KOLM_DATA_DIR;
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    api_key: 'ks_test_w718',
    base: 'http://localhost:9999',
    tenant_id: 'local',
  }));
  const res = spawnSync(process.execPath, [
    CLI_PATH, 'distill',
    '--teachers', 'claude-opus-4-7,gpt-4o,gemini-2-pro',
    '--weights', 'auto',
    '--namespace', 'w718-empty-' + Date.now().toString(36),
    '--json',
  ], {
    env: { ...process.env, KOLM_ENV: 'test' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  // Exit 3 = MISSING_PREREQ (no captures).
  assert.equal(res.status, 3, `expected exit 3, got ${res.status}. stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  // JSON envelope on stdout.
  let env;
  try { env = JSON.parse(res.stdout); } catch (e) {
    throw new Error(`stdout not JSON: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  assert.equal(env.ok, false);
  assert.equal(env.error, 'no_captures');
  assert.deepEqual(env.teachers, ['claude-opus-4-7', 'gpt-4o', 'gemini-2-pro']);
  assert.equal(env.weights_mode, 'auto');
  assert.ok(env.message && env.message.length > 0);
});

// =============================================================================
// 11) runMiniBakeoff honest envelope on no captures
// =============================================================================

test('W718 #11 — runMiniBakeoff honest envelope on no captures', async () => {
  const result = await runMiniBakeoff(['claude-opus-4-7', 'gpt-4o'], [], {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_captures');
  // The fallback table seeds priors so the council doesn't degenerate to
  // uniform weights — we get a real (TeacherReliabilityTable) back.
  assert.ok(result.table instanceof TeacherReliabilityTable);
});

// =============================================================================
// 12) computeTeacherWeights — risk penalty lowers all teachers' weights but
//     preserves rankings (since risk is per-capture, not per-teacher, it
//     shifts the logit baseline equally — softmax is invariant). This pins
//     the "risk_level=high" pathway so a future refactor that conflates
//     risk-per-teacher with risk-per-capture fails the test.
// =============================================================================

test('W718 #12 — risk_level=high preserves teacher rankings via softmax invariance', () => {
  const teachers = ['a', 'b', 'c'];
  const reliability = new TeacherReliabilityTable();
  reliability.setReliability('a', 'default', 'generation', { domain: 0.8, task: 0.8 });
  reliability.setReliability('b', 'default', 'generation', { domain: 0.6, task: 0.6 });
  reliability.setReliability('c', 'default', 'generation', { domain: 0.4, task: 0.4 });
  const lowRisk = computeTeacherWeights(teachers, { domain: 'default', task: 'generation', risk_level: 'low' }, reliability);
  const highRisk = computeTeacherWeights(teachers, { domain: 'default', task: 'generation', risk_level: 'high' }, reliability);
  // Same ranking under both risks (a > b > c).
  assert.equal(lowRisk[0].teacher, 'a');
  assert.equal(highRisk[0].teacher, 'a');
  // High-risk capture has risk_penalty < low-risk capture's risk_penalty.
  assert.ok(highRisk[0].contributions.risk_penalty < lowRisk[0].contributions.risk_penalty);
});
