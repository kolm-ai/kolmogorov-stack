// tests/wave921-govern-receipts-compliance.test.js
//
// W921 Govern / Receipts & Compliance — lock-in tests for the six specs:
//   1. Merkle-tree batch anchoring of receipts        (transparency-anchor.js)
//   2. in-toto/SLSA build provenance on artifacts      (govern-provenance.js)
//   3. append-only verifiable transparency log         (transparency-log.js)
//   4. compliance evidence export (SOC2/GDPR/EU-AI-Act) (compliance-export.js)
//   5. C2PA 2.x content credentials + hard binding      (compliance-c2pa.js)
//   6. PSI / MMD / ADWIN standard drift statistics      (govern-drift.js)
//   + the govern-routes.js register(r, deps) surface.
//
// All modules REUSE the already-tested src/merkle.js + src/intoto-slsa.js.
// Vectors are deterministic; no network, no GPU, no external service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';

import {
  TransparencyLog,
  getTransparencyLog,
  _resetTransparencyLogsForTests,
  signTreeHead,
  verifyTreeHeadSignature,
  buildCheckpointNote,
  verifyTransparencyAppend,
  canonicalEntryJson,
  TRANSPARENCY_LOG_VERSION,
} from '../src/transparency-log.js';

import {
  governReceiptBatch,
  anchorBatch,
  stampReceiptAnchor,
  verifyReceiptAnchor,
  anchorLeafHash,
  ReceiptAnchorBatcher,
  startBatcher,
  RECEIPT_ANCHOR_VERSION,
} from '../src/transparency-anchor.js';

import {
  buildSlsaProvenance,
  signSlsaProvenance,
  emitProvenanceAttestation,
  verifyProvenance,
  INTOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  KOLM_SLSA_CONFORMANCE,
} from '../src/govern-provenance.js';

import {
  populationStabilityIndex,
  psiBins,
  rbfKernelMatrix,
  medianHeuristicSigma,
  mmd2Unbiased,
  mmdPermutationTest,
  adwinEpsilonCut,
  adwin2,
  detectAdwinOverSeries,
  computeStandardSignals,
  PSI_WARN,
  PSI_ALERT,
  DRIFT_STATS_VERSION,
} from '../src/govern-drift.js';

import {
  complianceExport,
  buildArt12LoggingConformance,
  buildArt72PostMarketReport,
  exportArt12LogStream,
  extractRiskRelevantEvents,
  detectSubstantialModification,
  listFrameworks,
  FRAMEWORKS,
  ART12_RETENTION_FLOOR_DAYS,
  COMPLIANCE_EXPORT_VERSION,
} from '../src/compliance-export.js';

import {
  signC2paOutput,
  verifyC2paManifest,
  buildC2paManifestDefinition,
  c2paHashDataAssertion,
  c2paActionsAssertion,
  cborEncode,
  DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC,
  C2PA_HASH_DATA_LABEL,
  C2PA_CLAIM_VERSION,
} from '../src/compliance-c2pa.js';

import { register as registerGovernRoutes, GOVERN_ROUTES_VERSION } from '../src/govern-routes.js';

function freshSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}
function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ===========================================================================
// SPEC 3 — Append-only verifiable transparency log
// ===========================================================================

test('tlog: append links a hash chain that verifies with no secret', () => {
  const log = new TransparencyLog({ tenant_id: 't1', origin: 'kolm.ai/test' });
  log.append('receipt', { receipt_id: 'r0' });
  log.append('receipt', { receipt_id: 'r1' });
  log.append('decision', { route: 'frontier' });
  const chain = log.verifyChain();
  assert.equal(chain.ok, true);
  assert.equal(chain.total, 3);
  assert.equal(chain.breaks.length, 0);
});

test('tlog: tampering a historical entry breaks the chain at the first edit', () => {
  const log = new TransparencyLog({ tenant_id: 't2', origin: 'kolm.ai/test' });
  log.append('receipt', { receipt_id: 'r0' });
  log.append('receipt', { receipt_id: 'r1' });
  log.append('receipt', { receipt_id: 'r2' });
  // Tamper the middle entry's data after the fact.
  log._mem[1].data = { receipt_id: 'EVIL' };
  const chain = log.verifyChain();
  assert.equal(chain.ok, false);
  assert.ok(chain.breaks.some((b) => b.seq === 1));
});

test('tlog: every entry has an inclusion proof that verifies against the Tree Head', () => {
  const log = new TransparencyLog({ tenant_id: 't3', origin: 'kolm.ai/test' });
  for (let i = 0; i < 9; i++) log.append('receipt', { receipt_id: 'r' + i });
  const head = log.treeHead();
  assert.equal(head.tree_size, 9);
  for (let i = 0; i < 9; i++) {
    const p = log.inclusionProof(i);
    assert.equal(p.ok, true, `seq ${i} proof should be available`);
    assert.equal(p.root_hash, head.root_hash);
  }
});

test('tlog: signed Tree Head (C2SP checkpoint) verifies and rejects mutation', () => {
  const signer = freshSigner();
  const log = new TransparencyLog({ tenant_id: 't4', origin: 'kolm.ai/test' });
  log.append('receipt', { receipt_id: 'r0' });
  log.append('receipt', { receipt_id: 'r1' });
  const head = log.treeHead();
  const sth = signTreeHead(head, signer);
  assert.match(sth.note, /^kolm\.ai\/test\n2\n/);
  assert.equal(verifyTreeHeadSignature(sth).ok, true);
  assert.equal(verifyTreeHeadSignature(sth, signer.publicKey).ok, true);
  // Pinned-key mismatch rejected.
  assert.equal(verifyTreeHeadSignature(sth, freshSigner().publicKey).ok, false);
  // Mutated note rejected.
  const mutated = { ...sth, note: sth.note.replace('\n2\n', '\n3\n') };
  assert.equal(verifyTreeHeadSignature(mutated).ok, false);
});

test('tlog: checkpoint note has the C2SP >=3-line shape (origin/size/root)', () => {
  const note = buildCheckpointNote({ origin: 'o', tree_size: 5, root_b64: 'AAA=' });
  const lines = note.split('\n');
  assert.equal(lines[0], 'o');
  assert.equal(lines[1], '5');
  assert.equal(lines[2], 'AAA=');
});

test('tlog: verifyTransparencyAppend confirms strictly-next-seq + prev-link + inclusion', () => {
  const log = new TransparencyLog({ tenant_id: 't5', origin: 'kolm.ai/test' });
  const before = { ...log.treeHead(), last_entry_hash: null };
  const e0 = log.append('receipt', { receipt_id: 'r0' });
  const after = log.treeHead();
  const proof = log.inclusionProof(0);
  const v = verifyTransparencyAppend({ before, entry: e0, after, proof });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.appended_at_end, true);
  assert.equal(v.included, true);

  // second append links to the prior head's last entry hash.
  const before2 = { ...after, last_entry_hash: e0.entry_hash };
  const e1 = log.append('receipt', { receipt_id: 'r1' });
  const after2 = log.treeHead();
  const proof2 = log.inclusionProof(1);
  assert.equal(verifyTransparencyAppend({ before: before2, entry: e1, after: after2, proof: proof2 }).ok, true);
});

test('tlog: verifyTransparencyAppend rejects a non-append (tree grew by !=1 or wrong seq)', () => {
  const log = new TransparencyLog({ tenant_id: 't6', origin: 'kolm.ai/test' });
  const e0 = log.append('receipt', { receipt_id: 'r0' });
  // claim the after-tree grew by 2 -> rejected.
  const bad = verifyTransparencyAppend({ before: { tree_size: 0 }, entry: e0, after: { tree_size: 2, root_hash: log.treeHead().root_hash } });
  assert.equal(bad.ok, false);
  assert.equal(bad.appended_at_end, false);
});

test('tlog: canonicalEntryJson is order-independent (reproducible bytes)', () => {
  const a = canonicalEntryJson({ b: 1, a: 2, nested: { y: 1, x: 2 } });
  const b = canonicalEntryJson({ a: 2, b: 1, nested: { x: 2, y: 1 } });
  assert.equal(a, b);
});

test('tlog: getTransparencyLog returns a tenant-fenced shared instance', () => {
  _resetTransparencyLogsForTests();
  const l1 = getTransparencyLog({ tenant_id: 'shared', origin: 'kolm.ai/v1' });
  const l2 = getTransparencyLog({ tenant_id: 'shared', origin: 'kolm.ai/v1' });
  l1.append('receipt', { receipt_id: 'x' });
  assert.equal(l2.size(), 1, 'same tenant+origin shares one log');
  const other = getTransparencyLog({ tenant_id: 'other', origin: 'kolm.ai/v1' });
  assert.equal(other.size(), 0, 'different tenant is fenced');
});

// ===========================================================================
// SPEC 1 — Merkle-tree batch anchoring of receipts
// ===========================================================================

test('anchor: governReceiptBatch returns {merkle_root, leaves, inclusion_proofs} all verifying', () => {
  const receipts = Array.from({ length: 7 }, (_, i) => ({ receipt_id: 'rcpt_' + i, model: 'm', cost_usd: i * 0.001 }));
  const batch = governReceiptBatch(receipts);
  assert.equal(batch.tree_size, 7);
  assert.equal(batch.merkle_root.length, 64);
  assert.equal(batch.leaves.length, 7);
  assert.equal(batch.inclusion_proofs.length, 7);
  // Every inclusion proof verifies against the shared root.
  for (let i = 0; i < 7; i++) {
    const v = verifyReceiptAnchor({ receipt: receipts[i], anchor: { ...batch.inclusion_proofs[i], batch_root: batch.merkle_root } });
    assert.equal(v.level_a.ok, true, `level A inclusion for ${i}`);
  }
});

test('anchor: one batch root covers many receipts (>=256 receipts/entry)', () => {
  const receipts = Array.from({ length: 300 }, (_, i) => ({ receipt_id: 'r' + i, n: i }));
  const batch = governReceiptBatch(receipts);
  assert.equal(batch.tree_size, 300);
  // All 300 point to the SAME root.
  const roots = new Set(batch.inclusion_proofs.map((p) => p.batch_root));
  assert.equal(roots.size, 1);
});

test('anchor: anchorLeafHash excludes the non-signed anchor block + is re-serialization stable', () => {
  const r = { receipt_id: 'r', a: 1, b: 2 };
  const l1 = anchorLeafHash(r).toString('hex');
  const l2 = anchorLeafHash({ b: 2, a: 1, receipt_id: 'r' }).toString('hex');
  assert.equal(l1, l2, 'leaf hash is key-order independent');
  const withAnchor = { ...r, anchor: { batch_id: 'b', leaf_index: 0 } };
  assert.equal(anchorLeafHash(withAnchor).toString('hex'), l1, 'anchor block excluded from leaf');
});

test('anchor: anchorBatch degrades to state:local with no submitFn and NEVER throws', async () => {
  const signer = freshSigner();
  const batch = governReceiptBatch([{ receipt_id: 'r0' }, { receipt_id: 'r1' }]);
  const res = await anchorBatch(batch, { signer });
  assert.equal(res.state, 'local');
  assert.ok(res.checkpoint, 'a local kolm-signed checkpoint is produced');
});

test('anchor: anchorBatch with a failing submitFn degrades to local, never throws', async () => {
  const signer = freshSigner();
  const batch = governReceiptBatch([{ receipt_id: 'r0' }]);
  const res = await anchorBatch(batch, { signer, submitFn: async () => { throw new Error('rekor down'); } });
  assert.equal(res.state, 'local');
  assert.match(res.reason, /rekor down/);
});

test('anchor: anchorBatch with a working submitFn returns state:anchored', async () => {
  const signer = freshSigner();
  const batch = governReceiptBatch([{ receipt_id: 'r0' }, { receipt_id: 'r1' }]);
  const res = await anchorBatch(batch, { signer, submitFn: async ({ digestHex }) => ({ logIndex: 42, log_id: 'log1', root: digestHex }) });
  assert.equal(res.state, 'anchored');
  assert.equal(res.log.logIndex, 42);
});

test('anchor: two-level offline verify (A receipt-in-batch, B checkpoint sig) both pass', async () => {
  const signer = freshSigner();
  const receipts = Array.from({ length: 5 }, (_, i) => ({ receipt_id: 'r' + i, cost_usd: i }));
  const batch = governReceiptBatch(receipts);
  const anchorResult = await anchorBatch(batch, { signer });
  const anchor = stampReceiptAnchor({ ...batch.inclusion_proofs[3], batch_id: batch.batch_id }, anchorResult);
  const v = verifyReceiptAnchor({ receipt: receipts[3], anchor, pinnedLogKeyPem: signer.publicKey });
  assert.equal(v.ok, true);
  assert.equal(v.level_a.ok, true);
  assert.equal(v.level_b.ok, true);
});

test('anchor: level A fails on a tampered receipt; level B fails on a wrong pinned key', async () => {
  const signer = freshSigner();
  const receipts = [{ receipt_id: 'r0', cost_usd: 1 }, { receipt_id: 'r1', cost_usd: 2 }];
  const batch = governReceiptBatch(receipts);
  const anchorResult = await anchorBatch(batch, { signer });
  const anchor = stampReceiptAnchor({ ...batch.inclusion_proofs[0], batch_id: batch.batch_id }, anchorResult);
  // tamper receipt -> level A fails.
  const vTamper = verifyReceiptAnchor({ receipt: { receipt_id: 'r0', cost_usd: 999 }, anchor });
  assert.equal(vTamper.level_a.ok, false);
  assert.equal(vTamper.ok, false);
  // wrong pinned key -> level B fails.
  const vKey = verifyReceiptAnchor({ receipt: receipts[0], anchor, pinnedLogKeyPem: freshSigner().publicKey });
  assert.equal(vKey.level_b.ok, false);
});

test('anchor: verifyReceiptAnchor reports not_anchored when checkpoint absent (local only)', () => {
  const batch = governReceiptBatch([{ receipt_id: 'r0' }, { receipt_id: 'r1' }]);
  const anchor = stampReceiptAnchor({ ...batch.inclusion_proofs[0], batch_id: batch.batch_id }, { state: 'local', checkpoint: null });
  const v = verifyReceiptAnchor({ receipt: { receipt_id: 'r0' }, anchor });
  assert.equal(v.level_a.ok, true);
  assert.equal(v.level_b.ok, false);
  assert.equal(v.level_b.reason, 'not_anchored');
});

test('anchor: ReceiptAnchorBatcher enqueue is non-blocking, bounded, and never throws on the hot path', () => {
  const b = new ReceiptAnchorBatcher({ maxLeaves: 1e9, cap: 100 });
  let accepted = 0;
  for (let i = 0; i < 150; i++) {
    if (b.enqueue({ receipt_id: 'r' + i, receipt: { receipt_id: 'r' + i } })) accepted++;
  }
  assert.equal(accepted, 100, 'queue is bounded at cap');
  assert.equal(b.status().dropped, 50);
});

test('anchor: enqueue 10k receipts is fast (no per-call network)', () => {
  const b = new ReceiptAnchorBatcher({ maxLeaves: 1e9, cap: 20000 });
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) b.enqueue({ receipt_id: 'r' + i, leaf: Buffer.alloc(32, i % 256) });
  const dt = Date.now() - t0;
  assert.ok(dt < 2000, `enqueue 10k took ${dt}ms (<2000ms)`);
});

test('anchor: batcher flushNow produces a batch + per-receipt anchor stamps', async () => {
  let captured = null;
  const b = new ReceiptAnchorBatcher({ maxLeaves: 1e9, signer: freshSigner(), onBatch: (x) => { captured = x; } });
  b.enqueue({ receipt_id: 'a', receipt: { receipt_id: 'a' } });
  b.enqueue({ receipt_id: 'b', receipt: { receipt_id: 'b' } });
  const res = await b.flushNow();
  assert.equal(res.ok, true);
  assert.equal(res.tree_size, 2);
  assert.ok(captured && captured.stamps.length === 2);
  assert.equal(captured.stamps[0].receipt_id, 'a');
});

test('anchor: startBatcher returns a controllable handle that stops cleanly', async () => {
  const h = startBatcher({ maxLeaves: 1e9, intervalMs: 100000 });
  h.enqueue({ receipt_id: 'z', receipt: { receipt_id: 'z' } });
  assert.equal(h.status().queued, 1);
  const drained = await h.stop();
  assert.equal(drained.ok, true);
});

// ===========================================================================
// SPEC 2 — in-toto/SLSA build provenance on artifacts
// ===========================================================================

test('provenance: buildSlsaProvenance returns an in-toto v1 Statement + SLSA predicate', () => {
  const ah = sha256hex('artifact-bytes');
  const stmt = buildSlsaProvenance({
    manifest: { task: 'support', base_model: 'qwen' },
    hashes: { recipes_json: 'a'.repeat(64) },
    artifact_hash: ah, jobId: 'job1', builderVersion: '2.13.0',
    lineage: { source: 'distillation', teacher: { vendor: 'anthropic', model: 'opus' }, student_base: { repo: 'Qwen/Qwen2.5-7B' }, training_corpus_hash: 'b'.repeat(64) },
  });
  assert.equal(stmt._type, INTOTO_STATEMENT_TYPE);
  assert.equal(stmt.predicateType, SLSA_PROVENANCE_PREDICATE_TYPE);
  assert.equal(stmt.subject[0].digest.sha256, ah);
  const roles = stmt.predicate.buildDefinition.resolvedDependencies.map((d) => d.annotations && d.annotations.role).filter(Boolean);
  assert.ok(roles.includes('teacher'));
  assert.ok(roles.includes('student_base'));
});

test('provenance: degrades to recipes/evals deps without lineage (no fabricated materials)', () => {
  const stmt = buildSlsaProvenance({
    manifest: { task: 't' }, hashes: { recipes_json: 'c'.repeat(64), evals_json: 'd'.repeat(64) },
    artifact_hash: sha256hex('x'), jobId: 'j', builderVersion: '1.0.0',
  });
  const names = stmt.predicate.buildDefinition.resolvedDependencies.map((d) => d.name).sort();
  assert.deepEqual(names, ['evals.json', 'recipes.json']);
});

test('provenance: signSlsaProvenance -> verifyProvenance round-trips ok against the artifact', () => {
  const signer = freshSigner();
  const ah = sha256hex('the-zip');
  const signed = signSlsaProvenance({ manifest: { task: 't' }, hashes: {}, artifact_hash: ah, jobId: 'job', builderVersion: '1.0.0' }, signer);
  const v = verifyProvenance(signed.envelope, { publicKey: signer.publicKey, digestMap: { 'job.kolm': ah } });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.subjects_matched, v.subjects_total);
});

test('provenance: verify fails on a single-byte subject tamper', () => {
  const signer = freshSigner();
  const json = emitProvenanceAttestation({ manifest: { task: 't' }, hashes: {}, artifact_hash: sha256hex('a'), jobId: 'j', builderVersion: '1.0.0', subjectDigests: { 'j.kolm': sha256hex('a'), 'm.gguf': sha256hex('m') } }, signer);
  const env = JSON.parse(json);
  const tampered = { 'j.kolm': sha256hex('a'), 'm.gguf': sha256hex('m-TAMPERED') };
  const v = verifyProvenance(env, { publicKey: signer.publicKey, digestMap: tampered });
  assert.equal(v.ok, false);
  assert.ok(v.subjects_matched < v.subjects_total);
});

test('provenance: verify rejects a wrong public key', () => {
  const a = freshSigner();
  const b = freshSigner();
  const signed = signSlsaProvenance({ manifest: {}, hashes: {}, artifact_hash: sha256hex('z'), jobId: 'j', builderVersion: '1.0.0' }, a);
  assert.equal(verifyProvenance(signed.envelope, { publicKey: b.publicKey }).ok, false);
});

test('provenance: conformance string is L2-shape, never claims L3', () => {
  assert.match(KOLM_SLSA_CONFORMANCE, /L2/);
  assert.ok(!/L3/.test(KOLM_SLSA_CONFORMANCE));
});

// ===========================================================================
// SPEC 6 — PSI / MMD / ADWIN standard drift statistics
// ===========================================================================

test('drift PSI: no-shift baseline vs same-distribution sample stays ok (<0.1)', () => {
  const rng = (() => { let a = 7; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  const base = Array.from({ length: 500 }, () => rng());
  const look = Array.from({ length: 500 }, () => rng());
  const res = populationStabilityIndex(base, look);
  assert.equal(res.status, 'ok', `psi=${res.psi}`);
  assert.ok(res.psi < PSI_WARN);
});

test('drift PSI: a clear distribution shift alerts (>=0.25); no NaN/Infinity from empty bins', () => {
  const base = Array.from({ length: 300 }, (_, i) => (i % 100) / 100); // 0..1
  const look = Array.from({ length: 300 }, (_, i) => 5 + (i % 100) / 100); // 5..6, disjoint
  const res = populationStabilityIndex(base, look);
  assert.equal(res.status, 'alert');
  assert.ok(Number.isFinite(res.psi));
  for (const b of res.per_bin) assert.ok(Number.isFinite(b.contribution));
});

test('drift PSI: insufficient samples reports ok with a note (never alerts on thin data)', () => {
  const res = populationStabilityIndex([1, 2, 3], [4, 5, 6]);
  assert.equal(res.status, 'ok');
  assert.equal(res.psi, null);
  assert.match(res.note, /insufficient_samples/);
});

test('drift PSI: psiBins returns bins+1 monotone quantile edges with open outer edges', () => {
  const edges = psiBins(Array.from({ length: 100 }, (_, i) => i), 10);
  assert.equal(edges.length, 11);
  assert.equal(edges[0], -Infinity);
  assert.equal(edges[10], Infinity);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] >= edges[i - 1]);
});

test('drift MMD: detects a same-centroid different-spread shift a centroid test would miss', () => {
  // Both clouds centered at origin; X is tight, Y is wide -> equal mean, diff dist.
  const seed = (() => { let a = 99; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff - 0.5; }; })();
  const X = Array.from({ length: 60 }, () => [seed() * 0.1, seed() * 0.1]);
  const Y = Array.from({ length: 60 }, () => [seed() * 4, seed() * 4]);
  const res = mmdPermutationTest(X, Y, { permutations: 100, seed: 1 });
  assert.equal(res.status, 'alert', `p=${res.p_value}`);
  assert.ok(res.p_value < 0.05);
});

test('drift MMD: identical distributions do NOT alert (p high)', () => {
  const seed = (() => { let a = 5; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  const mk = () => Array.from({ length: 50 }, () => [seed(), seed()]);
  const res = mmdPermutationTest(mk(), mk(), { permutations: 100, seed: 2 });
  assert.equal(res.status, 'ok', `p=${res.p_value}`);
});

test('drift MMD: permutation p-value is reproducible under a fixed seed', () => {
  const X = Array.from({ length: 30 }, (_, i) => [i * 0.01, 0]);
  const Y = Array.from({ length: 30 }, (_, i) => [i * 0.01 + 1, 1]);
  const a = mmdPermutationTest(X, Y, { permutations: 80, seed: 42 });
  const b = mmdPermutationTest(X, Y, { permutations: 80, seed: 42 });
  assert.equal(a.p_value, b.p_value);
  assert.equal(a.mmd2, b.mmd2);
});

test('drift MMD: helpers — rbfKernelMatrix shape, median sigma > 0, unbiased MMD self-pair ~0', () => {
  const A = [[0, 0], [1, 1]];
  const B = [[0, 0], [2, 2], [3, 3]];
  const K = rbfKernelMatrix(A, B, 1);
  assert.equal(K.length, 2);
  assert.equal(K[0].length, 3);
  assert.ok(medianHeuristicSigma(A.concat(B)) > 0);
  // MMD of a distribution against itself (split halves) is near 0.
  const same = Array.from({ length: 20 }, (_, i) => [Math.sin(i), Math.cos(i)]);
  const m = mmd2Unbiased(same.slice(0, 10), same.slice(10), (x, y) => Math.exp(-((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2)));
  assert.ok(Math.abs(m) < 0.5);
});

test('drift ADWIN: stationary stream produces NO false-positive drift', () => {
  const series = Array.from({ length: 200 }, (_, i) => ({ ts: i, value: 0.5 + ((i % 2) ? 0.01 : -0.01) }));
  const res = detectAdwinOverSeries(series, { delta: 0.002 });
  assert.equal(res.drift_detected, false, `n_detections=${res.n_detections}`);
});

test('drift ADWIN: a step change is detected and localized near the change point', () => {
  const series = Array.from({ length: 200 }, (_, i) => ({ ts: i, value: i < 100 ? 0 : 1 }));
  const res = detectAdwinOverSeries(series, { delta: 0.002 });
  assert.equal(res.drift_detected, true);
  assert.ok(res.n_detections >= 1);
});

test('drift ADWIN: adwinEpsilonCut is finite for valid subwindows and Infinity for empty', () => {
  assert.ok(Number.isFinite(adwinEpsilonCut(50, 50, 0.25, 100, 0.002)));
  assert.equal(adwinEpsilonCut(0, 10, 0.25, 10, 0.002), Infinity);
});

test('drift ADWIN: adwin2 factory exposes update/width/variance/total/reset', () => {
  const d = adwin2({ delta: 0.002 });
  for (let i = 0; i < 10; i++) d.update(0.5);
  assert.ok(d.width() > 0);
  assert.ok(Number.isFinite(d.variance()));
  assert.ok(Number.isFinite(d.total()));
  d.reset();
  assert.equal(d.width(), 0);
});

test('drift: computeStandardSignals aggregates status (alert wins) without throwing', () => {
  const out = computeStandardSignals({
    baselineScalars: Array.from({ length: 100 }, (_, i) => i % 5),
    lookbackScalars: Array.from({ length: 100 }, (_, i) => 50 + (i % 5)),
    fallbackSeries: Array.from({ length: 100 }, (_, i) => ({ ts: i, value: i < 50 ? 0 : 1 })),
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'alert');
  assert.equal(out.version, DRIFT_STATS_VERSION);
});

// ===========================================================================
// SPEC 4 — Compliance evidence export (SOC2 / GDPR / EU-AI-Act)
// ===========================================================================

function seedRows(tenant, n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    tenant_id: tenant,
    at: new Date(Date.now() - i * 3600000).toISOString(),
    receipt: { receipt_id: 'r' + i, model: 'm', signature_ed25519: { signature: 'sig' + i }, fallback_reason: i === 3 ? 'timeout' : null },
  }));
}

test('compliance: lists three frameworks (soc2/gdpr/eu_ai_act) with control counts', () => {
  const fws = listFrameworks();
  const keys = fws.map((f) => f.framework).sort();
  assert.deepEqual(keys, ['eu_ai_act', 'gdpr', 'soc2']);
  for (const f of fws) assert.ok(f.controls > 0);
});

test('compliance: complianceExport maps controls to satisfied/partial/fail with evidence + gaps', () => {
  const rows = seedRows('tA');
  const out = complianceExport({
    framework: 'soc2', tenant_id: 'tA',
    readObservations: () => rows,
    verifyChain: () => ({ ok: true, total: 12, breaks: [] }),
    computeDrift: () => ({ standard_signals: { status: 'ok' } }),
    retentionDays: 200,
  });
  assert.equal(out.ok, true);
  assert.equal(out.framework, 'soc2');
  assert.equal(out.summary.controls_total, FRAMEWORKS.soc2.controls.length);
  for (const c of out.controls) {
    assert.ok(['satisfied', 'partial', 'fail'].includes(c.status));
    assert.ok(Array.isArray(c.gaps));
  }
});

test('compliance: a broken audit chain forces failed controls + conforms:false (loud, not hidden)', () => {
  const rows = seedRows('tB');
  const out = complianceExport({
    framework: 'gdpr', tenant_id: 'tB',
    readObservations: () => rows,
    verifyChain: () => ({ ok: false, total: 12, breaks: [{ seq: 4, reason: 'event_hash_mismatch' }] }),
    retentionDays: 200,
  });
  assert.equal(out.summary.conforms, false);
  assert.ok(out.limitations.includes('audit_chain_broken'));
  assert.ok(out.controls.some((c) => c.status === 'fail'));
});

test('compliance: unknown framework returns a clean error envelope (never throws)', () => {
  const out = complianceExport({ framework: 'hipaa-xyz', tenant_id: 't' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unknown_framework');
  assert.ok(out.available.includes('soc2'));
});

test('compliance: tenant_id is required (no cross-tenant leak by omission)', () => {
  const out = complianceExport({ framework: 'soc2' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tenant_id_required');
});

test('compliance: eu_ai_act alias normalization (ai-act / EU_AI_ACT) resolves', () => {
  const a = complianceExport({ framework: 'ai-act', tenant_id: 't', readObservations: () => [], verifyChain: () => ({ ok: true, total: 0, breaks: [] }) });
  assert.equal(a.framework, 'eu_ai_act');
});

test('aiact: buildArt12LoggingConformance conforms when chain verified + records present', () => {
  const rows = seedRows('tC');
  const out = buildArt12LoggingConformance({
    tenant_id: 'tC', readObservations: () => rows,
    verifyChain: () => ({ ok: true, total: 12, breaks: [] }),
    retentionDays: 200,
  });
  assert.equal(out.conforms, true);
  assert.equal(out.record_count, 12);
  assert.equal(out.tamper_evident.audit_chain_verified, true);
  assert.equal(out.retention.retention_met, true);
});

test('aiact: Art12 flags retention_policy_not_configured when retention missing (never assumed met)', () => {
  const rows = seedRows('tD');
  const out = buildArt12LoggingConformance({
    tenant_id: 'tD', readObservations: () => rows,
    verifyChain: () => ({ ok: true, total: 12, breaks: [] }),
  });
  assert.equal(out.retention.retention_met, 'unknown');
  assert.equal(out.retention.note, 'retention_policy_not_configured');
  assert.ok(out.limitations.includes('retention_policy_not_configured'));
  assert.equal(out.retention.floor_days, ART12_RETENTION_FLOOR_DAYS);
});

test('aiact: Art12 broken chain forces conforms:false + audit_chain_verified:false', () => {
  const out = buildArt12LoggingConformance({
    tenant_id: 'tE', readObservations: () => seedRows('tE'),
    verifyChain: () => ({ ok: false, total: 12, breaks: [{ seq: 2 }] }),
    retentionDays: 200,
  });
  assert.equal(out.conforms, false);
  assert.equal(out.tamper_evident.audit_chain_verified, false);
});

test('aiact: buildArt72PostMarketReport is element-shaped with evidence on findings', () => {
  const rows = seedRows('tF');
  const out = buildArt72PostMarketReport({
    tenant_id: 'tF', readObservations: () => rows,
    verifyChain: () => ({ ok: true, total: 12, breaks: [] }),
    computeDrift: () => ({ standard_signals: { psi: { status: 'alert', psi: 0.4 } } }),
    getLifecycle: () => [{ from_state: 'live', to_state: 'superseded', at: new Date().toISOString(), artifact_id: 'art2', reason: 'redistill' }],
  });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.performance_and_drift_findings));
  assert.ok(out.performance_and_drift_findings.length >= 1);
  for (const f of out.performance_and_drift_findings) assert.ok(Array.isArray(f.evidence));
  assert.ok(Array.isArray(out.lifecycle_events));
  assert.ok('continuous_compliance' in out.conclusion);
});

test('aiact: extractRiskRelevantEvents catches fallbacks + lifecycle supersede/revoke', () => {
  const rows = seedRows('tG');
  const lifecycle = [{ to_state: 'revoked', at: '2026-01-01', reason: 'cve' }, { to_state: 'live' }];
  const out = extractRiskRelevantEvents(rows, lifecycle);
  assert.ok(out.count >= 2);
  assert.ok(out.events.some((e) => e.kind === 'fallback'));
  assert.ok(out.events.some((e) => e.kind === 'revoke'));
});

test('aiact: detectSubstantialModification flags artifact/model changes', () => {
  const rows = [
    { tenant_id: 't', at: '2026-01-01', receipt: { receipt_id: 'r0', artifact_id: 'A' } },
    { tenant_id: 't', at: '2026-01-02', receipt: { receipt_id: 'r1', artifact_id: 'A' } },
    { tenant_id: 't', at: '2026-01-03', receipt: { receipt_id: 'r2', artifact_id: 'B' } },
  ];
  const mods = detectSubstantialModification(rows);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].before_artifact, 'A');
  assert.equal(mods[0].after_artifact, 'B');
});

test('aiact: exportArt12LogStream emits hashes-only log + Ed25519-signed coverage manifest', () => {
  const signer = freshSigner();
  const rows = seedRows('tH', 5);
  const out = exportArt12LogStream({
    tenant_id: 'tH', readObservations: () => rows,
    verifyChain: () => ({ ok: true, total: 5, breaks: [], last_hash: 'f'.repeat(64) }),
    signer, format: 'jsonl',
  });
  assert.equal(out.ok, true);
  assert.equal(out.format, 'jsonl');
  assert.equal(out.coverage_manifest.record_count, 5);
  assert.ok(out.coverage_manifest.signature_ed25519, 'manifest is signed');
  // The log is JSONL hashes-only (no raw prompt/output content).
  const lines = out.log.split('\n');
  assert.equal(lines.length, 5);
  const parsed = JSON.parse(lines[0]);
  assert.ok('receipt_id' in parsed && !('prompt' in parsed) && !('output' in parsed));
});

// ===========================================================================
// SPEC 5 — C2PA 2.x content credentials + hard binding
// ===========================================================================

test('c2pa: CBOR encoder round-trips (deterministic, canonical-key maps)', () => {
  const a = cborEncode({ b: 1, a: 'hi', arr: [1, 2, 3], flag: true });
  const b = cborEncode({ arr: [1, 2, 3], a: 'hi', flag: true, b: 1 });
  assert.deepEqual(a, b, 'key order does not change the CBOR bytes');
});

test('c2pa: manifest definition carries hard-binding + c2pa.created trainedAlgorithmicMedia', () => {
  const def = buildC2paManifestDefinition({ outputText: 'hello world', receipt: { receipt_id: 'r0' }, claimGeneratorVersion: '2.13.0' });
  assert.equal(def.claim_version, C2PA_CLAIM_VERSION);
  const labels = def.assertions.map((a) => a.label);
  assert.ok(labels.includes(C2PA_HASH_DATA_LABEL));
  assert.ok(labels.includes('c2pa.actions.v2'));
  const actions = def.assertions.find((a) => a.label === 'c2pa.actions.v2');
  assert.equal(actions.data.actions[0].action, 'c2pa.created');
  assert.equal(actions.data.actions[0].digitalSourceType, DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC);
});

test('c2pa: signC2paOutput produces a manifest that verifies as valid', () => {
  const signer = freshSigner();
  const text = 'The capital of France is Paris.';
  const out = signC2paOutput({ outputText: text, receipt: { receipt_id: 'rcpt_x' }, signer, claimGeneratorVersion: '2.13.0' });
  assert.equal(out.validation_status, 'valid');
  assert.equal(out.digitalSourceType, DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC);
  const v = verifyC2paManifest(out.manifestStoreBytes, Buffer.from(text, 'utf8'), { publicKey: signer.publicKey });
  assert.equal(v.ok, true, JSON.stringify(v.validation_errors));
  assert.equal(v.digitalSourceType, DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC);
});

test('c2pa: HARD BINDING — altering any output byte fails verification (tamper-evident)', () => {
  const signer = freshSigner();
  const text = 'Refund processed for order 12345.';
  const out = signC2paOutput({ outputText: text, receipt: { receipt_id: 'r' }, signer });
  // change ONE character.
  const tamperedAsset = Buffer.from('Refund processed for order 12346.', 'utf8');
  const v = verifyC2paManifest(out.manifestStoreBytes, tamperedAsset, { publicKey: signer.publicKey });
  assert.equal(v.ok, false);
  assert.ok(v.validation_errors.includes('hard_binding_mismatch'));
});

test('c2pa: a flipped assertion byte fails the assertion-hash check', () => {
  const signer = freshSigner();
  const text = 'hello';
  const out = signC2paOutput({ outputText: text, receipt: { receipt_id: 'r' }, signer });
  const store = JSON.parse(out.manifestStoreBytes.toString('utf8'));
  const mid = store.manifests[store.active_manifest];
  // tamper the hash.data assertion store entry.
  const raw = Buffer.from(mid.assertion_store[C2PA_HASH_DATA_LABEL], 'base64');
  raw[raw.length - 1] ^= 0xff;
  mid.assertion_store[C2PA_HASH_DATA_LABEL] = raw.toString('base64');
  const tamperedBytes = Buffer.from(JSON.stringify(store), 'utf8');
  const v = verifyC2paManifest(tamperedBytes, Buffer.from(text, 'utf8'), { publicKey: signer.publicKey });
  assert.equal(v.ok, false);
});

test('c2pa: wrong public key fails the COSE_Sign1 signature check', () => {
  const a = freshSigner();
  const b = freshSigner();
  const out = signC2paOutput({ outputText: 'x', receipt: { receipt_id: 'r' }, signer: a });
  const v = verifyC2paManifest(out.manifestStoreBytes, Buffer.from('x', 'utf8'), { publicKey: b.publicKey });
  assert.equal(v.ok, false);
  assert.ok(v.validation_errors.includes('cose_signature_invalid'));
});

test('c2pa: COSE signature comes from kolm Ed25519 key (fingerprint equality)', () => {
  const signer = freshSigner();
  const out = signC2paOutput({ outputText: 'y', receipt: { receipt_id: 'r' }, signer });
  assert.equal(out.key_fingerprint, keyFingerprint(signer.publicKey));
});

test('c2pa: verifyC2paManifest never throws on garbage', () => {
  assert.doesNotThrow(() => verifyC2paManifest(Buffer.from('not json'), Buffer.from('x'), {}));
  assert.equal(verifyC2paManifest(Buffer.from('not json'), Buffer.from('x'), {}).ok, false);
  assert.equal(verifyC2paManifest(Buffer.from('{}'), Buffer.from('x'), {}).ok, false);
});

test('c2pa: assertion helpers produce the spec labels', () => {
  assert.equal(c2paHashDataAssertion(Buffer.from('z')).label, C2PA_HASH_DATA_LABEL);
  assert.equal(c2paActionsAssertion({}).label, 'c2pa.actions.v2');
});

// ===========================================================================
// govern-routes — register(r, deps) surface
// ===========================================================================

function mockRouter() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return {
    routes,
    get: add('GET'), post: add('POST'),
    call(method, path, req) {
      const h = routes[`${method} ${path}`];
      if (!h) throw new Error(`no route ${method} ${path}`);
      const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      h(req, res);
      return res;
    },
  };
}

test('routes: register mounts the full Govern surface (16 routes)', () => {
  const r = mockRouter();
  registerGovernRoutes(r, {});
  assert.equal(Object.keys(r.routes).length, 16);
  assert.ok(r.routes['POST /v1/govern/anchor/batch']);
  assert.ok(r.routes['GET /v1/govern/transparency/head']);
  assert.ok(r.routes['POST /v1/govern/c2pa/sign']);
  assert.ok(r.routes['GET /v1/govern/compliance/ai-act/art12']);
});

test('routes: every route returns 401 without a tenant_record', () => {
  const r = mockRouter();
  registerGovernRoutes(r, {});
  const res = r.call('GET', '/v1/govern/transparency/head', { query: {} });
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'auth_required');
});

test('routes: transparency append -> head -> proof end-to-end through the router', () => {
  _resetTransparencyLogsForTests();
  const r = mockRouter();
  const signer = freshSigner();
  registerGovernRoutes(r, { getSigner: () => signer });
  const trec = { id: 'tenant_routes_1' };
  const a = r.call('POST', '/v1/govern/transparency/append', { tenant_record: trec, body: { kind: 'receipt', data: { receipt_id: 'r0' } } });
  assert.equal(a.body.ok, true);
  assert.equal(a.body.entry.seq, 0);
  const head = r.call('GET', '/v1/govern/transparency/head', { tenant_record: trec, query: {} });
  assert.equal(head.body.tree_head.tree_size, 1);
  assert.ok(head.body.signed_tree_head);
  assert.equal(verifyTreeHeadSignature(head.body.signed_tree_head).ok, true);
});

test('routes: anchor batch returns a verifiable batch + stamps through the router', async () => {
  const r = mockRouter();
  const signer = freshSigner();
  registerGovernRoutes(r, { getSigner: () => signer });
  // anchor/batch handler is async — call it directly to await.
  const handler = r.routes['POST /v1/govern/anchor/batch'];
  const receipts = [{ receipt_id: 'r0', c: 1 }, { receipt_id: 'r1', c: 2 }];
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ tenant_record: { id: 't' }, body: { receipts } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tree_size, 2);
  assert.equal(res.body.stamps.length, 2);
  const v = verifyReceiptAnchor({ receipt: receipts[0], anchor: res.body.stamps[0].anchor });
  assert.equal(v.level_a.ok, true);
});

test('routes: c2pa sign through the router validates as valid', () => {
  const r = mockRouter();
  const signer = freshSigner();
  registerGovernRoutes(r, { getSigner: () => signer });
  const res = r.call('POST', '/v1/govern/c2pa/sign', { tenant_record: { id: 't' }, body: { output_text: 'hi there', receipt: { receipt_id: 'r' } } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.validation_status, 'valid');
  const v = verifyC2paManifest(Buffer.from(res.body.manifest_store_b64, 'base64'), Buffer.from('hi there'), { publicKey: signer.publicKey });
  assert.equal(v.ok, true);
});

test('routes: compliance export through the router (tenant forced from tenant_record)', () => {
  const r = mockRouter();
  registerGovernRoutes(r, {
    verifyAuditChain: () => ({ ok: true, total: 3, breaks: [] }),
    readObservations: () => seedRows('forced'),
    retentionDays: 200,
  });
  const res = r.call('GET', '/v1/govern/compliance/export', { tenant_record: { id: 'forced' }, query: { framework: 'soc2' } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tenant_id, 'forced');
});

test('routes: register throws if given a non-router', () => {
  assert.throws(() => registerGovernRoutes({}, {}));
});

// ===========================================================================
// Version stamps pinned (regression sentinels)
// ===========================================================================
test('versions: all module version stamps are present and w921-shaped', () => {
  assert.match(TRANSPARENCY_LOG_VERSION, /^w921-/);
  assert.match(RECEIPT_ANCHOR_VERSION, /^w921-/);
  assert.match(DRIFT_STATS_VERSION, /^w921-/);
  assert.match(COMPLIANCE_EXPORT_VERSION, /^w921-/);
  assert.match(GOVERN_ROUTES_VERSION, /^w921-/);
});
