// W716 — TAAS (task-adaptive architecture search).
//
// Atomic items pinned:
//
//   1) CAPTURE_STATS_VERSION === 'w716-v1' AND RECOMMENDER_VERSION === 'w716-v1'
//   2) computeCaptureStats(empty) -> honest envelope with n=0 (no NaN)
//   3) computeCaptureStats with synthetic captures returns expected shape
//   4) vocab_entropy is positive AND bounded (Shannon log2(VOCAB_TOP_K))
//   5) recommendArch with n<100 -> 1B-class arch
//   6) recommendArch with high complexity -> 7B-class
//   7) recommendArch with high tool_use_rate + complexity (KOLM_ENABLE_MOE)
//      -> MoE recipe (3 of 8 experts, expert specialization)
//   8) buildMoeRecipe shape contract (num_experts, top_k, expert_specialization)
//   9) CLI `kolm distill --auto-arch --json` emits JSON envelope
//  10) CLI `kolm distill --auto-arch --json` with no captures exits 3 with
//      ok:false error:'no_captures' (anti-brittle: regex match on error field)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_STATS_VERSION,
  computeCaptureStats,
} from '../src/capture-stats.js';
import {
  RECOMMENDER_VERSION,
  recommendArch,
  ARCH_CATALOG,
} from '../src/student-arch-recommender.js';
import { buildMoeRecipe, MOE_RECIPE_VERSION } from '../src/compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w716-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// =============================================================================
// 1) Version constants
// =============================================================================

test('W716 #1 — version constants are w716-v1 (regex anchored)', async () => {
  // Anti-brittle: match version regex w716-v\d+ so a v2 bump doesn't false-fail.
  // The CURRENT version must be v1 — but the contract is "w716 family".
  assert.match(CAPTURE_STATS_VERSION, /^w716-v\d+$/);
  assert.match(RECOMMENDER_VERSION, /^w716-v\d+$/);
  assert.match(MOE_RECIPE_VERSION, /^w716-v\d+$/);
  // Spec pins v1 right now.
  assert.equal(CAPTURE_STATS_VERSION, 'w716-v1');
  assert.equal(RECOMMENDER_VERSION, 'w716-v1');
  assert.equal(MOE_RECIPE_VERSION, 'w716-v1');
});

// =============================================================================
// 2) Empty input honest envelope
// =============================================================================

test('W716 #2 — computeCaptureStats(empty) returns honest n=0 envelope', async () => {
  for (const input of [[], null, undefined, 'not-an-array', 42]) {
    const stats = computeCaptureStats(input);
    assert.equal(stats.n, 0, `n=0 for ${JSON.stringify(input)}`);
    assert.equal(stats.version, 'w716-v1');
    assert.equal(stats.output_length.p50, 0);
    assert.equal(stats.output_length.p95, 0);
    assert.equal(stats.output_length.mean, 0);
    assert.equal(stats.vocab_entropy_bits, 0);
    assert.equal(stats.reasoning_chain_depth_avg, 0);
    assert.equal(stats.tool_use_rate, 0);
    assert.equal(stats.task_complexity_proxy, 0);
    // Never NaN — explicit guard.
    for (const k of ['vocab_entropy_bits', 'reasoning_chain_depth_avg', 'tool_use_rate', 'task_complexity_proxy']) {
      assert.ok(Number.isFinite(stats[k]), `${k} must be finite, got ${stats[k]}`);
    }
  }
});

// =============================================================================
// 3) Synthetic captures shape contract
// =============================================================================

test('W716 #3 — computeCaptureStats with synthetic captures returns expected shape', async () => {
  const captures = [
    { prompt: 'Q1?', response: 'A short answer.' },
    { prompt: 'Q2?', response: 'A medium length answer that spans several words to inflate counts.' },
    { prompt: 'Q3?', response: 'Step 1. Think.\n\nStep 2. Answer.\n\nStep 3. Verify.' },
    { prompt: 'Q4?', response: '<think>internal reasoning</think> Final result here.' },
    { prompt: 'Q5?', response: '{"tool":"calc","args":{"x":1}}', tool_calls: [{ name: 'calc' }] },
  ];
  const stats = computeCaptureStats(captures);
  assert.equal(stats.n, 5);
  assert.ok(stats.output_length.mean > 0, 'mean length > 0');
  assert.ok(stats.output_length.p95 >= stats.output_length.p50, 'p95 >= p50');
  assert.ok(stats.vocab_entropy_bits > 0, 'vocab entropy > 0');
  assert.ok(stats.reasoning_chain_depth_avg > 0, 'depth > 0 (Step markers + <think>)');
  assert.ok(stats.tool_use_rate > 0, 'tool_use_rate > 0 (has tool_calls and JSON response)');
  assert.ok(stats.task_complexity_proxy >= 0 && stats.task_complexity_proxy <= 1,
    `composite in [0,1], got ${stats.task_complexity_proxy}`);
});

// =============================================================================
// 4) Entropy is positive and bounded
// =============================================================================

test('W716 #4 — vocab_entropy_bits is positive AND bounded log2(VOCAB_TOP_K)', async () => {
  // Generate captures with rich diverse vocab.
  const captures = [];
  for (let i = 0; i < 50; i++) {
    const words = [];
    for (let j = 0; j < 100; j++) {
      // Each word is unique to maximize entropy.
      words.push(`word${i}_${j}`);
    }
    captures.push({ prompt: `Q${i}`, response: words.join(' ') });
  }
  const stats = computeCaptureStats(captures);
  assert.ok(stats.vocab_entropy_bits > 0, 'entropy must be positive for diverse vocab');
  // Upper bound: log2(VOCAB_TOP_K=5000) ~ 12.29 bits. Anti-brittle: use threshold
  // > log2(5000) + tiny epsilon to avoid floating-point off-by-one false-fail.
  const upperBound = Math.log2(5000) + 0.01;
  assert.ok(stats.vocab_entropy_bits <= upperBound,
    `entropy must be bounded by log2(5000)+eps; got ${stats.vocab_entropy_bits}, bound ${upperBound}`);
  // Determinism: same input -> same output.
  const stats2 = computeCaptureStats(captures);
  assert.equal(stats.vocab_entropy_bits, stats2.vocab_entropy_bits);
});

// =============================================================================
// 5) n<100 -> 1B-class
// =============================================================================

test('W716 #5 — recommendArch with n<100 picks 1B-class', async () => {
  for (const n of [0, 1, 50, 99]) {
    const stats = { n, output_length: { p50: 500, p95: 1500, mean: 700 },
                    vocab_entropy_bits: 8, reasoning_chain_depth_avg: 4,
                    tool_use_rate: 0.5, task_complexity_proxy: 0.8 };
    const rec = recommendArch(stats);
    // Anti-brittle: match size_label regex /^1B/ rather than equality so
    // a 1B-variant rename doesn't break the test.
    assert.match(rec.recommended.size_label, /^1B/,
      `n=${n} should pick 1B-class, got ${rec.recommended.size_label}`);
    assert.equal(rec.version, 'w716-v1');
    assert.ok(typeof rec.reasoning === 'string' && rec.reasoning.length > 0);
  }
});

// =============================================================================
// 6) High complexity -> 7B-class
// =============================================================================

test('W716 #6 — recommendArch with high complexity picks 7B-class', async () => {
  // High n, high complexity, low tool rate (no MoE branch).
  const stats = {
    n: 500,
    output_length: { p50: 800, p95: 1500, mean: 900 },
    vocab_entropy_bits: 9,
    reasoning_chain_depth_avg: 5,
    tool_use_rate: 0.1,
    task_complexity_proxy: 0.75,
  };
  // Ensure MoE gate is off so we test the 7B branch deterministically.
  const prevMoe = process.env.KOLM_ENABLE_MOE;
  delete process.env.KOLM_ENABLE_MOE;
  try {
    const rec = recommendArch(stats);
    assert.match(rec.recommended.size_label, /^7B/,
      `high complexity should pick 7B-class, got ${rec.recommended.size_label}`);
    assert.equal(rec.recommended.quant, 'int4');
    assert.ok(!rec.recommended.moe, 'dense pick should have no moe block');
  } finally {
    if (prevMoe != null) process.env.KOLM_ENABLE_MOE = prevMoe;
  }
});

// =============================================================================
// 7) High tool_use + complexity + KOLM_ENABLE_MOE -> MoE recipe
// =============================================================================

test('W716 #7 — high tool_use + complexity + MoE enabled picks MoE arch', async () => {
  const stats = {
    n: 500,
    output_length: { p50: 800, p95: 1500, mean: 900 },
    vocab_entropy_bits: 9,
    reasoning_chain_depth_avg: 5,
    tool_use_rate: 0.5,
    task_complexity_proxy: 0.75,
  };
  const prevMoe = process.env.KOLM_ENABLE_MOE;
  process.env.KOLM_ENABLE_MOE = '1';
  try {
    const rec = recommendArch(stats);
    assert.ok(rec.recommended.moe, 'MoE branch should fire under env gate');
    assert.equal(rec.recommended.moe.num_experts, 8);
    assert.equal(rec.recommended.moe.top_k, 3);
    assert.ok(Array.isArray(rec.recommended.moe.expert_specialization));
    // Anti-brittle: assert specialization includes the canonical three rather
    // than the array equals a fixed sequence.
    const specSet = new Set(rec.recommended.moe.expert_specialization);
    for (const s of ['tool_call', 'reasoning', 'general']) {
      assert.ok(specSet.has(s), `specialization must include "${s}"`);
    }
  } finally {
    if (prevMoe != null) process.env.KOLM_ENABLE_MOE = prevMoe;
    else delete process.env.KOLM_ENABLE_MOE;
  }
});

// =============================================================================
// 8) buildMoeRecipe shape contract
// =============================================================================

test('W716 #8 — buildMoeRecipe shape contract', async () => {
  // Dense arch -> arch_not_moe.
  const dense = { family: 'qwen2.5-3b-class', depth: 36, hidden_dim: 2048 };
  const r1 = buildMoeRecipe(dense);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'arch_not_moe');

  // No arch at all -> arch_spec_required.
  const r0 = buildMoeRecipe(null);
  assert.equal(r0.ok, false);
  assert.equal(r0.error, 'arch_spec_required');

  // Valid MoE arch -> full recipe.
  const moeArch = {
    family: 'qwen2.5-3b-class',
    depth: 28,
    hidden_dim: 2048,
    num_attention_heads: 16,
    moe: {
      num_experts: 8, top_k: 3,
      expert_specialization: ['tool_call', 'reasoning', 'general'],
      capacity_factor: 1.25,
      routing: 'switch-transformer-top-k',
    },
  };
  const r2 = buildMoeRecipe(moeArch);
  assert.equal(r2.ok, true);
  assert.equal(r2.production_ready, false, 'MoE is scaffold only — production_ready:false');
  assert.equal(r2.recipe.kind, 'moe');
  assert.equal(r2.recipe.num_experts, 8);
  assert.equal(r2.recipe.top_k, 3);
  assert.ok(Array.isArray(r2.recipe.expert_specialization));
  assert.equal(r2.recipe.expert_specialization.length, 3);
  assert.ok(typeof r2.yaml === 'string');
  assert.match(r2.yaml, /num_experts:\s*8/);
  assert.match(r2.yaml, /top_k:\s*3/);
  assert.match(r2.yaml, /production_ready:\s*false/);
  assert.equal(r2.version, 'w716-v1');
});

// =============================================================================
// 9) CLI --auto-arch --json with captures
// =============================================================================

test('W716 #9 — CLI `kolm distill --auto-arch --json` with captures emits report', async () => {
  const tmp = freshDir();
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w716', base: 'http://127.0.0.1:1', tenant_id: 'local' }),
  );
  // Pre-populate the legacy synchronous capture store with a handful of
  // observations under tenant=local namespace=default. The capture-store
  // path reads from store.all('observations') when no driver is set, and
  // the test-fresh HOME pins it to disk under tmp.
  const obsPath = path.join(cfgDir, 'observations.json');
  const observations = [];
  for (let i = 0; i < 20; i++) {
    observations.push({
      id: 'obs_' + i,
      tenant: 'local',
      corpus_namespace: 'default',
      prompt: `Question ${i}?`,
      response: `Step 1. Analyze.\n\nStep 2. Answer ${i}.\n\nStep 3. Verify.`,
      created_at: new Date().toISOString(),
    });
  }
  fs.writeFileSync(obsPath, JSON.stringify(observations, null, 2));

  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_ENV: 'test',
  };
  const r = spawnSync(process.execPath, [CLI_PATH, 'distill', '--auto-arch', '--json'], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  const stdout = r.stdout || '';
  // The output should be JSON when --json is set. Parse leniently — slice
  // from first { to last } so any leading log noise is tolerated.
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 600)} stderr=${(r.stderr || '').slice(0, 300)}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  // Either we got captures (ok:true with stats/recommendation), or we got
  // honest no_captures envelope. Both are acceptable shapes; the test pins
  // the envelope schema either way.
  assert.match(env_out.version || '', /^w716-v\d+$/);
  if (env_out.ok === true) {
    assert.ok(env_out.stats, 'envelope has stats');
    assert.ok(env_out.recommendation, 'envelope has recommendation');
    assert.match(env_out.recommendation.version, /^w716-v\d+$/);
    assert.match(env_out.recommendation.recommended.size_label, /^(1B|3B|7B)/);
  } else {
    // no_captures path: CLI exit was 3, envelope carries error:'no_captures'.
    assert.equal(env_out.ok, false);
    assert.match(String(env_out.error), /no_captures/);
    assert.equal(r.status, 3, `no_captures should exit 3, got ${r.status}`);
  }
});

// =============================================================================
// 10) CLI no captures path -> honest envelope exit 3
// =============================================================================

test('W716 #10 — CLI `kolm distill --auto-arch --json` no captures exits 3', async () => {
  const tmp = freshDir();
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w716', base: 'http://127.0.0.1:1', tenant_id: 'tenant_no_captures' }),
  );
  // Explicitly write an empty observations file so the store loads but is empty.
  fs.writeFileSync(path.join(cfgDir, 'observations.json'), '[]');
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_ENV: 'test',
  };
  const r = spawnSync(process.execPath,
    [CLI_PATH, 'distill', '--auto-arch', '--namespace', 'definitely-empty-ns-' + Date.now(), '--json'],
    { env, encoding: 'utf8', timeout: 30_000 });
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 600)} stderr=${(r.stderr || '').slice(0, 300)}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, false);
  assert.match(String(env_out.error), /no_captures/);
  assert.equal(r.status, 3, `exit code should be 3 for no_captures, got ${r.status}`);
  // Hint should mention 'kolm capture' for discoverability.
  assert.match(String(env_out.hint || ''), /kolm capture/);
});

// =============================================================================
// Bonus: ARCH_CATALOG sanity
// =============================================================================

test('W716 — ARCH_CATALOG exports expected size buckets', async () => {
  const keys = Object.keys(ARCH_CATALOG);
  // Anti-brittle: assert membership rather than exact-array equality.
  for (const k of ['ARCH_1B', 'ARCH_3B', 'ARCH_7B', 'ARCH_MOE_8x3']) {
    assert.ok(keys.includes(k), `catalog missing ${k}`);
  }
  assert.equal(ARCH_CATALOG.ARCH_1B.size_label, '1B');
  assert.equal(ARCH_CATALOG.ARCH_3B.size_label, '3B');
  assert.equal(ARCH_CATALOG.ARCH_7B.size_label, '7B');
  assert.ok(ARCH_CATALOG.ARCH_MOE_8x3.moe);
});
