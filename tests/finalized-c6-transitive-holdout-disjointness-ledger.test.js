// Proves src/holdout-disjointness-ledger.js: the FINALIZED-C6 atom - a REAL
// transitive cross-corpus holdout-disjointness ledger that fail-closes the
// K-score ship gate when ANY train-side x holdout-side corpus pair shares a
// row (exact / near-dup / group-key) above a recorded tolerance.
//
// No GPU, no network. Every assertion runs over in-memory corpora. The atom
// reuses the project's MinHash/LSH substrate (src/minhash-dedup.js) + RFC-6962
// Merkle commitments (src/merkle.js) and the REAL K-score gate (computeKScoreV2
// from src/kscore.js).
//
// What is proven:
//   1. ingest commits each corpus to a stable Merkle root over hash-only leaves
//   2. the full bipartite train x holdout matrix is computed (transitive closure
//      over all edges) - a leak in ANY (train_i, holdout_j) cell is caught
//   3. exact (lexical) overlap is detected (incl. case/whitespace variants)
//   4. near-dup (MinHash/LSH + Jaccard) overlap is detected when no exact match
//   5. group-key overlap (shared member/case id) is detected with NO text overlap
//   6. clean corpora -> disjoint:true -> ships:true; any leak -> fail-closed
//   7. PRIVACY: tenant corpus committed by hash only; block carries NO plaintext
//   8. the disjointness verdict fail-closes the real K-score gate (true->false)
//   9. a third party re-verifies from committed roots + signatures, no plaintext
//  10. block hash binds the verdict: tampering disjoint/matrix is caught
//  11. fail-closed when ledger is missing/invalid (no proof => no ship)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISJOINTNESS_LEDGER_VERSION,
  TRAIN_SIDES,
  HOLDOUT_SIDES,
  rowHash,
  ingestCorpus,
  pairDisjointness,
  buildDisjointnessLedger,
  validateDisjointnessLedger,
  reVerifyFromCommitments,
  gateKScoreWithDisjointness,
  commitCorpusHashOnly,
} from '../src/holdout-disjointness-ledger.js';

import { computeKScoreV2 } from '../src/kscore.js';

// ---------------------------------------------------------------------------
// Fixtures. Distinct, well-separated rows so the near-dup floor (0.8) never
// fires by accident; specific colliding rows are injected per-test.
// ---------------------------------------------------------------------------
function mkRows(prefix, n, offset = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      input: `${prefix} request number ${offset + i} about the quarterly settlement ledger and audit trail`,
      output: `${prefix} response ${offset + i}`,
    });
  }
  return out;
}

function cleanCorpora() {
  return [
    { side: 'real_seed', name: 'seeds', rows: mkRows('alpha seed', 12, 0) },
    { side: 'synthetic_post_curate', name: 'synth', rows: mkRows('beta synth', 12, 100) },
    { side: 'distilled_teacher', name: 'distill', rows: mkRows('gamma distill', 12, 200) },
    { side: 'seed_holdout', name: 'holdout', rows: mkRows('delta holdout', 8, 300) },
    { side: 'external', name: 'gsm', rows: mkRows('epsilon external', 8, 400) },
    { side: 'adversarial', name: 'redteam', rows: mkRows('zeta adversarial', 6, 500) },
    { side: 'calibration', name: 'calib', rows: mkRows('eta calibration', 6, 600) },
  ];
}

// A passing K-score envelope (composite >= 0.85) so the disjointness gate is the
// only thing that can flip ships.
function passingKScore() {
  const env = computeKScoreV2({
    accuracy: 0.97,
    coverage: 0.96,
    size_bytes: 4096,
    p50_latency_us: 800,
    cost_usd_per_call: 0,
    holdout_accuracy: 0.95,
  });
  return env;
}

// ---------------------------------------------------------------------------
test('1. ingest commits each corpus to a stable, reproducible Merkle root', () => {
  const spec = { side: 'real_seed', name: 'seeds', rows: mkRows('alpha seed', 10) };
  const a = ingestCorpus(spec, { seed: 7 });
  const b = ingestCorpus(spec, { seed: 7 });
  assert.equal(a.n_rows, 10);
  assert.match(a.merkle_root, /^[0-9a-f]{64}$/, 'merkle root is hex64');
  assert.equal(a.merkle_root, b.merkle_root, 'same input + seed => same root (reproducible)');
  // changing one row changes the root (binding)
  const mutated = { side: 'real_seed', name: 'seeds', rows: mkRows('alpha seed', 10).map((r, i) => i === 3 ? { input: 'totally different row', output: 'x' } : r) };
  const c = ingestCorpus(mutated, { seed: 7 });
  assert.notEqual(c.merkle_root, a.merkle_root, 'mutating a row changes the root');
});

test('2. transitive bipartite matrix covers EVERY train x holdout edge', () => {
  const block = buildDisjointnessLedger(cleanCorpora(), { seed: 7 });
  // 3 train sides x 4 holdout sides = 12 cells
  assert.equal(block.n_pairs, 12, 'full bipartite product is scored');
  const seen = new Set(block.matrix.map((p) => p.train + '->' + p.holdout));
  for (const t of ['seeds', 'synth', 'distill']) {
    for (const h of ['holdout', 'gsm', 'redteam', 'calib']) {
      assert.ok(seen.has(t + '->' + h), `edge ${t}->${h} present in matrix`);
    }
  }
  assert.equal(block.spec, DISJOINTNESS_LEDGER_VERSION);
});

test('3. exact (lexical) overlap is detected incl. case/whitespace variants', () => {
  const leaked = mkRows('alpha seed', 10, 0);
  // inject the SAME row (case + whitespace mangled) into the external holdout:
  // exact tier normalizes case/whitespace so it is still an exact hit.
  const sharedTrainRow = leaked[2];
  const corpora = [
    { side: 'real_seed', name: 'seeds', rows: leaked },
    { side: 'external', name: 'gsm',
      rows: [
        ...mkRows('epsilon external', 6, 400),
        { input: '   ' + sharedTrainRow.input.toUpperCase() + '  ', output: 'leaked' },
      ] },
    { side: 'seed_holdout', name: 'holdout', rows: mkRows('delta holdout', 6, 300) },
  ];
  const block = buildDisjointnessLedger(corpora, { seed: 7 });
  const cell = block.matrix.find((p) => p.train === 'seeds' && p.holdout === 'gsm');
  assert.equal(cell.exact_overlap, 1, 'exact overlap detected despite case/whitespace');
  assert.equal(cell.worst_jaccard, 1, 'exact match => worst_jaccard 1.0');
  assert.equal(block.disjoint, false);
  assert.equal(block.ships, false, 'fail-closed on exact leak');
});

test('4. near-dup overlap (MinHash/LSH) is detected when no exact match exists', () => {
  const base = 'the auditor reviewed the quarterly settlement ledger entries and reconciled every line of the trial balance with care';
  // near-dup: append a couple tokens so the row-hash differs but Jaccard stays high.
  const nearDup = base + ' and signed off';
  const corpora = [
    { side: 'distilled_teacher', name: 'distill', rows: [{ input: nearDup, output: 'a' }, ...mkRows('gamma distill', 8, 200)] },
    { side: 'external', name: 'gsm', rows: [{ input: base, output: 'b' }, ...mkRows('epsilon external', 6, 400)] },
    { side: 'seed_holdout', name: 'holdout', rows: mkRows('delta holdout', 6, 300) },
  ];
  const block = buildDisjointnessLedger(corpora, { seed: 7, nearDupJaccard: 0.7 });
  const cell = block.matrix.find((p) => p.train === 'distill' && p.holdout === 'gsm');
  assert.equal(cell.exact_overlap, 0, 'no exact match (row hashes differ)');
  assert.ok(cell.near_dup_overlap >= 1, 'near-dup overlap detected via MinHash/LSH');
  assert.ok(cell.worst_jaccard >= 0.7, 'recorded worst-case Jaccard above floor');
  assert.equal(block.ships, false, 'fail-closed on near-dup leak');
});

test('5. group-key overlap (shared member id) is detected with NO text overlap', () => {
  const corpora = [
    { side: 'real_seed', name: 'seeds', group_key: 'member_id',
      rows: [
        { input: 'patient alice presented with chest pain', output: 'triage', metadata: { member_id: 'M-9001' } },
        ...mkRows('alpha seed', 6, 0).map((r) => ({ ...r, metadata: { member_id: 'M-' + Math.random() } })),
      ] },
    { side: 'seed_holdout', name: 'holdout', group_key: 'member_id',
      rows: [
        // completely different TEXT but the SAME member -> patient-level leak
        { input: 'follow-up echocardiogram scheduled for the cardiology ward', output: 'ok', metadata: { member_id: 'M-9001' } },
        ...mkRows('delta holdout', 6, 300).map((r) => ({ ...r, metadata: { member_id: 'H-' + Math.random() } })),
      ] },
  ];
  const block = buildDisjointnessLedger(corpora, { seed: 7 });
  const cell = block.matrix.find((p) => p.train === 'seeds' && p.holdout === 'holdout');
  assert.equal(cell.exact_overlap, 0, 'no text overlap');
  assert.equal(cell.group_overlap, 1, 'shared member_id detected (group-key leak)');
  assert.equal(block.ships, false, 'fail-closed on group-key leak');
});

test('6. clean corpora -> disjoint:true -> ships:true', () => {
  const block = buildDisjointnessLedger(cleanCorpora(), { seed: 7 });
  assert.equal(block.n_violations, 0);
  assert.equal(block.total_overlap, 0);
  assert.equal(block.disjoint, true);
  assert.equal(block.ships, true, 'clean ledger ships');
  // and it validates structurally
  assert.doesNotThrow(() => validateDisjointnessLedger(block));
});

test('7. PRIVACY: tenant corpus committed by hash only; block carries NO plaintext', () => {
  // Tenant commits on their own infra; plaintext never leaves commitCorpusHashOnly.
  const secret = 'SSN 123-45-6789 belongs to confidential patient Jane Roe of ward 7';
  const tenantRows = [
    { input: secret, output: 'redact' },
    ...mkRows('tenant private', 8, 700),
  ];
  const committed = commitCorpusHashOnly(tenantRows, { seed: 7, group_key: 'member_id' });
  assert.equal(committed.n_rows, 9);
  assert.equal(committed.rowHashes.length, 9);
  assert.equal(committed.signatures.length, 9);

  const corpora = [
    { side: 'real_seed', name: 'seeds', rows: mkRows('alpha seed', 8, 0) },
    {
      side: 'tenant_shadow', name: 'tenant', privacy: 'hash_only',
      rowHashes: committed.rowHashes, signatures: committed.signatures, groupHashes: committed.groupHashes,
    },
  ];
  const block = buildDisjointnessLedger(corpora, { seed: 7 });

  // The whole serialized block must not contain the tenant secret anywhere.
  const serialized = JSON.stringify(block);
  assert.ok(!serialized.includes('123-45-6789'), 'no SSN in block');
  assert.ok(!serialized.includes('Jane Roe'), 'no tenant name in block');
  assert.ok(!serialized.includes('confidential patient'), 'no tenant plaintext in block');
  // but the tenant corpus IS committed (root + n_rows recorded)
  const tenantEntry = block.corpora.find((c) => c.name === 'tenant');
  assert.equal(tenantEntry.privacy, 'hash_only');
  assert.match(tenantEntry.merkle_root, /^[0-9a-f]{64}$/);
  assert.equal(tenantEntry.n_rows, 9);
});

test('8. disjointness verdict fail-closes the REAL K-score gate (true->false)', () => {
  const k = passingKScore();
  assert.equal(k.ships, true, 'baseline K-score ships on its own');

  // clean ledger: ship stays true
  const cleanBlock = buildDisjointnessLedger(cleanCorpora(), { seed: 7 });
  const gatedClean = gateKScoreWithDisjointness(k, cleanBlock);
  assert.equal(gatedClean.ships, true, 'clean ledger does not block a passing K-score');
  assert.equal(gatedClean.disjointness.disjoint, true);

  // contaminated ledger: ship flips to false
  const leaked = mkRows('alpha seed', 8, 0);
  const dirty = buildDisjointnessLedger([
    { side: 'real_seed', name: 'seeds', rows: leaked },
    { side: 'external', name: 'gsm', rows: [leaked[1], ...mkRows('epsilon external', 5, 400)] },
  ], { seed: 7 });
  assert.equal(dirty.ships, false);
  const gatedDirty = gateKScoreWithDisjointness(k, dirty);
  assert.equal(gatedDirty.ships, false, 'contaminated holdout blocks the ship');
  assert.equal(gatedDirty.disjointness.disjoint, false);
  assert.ok(gatedDirty.disjointness.blocked_reason.includes('contamination'));
  assert.equal(gatedDirty.disjointness.k_score_ships, true, 'records that K-score itself passed');
  // composite/gate preserved
  assert.equal(gatedDirty.composite, k.composite);
  assert.equal(gatedDirty.gate, k.gate);
});

test('8b. gate NEVER widens: a failing K-score stays failed even with clean ledger', () => {
  const failing = computeKScoreV2({ accuracy: 0.3, coverage: 0.3, size_bytes: 1e9, p50_latency_us: 9e6 });
  assert.equal(failing.ships, false);
  const cleanBlock = buildDisjointnessLedger(cleanCorpora(), { seed: 7 });
  const gated = gateKScoreWithDisjointness(failing, cleanBlock);
  assert.equal(gated.ships, false, 'disjoint ledger cannot rescue a failing K-score');
});

test('9. third party re-verifies from committed roots + signatures, no plaintext', () => {
  const corpora = cleanCorpora();

  // The author publishes a hash-only commitment manifest (the privacy-preserving
  // shipping form): every corpus committed by hash, NO plaintext leaves. The
  // ledger is built from those commitments, exactly as a third party would
  // rebuild it - so the verdict, roots, AND full block hash are bit-exact
  // reproducible without any corpus plaintext.
  const commitments = corpora.map((c) => {
    const com = commitCorpusHashOnly(c.rows, { seed: 7, group_key: c.group_key });
    return {
      side: c.side, name: c.name, privacy: 'hash_only',
      rowHashes: com.rowHashes, signatures: com.signatures, groupHashes: com.groupHashes,
      group_key: c.group_key,
    };
  });
  // ensure the verifier truly has no plaintext available
  for (const com of commitments) assert.equal(com.rows, undefined);

  const block = buildDisjointnessLedger(commitments, { seed: 7, generated_at: '2026-06-17T00:00:00.000Z' });
  const res = reVerifyFromCommitments(block, commitments, {});
  assert.equal(res.ok, true, 're-verification ok from commitments alone');
  assert.equal(res.roots_match, true, 'every committed Merkle root reproduced');
  assert.equal(res.verdict_match, true, 'disjointness verdict reproduced');
  assert.equal(res.hash_match, true, 'full block hash reproduced (bit-exact re-verifiability)');
  assert.equal(res.recomputed_disjoint, true);

  // And the plaintext-author can ALSO re-verify their own block against the
  // same commitments: roots + verdict reproduce (privacy-mode metadata aside).
  const plaintextBlock = buildDisjointnessLedger(corpora, { seed: 7, generated_at: '2026-06-17T00:00:00.000Z' });
  const res2 = reVerifyFromCommitments(plaintextBlock, commitments, {});
  assert.equal(res2.ok, true, 'roots + verdict reproduce across privacy modes');
  assert.equal(res2.roots_match, true, 'Merkle roots are privacy-mode invariant');
});

test('9b. re-verify catches a corpus whose committed root does not match', () => {
  const corpora = cleanCorpora();
  const block = buildDisjointnessLedger(corpora, { seed: 7, generated_at: '2026-06-17T00:00:00.000Z' });
  const commitments = corpora.map((c) => {
    // tamper the FIRST corpus's commitments (drop a row) so its root drifts
    const rows = c.name === 'seeds' ? c.rows.slice(1) : c.rows;
    const com = commitCorpusHashOnly(rows, { seed: 7, group_key: c.group_key });
    return { side: c.side, name: c.name, privacy: 'hash_only', rowHashes: com.rowHashes, signatures: com.signatures, groupHashes: com.groupHashes, group_key: c.group_key };
  });
  const res = reVerifyFromCommitments(block, commitments, {});
  assert.equal(res.ok, false, 'tampered commitments rejected');
  assert.equal(res.roots_match, false);
  assert.match(res.reason, /root mismatch/);
});

test('10. block hash binds the verdict: tampering disjoint/matrix is caught', () => {
  const leaked = mkRows('alpha seed', 8, 0);
  const block = buildDisjointnessLedger([
    { side: 'real_seed', name: 'seeds', rows: leaked },
    { side: 'external', name: 'gsm', rows: [leaked[0], ...mkRows('epsilon external', 5, 400)] },
  ], { seed: 7 });
  assert.equal(block.disjoint, false);

  // Attacker flips the verdict to ship without touching the matrix.
  const tampered = JSON.parse(JSON.stringify(block));
  tampered.disjoint = true;
  tampered.ships = true;
  assert.throws(() => validateDisjointnessLedger(tampered), /contradicts matrix|hash drift|fail-closed/);

  // Attacker flips disjoint+ships AND zeroes the violating cell counts but keeps
  // the stale hash -> hash drift catches it.
  const tampered2 = JSON.parse(JSON.stringify(block));
  tampered2.disjoint = true;
  tampered2.ships = true;
  tampered2.n_violations = 0;
  for (const p of tampered2.matrix) { p.exact_overlap = 0; p.near_dup_overlap = 0; p.group_overlap = 0; p.within_tolerance = true; }
  assert.throws(() => validateDisjointnessLedger(tampered2), /hash drift/);
});

test('11. fail-closed when ledger is missing or invalid (no proof => no ship)', () => {
  const k = passingKScore();
  // missing ledger
  const gNull = gateKScoreWithDisjointness(k, null);
  assert.equal(gNull.ships, false, 'no ledger => do not ship');
  assert.ok(gNull.disjointness.blocked_reason.includes('no disjointness ledger'));
  // invalid ledger (wrong spec)
  const gBad = gateKScoreWithDisjointness(k, { spec: 'nope', disjoint: true, ships: true });
  assert.equal(gBad.ships, false, 'invalid ledger => do not ship');
  assert.ok(gBad.disjointness.blocked_reason.includes('invalid'));
});

test('12. tolerance is recorded + bound into the hash (non-repudiable relaxation)', () => {
  const leaked = mkRows('alpha seed', 8, 0);
  const corpora = [
    { side: 'real_seed', name: 'seeds', rows: leaked },
    { side: 'calibration', name: 'calib', rows: [leaked[0], ...mkRows('eta calibration', 5, 600)] },
  ];
  // default tolerance 0 -> fails
  const strict = buildDisjointnessLedger(corpora, { seed: 7 });
  assert.equal(strict.ships, false);
  // explicit tolerance of 1 exact overlap (operator KNOWS calib draws 1 from seeds)
  const relaxed = buildDisjointnessLedger(corpora, { seed: 7, tolerance: { exact: 1 } });
  assert.equal(relaxed.tolerance.exact, 1, 'tolerance recorded');
  assert.equal(relaxed.ships, true, 'within recorded tolerance => ships');
  // the relaxation changes the hash (non-repudiable)
  assert.notEqual(relaxed.hash, strict.hash);
  assert.doesNotThrow(() => validateDisjointnessLedger(relaxed));
});

test('13. requires at least one train AND one holdout corpus', () => {
  assert.throws(() => buildDisjointnessLedger([{ side: 'real_seed', name: 'a', rows: mkRows('x', 3) }], {}), /no holdout-side/);
  assert.throws(() => buildDisjointnessLedger([{ side: 'external', name: 'b', rows: mkRows('y', 3) }], {}), /no train-side/);
});

test('14. pairDisjointness is reusable standalone and near-linear-friendly', () => {
  const t = ingestCorpus({ side: 'real_seed', name: 'seeds', rows: mkRows('alpha', 200, 0) }, { seed: 7 });
  const h = ingestCorpus({ side: 'external', name: 'gsm', rows: mkRows('beta', 200, 1000) }, { seed: 7 });
  const pair = pairDisjointness(t, h, {});
  assert.equal(pair.total_overlap, 0, '200x200 disjoint corpora => zero overlap');
  assert.equal(pair.disjoint, true);
});

test('15. side taxonomy exports cover the full eval ladder', () => {
  assert.deepEqual(TRAIN_SIDES, ['real_seed', 'synthetic_post_curate', 'distilled_teacher']);
  assert.deepEqual(HOLDOUT_SIDES, ['seed_holdout', 'external', 'adversarial', 'tenant_shadow', 'calibration']);
  // rowHash is deterministic + normalization-aware
  assert.equal(rowHash({ input: 'Hello World' }), rowHash({ input: '  hello   world ' }));
});
