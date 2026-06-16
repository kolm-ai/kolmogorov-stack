// FINALIZED-C5 - regression guards for the deep-dive fixes.
//
// (1) accuracy-recovery-gate: the gate silently SHIPPED an UNMEASURED artifact
//     (empty holdout -> assume quant==fp16 -> pass). Now it must FAIL CLOSED with
//     verdict 'gate_unrun' (does not ship) - a 'pass' verdict must be backed by a
//     real perplexity/KL measurement (moat).
// (2) layer-importance: the per-layer importance signal + mixed-precision schedule
//     receipt could not reach the signed artifact because buildAndZip never
//     forwarded the blocks to buildPayload. Now buildAndZip threads
//     mixed_precision_proof + importance_signal so the manifest embeds them AND
//     binds their SHA-256 into the artifact hash chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';
import { recoverAndGate } from '../src/quant-accuracy-recovery.js';
import { buildAndZip } from '../src/artifact.js';
import { doctorTurnkey } from '../src/quant-turnkey-runners.js';

function _tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-c5fix-')); }

// ---------------------------------------------------------------------------
// (1) accuracy-recovery gate fails CLOSED on unmeasured accuracy.
// ---------------------------------------------------------------------------
test('quant accuracy gate FAILS CLOSED (gate_unrun) when the holdout is unmeasured', () => {
  const r = recoverAndGate({ holdout: { fp16_rows: [], quant_rows: [] }, fp16_meta: { accuracy: 0.94 } });
  assert.equal(r.ships, false, 'must NOT ship an unmeasured artifact');
  assert.equal(r.verdict, 'gate_unrun');
  assert.match(r.gate.reason, /UNMEASURED|fail-closed/i);
});

test('quant accuracy gate also fails closed when only the QUANT rows are missing', () => {
  // fp16 measured but quant absent -> cannot compute the drop -> must not ship.
  const fp16 = Array.from({ length: 8 }, () => ({ logits: [2, 1, 0, -1], target: 0 }));
  const r = recoverAndGate({ holdout: { fp16_rows: fp16, quant_rows: [] }, fp16_meta: { accuracy: 0.9 } });
  assert.equal(r.ships, false);
  assert.equal(r.verdict, 'gate_unrun');
});

// ---------------------------------------------------------------------------
// (2) buildAndZip threads the layer-importance blocks into the signed artifact.
// ---------------------------------------------------------------------------
async function _build(extra) {
  const outDir = _tmp();
  const r = await buildAndZip({
    job_id: `c5fix-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    task: 'c5fix-test',
    base_model: 'none',
    recipes: [{ id: 'r1', source: 'export default function r1(x){return String(x).toUpperCase()}', positives: [{ input: 'hi', expected: 'HI' }] }],
    evals: { cases: [{ input: 'hi', expected: 'HI' }] },
    training_stats: { pass_rate_positive: 1.0, latency_p50_us: 10, cost_usd_per_call: 0 },
    outDir,
    tier: 'recipe',
    ...extra,
  });
  return r;
}

test('buildAndZip embeds mixed_precision_proof + importance_signal into the manifest', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-c5fix';
  const mixed_precision_proof = { schedule: [{ layer: 0, bits: 8 }, { layer: 1, bits: 2 }], applied_equals_requested: true };
  const importance_signal = { method: 'curvature', per_layer: [1.0, 0.0002], source: 'test' };
  const r = await _build({ mixed_precision_proof, importance_signal });
  assert.ok(r.manifest.mixed_precision_proof, 'manifest must carry mixed_precision_proof (was dropped by the missing seam)');
  assert.ok(r.manifest.importance_signal, 'manifest must carry importance_signal');
  assert.deepEqual(r.manifest.mixed_precision_proof.schedule, mixed_precision_proof.schedule);
  assert.deepEqual(r.manifest.importance_signal.per_layer, importance_signal.per_layer);
});

test('the importance blocks are BOUND into the artifact hash (tamper-evidence)', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-c5fix';
  const withBlocks = await _build({
    mixed_precision_proof: { schedule: [{ layer: 0, bits: 8 }], applied_equals_requested: true },
    importance_signal: { method: 'curvature', per_layer: [1.0], source: 'a' },
  });
  const without = await _build({});
  const differentSignal = await _build({
    mixed_precision_proof: { schedule: [{ layer: 0, bits: 4 }], applied_equals_requested: true },
    importance_signal: { method: 'curvature', per_layer: [0.5], source: 'b' },
  });
  const h = (r) => r.artifact_hash; // top-level artifact_hash binds the block SHA-256s
  assert.ok(h(withBlocks), 'artifact_hash must be present');
  assert.notEqual(h(withBlocks), h(without), 'embedding the blocks must change the artifact hash');
  assert.notEqual(h(withBlocks), h(differentSignal), 'a DIFFERENT importance signal must change the artifact hash (binding is real, not cosmetic)');
});

test('omitting the blocks is byte-stable (W460): no block keys in the manifest', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-c5fix';
  const r = await _build({});
  assert.equal('mixed_precision_proof' in r.manifest, false, 'absent block must NOT appear (conditional-spread W460 law)');
  assert.equal('importance_signal' in r.manifest, false);
});

// ---------------------------------------------------------------------------
// (3) turnkey doctor VALIDATES the pinned commit (was: only checked file exists).
// ---------------------------------------------------------------------------
test('doctorTurnkey fails the pin when the checkout is on the WRONG commit (drift)', () => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) return; // git unavailable on this box -> skip
  const d = _tmp();
  spawnSync('git', ['init', '-q', d]);
  spawnSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(d, 'main.py'), 'x'); // AQLM entry EXISTS but commit != pinned 8d6b1ad
  const r = doctorTurnkey('aqlm', { env: { AQLM_REPO_PATH: d } });
  assert.equal(r.ready, false, 'a checkout on the wrong commit must NOT report ready (the pin is the whole point)');
  assert.ok((r.reasons || []).some((x) => /expected pinned|drift|unverifiable/i.test(x)),
    'must explain the pin mismatch: ' + JSON.stringify(r.reasons));
});
