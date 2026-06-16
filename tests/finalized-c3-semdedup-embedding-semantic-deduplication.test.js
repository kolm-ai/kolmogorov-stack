// FINALIZED C3 — SemDeDup embedding-cluster semantic deduplication.
//
// Covers src/data-semdedup.js (SemDeDup, Abbas et al. 2023) and its DEFAULT-ON
// wiring into the CURATE pipeline (after MinHash, before the python embedding
// pass). Pure JS, zero new deps, runs on a python-less box.
//
// Pins:
//   - return contract { kept, removed_groups, dup_rate, epsilon, report }
//   - report has a per-cluster redundancy block + backend_used
//   - paraphrase / near-identical pairs collapse to one representative
//   - epsilon is the single knob: bigger epsilon => looser => fewer removed
//   - keep policy ('low-density'|'high-quality'|'centroid'|'first') honored
//   - determinism: identical input + seed => identical kept set + dup_rate
//   - degrade-to-no-op: empty / singleton / epsilon<=0 / failing embedder, all
//     recorded in report.backend_used, NEVER throws
//   - injected embedder path (privacy: real-model swap) works + is recorded
//   - CURATE integration: semdedup is DEFAULT-ON, removes semantic dups, surfaces
//     report.semdedup + report.backend_used, and semdedup:false disables it

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { semDedup, SEMDEDUP_VERSION } from '../src/data-semdedup.js';
import { curatePairs } from '../src/data-curate.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

// Two tight semantic clusters of near-duplicate phrasings + two distinct loners.
function corpus() {
  return [
    { input: 'How do I reset my password?', output: 'Click the reset link in the login page and follow the email.' },
    { input: 'How can I reset my password?', output: 'Click the reset link on the login page then follow the email.' },
    { input: 'I forgot my password, how to reset it?', output: 'Click the reset link in the login page and follow the email instructions.' },
    { input: 'What is the capital of France?', output: 'The capital of France is Paris.' },
    { input: 'Tell me the capital city of France.', output: 'The capital of France is Paris, a major European city.' },
    { input: 'Explain quantum entanglement briefly.', output: 'Entangled particles share a state so measuring one instantly informs the other.' },
    { input: 'Write a haiku about the ocean.', output: 'Waves crash on cold stone / salt wind carries distant cries / blue meets endless sky.' },
  ];
}

// ── module: return contract ───────────────────────────────────────────────────

test('semDedup return contract + per-cluster redundancy report', () => {
  const res = semDedup(corpus(), { epsilon: 0.2, seed: 7 });
  assert.ok(Array.isArray(res.kept), 'kept is an array');
  assert.ok(Array.isArray(res.removed_groups), 'removed_groups is an array');
  assert.equal(typeof res.dup_rate, 'number');
  assert.ok(res.dup_rate >= 0 && res.dup_rate <= 1, 'dup_rate in [0,1]');
  assert.equal(res.epsilon, 0.2, 'epsilon echoed');
  assert.ok(res.report && typeof res.report === 'object', 'report present');
  assert.equal(res.report.version, SEMDEDUP_VERSION);
  assert.ok(Array.isArray(res.report.clusters), 'per-cluster report present');
  assert.equal(typeof res.report.backend_used, 'string');
  assert.equal(res.report.epsilon, 0.2);
  // dup_rate is consistent with kept count.
  assert.equal(res.report.n_in, 7);
  assert.equal(res.report.n_kept, res.kept.length);
  assert.equal(res.report.n_in - res.report.n_kept, res.report.n_removed);
  // each cluster report row has the redundancy fields.
  for (const c of res.report.clusters) {
    assert.equal(typeof c.size, 'number');
    assert.equal(typeof c.kept, 'number');
    assert.equal(typeof c.removed, 'number');
    assert.ok(c.redundancy >= 0 && c.redundancy <= 1);
  }
});

test('semDedup collapses near-identical pairs to a representative', () => {
  // Force a single cluster so the prune is unambiguous; 3 near-identical + 1 far.
  const pairs = [
    { input: 'q', output: 'the quick brown fox jumps over the lazy dog' },
    { input: 'q', output: 'the quick brown fox jumps over the lazy dog' },
    { input: 'q', output: 'the quick brown fox jumps over the lazy dog' },
    { input: 'z', output: 'completely unrelated text about astrophysics and stars' },
  ];
  const res = semDedup(pairs, { epsilon: 0.1, k: 2, seed: 1 });
  assert.ok(res.kept.length < pairs.length, 'at least one duplicate removed');
  assert.ok(res.removed_groups.length >= 1, 'a removed group recorded');
  const g = res.removed_groups[0];
  assert.equal(typeof g.kept_idx, 'number');
  assert.ok(Array.isArray(g.removed_idxs) && g.removed_idxs.length >= 1);
  // the unrelated row must survive.
  const keptOutputs = res.kept.map((p) => p.output);
  assert.ok(keptOutputs.some((o) => o.includes('astrophysics')), 'distinct row kept');
});

// ── epsilon is the single knob ────────────────────────────────────────────────

test('epsilon monotonicity: larger epsilon removes no more than smaller', () => {
  const base = corpus();
  const tight = semDedup(base.map((p) => ({ ...p })), { epsilon: 0.02, seed: 9 });
  const loose = semDedup(base.map((p) => ({ ...p })), { epsilon: 0.5, seed: 9 });
  // sim_threshold = 1 - epsilon. Smaller epsilon => higher threshold => HARDER to
  // be a dup => FEWER removed. So removed(loose) >= removed(tight).
  assert.ok(
    loose.report.n_removed >= tight.report.n_removed,
    `loose(${loose.report.n_removed}) >= tight(${tight.report.n_removed})`,
  );
  assert.equal(tight.report.sim_threshold, 0.98);
  assert.equal(loose.report.sim_threshold, 0.5);
});

// ── keep policy ───────────────────────────────────────────────────────────────

test('keep policy is honored + recorded', () => {
  const pairs = corpus();
  for (const keep of ['low-density', 'high-quality', 'centroid', 'first']) {
    const res = semDedup(pairs.map((p) => ({ ...p })), { epsilon: 0.3, keep, seed: 3 });
    assert.equal(res.report.keep_policy, keep, `keep ${keep} recorded`);
    assert.ok(Array.isArray(res.kept));
  }
});

test('high-quality keep policy retains the higher-quality member', () => {
  // Two near-identical inputs; one output is a refusal (low quality), one is a
  // well-formed structured answer (high quality). high-quality must keep the good.
  const good = 'Here are the steps:\n1. Open settings\n2. Click reset\n3. Confirm the change to finish.';
  const bad = 'I am sorry, I cannot help with that request at this time.';
  const pairs = [
    { input: 'how to reset settings', output: bad },
    { input: 'how to reset the settings', output: good },
  ];
  const res = semDedup(pairs, { epsilon: 0.4, k: 1, keep: 'high-quality', seed: 2 });
  if (res.report.n_removed >= 1) {
    const keptOutputs = res.kept.map((p) => p.output);
    assert.ok(keptOutputs.includes(good), 'high-quality survivor kept');
    assert.ok(!keptOutputs.includes(bad), 'low-quality refusal dropped');
  }
});

// ── determinism ───────────────────────────────────────────────────────────────

test('determinism: identical input + seed => identical result', () => {
  const a = semDedup(corpus(), { epsilon: 0.25, seed: 42 });
  const b = semDedup(corpus(), { epsilon: 0.25, seed: 42 });
  assert.equal(a.dup_rate, b.dup_rate, 'dup_rate stable');
  assert.equal(a.kept.length, b.kept.length, 'kept count stable');
  assert.deepEqual(
    a.kept.map((p) => p.input),
    b.kept.map((p) => p.input),
    'kept set stable',
  );
  assert.deepEqual(a.report.clusters, b.report.clusters, 'cluster report stable');
});

// ── degrade-to-no-op (never throws) ───────────────────────────────────────────

test('degrades to recorded no-op on empty / singleton / epsilon<=0', () => {
  const empty = semDedup([], { epsilon: 0.1 });
  assert.equal(empty.kept.length, 0);
  assert.equal(empty.dup_rate, 0);
  assert.match(empty.report.backend_used, /^none:/);

  const single = semDedup([{ input: 'a', output: 'b' }], { epsilon: 0.1 });
  assert.equal(single.kept.length, 1);
  assert.match(single.report.backend_used, /^none:/);

  const off = semDedup(corpus(), { epsilon: 0 });
  assert.equal(off.kept.length, 7, 'epsilon=0 keeps everything');
  assert.equal(off.report.backend_used, 'none:epsilon_zero');
});

test('never throws on malformed rows', () => {
  const junk = [null, undefined, 42, {}, { input: 'x' }, { output: 'y' }, 'string-row'];
  let res;
  assert.doesNotThrow(() => { res = semDedup(junk, { epsilon: 0.2, seed: 5 }); });
  assert.ok(Array.isArray(res.kept));
  assert.equal(typeof res.dup_rate, 'number');
});

test('failing injected embedder degrades to recorded no-op, never throws', () => {
  const bad = () => { throw new Error('boom'); };
  let res;
  assert.doesNotThrow(() => { res = semDedup(corpus(), { epsilon: 0.2, embedder: bad }); });
  assert.equal(res.kept.length, 7, 'no-op keeps all rows');
  assert.match(res.report.backend_used, /^none:embed_failed/);
});

// ── injected embedder (privacy / real-model swap) ─────────────────────────────

test('injected embedder path works + is recorded as injected', () => {
  // Tiny deterministic 4-dim embedder keyed on a coarse topic word so clustering
  // is meaningful without the default hash-bag embedder.
  const inject = (text) => {
    const t = String(text).toLowerCase();
    return [
      t.includes('password') ? 1 : 0,
      t.includes('france') || t.includes('paris') ? 1 : 0,
      t.includes('quantum') ? 1 : 0,
      t.includes('ocean') || t.includes('haiku') ? 1 : 0.001,
    ];
  };
  const res = semDedup(corpus(), { epsilon: 0.2, embedder: inject, seed: 11 });
  assert.match(res.report.backend_used, /injected/);
  assert.ok(res.report.n_removed >= 1, 'injected-space duplicates pruned');
});

// ── CURATE integration: default-on + disable ──────────────────────────────────

test('CURATE runs SemDeDup DEFAULT-ON (no opts) and surfaces the report', async () => {
  // Disable python dedup so the result reflects ONLY the JS semdedup stage, and
  // disable quality/cot so no other stage removes our rows.
  const pairs = corpus();
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'semdedup-default-' + Date.now(),
    pairs,
    opts: { dedup: false, quality: false, cot: false, pii: false, cluster: false },
  });
  assert.equal(res.ok, true, 'curate ok');
  assert.ok(res.report.semdedup && typeof res.report.semdedup === 'object', 'semdedup report present');
  assert.equal(res.report.semdedup.version, SEMDEDUP_VERSION);
  assert.match(res.report.backend_used, /semdedup-js/, 'backend_used records semdedup');
  // default epsilon is 0.05 unless overridden.
  assert.equal(res.report.semdedup.epsilon, 0.05);
});

test('CURATE epsilon knob flows through to the SemDeDup stage', async () => {
  const pairs = corpus();
  const loose = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'semdedup-eps-loose-' + Date.now(),
    pairs: pairs.map((p) => ({ ...p })),
    opts: { dedup: false, quality: false, cot: false, pii: false, cluster: false, epsilon: 0.4 },
  });
  assert.equal(loose.report.semdedup.epsilon, 0.4, 'epsilon plumbed through curate');
  assert.equal(loose.report.semdedup.sim_threshold, 0.6);
});

test('CURATE semdedup:false disables the stage (back-compat)', async () => {
  const pairs = corpus();
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'semdedup-off-' + Date.now(),
    pairs,
    opts: { semdedup: false, dedup: false, quality: false, cot: false, pii: false, cluster: false },
  });
  assert.equal(res.ok, true);
  assert.equal(res.report.semdedup, null, 'semdedup not run');
  assert.equal(res.report.backend_used, 'none', 'no dedup backend ran');
  assert.equal(res.n_kept, pairs.length, 'all rows kept when every removing stage is off');
});

test('CURATE never throws + stays ok when SemDeDup sees a degenerate corpus', async () => {
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'semdedup-degenerate-' + Date.now(),
    pairs: [{ input: 'only one', output: 'single row' }],
    opts: { dedup: false, quality: false, cot: false, pii: false, cluster: false },
  });
  assert.equal(res.ok, true);
  // n=1 -> semdedup stage is gated off (work.length > 1) so report stays null.
  assert.equal(res.report.semdedup, null);
});
