// W778 - Statistical significance + auto-rollback gate tests.
//
// One atomic test per contract. W604 anti-brittleness:
//   - version asserted via regex /^w778-/.
//   - p-value tolerances allow numerical slack; we never compare to literal
//     reference values when an implementation choice (Lanczos vs Stirling for
//     log gamma, etc.) can move the last few digits.
//
// Coverage map (>= 12 tests):
//
//   #1  Module exports + STAT_SIG_VERSION regex + default constants
//   #2  welchT honest envelope when n < 2 on either arm
//   #3  welchT happy path: identical samples -> p ~ 1.0
//   #4  welchT clean delta returns p < 0.001 (well-separated means)
//   #5  welchT handles zero-variance arms without NaN
//   #6  welchT confidence interval is finite + brackets mean delta sign
//   #7  gate insufficient when n_a < min_n (sample-size floor)
//   #8  gate insufficient when effect_size < min_effect_size
//   #9  gate pass when arm B beats A with p < alpha AND effect_size > min
//  #10  gate fail when arm B underperforms arm A (regression)
//  #11  gate reads samples from W777 ab-router via ab_test_id
//  #12  Route POST /v1/stat-sig/test requires auth
//  #13  Route POST /v1/stat-sig/test happy path round-trip with provisioned tenant
//  #14  CLI `kolm stat-sig --help` exits 0
//  #15  CLI `kolm stat-sig test --samples-a ... --samples-b ... --json` round-trip
//  #16  CLI `kolm stat-sig` (no subverb) -> missing_subverb honest envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bodyParser from 'body-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w778-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

async function _loadMods() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const store = await import('../src/store.js');
  if (typeof store._resetForTests === 'function') store._resetForTests();
  const ss = await import('../src/stat-sig.js');
  const ab = await import('../src/ab-router.js');
  return { es, store, ss, ab };
}

// =============================================================================
// #1 - exports + version regex + default constants
// =============================================================================

test('W778 #1 - module exports + STAT_SIG_VERSION regex + defaults', async () => {
  freshDir();
  const { ss } = await _loadMods();
  assert.equal(typeof ss.STAT_SIG_VERSION, 'string');
  assert.ok(/^w778-/.test(ss.STAT_SIG_VERSION));
  assert.equal(typeof ss.welchT, 'function');
  assert.equal(typeof ss.gate, 'function');
  assert.equal(ss.DEFAULT_ALPHA, 0.05);
  assert.equal(ss.DEFAULT_MIN_N, 30);
  assert.equal(ss.DEFAULT_MIN_EFFECT_SIZE, 0.01);
});

// =============================================================================
// #2 - welchT honest envelope when either arm has n < 2
// =============================================================================

test('W778 #2 - welchT honest envelope on n < 2', async () => {
  freshDir();
  const { ss } = await _loadMods();
  let r = ss.welchT({ samples_a: [0.5], samples_b: [0.6, 0.7] });
  assert.equal(r.ok, false);
  assert.ok(/insufficient/.test(r.error || ''),
    'error must mention insufficient/sample-size; got ' + r.error);
  r = ss.welchT({ samples_a: [], samples_b: [] });
  assert.equal(r.ok, false);
  assert.ok(/^w778-/.test(r.version));
});

// =============================================================================
// #3 - welchT identical samples -> p ~ 1.0
// =============================================================================

test('W778 #3 - welchT identical samples returns p close to 1.0', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const same = [];
  for (let i = 0; i < 30; i++) same.push(0.5 + i * 0.01);
  const r = ss.welchT({ samples_a: same.slice(), samples_b: same.slice() });
  assert.equal(r.ok, true);
  assert.ok(r.p > 0.9, 'identical samples should give p near 1.0; got ' + r.p);
  assert.equal(r.mean_a, r.mean_b);
});

// =============================================================================
// #4 - welchT clean delta -> p < 0.001
// =============================================================================

test('W778 #4 - welchT well-separated samples returns p < 0.001', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 50; i++) {
    a.push(0.50 + (i * 0.0005));
    b.push(0.80 + (i * 0.0005));
  }
  const r = ss.welchT({ samples_a: a, samples_b: b });
  assert.equal(r.ok, true);
  assert.ok(r.p < 0.001, 'clean delta p must be tiny; got ' + r.p);
  assert.ok(r.mean_b > r.mean_a);
  assert.ok(r.df > 0);
  assert.ok(Number.isFinite(r.t));
});

// =============================================================================
// #5 - welchT handles zero-variance arms without NaN
// =============================================================================

test('W778 #5 - welchT zero-variance arms returns p=1.0 without NaN', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 10; i++) { a.push(0.5); b.push(0.5); }
  const r = ss.welchT({ samples_a: a, samples_b: b });
  assert.equal(r.ok, true);
  assert.ok(!Number.isNaN(r.p), 'p must not be NaN; got ' + r.p);
  assert.equal(r.p, 1.0, 'zero-variance equal means -> p = 1.0; got ' + r.p);
  assert.equal(r.var_a, 0);
  assert.equal(r.var_b, 0);
});

// =============================================================================
// #6 - welchT confidence interval is finite + sign-aware
// =============================================================================

test('W778 #6 - welchT confidence interval is finite and brackets delta sign', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 50; i++) {
    a.push(0.40 + (i * 0.001));
    b.push(0.85 + (i * 0.001));
  }
  const r = ss.welchT({ samples_a: a, samples_b: b });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.ci_low), 'ci_low must be finite; got ' + r.ci_low);
  assert.ok(Number.isFinite(r.ci_high), 'ci_high must be finite; got ' + r.ci_high);
  assert.ok(r.ci_low < r.ci_high, 'ci_low < ci_high required');
  // For positive delta (mean_b - mean_a > 0), the 95% CI should be positive.
  assert.ok(r.ci_low > 0,
    'positive delta CI should be positive; got [' + r.ci_low + ', ' + r.ci_high + ']');
});

// =============================================================================
// #7 - gate insufficient when n < min_n
// =============================================================================

test('W778 #7 - gate insufficient when sample size below min_n', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const r = await ss.gate({
    samples_a: [0.5, 0.6, 0.55],
    samples_b: [0.7, 0.8, 0.75],
    min_n: 30,
  });
  assert.equal(r.decision, 'insufficient',
    'expected insufficient; got ' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.reason, 'sample_size_below_min');
  assert.ok(/^w778-/.test(r.version));
});

// =============================================================================
// #8 - gate insufficient when effect_size below min
// =============================================================================

test('W778 #8 - gate insufficient when effect_size below min_effect_size', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 50; i++) {
    a.push(0.5 + (i * 0.0001));
    b.push(0.5005 + (i * 0.0001));   // delta ~ 0.0005
  }
  const r = await ss.gate({
    samples_a: a,
    samples_b: b,
    min_n: 30,
    min_effect_size: 0.01,
  });
  assert.equal(r.decision, 'insufficient',
    'expected insufficient; got ' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.reason, 'effect_size_below_min');
});

// =============================================================================
// #9 - gate pass when arm B beats A
// =============================================================================

test('W778 #9 - gate pass when arm B beats arm A with p < alpha + effect', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 50; i++) {
    a.push(0.50 + (i * 0.0005));
    b.push(0.85 + (i * 0.0005));
  }
  const r = await ss.gate({
    samples_a: a,
    samples_b: b,
    alpha: 0.05,
    min_n: 30,
    min_effect_size: 0.01,
  });
  assert.equal(r.decision, 'pass',
    'expected pass; got ' + JSON.stringify(r).slice(0, 300));
  assert.equal(r.reason, 'sig_and_effect');
  assert.ok(r.p < 0.05);
  assert.ok(r.effect_size > 0);
});

// =============================================================================
// #10 - gate fail when arm B underperforms arm A
// =============================================================================

test('W778 #10 - gate fail when arm B underperforms arm A (regression)', async () => {
  freshDir();
  const { ss } = await _loadMods();
  const a = []; const b = [];
  for (let i = 0; i < 50; i++) {
    a.push(0.90 + (i * 0.0005));
    b.push(0.30 + (i * 0.0005));
  }
  const r = await ss.gate({
    samples_a: a,
    samples_b: b,
    alpha: 0.05,
    min_n: 30,
    min_effect_size: 0.01,
  });
  assert.equal(r.decision, 'fail',
    'expected fail; got ' + JSON.stringify(r).slice(0, 300));
  assert.equal(r.reason, 'arm_b_underperforms');
  assert.ok(r.effect_size < 0);
});

// =============================================================================
// #11 - gate reads samples from W777 ab-router via ab_test_id
// =============================================================================

test('W778 #11 - gate pulls samples from W777 ab-router via ab_test_id', async () => {
  freshDir();
  const { ss, ab } = await _loadMods();
  const tenant = 'tenant_w778_gate';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_gate', arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  // Seed 40 outcomes per arm with arm B winning clearly.
  for (let i = 0; i < 40; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'a',
      kscore: 0.50 + (i * 0.0005),
    });
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'b',
      kscore: 0.85 + (i * 0.0005),
    });
  }
  const gateR = await ss.gate({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(gateR.decision, 'pass',
    'expected pass; got ' + JSON.stringify(gateR).slice(0, 400));
  assert.ok(/^w778-/.test(gateR.version));
});

// =============================================================================
// #12 - Route POST /v1/stat-sig/test requires auth (401)
// =============================================================================

test('W778 #12 - route POST /v1/stat-sig/test requires auth', async () => {
  freshDir();
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(bodyParser.json({ limit: '8mb' }));
  app.use(buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch('http://127.0.0.1:' + port + '/v1/stat-sig/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ samples_a: [1, 2, 3], samples_b: [4, 5, 6] }),
        });
        assert.equal(res.status, 401, 'expected 401; got ' + res.status);
        const j = await res.json();
        assert.ok(j.ok !== true);
        const errStr = String(j.error || j.message || '').toLowerCase();
        assert.ok(/auth|api[\s_-]?key|unauth/.test(errStr),
          'expected auth-related error; got ' + JSON.stringify(j));
        server.close(() => resolve());
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

// =============================================================================
// #13 - Route POST /v1/stat-sig/test happy path
// =============================================================================

test('W778 #13 - route POST /v1/stat-sig/test round-trip with provisioned tenant', async () => {
  freshDir();
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const storeMod = await import('../src/store.js');
  if (typeof storeMod._resetForTests === 'function') storeMod._resetForTests();
  const { provisionAnonTenant } = await import('../src/auth.js');
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(bodyParser.json({ limit: '8mb' }));
  app.use(buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const a = []; const b = [];
        for (let i = 0; i < 40; i++) {
          a.push(0.5 + i * 0.001);
          b.push(0.85 + i * 0.001);
        }
        const res = await fetch('http://127.0.0.1:' + port + '/v1/stat-sig/test', {
          method: 'POST',
          headers: {
            'authorization': 'Bearer ' + t.api_key,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ samples_a: a, samples_b: b }),
        });
        assert.equal(res.status, 200, 'expected 200; got ' + res.status);
        const j = await res.json();
        assert.equal(j.ok, true, JSON.stringify(j).slice(0, 400));
        assert.ok(Number.isFinite(j.t));
        assert.ok(Number.isFinite(j.p));
        assert.ok(j.p < 0.05);
        assert.ok(/^w778-/.test(j.version));
        server.close(() => resolve());
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

// =============================================================================
// #14 - CLI --help
// =============================================================================

test('W778 #14 - `kolm stat-sig --help` exits 0 with usage', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'stat-sig', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, 'expected exit 0; got ' + r.status + ' combined=' + combined.slice(0, 400));
  assert.ok(/stat-sig/.test(combined));
  assert.ok(/test|gate/.test(combined));
});

// =============================================================================
// #15 - CLI test verb round-trip
// =============================================================================

test('W778 #15 - `kolm stat-sig test --samples-a ... --samples-b ... --json` round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w778-cli-'));
  const samplesA = [];
  const samplesB = [];
  for (let i = 0; i < 40; i++) {
    samplesA.push(0.5 + i * 0.001);
    samplesB.push(0.85 + i * 0.001);
  }
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'stat-sig', 'test',
    '--samples-a', samplesA.join(','),
    '--samples-b', samplesB.join(','),
    '--json',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    },
  });
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) {} // deliberate: cleanup
  assert.ok(parsed && typeof parsed === 'object',
    'expected JSON envelope; got stdout=' + out.slice(0, 200) + ' stderr=' + (r.stderr || '').slice(0, 200));
  assert.equal(parsed.ok, true);
  assert.ok(Number.isFinite(parsed.t));
  assert.ok(Number.isFinite(parsed.p));
  assert.ok(parsed.p < 0.05);
  assert.ok(/^w778-/.test(parsed.version));
});

// =============================================================================
// #16 - CLI no-subverb -> missing_subverb
// =============================================================================

test('W778 #16 - `kolm stat-sig --json` (no subverb) -> missing_subverb envelope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w778-cli2-'));
  const r = spawnSync(process.execPath, [CLI_PATH, 'stat-sig', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    },
  });
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) {} // deliberate: cleanup
  assert.ok(parsed && typeof parsed === 'object',
    'expected JSON envelope; got stdout=' + out.slice(0, 200) + ' stderr=' + (r.stderr || '').slice(0, 200));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'missing_subverb');
  assert.ok(/^w778-/.test(parsed.version));
});
