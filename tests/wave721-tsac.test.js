// W721 — Task-Specific Attention Compiler (TSAC) tests.
//
// Atomic items pinned (matches the W721 implementation):
//
//   1) TSAC_VERSION === 'w721-v1'
//   2) buildDefaultProfile shape (one entry per (layer, head); load-bearing defaults)
//   3) validateProfile rejects out-of-range page_topk
//   4) validateProfile rejects bad prefill_pattern strings
//   5) compileTsacProfile honest envelope when captures.length < 8
//   6) compileTsacProfile honest envelope when no attention_traces are present
//   7) compileTsacProfile happy path: output passes validateProfile
//   8) summarizeProfile counts dense vs sparse vs pruned correctly
//   9) artifact_hash differs when sparsity_profile is added (W460-pattern lock-in)
//  10) artifact_hash is byte-identical when sparsity_profile is null vs absent
//      (CRITICAL — preserves existing artifact byte-stability)
//  11) worker shell honest envelope when TSAC_KERNEL_CMD points to a nonexistent binary
//  12) safety-critical heads MUST run dense on both axes (validator enforces)
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing fields
// (TSAC_VERSION, error codes, summary numeric ranges, exit codes, hash
// inequality, hash equality).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TSAC_VERSION,
  DEFAULT_PREFILL_PATTERNS,
  DEFAULT_DECODE_POLICIES,
  validateProfile,
  buildDefaultProfile,
  summarizeProfile,
} from '../src/tsac-profile.js';
import { compileTsacProfile } from '../src/tsac-compiler.js';
import { buildPayload } from '../src/artifact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SHELL = path.join(__dirname, '..', 'workers', 'tsac', 'tsac.mjs');

// Each test gets a fresh KOLM_DATA_DIR so any incidental state writes do
// not collide with sibling tests in the larger suite.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w721-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) TSAC_VERSION
// =============================================================================

test('W721 #1 — TSAC_VERSION exported as w721-v1', () => {
  freshDir();
  assert.equal(TSAC_VERSION, 'w721-v1');
  // Sibling enums must include the canonical defaults pinned by the research doc.
  assert.ok(DEFAULT_PREFILL_PATTERNS.includes('vertical_slash'));
  assert.ok(DEFAULT_DECODE_POLICIES.includes('query_page_topk'));
  assert.ok(DEFAULT_PREFILL_PATTERNS.includes('dense'));
  assert.ok(DEFAULT_DECODE_POLICIES.includes('dense'));
});

// =============================================================================
// 2) buildDefaultProfile shape
// =============================================================================

test('W721 #2 — buildDefaultProfile emits one entry per (layer, head) with load-bearing defaults', () => {
  freshDir();
  const profile = buildDefaultProfile({
    task: 'claims-redaction',
    num_layers: 4,
    num_heads: 3,
  });
  assert.equal(profile.tsac_version, 'w721-v1');
  assert.equal(profile.task, 'claims-redaction');
  assert.equal(profile.num_layers, 4);
  assert.equal(profile.num_heads, 3);
  assert.equal(profile.entries.length, 4 * 3);
  // Spot-check a representative entry — research-doc defaults (page_topk:16,
  // sink_keep:8, local_window:512, dense_fallback_threshold:0.06).
  const first = profile.entries[0];
  assert.equal(first.layer, 0);
  assert.equal(first.head, 0);
  assert.equal(first.page_topk, 16);
  assert.equal(first.sink_keep, 8);
  assert.equal(first.local_window, 512);
  assert.equal(first.dense_fallback_threshold, 0.06);
  assert.equal(first.quality_guard, 'logit_delta_and_kscore');
  // Every entry passes validateProfile.
  for (const e of profile.entries) {
    const v = validateProfile(e);
    assert.ok(v.ok, `entry l=${e.layer} h=${e.head} invalid: ${(v.errors || []).join('; ')}`);
  }
  // The full profile (wrapped) also validates.
  const vFull = validateProfile(profile);
  assert.ok(vFull.ok, `wrapped profile failed validation: ${(vFull.errors || []).join('; ')}`);
});

// =============================================================================
// 3) validateProfile rejects out-of-range page_topk
// =============================================================================

test('W721 #3 — validateProfile rejects out-of-range page_topk', () => {
  freshDir();
  const base = buildDefaultProfile({ task: 't', num_layers: 1, num_heads: 1 });
  // Negative page_topk — outside [PAGE_TOPK_MIN, PAGE_TOPK_MAX].
  const bad = { ...base.entries[0], page_topk: -1 };
  const v = validateProfile(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /page_topk/i.test(e) && /range/i.test(e)),
    `expected page_topk range error; got ${JSON.stringify(v.errors)}`);
  // Way over the cap also rejected.
  const tooBig = { ...base.entries[0], page_topk: 10_000_000 };
  const v2 = validateProfile(tooBig);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => /page_topk/i.test(e)),
    `expected page_topk error for 10M; got ${JSON.stringify(v2.errors)}`);
});

// =============================================================================
// 4) validateProfile rejects bad prefill_pattern strings
// =============================================================================

test('W721 #4 — validateProfile rejects unknown prefill_pattern strings', () => {
  freshDir();
  const base = buildDefaultProfile({ task: 't', num_layers: 1, num_heads: 1 });
  const bad = { ...base.entries[0], prefill_pattern: 'imaginary_kernel' };
  const v = validateProfile(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /prefill_pattern/i.test(e)),
    `expected prefill_pattern error; got ${JSON.stringify(v.errors)}`);
  // Bad decode_policy also rejected.
  const bad2 = { ...base.entries[0], decode_policy: 'made_up_policy' };
  const v2 = validateProfile(bad2);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => /decode_policy/i.test(e)),
    `expected decode_policy error; got ${JSON.stringify(v2.errors)}`);
});

// =============================================================================
// 5) insufficient_captures envelope
// =============================================================================

test('W721 #5 — compileTsacProfile honest envelope when captures.length < 8', () => {
  freshDir();
  const captures = Array.from({ length: 3 }, (_, i) => ({
    id: 'c' + i,
    attention_traces: [{ layer: 0, head: 0, signature: 'vertical_slash' }],
  }));
  const r = compileTsacProfile({ task_name: 'claims-redaction', captures });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_captures_for_tsac');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
});

// =============================================================================
// 6) no_attention_telemetry envelope
// =============================================================================

test('W721 #6 — compileTsacProfile honest envelope when no captures carry attention_traces', () => {
  freshDir();
  const captures = Array.from({ length: 12 }, (_, i) => ({
    id: 'c' + i,
    // No attention_traces[] — the upstream collector is not wired.
  }));
  const r = compileTsacProfile({ task_name: 'claims-redaction', captures });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_attention_telemetry');
  assert.ok(/capture-attention|buildDefaultProfile/i.test(r.hint),
    `expected actionable hint mentioning capture-attention or buildDefaultProfile; got ${r.hint}`);
});

// =============================================================================
// 7) compileTsacProfile happy path
// =============================================================================

test('W721 #7 — compileTsacProfile happy path returns a profile that passes validateProfile', () => {
  freshDir();
  const NUM_LAYERS = 2;
  const NUM_HEADS = 4;
  // Build captures with attention_traces pinned to vertical_slash for every
  // (layer, head). Compiler should converge to vertical_slash uniformly.
  const captures = Array.from({ length: 10 }, (_, i) => ({
    id: 'c' + i,
    attention_traces: (() => {
      const arr = [];
      for (let l = 0; l < NUM_LAYERS; l += 1) {
        for (let h = 0; h < NUM_HEADS; h += 1) {
          arr.push({ layer: l, head: h, signature: 'vertical_slash', similarity: 0.95 });
        }
      }
      return arr;
    })(),
  }));
  const r = compileTsacProfile({
    task_name: 'claims-redaction',
    captures,
    opts: { num_layers: NUM_LAYERS, num_heads: NUM_HEADS },
  });
  assert.equal(r.ok, true);
  assert.equal(r.profile.task, 'claims-redaction');
  assert.equal(r.profile.num_layers, NUM_LAYERS);
  assert.equal(r.profile.num_heads, NUM_HEADS);
  assert.equal(r.profile.entries.length, NUM_LAYERS * NUM_HEADS);
  // All entries converged to vertical_slash + query_page_topk + page_topk=16.
  for (const e of r.profile.entries) {
    assert.equal(e.prefill_pattern, 'vertical_slash');
    assert.equal(e.decode_policy, 'query_page_topk');
    assert.equal(e.page_topk, 16);
  }
  const v = validateProfile(r.profile);
  assert.ok(v.ok, `happy-path profile failed validation: ${(v.errors || []).join('; ')}`);
  assert.equal(r.telemetry.captures_used, 10);
  assert.equal(r.telemetry.heads_with_telemetry, NUM_LAYERS * NUM_HEADS);
  assert.equal(r.telemetry.heads_fallback, 0);
  assert.equal(typeof r.telemetry.profile_hash, 'string');
  assert.equal(r.telemetry.profile_hash.length, 64);
});

// =============================================================================
// 8) summarizeProfile counts dense vs sparse vs pruned
// =============================================================================

test('W721 #8 — summarizeProfile counts dense vs sparse vs pruned correctly', () => {
  freshDir();
  const profile = buildDefaultProfile({ task: 't', num_layers: 1, num_heads: 6 });
  // Default builder gives every head vertical_slash + query_page_topk → all sparse.
  let s = summarizeProfile(profile);
  assert.equal(s.total_heads, 6);
  assert.equal(s.dense_heads, 0);
  assert.equal(s.sparse_heads, 6);
  assert.equal(s.pruned_heads, 0);
  assert.equal(s.safety_critical_heads, 0);
  assert.equal(s.avg_page_topk, 16);
  // Mutate: 2 dense, 1 pruned (head_pruned + head_pruned_decode), 1 safety-critical (forces dense).
  profile.entries[0].prefill_pattern = 'dense';
  profile.entries[0].decode_policy = 'dense';
  profile.entries[1].prefill_pattern = 'dense';
  profile.entries[1].decode_policy = 'dense';
  profile.entries[2].prefill_pattern = 'head_pruned';
  profile.entries[2].decode_policy = 'head_pruned_decode';
  profile.entries[3].is_safety_critical = true;
  profile.entries[3].prefill_pattern = 'dense';
  profile.entries[3].decode_policy = 'dense';
  s = summarizeProfile(profile);
  assert.equal(s.total_heads, 6);
  // 3 dense (entries 0, 1, and the safety-critical entry 3)
  assert.equal(s.dense_heads, 3);
  // 2 sparse (entries 4, 5 stayed vertical_slash + query_page_topk)
  assert.equal(s.sparse_heads, 2);
  // 1 pruned (entry 2)
  assert.equal(s.pruned_heads, 1);
  assert.equal(s.safety_critical_heads, 1);
});

// =============================================================================
// 9) artifact_hash binding (lock-in for the W460-pattern conditional hash slot)
// =============================================================================

test('W721 #9 — artifact_hash differs when sparsity_profile is added (hash chain lock-in)', () => {
  freshDir();
  const baseArgs = {
    job_id: 'job_w721_9',
    task: 'W721 sparsity profile binding',
    base_model: 'none',
    recipes: [{ id: 'r1', name: 'r', source: 'function generate(){return {};}' }],
    training_stats: { pass_rate_positive: 1.0 },
    judge_id: 'judge-w721',
    eval_score: 1.0,
  };
  const profile = buildDefaultProfile({ task: 't', num_layers: 2, num_heads: 2 });
  const withProfile = buildPayload({ ...baseArgs, sparsity_profile: profile });
  const without = buildPayload({ ...baseArgs });
  // Manifest surface — non-null only when profile present.
  assert.deepEqual(withProfile.manifest.sparsity_profile, profile);
  assert.equal(without.manifest.sparsity_profile, null);
  // Hash chain binding: changing the profile MUST change artifact_hash.
  assert.notEqual(
    withProfile.artifact_hash,
    without.artifact_hash,
    'artifact_hash should differ when sparsity_profile is bound into the hash chain',
  );
});

// =============================================================================
// 10) byte-identical when sparsity_profile is null vs absent
//     (CRITICAL — preserves existing artifact byte-stability for the no-TSAC path)
// =============================================================================

test('W721 #10 — artifact_hash byte-identical when sparsity_profile is null vs absent (W460 pattern)', () => {
  freshDir();
  // Freeze the wall clock for this test so the timestamp-stamped fields
  // (recipe_bundle_mjs `// generated_at`, receipt issued_at) hash identically
  // across the three buildPayload calls below. Without the freeze the bundle
  // header drifts between calls and we cannot isolate the W721 hash-slot
  // contribution. We restore Date in a try/finally.
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
      job_id: 'job_w721_10',
      task: 'W721 byte-stability preservation',
      base_model: 'none',
      recipes: [{ id: 'r1', name: 'r', source: 'function generate(){return {};}' }],
      training_stats: { pass_rate_positive: 1.0 },
      judge_id: 'judge-w721',
      eval_score: 1.0,
    };
    const explicitNull = buildPayload({ ...baseArgs, sparsity_profile: null });
    const explicitEmpty = buildPayload({ ...baseArgs, sparsity_profile: {} });
    const absent = buildPayload({ ...baseArgs });
    // Manifest surface all show null (no profile).
    assert.equal(explicitNull.manifest.sparsity_profile, null);
    assert.equal(explicitEmpty.manifest.sparsity_profile, null);
    assert.equal(absent.manifest.sparsity_profile, null);
    // Hash chain: all three paths MUST produce the same artifact_hash so
    // existing (pre-W721) artifacts that re-build without a profile do not
    // suddenly drift to a new hash. This is the load-bearing W460 pattern.
    assert.equal(
      explicitNull.artifact_hash,
      absent.artifact_hash,
      'sparsity_profile=null must hash identically to omitting the field',
    );
    assert.equal(
      explicitEmpty.artifact_hash,
      absent.artifact_hash,
      'sparsity_profile={} must hash identically to omitting the field (W460 pattern)',
    );
  } finally {
    // eslint-disable-next-line no-global-assign
    global.Date = RealDate;
  }
});

// =============================================================================
// 11) worker shell honest envelope when TSAC_KERNEL_CMD is nonexistent
// =============================================================================

test('W721 #11 — worker shell emits honest envelope when TSAC_KERNEL_CMD points to a nonexistent binary', () => {
  const tmp = freshDir();
  const profile = buildDefaultProfile({ task: 't', num_layers: 1, num_heads: 1 });
  const profilePath = path.join(tmp, 'p.json');
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const env = {
    ...process.env,
    TSAC_KERNEL_CMD: path.join(tmp, 'this-binary-does-not-exist-' + crypto.randomBytes(4).toString('hex')),
  };
  const r = spawnSync(process.execPath, [WORKER_SHELL, '--profile', profilePath], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const stdout = r.stdout || '';
  const lastBrace = stdout.lastIndexOf('}');
  const firstBrace = stdout.lastIndexOf('{', lastBrace);
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope on stdout; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'no_kernel_runtime');
  assert.ok(typeof parsed.hint === 'string' && parsed.hint.length > 0);
  assert.equal(r.status, 3, `expected exit 3 on missing kernel runtime; got ${r.status}`);
});

// =============================================================================
// 12) safety-critical heads must run dense on both axes (validator enforces)
// =============================================================================

test('W721 #12 — safety-critical heads must run dense on both axes', () => {
  freshDir();
  const base = buildDefaultProfile({ task: 't', num_layers: 1, num_heads: 1 });
  const bad = {
    ...base.entries[0],
    is_safety_critical: true,
    prefill_pattern: 'vertical_slash', // disallowed when safety-critical
    decode_policy: 'query_page_topk',  // disallowed when safety-critical
  };
  const v = validateProfile(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /safety-critical/i.test(e) && /prefill_pattern/i.test(e)),
    `expected safety-critical prefill_pattern error; got ${JSON.stringify(v.errors)}`);
  assert.ok(v.errors.some((e) => /safety-critical/i.test(e) && /decode_policy/i.test(e)),
    `expected safety-critical decode_policy error; got ${JSON.stringify(v.errors)}`);
  // And the legal safety-critical configuration validates clean.
  const good = {
    ...base.entries[0],
    is_safety_critical: true,
    prefill_pattern: 'dense',
    decode_policy: 'dense',
  };
  const vGood = validateProfile(good);
  assert.ok(vGood.ok, `safety-critical+dense should validate; got errors: ${(vGood.errors || []).join('; ')}`);
});
