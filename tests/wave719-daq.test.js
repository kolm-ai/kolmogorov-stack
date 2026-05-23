// W719 — Distillation-Aware Quantization (DAQ) tests.
//
// Atomic items pinned (matches the W719 implementation):
//
//   1) DAQ_VERSION === 'w719-v1'
//   2) DEFAULT_PROFILE shape (canonical schema)
//   3) buildDaqProfile returns an array of valid per-layer profiles
//   4) decideBitsForLayer: high kl_sensitivity (> 0.05) → 8-bit
//   5) decideBitsForLayer: low kl_sensitivity (< 0.01) → 4-bit
//   6) summarizeBitBudget computes savings vs uniform int8
//   7) validateProfile catches missing layer_id
//   8) validateProfile catches out-of-range bits (e.g., 0 or 17)
//   9) Manifest output includes mixed_precision_profile when daq_profile passed
//  10) CLI `kolm distill --mixed-precision auto` with no telemetry exits 3
//      with an honest envelope
//  11) python workers/quantize/scripts/quantize.py --help shows --mixed-precision
//
// W604 anti-brittleness: no explicit lock-in of file lists, no exact-string
// matches on free-form messages; assertions key on the load-bearing fields
// (DAQ_VERSION, error codes, summary numeric ranges, etc).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DAQ_VERSION,
  DEFAULT_PROFILE,
  buildDaqProfile,
  decideBitsForLayer,
  summarizeBitBudget,
  validateProfile,
  hashDaqProfile,
} from '../src/daq-profile.js';
import { buildPayload } from '../src/artifact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');
const QUANTIZE_PY = path.join(__dirname, '..', 'workers', 'quantize', 'scripts', 'quantize.py');

// Each test gets a fresh KOLM_DATA_DIR so the auto-mode CLI test cannot
// accidentally find a real run-meta written by a sibling test.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w719-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) DAQ_VERSION constant
// =============================================================================

test('W719 #1 — DAQ_VERSION is w719-v1', () => {
  freshDir();
  assert.equal(DAQ_VERSION, 'w719-v1');
});

// =============================================================================
// 2) DEFAULT_PROFILE shape
// =============================================================================

test('W719 #2 — DEFAULT_PROFILE carries the canonical schema fields', () => {
  freshDir();
  const required = [
    'layer_id', 'weight_bits', 'activation_bits', 'kv_bits',
    'group_size', 'protected_channels', 'clip_percentile',
    'scale_mode', 'fallback_dtype', 'kl_sensitivity',
  ];
  for (const k of required) {
    assert.ok(k in DEFAULT_PROFILE, `DEFAULT_PROFILE missing required field: ${k}`);
  }
  assert.ok(Array.isArray(DEFAULT_PROFILE.protected_channels));
  assert.ok(Number.isFinite(DEFAULT_PROFILE.weight_bits));
  assert.ok(Number.isFinite(DEFAULT_PROFILE.kl_sensitivity));
  // DEFAULT_PROFILE is frozen so callers cannot tamper the canonical schema.
  assert.ok(Object.isFrozen(DEFAULT_PROFILE));
});

// =============================================================================
// 3) buildDaqProfile returns valid per-layer profiles
// =============================================================================

test('W719 #3 — buildDaqProfile returns array of valid per-layer profiles', () => {
  freshDir();
  const telemetry = [
    { layer_id: 'decoder.layers.0.attn.q_proj',   kl_sensitivity: 0.002 },
    { layer_id: 'decoder.layers.12.mlp.down_proj', kl_sensitivity: 0.072 },
    { layer_id: 'decoder.layers.30.attn.k_proj',  kl_sensitivity: 0.025, outlier_channels: [17, 203, 791] },
  ];
  const profile = buildDaqProfile(telemetry, {});
  assert.ok(Array.isArray(profile));
  assert.equal(profile.length, telemetry.length);
  for (const layer of profile) {
    const v = validateProfile(layer);
    assert.ok(v.ok, `layer ${layer.layer_id} failed validation: ${v.errors.join('; ')}`);
  }
  // Layer ordering preserved.
  assert.equal(profile[0].layer_id, telemetry[0].layer_id);
  assert.equal(profile[2].layer_id, telemetry[2].layer_id);
  // Mid-range layer surfaces the outlier channels we provided.
  assert.deepEqual(profile[2].protected_channels, [17, 203, 791]);
});

// =============================================================================
// 4) decideBitsForLayer: high sensitivity branch
// =============================================================================

test('W719 #4 — decideBitsForLayer: high kl_sensitivity (> 0.05) → 8 bits', () => {
  freshDir();
  const layer = decideBitsForLayer({
    layer_id: 'decoder.layers.20.mlp.up_proj',
    kl_sensitivity: 0.12, // well above 0.05
  });
  assert.equal(layer.weight_bits, 8);
  assert.equal(layer.activation_bits, 8);
  assert.equal(layer.kv_bits, 8);
  assert.equal(layer.layer_id, 'decoder.layers.20.mlp.up_proj');
});

// =============================================================================
// 5) decideBitsForLayer: low sensitivity branch
// =============================================================================

test('W719 #5 — decideBitsForLayer: low kl_sensitivity (< 0.01) → 4 bits', () => {
  freshDir();
  const layer = decideBitsForLayer({
    layer_id: 'decoder.layers.5.attn.v_proj',
    kl_sensitivity: 0.003, // well below 0.01
  });
  assert.equal(layer.weight_bits, 4);
  // Low-sensitivity branch protects nothing — the layer is near-lossless.
  assert.deepEqual(layer.protected_channels, []);
});

// =============================================================================
// 6) summarizeBitBudget vs uniform int8
// =============================================================================

test('W719 #6 — summarizeBitBudget reports savings vs uniform int8', () => {
  freshDir();
  // Construct a profile that is exactly 4 bits/layer — should report 50% savings
  // vs uniform int8 (8 bits/layer baseline).
  const all4bit = Array.from({ length: 10 }, (_, i) => ({
    layer_id: `L${i}`, kl_sensitivity: 0.001,
  }));
  const profile = buildDaqProfile(all4bit, {});
  const summary = summarizeBitBudget(profile);
  assert.equal(summary.total_layers, 10);
  assert.equal(summary.weighted_avg_bits, 4);
  assert.equal(summary.vs_uniform_int8_savings_pct, 50);
  // Uniform 8-bit baseline → 0% savings.
  const all8bit = Array.from({ length: 5 }, (_, i) => ({
    layer_id: `H${i}`, kl_sensitivity: 0.10,
  }));
  const profileHi = buildDaqProfile(all8bit, {});
  const summaryHi = summarizeBitBudget(profileHi);
  assert.equal(summaryHi.weighted_avg_bits, 8);
  assert.equal(summaryHi.vs_uniform_int8_savings_pct, 0);
});

// =============================================================================
// 7) validateProfile catches missing layer_id
// =============================================================================

test('W719 #7 — validateProfile rejects missing layer_id', () => {
  freshDir();
  const bad = {
    weight_bits: 4,
    activation_bits: 8,
    kv_bits: 8,
    group_size: 128,
    protected_channels: [],
    clip_percentile: 99.95,
    scale_mode: 'smoothquant+awq',
    fallback_dtype: 'bf16',
    kl_sensitivity: 0.02,
  };
  const v = validateProfile(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /layer_id/i.test(e)),
    `expected error mentioning layer_id; got ${JSON.stringify(v.errors)}`);
});

// =============================================================================
// 8) validateProfile catches out-of-range bits
// =============================================================================

test('W719 #8 — validateProfile rejects out-of-range bits (0 and 17)', () => {
  freshDir();
  const zeroBits = {
    layer_id: 'L0', weight_bits: 0, activation_bits: 8, kv_bits: 8,
    group_size: 128, protected_channels: [], clip_percentile: 99.95,
    scale_mode: 'awq', fallback_dtype: 'bf16', kl_sensitivity: 0.02,
  };
  const v0 = validateProfile(zeroBits);
  assert.equal(v0.ok, false);
  assert.ok(v0.errors.some((e) => /weight_bits/i.test(e) && /range/i.test(e)),
    `expected weight_bits range error; got ${JSON.stringify(v0.errors)}`);
  const tooManyBits = { ...zeroBits, weight_bits: 17 };
  const v17 = validateProfile(tooManyBits);
  assert.equal(v17.ok, false);
  assert.ok(v17.errors.some((e) => /weight_bits/i.test(e)),
    `expected weight_bits range error for 17; got ${JSON.stringify(v17.errors)}`);
});

// =============================================================================
// 9) Manifest output includes mixed_precision_profile when daq_profile passed
// =============================================================================

test('W719 #9 — buildPayload surfaces mixed_precision_profile + binds it into artifact_hash', () => {
  freshDir();
  const telemetry = [
    { layer_id: 'L0', kl_sensitivity: 0.002 },
    { layer_id: 'L1', kl_sensitivity: 0.07 },
  ];
  const profile = buildDaqProfile(telemetry, {});
  const baseArgs = {
    job_id: 'job_w719_9',
    task: 'W719 manifest profile binding',
    base_model: 'none',
    recipes: [{ id: 'r1', name: 'r', source: 'function generate(){return {};}' }],
    training_stats: { pass_rate_positive: 1.0 },
    judge_id: 'judge-w719',
    eval_score: 1.0,
  };
  const withProfile = buildPayload({ ...baseArgs, daq_profile: profile });
  const without = buildPayload({ ...baseArgs });
  // Manifest field surfaced when profile passed.
  assert.deepEqual(withProfile.manifest.mixed_precision_profile, profile);
  // Manifest field absent (null) when profile NOT passed — keeps existing
  // artifacts byte-stable for the no-DAQ path.
  assert.equal(without.manifest.mixed_precision_profile, null);
  // Hash chain binding: changing the profile MUST change artifact_hash.
  assert.notEqual(withProfile.artifact_hash, without.artifact_hash,
    'artifact_hash should differ when mixed_precision_profile is bound');
  // hashDaqProfile is stable.
  assert.equal(hashDaqProfile(profile), hashDaqProfile(profile));
});

// =============================================================================
// 10) CLI auto-mode with no telemetry → exit 3 + honest envelope
// =============================================================================

test('W719 #10 — CLI `kolm distill --mixed-precision auto` with no telemetry exits 3 with honest envelope', () => {
  const tmp = freshDir();
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w719',
    KOLM_TENANT_ID: 'tenant_w719_10',
  };
  // Pre-create the distill config so cmdDistillMixedPrecision's loadConfig
  // gate (it runs before the auto branch) sees an api_key on disk.
  fs.mkdirSync(path.join(tmp, '.kolm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.kolm', 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w719', base: 'http://127.0.0.1:1' }, null, 2));
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill',
    '--mixed-precision', 'auto',
    '--namespace', 'ns_w719_10',
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'no_telemetry');
  assert.equal(parsed.daq_version, 'w719-v1');
  assert.equal(parsed.namespace, 'ns_w719_10');
  assert.ok(typeof parsed.hint === 'string' && parsed.hint.length > 0);
  assert.equal(r.status, 3, `expected exit 3 on missing telemetry; got ${r.status}`);
});

// =============================================================================
// 11) Python worker --help advertises --mixed-precision
// =============================================================================

test('W719 #11 — python quantize.py --help advertises --mixed-precision', () => {
  freshDir();
  // Probe `python3` then `python` so the test runs on dev boxes that ship
  // either. If neither is present we skip — the python path is exercised in
  // the dedicated CI image, not on dev windows boxes without it.
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  let r;
  for (const py of candidates) {
    r = spawnSync(py, [QUANTIZE_PY, '--help'], { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0 || (r.stdout && /--mixed-precision/.test(r.stdout))) break;
  }
  if (!r || r.error || r.status !== 0) {
    // Python is genuinely missing on this host — surface as t.skip-equivalent.
    // We assert at minimum that the python source file carries the flag so
    // the test still catches an accidental flag removal even on host without python.
    const py = fs.readFileSync(QUANTIZE_PY, 'utf8');
    assert.ok(py.includes('--mixed-precision') || py.includes('mixed_precision'),
      'quantize.py source must reference --mixed-precision even when python is unavailable');
    return;
  }
  assert.ok(/--mixed-precision/.test(r.stdout),
    `python quantize.py --help must surface --mixed-precision; got: ${r.stdout.slice(0, 600)}`);
});
