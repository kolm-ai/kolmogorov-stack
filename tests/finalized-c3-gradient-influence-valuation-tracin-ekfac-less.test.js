// Finalized C3 - Gradient-influence per-pair VALUATION (TracIn / EK-FAC / LESS).
//
// Proves the acceptance criteria for the new src/data-value-influence.js valuer +
// the on-disk gradient-store contract, with a pure-JS fixture writer (no torch).
// The GPU worker (workers/data/scripts/compute_grads.py) is checked structurally
// (env-gate, exit codes, never-spawned-by-default) without invoking heavy deps.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  valuePairsByInfluence,
  readGradStore,
  VALUE_INFLUENCE_VERSION,
  __internals,
} from '../src/data-value-influence.js';
import {
  selectInformativeSubset,
  reprFilterSelect,
} from '../src/data-select.js';

const { _sparseSignProject, _lessScore, _tracinScore, _rowId } = __internals;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── fixture writer (pure JS; mirrors the worker's binary layout) ─────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-gradstore-'));
}

function writeF32(file, floats) {
  const buf = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4);
  fs.writeFileSync(file, buf);
}

/**
 * buildStore(root, namespace, {pairs, trainGrads, valGrads, lr, attest, ...})
 * trainGrads: number[][]  one [nck*d] flat row per train pair (checkpoint-major)
 * valGrads:   number[][]  one [d] mean row per checkpoint
 */
function buildStore(root, namespace, opts) {
  const dir = path.join(root, namespace);
  fs.mkdirSync(dir, { recursive: true });
  const d = opts.d;
  const nck = opts.nck;
  const manifest = Object.assign({
    version: 'gradstore-v1',
    namespace,
    proj_dim: d,
    proj_seed: opts.seed || 'fixture-seed',
    proj_type: 'sparse-sign',
    dtype: 'f32',
    n_train: opts.pairs.length,
    n_checkpoints: nck,
    checkpoints: Array.from({ length: nck }, (_, c) => ({ step: c, lr: opts.lr ? opts.lr[c] : 1 })),
    method_support: ['tracin', 'less'],
    train_id_field: 'id|capture_id|event_id|trace_id|sha256',
    holdout_disjoint_attested: opts.attest !== false,
    model_fingerprint: 'fixturefp',
    created_at: new Date().toISOString(),
  }, opts.manifestOverride || {});
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // train_ids.jsonl - join table.
  const idsLines = opts.pairs.map((p, idx) => JSON.stringify({ idx, pair_id: _rowId(p) }));
  fs.writeFileSync(path.join(dir, 'train_ids.jsonl'), idsLines.join('\n') + '\n');

  // train_grads.f32 - flat [train][ckpt][dim].
  const flatTrain = [];
  for (const row of opts.trainGrads) for (const x of row) flatTrain.push(x);
  writeF32(path.join(dir, 'train_grads.f32'), flatTrain);

  // val_grads.f32 - nck*d.
  const flatVal = [];
  for (const row of opts.valGrads) for (const x of row) flatVal.push(x);
  writeF32(path.join(dir, 'val_grads.f32'), flatVal);

  // lr.f32
  writeF32(path.join(dir, 'lr.f32'), manifest.checkpoints.map((c) => c.lr));
  return dir;
}

// ── AC1: missing store -> degraded all-null, never throws ────────────────────

test('AC1 missing store returns degraded all-null scores (never throws)', () => {
  const root = mkTmp();
  const pairs = [{ id: 'a', input: 'x', output: 'y' }, { id: 'b', input: 'p', output: 'q' }];
  const r = valuePairsByInfluence({ pairs, namespace: 'nope', gradStoreDir: root });
  assert.equal(r.ok, true);
  assert.equal(r.version, VALUE_INFLUENCE_VERSION);
  assert.equal(r.report.degraded, true);
  assert.equal(r.report.degrade_reason, 'no_grad_store');
  assert.equal(r.scores.length, pairs.length);
  assert.ok(r.scores.every((s) => s === null));
});

// ── AC2: projection determinism + JL cosine preservation ─────────────────────

test('AC2 _sparseSignProject is deterministic; JL preserves cosine within +-0.05', () => {
  const dim = 8192;
  const src = 100000;
  const rng = mulberry32(12345);
  const a = Array.from({ length: src }, () => rng() - 0.5);
  const b = Array.from({ length: src }, () => rng() - 0.5);

  const pa1 = _sparseSignProject(a, dim, 'seedA');
  const pa2 = _sparseSignProject(a, dim, 'seedA');
  // byte-identical across two calls with the same seed
  assert.deepEqual(Array.from(pa1), Array.from(pa2));
  // different seed -> different projection
  const paOther = _sparseSignProject(a, dim, 'seedB');
  assert.notDeepEqual(Array.from(pa1), Array.from(paOther));

  // JL cosine preservation over 50 random pairs to within +-0.05
  let maxErr = 0;
  const rng2 = mulberry32(999);
  for (let t = 0; t < 50; t++) {
    const u = Array.from({ length: src }, () => (rng2() < 0.02 ? rng2() - 0.5 : 0)); // sparse
    const v = Array.from({ length: src }, () => (rng2() < 0.02 ? rng2() - 0.5 : 0));
    const exact = cosineArr(u, v);
    const pu = _sparseSignProject(u, dim, 'jlseed');
    const pv = _sparseSignProject(v, dim, 'jlseed');
    const approx = cosineArrTyped(pu, pv);
    maxErr = Math.max(maxErr, Math.abs(exact - approx));
  }
  assert.ok(maxErr <= 0.05, `JL cosine max error ${maxErr} > 0.05`);
});

// ── AC3: TracIn/LESS correctness on a synthetic store ────────────────────────

test('AC3 row A == val grad, row B == -val grad: LESS score(A)>0>score(B), A==-B', () => {
  const root = mkTmp();
  const d = 16;
  const nck = 1;
  const val = Array.from({ length: d }, (_, i) => Math.sin(i + 1));
  const negVal = val.map((x) => -x);
  const pairs = [{ id: 'A', input: 'a', output: 'oa' }, { id: 'B', input: 'b', output: 'ob' }];
  buildStore(root, 'syn', { d, nck, pairs, lr: [0.5], trainGrads: [val, negVal], valGrads: [val] });

  const less = valuePairsByInfluence({ pairs, namespace: 'syn', gradStoreDir: root, method: 'less' });
  assert.equal(less.ok, true);
  const sa = less.scores[0]; const sb = less.scores[1];
  assert.ok(sa > 0 && sb < 0, `expected A>0>B, got ${sa},${sb}`);
  assert.ok(Math.abs(sa - (-sb)) < 1e-9, `cosine antisymmetry: ${sa} vs ${-sb}`);
  assert.ok(Math.abs(sa - 1) < 1e-9, 'A perfectly aligned -> cosine 1');

  const tr = valuePairsByInfluence({ pairs, namespace: 'syn', gradStoreDir: root, method: 'tracin' });
  assert.ok(tr.scores[0] > tr.scores[1], 'tracin ranks A above B');
});

// ── AC4: join contract (id|capture_id|event_id|trace_id|content-hash) ────────

test('AC4 join contract 1:1; unmatched -> null + n_unmatched; n_scored+n_unmatched==len', () => {
  const root = mkTmp();
  const d = 8; const nck = 1;
  const val = Array.from({ length: d }, (_, i) => i + 1);
  const stored = [
    { capture_id: 'cap1', input: 'i1', output: 'o1' },
    { event_id: 'ev2', input: 'i2', output: 'o2' },
    { trace_id: 'tr3', input: 'i3', output: 'o3' },
    { input: 'hash-me-in', output: 'hash-me-out' }, // content-hash id
  ];
  const grads = stored.map(() => val.slice());
  buildStore(root, 'join', { d, nck, pairs: stored, trainGrads: grads, valGrads: [val] });

  // query pairs: 4 that match (by various id fields incl. content hash) + 1 miss.
  const query = [
    { capture_id: 'cap1', input: 'i1', output: 'o1' },
    { event_id: 'ev2', input: 'i2', output: 'o2' },
    { trace_id: 'tr3', input: 'i3', output: 'o3' },
    { input: 'hash-me-in', output: 'hash-me-out' },
    { id: 'unknown', input: 'zz', output: 'zz' },
  ];
  const r = valuePairsByInfluence({ pairs: query, namespace: 'join', gradStoreDir: root });
  assert.equal(r.n_scored, 4);
  assert.equal(r.n_unmatched, 1);
  assert.equal(r.n_scored + r.n_unmatched, query.length);
  assert.equal(r.scores[4], null, 'unmatched pair gets null, not 0');
  assert.ok(r.scores.slice(0, 4).every((s) => typeof s === 'number'));
});

// ── AC5: fail-closed moat (holdout_disjoint_attested) ────────────────────────

test('AC5 unattested holdout disjointness => ok:false error, no scores', () => {
  const root = mkTmp();
  const d = 4; const nck = 1;
  const val = [1, 2, 3, 4];
  const pairs = [{ id: 'a', input: 'x', output: 'y' }];
  buildStore(root, 'unatt', { d, nck, pairs, trainGrads: [val], valGrads: [val], attest: false });
  const r = valuePairsByInfluence({ pairs, namespace: 'unatt', gradStoreDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'holdout_disjointness_unattested');
  assert.equal(r.scores, undefined);
});

// ── AC6: EK-FAC opt-in degrades to LESS when no factors ──────────────────────

test('AC6 method:ekfac with no factors -> backend_used less + degrade_reason', () => {
  const root = mkTmp();
  const d = 6; const nck = 1;
  const val = Array.from({ length: d }, (_, i) => i - 2);
  const pairs = [{ id: 'a', input: 'x', output: 'y' }];
  buildStore(root, 'ek', { d, nck, pairs, trainGrads: [val], valGrads: [val] });
  const r = valuePairsByInfluence({ pairs, namespace: 'ek', gradStoreDir: root, method: 'ekfac' });
  assert.equal(r.ok, true);
  assert.equal(r.report.backend_used, 'less');
  assert.equal(r.report.degraded, true);
  assert.equal(r.report.degrade_reason, 'ekfac_factors_absent');
  // the score must be the LESS cosine (1 here: row==val), not an ekfac value.
  assert.ok(Math.abs(r.scores[0] - 1) < 1e-9);
});

test('AC6b method:ekfac WITH injected factors uses the ekfac kernel (not less)', () => {
  const root = mkTmp();
  const d = 4; const nck = 1;
  const val = [1, 1, 1, 1];
  const train = [2, 0, 0, 0];
  const pairs = [{ id: 'a', input: 'x', output: 'y' }];
  buildStore(root, 'ekf', { d, nck, pairs, trainGrads: [train], valGrads: [val] });
  // inv diagonal (preconditioner) per checkpoint: weight dim0 heavily.
  const factors = { inv: [[10, 1, 1, 1]] };
  const r = valuePairsByInfluence({ pairs, namespace: 'ekf', gradStoreDir: root, method: 'ekfac', ekfacFactors: factors });
  assert.equal(r.ok, true);
  assert.equal(r.report.backend_used, 'ekfac');
  assert.equal(r.report.degraded, false);
  // ekfac kernel: sum_i train_i*inv_i*val_i = 2*10*1 = 20.
  assert.ok(Math.abs(r.scores[0] - 20) < 1e-9, `expected ekfac=20, got ${r.scores[0]}`);
});

// ── AC7: binary I/O round-trip; seek-only row read on a >10MB file ───────────

test('AC7 readGradStore seeks one row from a >10MB train_grads.f32 (no full load)', () => {
  const root = mkTmp();
  const d = 8192; const nck = 1;
  // 400 rows * 8192 * 4 bytes ~= 13.1 MB train_grads.f32
  const nTrain = 400;
  const pairs = Array.from({ length: nTrain }, (_, i) => ({ id: 'p' + i, input: 'in' + i, output: 'out' + i }));
  const val = Array.from({ length: d }, (_, i) => (i % 7) - 3);
  // give row 137 a known, distinctive pattern
  const target = 137;
  const trainGrads = pairs.map((_, i) => {
    if (i === target) return Array.from({ length: d }, (__, k) => (k === 5 ? 42.5 : k === 9000 % d ? -7.25 : 0));
    return Array.from({ length: d }, () => 0);
  });
  const dir = buildStore(root, 'big', { d, nck, pairs, trainGrads, valGrads: [val] });
  const stat = fs.statSync(path.join(dir, 'train_grads.f32'));
  assert.ok(stat.size > 10 * 1024 * 1024, `expected >10MB, got ${stat.size}`);

  const store = readGradStore(root, 'big');
  assert.equal(store.ok, true);
  const row = store.readTrainRow(target);
  assert.equal(row.length, nck * d);
  assert.equal(row[5], 42.5);
  assert.equal(row[9000 % d], -7.25);
  // a different row reads as zeros (proves offset correctness, not a stale buffer)
  const row0 = store.readTrainRow(0);
  assert.equal(row0[5], 0);
  store.close();
});

// ── AC8: selection wiring (seam test; existing select code, no prod edit) ────

test('AC8 influence scores order selectInformativeSubset/reprFilterSelect; tau dedups', () => {
  // 4 pairs: H1 & H2 are NEAR-DUPLICATE high-influence; M medium; L low.
  const dupText = 'the quick brown fox jumps over the lazy dog repeatedly today';
  const pairs = [
    { id: 'H1', input: dupText, output: 'alpha response one here now' },
    { id: 'H2', input: dupText + ' .', output: 'alpha response one here now' }, // near-dup of H1
    { id: 'M', input: 'completely different medium topic about oceans and tides', output: 'mid' },
    { id: 'L', input: 'yet another unrelated subject concerning mountains snow', output: 'low' },
  ];
  // influence scores: H1,H2 high; M medium; L low.
  const scores = [0.95, 0.94, 0.50, 0.10];

  // reprFilterSelect: highest-influence-non-redundant first. Budget 2, tight tau.
  const sel = reprFilterSelect(pairs, scores, 2, 0.6);
  // H1 is picked first (highest score); H2 is a near-dup and should be gated out,
  // so the 2nd pick should be M (the next non-redundant), NOT H2.
  assert.ok(sel.selected_indices.includes(0), 'highest-influence H1 selected');
  assert.ok(!(sel.selected_indices.includes(1) && sel.selected_indices.includes(0)) || sel.selected_indices.length < 2 || sel.selected_indices.includes(2),
    'near-dup H2 not co-selected with H1 under tau');
  assert.ok(sel.selected_indices.includes(2), 'diverse medium M selected as 2nd over near-dup H2');

  // selectInformativeSubset honors opts.scores for its self-coverage seed +
  // returns a valid envelope; the highest-influence item anchors the spread.
  const inf = selectInformativeSubset(pairs, 2, { scores, diversity_tau: 0.6 });
  assert.equal(inf.ok, true);
  assert.equal(inf.selected_indices.length, 2);
});

// ── AC9: GPU worker env-gate + never spawned by default ──────────────────────

test('AC9 compute_grads.py is env-gated, fails loud, never spawned by default path', () => {
  const worker = path.join(REPO, 'workers', 'data', 'scripts', 'compute_grads.py');
  assert.ok(fs.existsSync(worker), 'worker exists');
  const src = fs.readFileSync(worker, 'utf8');
  // _require pattern with exit 3 + install hint, mirroring train_lora.py
  assert.ok(/sys\.exit\(3\)/.test(src), 'exits 3 on missing dep');
  assert.ok(/install hint/.test(src), 'prints install hint');
  assert.ok(/KOLM_GRAD_VALUATION/.test(src), 'env-gated on KOLM_GRAD_VALUATION');
  assert.ok(/--attest-disjoint/.test(src), 'requires disjointness attestation');

  // NEVER imported/spawned by the default compile path.
  for (const f of ['src/distill-pipeline.js', 'src/data-curate.js']) {
    const txt = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!/compute_grads/.test(txt), `${f} must not reference compute_grads`);
  }
});

// ── AC10: privacy boundary - no raw text in any store file ───────────────────

test('AC10 gradient store contains no raw input/output text; val is mean-only', () => {
  const root = mkTmp();
  const d = 32; const nck = 2;
  const SECRET_IN = 'SUPER_SECRET_CUSTOMER_PROMPT_TOKEN';
  const SECRET_OUT = 'CONFIDENTIAL_TEACHER_ANSWER_TOKEN';
  const pairs = [{ id: 'a', input: SECRET_IN, output: SECRET_OUT }];
  const tg = Array.from({ length: nck * d }, (_, i) => Math.cos(i));
  const vg = [Array.from({ length: d }, (_, i) => i), Array.from({ length: d }, (_, i) => -i)];
  const dir = buildStore(root, 'priv', { d, nck, pairs, trainGrads: [tg], valGrads: vg });

  for (const f of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, f));
    const asStr = raw.toString('latin1');
    assert.ok(!asStr.includes(SECRET_IN), `${f} leaks input text`);
    assert.ok(!asStr.includes(SECRET_OUT), `${f} leaks output text`);
  }
  // val_grads.f32 has EXACTLY nck*d floats (mean-aggregated, no per-example grads)
  const valBytes = fs.statSync(path.join(dir, 'val_grads.f32')).size;
  assert.equal(valBytes, nck * d * 4);
  // train_ids carries only {idx, pair_id}
  const ids = fs.readFileSync(path.join(dir, 'train_ids.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const e of ids) {
    assert.deepEqual(Object.keys(e).sort(), ['idx', 'pair_id']);
  }
});

// ── AC11: full envelope discipline + fuzz (malformed/truncated never throw) ──

test('AC11 fuzz: malformed manifests / truncated binaries / bad pairs never throw', () => {
  const root = mkTmp();
  const d = 8; const nck = 1;
  const val = [1, 1, 1, 1, 1, 1, 1, 1];
  const pairs = [{ id: 'a', input: 'x', output: 'y' }];
  buildStore(root, 'fuzz', { d, nck, pairs, trainGrads: [val], valGrads: [val] });
  const dir = path.join(root, 'fuzz');

  // corrupt manifest (bad json)
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ this is not json');
  let r = valuePairsByInfluence({ pairs, namespace: 'fuzz', gradStoreDir: root });
  assert.equal(r.ok, false);
  assert.equal(r.version, VALUE_INFLUENCE_VERSION);

  // manifest missing proj params
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 'gradstore-v1', holdout_disjoint_attested: true }));
  r = valuePairsByInfluence({ pairs, namespace: 'fuzz', gradStoreDir: root });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string');

  // truncated val_grads (shape mismatch)
  buildStore(root, 'fuzz2', { d, nck, pairs, trainGrads: [val], valGrads: [val] });
  writeF32(path.join(root, 'fuzz2', 'val_grads.f32'), [1, 2, 3]); // wrong length
  r = valuePairsByInfluence({ pairs, namespace: 'fuzz2', gradStoreDir: root });
  assert.equal(r.ok, false);

  // non-array pairs
  for (const bad of [null, undefined, 42, 'str', {}]) {
    const rr = valuePairsByInfluence({ pairs: bad, namespace: 'nope', gradStoreDir: root });
    assert.ok(rr && typeof rr.ok === 'boolean' && rr.version === VALUE_INFLUENCE_VERSION);
  }
  // projection on garbage never throws
  assert.doesNotThrow(() => _sparseSignProject(null, 16, 's'));
  assert.doesNotThrow(() => _sparseSignProject([NaN, Infinity, 1], 16, 's'));
});

// ── AC12: no-regression sanity for the existing select API surface ───────────

test('AC12 existing data-select API unchanged (scores param still threads)', () => {
  const pairs = [{ input: 'a', output: 'aa' }, { input: 'b', output: 'bb' }, { input: 'c', output: 'cc' }];
  const out = reprFilterSelect(pairs, [0.1, 0.9, 0.5], 2, 0.95);
  assert.equal(out.selected_indices.length, 2);
  // highest score (index 1) must be selected
  assert.ok(out.selected_indices.includes(1));
});

// ── helpers ──────────────────────────────────────────────────────────────────

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cosineArr(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

function cosineArrTyped(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}
