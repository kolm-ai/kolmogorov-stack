// scripts/data-feedback-smoke.mjs
//
// Smoke test for src/data-feedback.js (FEEDBACK stage of the KOLM data engine).
//
// Isolates persistence state in a fresh temp KOLM_DATA_DIR BEFORE importing the
// module so the event-store binds to the throwaway dir. Prints "N passed,
// M failed" and exits nonzero on any failure.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// --- state isolation: must happen before the module import below ---
process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-feedback-smoke-'));

const {
  FEEDBACK_VERSION,
  identifyProdGaps,
  proposeRecompile,
  latestProposal,
  recordABResult,
  scheduleRecompile,
  costPrune,
} = await import('../src/data-feedback.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail != null ? `  (${detail})` : ''}`);
  }
}

const TENANT = 'tenant_smoke';
const NS = 'support';

// --- 1. identifyProdGaps with injectGaps ---
{
  const injectGaps = [
    { cluster_id: 'c1', gap_score: 0.8, recommended_count: 50 },
    { cluster_id: 'c2', gap_score: 0.5, recommended_count: 20 },
  ];
  const r = await identifyProdGaps({ tenant: TENANT, namespace: NS, injectGaps });
  check('1.version', r.version === FEEDBACK_VERSION && FEEDBACK_VERSION === 'feedback-v1', r.version);
  check('1.ok', r.ok === true, JSON.stringify(r));
  check('1.n_gaps===2', r.n_gaps === 2, r.n_gaps);
  check('1.recommended_actions.length===2', r.recommended_actions.length === 2, r.recommended_actions.length);
  check('1.est_pairs preserved (50)', r.recommended_actions[0].est_pairs === 50, r.recommended_actions[0].est_pairs);
  check('1.est_pairs preserved (20)', r.recommended_actions[1].est_pairs === 20, r.recommended_actions[1].est_pairs);
  check('1.action is gap-fill', /gap-fill/.test(r.recommended_actions[0].action), r.recommended_actions[0].action);
  check('1.cluster_id mapped', r.recommended_actions[0].cluster_id === 'c1', r.recommended_actions[0].cluster_id);
}

// --- 2. proposeRecompile -> est_pairs_needed===70, then round-trip via latestProposal ---
{
  const gaps = [
    { cluster_id: 'c1', gap_score: 0.8, recommended_count: 50 },
    { cluster_id: 'c2', gap_score: 0.5, recommended_count: 20 },
  ];
  const r = await proposeRecompile({ tenant: TENANT, namespace: NS, gaps });
  check('2.ok', r.ok === true, JSON.stringify(r));
  check('2.est_pairs_needed===70', r.proposal.est_pairs_needed === 70, r.proposal.est_pairs_needed);
  check('2.strategy gap-fill', r.proposal.strategy === 'gap-fill', r.proposal.strategy);
  check('2.reason is string', typeof r.proposal.reason === 'string' && r.proposal.reason.length > 0, r.proposal.reason);
  check('2.proposed_at set', typeof r.proposal.proposed_at === 'string', r.proposal.proposed_at);

  const back = await latestProposal({ tenant: TENANT, namespace: NS });
  check('2.latestProposal.ok', back.ok === true, JSON.stringify(back));
  check('2.persisted round-trip non-null', back.proposal !== null, JSON.stringify(back));
  check('2.round-trip est_pairs_needed===70', back.proposal && back.proposal.est_pairs_needed === 70, back.proposal && back.proposal.est_pairs_needed);
  check('2.round-trip strategy gap-fill', back.proposal && back.proposal.strategy === 'gap-fill', back.proposal && back.proposal.strategy);
}

// --- 3. recordABResult(winner:'b') ---
{
  const r = await recordABResult({
    tenant: TENANT,
    namespace: NS,
    variant_a: 'trinity-500',
    variant_b: 'trinity-510',
    winner: 'b',
    metric: { name: 'win_rate', a: 0.41, b: 0.58 },
  });
  check('3.ok', r.ok === true, JSON.stringify(r));
  check('3.recorded', r.recorded === true, r.recorded);
  check("3.winner==='b'", r.winner === 'b', r.winner);
}

// --- 4. scheduleRecompile: valid cron preserved; empty cron -> ok:false ---
{
  const r = scheduleRecompile({ cron: '0 3 * * 1', namespace: NS });
  check('4.ok', r.ok === true, JSON.stringify(r));
  check('4.cron preserved', r.schedule.cron === '0 3 * * 1', r.schedule.cron);
  check('4.namespace preserved', r.schedule.namespace === NS, r.schedule.namespace);
  check('4.next_hint present', typeof r.schedule.next_hint === 'string', r.schedule.next_hint);

  const empty = scheduleRecompile({ cron: '' });
  check('4.empty cron -> ok:false', empty.ok === false, JSON.stringify(empty));
  check('4.empty cron version', empty.version === FEEDBACK_VERSION, empty.version);

  const ws = scheduleRecompile({ cron: '   ' });
  check('4.whitespace cron -> ok:false', ws.ok === false, JSON.stringify(ws));
}

// --- 5. costPrune over 10 synthetic pairs with a tight ceiling ---
{
  // 10 pairs with increasing output length (i+1 chars of 'x' for index i),
  // plus one empty-output pair that must always be dropped.
  const pairs = [];
  for (let i = 0; i < 9; i++) {
    pairs.push({ input: `q${i}`, output: 'x'.repeat((i + 1) * 40) });
  }
  pairs.push({ input: 'q-empty', output: '' }); // empty output -> never kept

  // First measure the unconstrained per-pair cost by giving a huge ceiling.
  const big = costPrune({ pairs, max_cost_usd: 1000 });
  check('5.big.ok', big.ok === true, JSON.stringify(big));
  // Per-pair cost = total est over kept (all 9 non-empty kept).
  const perPair = big.kept.length > 0 ? big.est_cost_usd / big.kept.length : 0;
  check('5.perPair > 0 (priced model)', perPair > 0, perPair);
  check('5.empty-output dropped under big ceiling', big.kept.length === 9, big.kept.length);

  // Tight ceiling: room for ~4 pairs only.
  const tight = perPair * 4.5;
  const r = costPrune({ pairs, max_cost_usd: tight });
  check('5.tight.ok', r.ok === true, JSON.stringify(r));
  check('5.dropped_count > 0', r.dropped_count > 0, r.dropped_count);
  check('5.est_cost_usd <= max_cost_usd', r.est_cost_usd <= tight + 1e-9, `${r.est_cost_usd} <= ${tight}`);
  check('5.kept favors longer outputs', r.kept.length > 0 && r.kept[0].output.length === 360, r.kept[0] && r.kept[0].output.length);
  // The longest (360-char) must be kept; the empty one must not.
  const keptInputs = new Set(r.kept.map((p) => p.input));
  check('5.empty output never kept', !keptInputs.has('q-empty'), [...keptInputs].join(','));
  check('5.kept count <= 4 under tight cap', r.kept.length <= 4, r.kept.length);
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);

// Best-effort temp cleanup (does not affect exit status).
try { fs.rmSync(process.env.KOLM_DATA_DIR, { recursive: true, force: true }); } catch {}

process.exit(failed === 0 ? 0 : 1);
