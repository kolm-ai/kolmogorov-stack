// W722 — Importance-Tiered KV Cache (ITKV) tests.
//
// Atomic items pinned (matches the W722 implementation):
//
//   1) ITKV_VERSION === 'w722-v1'
//   2) TOKEN_CLASSES contains all 7 classes from research doc lines 1444-1454
//   3) DEFAULT_PRECISION_BY_CLASS sink='bf16' and irrelevant_span='offload'
//   4) classifyToken returns 'sink' for position < sink_anchor
//   5) classifyToken returns 'policy' when is_policy_span true even if recent
//   6) classifyToken retrieved_evidence tier varies by citation_confidence
//   7) buildItkvProfile honest envelope when bad precision_override
//   8) estimateMemoryReduction honest envelope when distribution mismatch
//   9) estimateMemoryReduction happy path reduction_pct > 0
//  10) worker shell honest envelope when ITKV_TIER_CMD points to nonexistent
//  11) Python tier selector byte-identical to JS classifyToken (parity)
//  12) CLI `kolm distill itkv build` writes a valid profile JSON
//  13) CLI `kolm distill itkv estimate` mismatch -> exit 1 + honest envelope
//
// W604 anti-brittleness: no explicit-array family checks. No assertions on
// sw.js or frontend-version.json (orchestrator owns those). Assertions key
// on load-bearing fields (constants, error codes, numeric ranges).
//
// Note: the python-parity test (#11) skips if python3 is not on PATH. The
// Python source-level check verifies the script is at least present so an
// accidental deletion is still caught even on python-less hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ITKV_VERSION,
  TOKEN_CLASSES,
  PRECISION_TIERS,
  DEFAULT_PRECISION_BY_CLASS,
  classifyToken,
  precisionTierFor,
  buildItkvProfile,
  estimateMemoryReduction,
  hashItkvProfile,
} from '../src/itkv-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');
const WORKER_PATH = path.join(__dirname, '..', 'workers', 'itkv', 'itkv.mjs');
const PYTHON_STUB = path.join(__dirname, '..', 'workers', 'itkv', 'scripts', 'itkv.py');

// Each test gets a fresh KOLM_DATA_DIR so the CLI test can't accidentally
// find a real run-meta written by a sibling test.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w722-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Find a python interpreter. Returns null if none on PATH.
function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (!r.error && (r.status === 0 || /python/i.test((r.stdout || '') + (r.stderr || '')))) {
        return c;
      }
    } catch {
      // continue
    }
  }
  return null;
}

// =============================================================================
// 1) ITKV_VERSION constant
// =============================================================================

test('W722 #1 — ITKV_VERSION is w722-v1', () => {
  freshDir();
  assert.equal(ITKV_VERSION, 'w722-v1');
});

// =============================================================================
// 2) TOKEN_CLASSES covers all 7 research-doc classes
// =============================================================================

test('W722 #2 — TOKEN_CLASSES contains all 7 classes from research doc', () => {
  freshDir();
  const required = [
    'sink',
    'policy',
    'schema',
    'retrieved_evidence',
    'conversation_recent',
    'boilerplate',
    'irrelevant_span',
  ];
  for (const c of required) {
    assert.ok(TOKEN_CLASSES.includes(c), `TOKEN_CLASSES missing required class: ${c}`);
  }
  assert.equal(TOKEN_CLASSES.length, 7);
  // PRECISION_TIERS sanity (anchor the 5 tiers from research doc line 1458).
  for (const t of ['bf16', 'fp8', 'int8', 'int4', 'offload']) {
    assert.ok(PRECISION_TIERS.includes(t), `PRECISION_TIERS missing required tier: ${t}`);
  }
});

// =============================================================================
// 3) DEFAULT_PRECISION_BY_CLASS anchor (research doc line 1458-1460)
// =============================================================================

test('W722 #3 — DEFAULT_PRECISION_BY_CLASS anchors the research-doc policy', () => {
  freshDir();
  // The research doc explicitly pins these two endpoints of the policy:
  //   "sink BF16" — sink classed tokens MUST stay at bf16
  //   "cold INT4/offload" — irrelevant_span gets offloaded (lowest tier)
  assert.equal(DEFAULT_PRECISION_BY_CLASS.sink, 'bf16');
  assert.equal(DEFAULT_PRECISION_BY_CLASS.irrelevant_span, 'offload');
  // Bonus: conversation_recent must also stay at bf16 (research doc:
  //   "recent BF16").
  assert.equal(DEFAULT_PRECISION_BY_CLASS.conversation_recent, 'bf16');
});

// =============================================================================
// 4) classifyToken sink branch
// =============================================================================

test('W722 #4 — classifyToken returns sink for position < sink_anchor', () => {
  freshDir();
  for (let pos = 0; pos < 4; pos += 1) {
    const cls = classifyToken({ position: pos, sink_anchor: 4 });
    assert.equal(cls, 'sink', `position ${pos} should classify as sink`);
  }
  // Position == sink_anchor is NOT sink (boundary check).
  const at4 = classifyToken({ position: 4, sink_anchor: 4, recent_window_start: 10_000 });
  assert.notEqual(at4, 'sink');
  // Position past sink_anchor with no other signals -> irrelevant_span.
  const at5 = classifyToken({ position: 5, sink_anchor: 4, recent_window_start: 10_000 });
  assert.equal(at5, 'irrelevant_span');
});

// =============================================================================
// 5) classifyToken policy wins over recency
// =============================================================================

test('W722 #5 — classifyToken returns policy even if position is recent', () => {
  freshDir();
  // Position inside the recent window (>= recent_window_start) BUT
  // is_policy_span true. Policy must win because policy has long TTL +
  // high precision regardless of recency.
  const cls = classifyToken({
    position: 1000,
    sink_anchor: 4,
    recent_window_start: 900,
    is_policy_span: true,
  });
  assert.equal(cls, 'policy');
});

// =============================================================================
// 6) classifyToken retrieved_evidence — tier varies by citation_confidence
// =============================================================================

test('W722 #6 — classifyToken retrieved_evidence tier varies by citation confidence', () => {
  freshDir();
  // High confidence (> 0.8) -> int8
  const hi = classifyToken({
    position: 50,
    sink_anchor: 4,
    is_retrieved_evidence: true,
    citation_confidence: 0.95,
  });
  assert.ok(hi && typeof hi === 'object', 'retrieved_evidence must return {class, precision_tier}');
  assert.equal(hi.class, 'retrieved_evidence');
  assert.equal(hi.precision_tier, 'int8');

  // Mid confidence (> 0.5, <= 0.8) -> int4
  const mid = classifyToken({
    position: 60,
    sink_anchor: 4,
    is_retrieved_evidence: true,
    citation_confidence: 0.7,
  });
  assert.equal(mid.class, 'retrieved_evidence');
  assert.equal(mid.precision_tier, 'int4');

  // Low confidence (<= 0.5) -> offload
  const lo = classifyToken({
    position: 70,
    sink_anchor: 4,
    is_retrieved_evidence: true,
    citation_confidence: 0.3,
  });
  assert.equal(lo.class, 'retrieved_evidence');
  assert.equal(lo.precision_tier, 'offload');

  // Sanity: precisionTierFor() respects the override tier from classifyToken.
  assert.equal(precisionTierFor(hi), 'int8');
  assert.equal(precisionTierFor(mid), 'int4');
  assert.equal(precisionTierFor(lo), 'offload');
});

// =============================================================================
// 7) buildItkvProfile honest envelope on bad precision_override
// =============================================================================

test('W722 #7 — buildItkvProfile honest envelope on bad precision_override', () => {
  freshDir();
  const bad = buildItkvProfile({
    artifact_id: 'art_w722_7',
    precision_override: { sink: 'fp4' }, // not in PRECISION_TIERS
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_precision_tier');
  assert.ok(typeof bad.hint === 'string' && bad.hint.length > 0);
  assert.equal(bad.bad_class, 'sink');
  assert.equal(bad.bad_tier, 'fp4');

  // Sanity: a valid override succeeds.
  const ok = buildItkvProfile({
    artifact_id: 'art_w722_7b',
    precision_override: { sink: 'bf16', boilerplate: 'int4' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.profile.version, ITKV_VERSION);
  assert.equal(ok.profile.precision_by_class.sink, 'bf16');
  assert.equal(ok.profile.precision_by_class.boilerplate, 'int4');
  // Hash binding sanity: same profile -> same hash.
  assert.equal(hashItkvProfile(ok.profile), hashItkvProfile(ok.profile));
});

// =============================================================================
// 8) estimateMemoryReduction honest envelope on distribution mismatch
// =============================================================================

test('W722 #8 — estimateMemoryReduction rejects distribution that does not match total_tokens', () => {
  freshDir();
  const built = buildItkvProfile({ artifact_id: 'art_w722_8' });
  assert.equal(built.ok, true);
  const r = estimateMemoryReduction(built.profile, {
    total_tokens: 1000,
    class_distribution: { sink: 4, policy: 50 }, // sums to 54, not ~1000
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'class_distribution_mismatch');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  assert.ok(Math.abs(r.distribution_sum - 54) < 1);
});

// =============================================================================
// 9) estimateMemoryReduction happy path — realistic distribution shows savings
// =============================================================================

test('W722 #9 — estimateMemoryReduction reduction_pct > 0 for realistic sink+boilerplate-heavy distribution', () => {
  freshDir();
  const built = buildItkvProfile({ artifact_id: 'art_w722_9' });
  assert.equal(built.ok, true);
  // Realistic agent-workload distribution (sums to 1000):
  //   sink=4 (BF16)              — full precision
  //   policy=50 (FP8)            — high precision compressed
  //   schema=100 (INT8)          — reusable schema
  //   retrieved_evidence=150 (INT8 default)
  //   conversation_recent=200 (BF16)
  //   boilerplate=400 (INT4)     — bulk of the savings
  //   irrelevant_span=96 (offload)
  const dist = {
    sink: 4,
    policy: 50,
    schema: 100,
    retrieved_evidence: 150,
    conversation_recent: 200,
    boilerplate: 400,
    irrelevant_span: 96,
  };
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  assert.equal(total, 1000);
  const r = estimateMemoryReduction(built.profile, {
    total_tokens: total,
    class_distribution: dist,
  });
  assert.equal(r.ok, true);
  assert.ok(r.reduction_pct > 0,
    `expected positive reduction_pct, got ${r.reduction_pct}`);
  // Sanity: itkv estimate must be strictly less than the bf16 baseline (the
  // workload is dominated by boilerplate at int4 + a chunk of offloaded
  // irrelevant_span, so we expect a real reduction, not a marginal one).
  assert.ok(r.itkv_bytes_estimated < r.bf16_bytes_baseline);
  // by_class_breakdown surfaces all 7 classes.
  assert.equal(r.by_class_breakdown.length, 7);
  // Spot-check the boilerplate row.
  const bp = r.by_class_breakdown.find((x) => x.class === 'boilerplate');
  assert.ok(bp);
  assert.equal(bp.tier, 'int4');
  assert.equal(bp.count, 400);
  // bytes = count * 0.5 = 200
  assert.equal(bp.bytes, 200);
});

// =============================================================================
// 10) Worker shell honest envelope on missing ITKV_TIER_CMD binary
// =============================================================================

test('W722 #10 — worker shell honest envelope when ITKV_TIER_CMD points to nonexistent binary', () => {
  const tmp = freshDir();
  // Build a tokens.jsonl so we get past the bad-args check.
  const tokensPath = path.join(tmp, 'tokens.jsonl');
  fs.writeFileSync(tokensPath, JSON.stringify({ position: 0 }) + '\n');
  const outPath = path.join(tmp, 'out.jsonl');

  const fakeBin = path.join(tmp, 'does-not-exist-' + Date.now());
  // ITKV_TIER_CMD points to a path that does not exist on disk -> the
  // locator returns null and the shell emits {ok:false, error:'no_tier_runtime'}
  // with exit 3. The CRITICAL invariant: never silent fallthrough.
  const env = {
    ...process.env,
    ITKV_TIER_CMD: fakeBin,
    // Clear PATH so python3 is not found as a fallback (otherwise the env
    // override fails, falls back to python, and the test does not exercise
    // the no-runtime branch). Empty PATH on Windows still works because
    // we check existsSync(path) directly.
    PATH: '',
    Path: '',
  };
  const r = spawnSync(process.execPath, [
    WORKER_PATH,
    '--tokens', tokensPath,
    '--output', outPath,
  ], { env, encoding: 'utf8', timeout: 15_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, false);
  assert.equal(env_out.error, 'no_tier_runtime');
  assert.ok(typeof env_out.install_hint === 'string' && env_out.install_hint.length > 0,
    'install_hint must be a non-empty string');
  assert.equal(r.status, 3,
    `expected exit 3 on no_tier_runtime; got ${r.status}`);
});

// =============================================================================
// 11) Python tier selector byte-identical to JS classifyToken
// =============================================================================

test('W722 #11 — python tier selector byte-identical to JS classifyToken', () => {
  const tmp = freshDir();
  const py = findPython();
  // Confirm the Python source file exists regardless — guards against an
  // accidental deletion even when python3 is not on PATH.
  assert.ok(fs.existsSync(PYTHON_STUB), `expected python stub at ${PYTHON_STUB}`);
  if (!py) {
    // Python not on PATH — skip the live parity check.
    return;
  }

  // Build a fixture of tokens that exercises EVERY branch of classifyToken.
  const tokens = [
    // sink branch
    { position: 0, sink_anchor: 4 },
    { position: 3, sink_anchor: 4 },
    // policy branch (must beat conversation_recent)
    { position: 1000, sink_anchor: 4, recent_window_start: 900, is_policy_span: true },
    // schema branch
    { position: 200, sink_anchor: 4, is_schema_span: true },
    // retrieved_evidence with HIGH confidence
    { position: 50, sink_anchor: 4, is_retrieved_evidence: true, citation_confidence: 0.95 },
    // retrieved_evidence with MID confidence
    { position: 60, sink_anchor: 4, is_retrieved_evidence: true, citation_confidence: 0.7 },
    // retrieved_evidence with LOW confidence
    { position: 70, sink_anchor: 4, is_retrieved_evidence: true, citation_confidence: 0.2 },
    // conversation_recent branch
    { position: 950, sink_anchor: 4, recent_window_start: 900 },
    // boilerplate via role
    { position: 200, sink_anchor: 4, recent_window_start: 10_000, role: 'boilerplate' },
    // boilerplate via repeated-prefix
    { position: 250, sink_anchor: 4, recent_window_start: 10_000, is_repeated_prefix: true },
    // fallthrough -> irrelevant_span
    { position: 300, sink_anchor: 4, recent_window_start: 10_000 },
  ];

  // Write the tokens JSONL.
  const tokensPath = path.join(tmp, 'tokens.jsonl');
  fs.writeFileSync(tokensPath, tokens.map((t) => JSON.stringify(t)).join('\n') + '\n');
  const outPath = path.join(tmp, 'out.jsonl');

  // Run the Python stub directly.
  const pyRun = spawnSync(py, [
    PYTHON_STUB,
    '--tokens', tokensPath,
    '--output', outPath,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (pyRun.status !== 0) {
    // python is available but the script crashed — that IS a failure.
    assert.fail(`python stub exited ${pyRun.status}; stderr=${pyRun.stderr}`);
  }
  assert.ok(fs.existsSync(outPath), 'python stub must write the output file');

  const pyLines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
  const pyResults = pyLines.map((l) => JSON.parse(l));

  // Compute the JS classifications using the SAME inputs.
  const jsResults = tokens.map((t) => {
    const r = classifyToken(t);
    const tier = precisionTierFor(r, null);
    const cls = r && typeof r === 'object' ? r.class : r;
    const pos = Number.isInteger(t.position) ? t.position : -1;
    return { position: pos, class: cls, precision_tier: tier };
  });

  // Byte-identical on the load-bearing fields (position, class, precision_tier).
  assert.equal(pyResults.length, jsResults.length,
    `mismatched row counts: py=${pyResults.length} js=${jsResults.length}`);
  for (let i = 0; i < jsResults.length; i += 1) {
    const a = jsResults[i];
    const b = pyResults[i];
    assert.equal(b.position, a.position, `row ${i}: position mismatch`);
    assert.equal(b.class, a.class,
      `row ${i}: class mismatch py=${b.class} js=${a.class} input=${JSON.stringify(tokens[i])}`);
    assert.equal(b.precision_tier, a.precision_tier,
      `row ${i}: tier mismatch py=${b.precision_tier} js=${a.precision_tier} input=${JSON.stringify(tokens[i])}`);
  }
});

// =============================================================================
// 12) CLI `kolm distill itkv build` writes a valid profile JSON
// =============================================================================

test('W722 #12 — CLI `kolm distill itkv build --artifact ART --out FILE` writes valid profile', () => {
  const tmp = freshDir();
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
  };
  const outPath = path.join(tmp, 'itkv-profile.json');
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', 'itkv', 'build',
    '--artifact', 'art_w722_12',
    '--sink-anchor', '8',
    '--recent-window', '256',
    '--out', outPath,
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)} status=${r.status}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, true, `build verb should succeed; envelope=${JSON.stringify(env_out)}`);
  assert.equal(env_out.version, ITKV_VERSION);
  assert.equal(env_out.profile_path, outPath);
  assert.ok(fs.existsSync(outPath), 'profile file must be written to disk');

  const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(onDisk.version, ITKV_VERSION);
  assert.equal(onDisk.artifact_id, 'art_w722_12');
  assert.equal(onDisk.sink_anchor, 8);
  assert.equal(onDisk.recent_window_size, 256);
  assert.equal(onDisk.precision_by_class.sink, 'bf16');
  assert.equal(onDisk.precision_by_class.irrelevant_span, 'offload');
  assert.equal(r.status, 0, `expected exit 0 on success; got ${r.status}`);
});

// =============================================================================
// 13) CLI `kolm distill itkv estimate` honest envelope on distribution mismatch
// =============================================================================

test('W722 #13 — CLI `kolm distill itkv estimate` distribution mismatch -> exit 1 + honest envelope', () => {
  const tmp = freshDir();
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
  };
  // First, build a profile so we have something on disk.
  const profilePath = path.join(tmp, 'profile.json');
  const built = buildItkvProfile({ artifact_id: 'art_w722_13' });
  assert.equal(built.ok, true);
  fs.writeFileSync(profilePath, JSON.stringify(built.profile, null, 2));

  // Now call estimate with a distribution that does NOT sum to total_tokens.
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', 'itkv', 'estimate',
    '--profile', profilePath,
    '--total-tokens', '1000',
    '--distribution', 'sink:4,policy:50', // only 54
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)} status=${r.status}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, false);
  assert.equal(env_out.error, 'class_distribution_mismatch');
  assert.equal(env_out.version, ITKV_VERSION);
  assert.ok(typeof env_out.hint === 'string' && env_out.hint.length > 0);
  // Honest envelope MUST exit non-zero (W722 brief invariant).
  assert.notEqual(r.status, 0, `honest envelope must exit non-zero; got ${r.status}`);
});

// #14 — orchestrator wrap-up: src/artifact.js binds kv_profile_hash into
// artifact_hash with the W460 conditional-slot pattern. Pre-W722 artifacts
// (no kv_profile) MUST remain byte-identical when rebuilt with field absent
// or null; presence of a non-empty kv_profile MUST change artifact_hash.
test('W722 #14 — artifact.js kv_profile_hash slot follows W460 byte-stability pattern', async () => {
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  const { buildPayload } = await import('../src/artifact.js');
  // Freeze the wall clock (same pattern as W721 #10) so recipe_bundle_mjs
  // `generated_at` + receipt issued_at don't drift between buildPayload calls
  // and we can isolate the kv_profile hash-slot contribution.
  const RealDate = Date;
  const fixedIso = '2026-05-24T00:00:00.000Z';
  const fixedMs = RealDate.parse(fixedIso);
  class FrozenDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) { super(fixedMs); } else { super(...a); }
    }
    static now() { return fixedMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }
  // eslint-disable-next-line no-global-assign
  global.Date = FrozenDate;
  try {
    const baseArgs = {
      job_id: 'job_w722_14',
      task: 'W722 kv_profile artifact integration smoke',
      base_model: 'none',
      recipes: [{
        id: 'rcp_w722',
        name: 'Echo',
        source: 'function generate(input) { return { echo: String(input.text||input) }; }',
      }],
      training_stats: { verifier_accepted: true, pass_rate_positive: 1.0 },
      judge_id: 'judge-w722',
      eval_score: 1.0,
    };

    const noField = buildPayload({ ...baseArgs });
    const nullField = buildPayload({ ...baseArgs, kv_profile: null });
    const emptyField = buildPayload({ ...baseArgs, kv_profile: {} });
    const withProfile = buildPayload({
      ...baseArgs,
      kv_profile: {
        version: 'w722-v1',
        sink_anchor: 4,
        recent_window_size: 512,
        precision_by_class: {
          sink: 'bf16', policy: 'fp8', schema: 'int8',
          retrieved_evidence: 'int8', conversation_recent: 'bf16',
          boilerplate: 'int4', irrelevant_span: 'offload',
        },
      },
    });

    const h1 = noField.artifact_hash;
    const h2 = nullField.artifact_hash;
    const h3 = emptyField.artifact_hash;
    const h4 = withProfile.artifact_hash;

    assert.ok(h1 && typeof h1 === 'string', 'artifact_hash must be a non-empty string');
    assert.equal(h1, h2, 'kv_profile absent vs null MUST produce identical hash (W460 byte-stability)');
    assert.equal(h1, h3, 'kv_profile absent vs empty object MUST produce identical hash');
    assert.notEqual(h1, h4, 'non-empty kv_profile MUST change artifact_hash (binding into receipt chain)');
    assert.equal(withProfile.manifest.kv_profile.version, 'w722-v1');
    assert.equal(noField.manifest.kv_profile, null, 'absent kv_profile surfaces as manifest.kv_profile=null');
  } finally {
    // eslint-disable-next-line no-global-assign
    global.Date = RealDate;
  }
});
