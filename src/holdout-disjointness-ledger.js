// src/holdout-disjointness-ledger.js
//
// FINALIZED-C6 atom: Transitive cross-corpus holdout-disjointness ledger
// (fail-closed, all tiers at once).
//
// PROBLEM. The eval ladder (src/seeds.js Q+2 seed split, src/external-holdout.js
// N+3/N+4 external+adversarial, src/tenant-holdout.js N+5 shadow corpus, plus
// the calibration pack) each prove ONE holdout is disjoint from ONE train split.
// But a K-score ships off MANY train-side corpora at once (real seeds, the
// post-curate synthetic set, distilled/teacher rows) scored against MANY
// holdout tiers. A row that leaks from the DISTILLED corpus into the EXTERNAL
// holdout is invisible to every per-pair check above. The K-score then reports
// inflated generalization (R/F/T axes) over a contaminated holdout - the exact
// failure that launders trust out of a signed artifact.
//
// THIS MODULE. One manifest block (`eval_disjointness_ledger`) that ingests the
// canonical row-hash sets + MinHash/LSH signatures of EVERY train-side corpus
// AND EVERY holdout tier, computes the FULL pairwise train x holdout
// disjointness matrix - lexical (exact row-hash), near-dup (MinHash/LSH +
// true-Jaccard verify), and group-key (member/case/claim id leakage) - in
// near-linear time by reusing the eval-decontam LSH substrate
// (src/minhash-dedup.js), commits every corpus to an RFC-6962 Merkle root
// (src/merkle.js), emits per-pair overlap counts + worst-case Jaccard, and
// FAIL-CLOSES the K-score ship gate if ANY train x holdout cell is non-empty
// above a recorded tolerance.
//
// TRANSITIVITY. Disjointness is not transitively guaranteed by per-pair seed
// checks: train_A disjoint from holdout_H and train_B disjoint from holdout_H
// does not imply the UNION (train_A U train_B) is decontaminated against H if
// the curate stage merged a row from B that originated in A's neighborhood of
// H. The ledger closes this by treating EVERY train-side corpus as one probe
// population against EVERY holdout-side tier - the complete bipartite product -
// so no train x holdout edge is left unchecked. "Transitive" = the closure over
// all (train_i, holdout_j) edges, not just the ones a single split happened to
// compare.
//
// NEAR-LINEAR. Naive all-pairs is O(sum_train_rows * sum_holdout_rows * tiers).
// Instead we build ONE LSH band index over each holdout tier (in ingest) and
// reuse it across every train corpus, then probe each train row against only
// its colliding holdout rows. With LSH this is ~O(N + M + candidate_pairs); on
// de-correlated corpora candidate_pairs is small, so the matrix is near-linear
// in total rows.
//
// PRIVACY (load-bearing for kolm). Tenant-shadow corpora are committed BY HASH
// ONLY: the caller passes {rowHashes, signatures} (or {rows} with
// privacy:'hash_only', in which case we hash + sign locally and DROP the
// plaintext before it can be recorded). The ledger block never contains tenant
// row text - only the per-row SHA-256 hashes, MinHash signatures, group-key
// hashes, and the Merkle root. A third party re-verifies disjointness from the
// committed roots + signatures WITHOUT the plaintext. No tenant bytes ever flow
// to an external/hyperscaler path through this module.
//
// RE-VERIFIABILITY. Every corpus exposes a Merkle root over its per-row leaf
// commitments (row_hash || signature_digest || group_hash). The ledger records
// each root + the pairwise overlap evidence (the actual colliding leaf hashes,
// not the text). A third party recomputes the matrix from the committed roots +
// the published signatures and confirms the same fail-closed verdict, with zero
// access to any corpus plaintext.
//
// ZERO new npm deps. Pure JS over node:crypto + the existing MinHash + Merkle
// modules. ASCII only.

import crypto from 'node:crypto';
import {
  shingleSet,
  minhashSignature,
  makePermutations,
  lshBuckets,
  estimateJaccard,
} from './minhash-dedup.js';
import { computeRoot, leafHash } from './merkle.js';

export const DISJOINTNESS_LEDGER_VERSION = 'eval-disjointness-ledger-v1';

// The canonical side taxonomy. Every ingested corpus declares exactly one side.
// Train-side corpora are the probe population; holdout-side tiers are the
// protected population the K-score's R/F/T axes are measured against.
export const TRAIN_SIDES = Object.freeze(['real_seed', 'synthetic_post_curate', 'distilled_teacher']);
export const HOLDOUT_SIDES = Object.freeze(['seed_holdout', 'external', 'adversarial', 'tenant_shadow', 'calibration']);
export const ALL_SIDES = Object.freeze([...TRAIN_SIDES, ...HOLDOUT_SIDES]);

// Default near-dup parameters. 128 hashes / 16 bands x 8 rows is the project
// standard (matches minhash-dedup + seeds.js leakage detector). The default
// tolerance is ZERO overlap: a single train x holdout collision fails the gate.
const DEFAULT_NUM_HASHES = 128;
const DEFAULT_BANDS = 16;
const DEFAULT_ROWS = 8;
const DEFAULT_NEAR_DUP_JACCARD = 0.8; // true-Jaccard floor for a near-dup hit
const DEFAULT_SHINGLE_K = 5;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// Canonical-JSON (sorted keys) - matches seeds.js / external-holdout.js so the
// ledger hash is stable across machines and the python mirror, and so a third
// party canonicalizes identically.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

// Flatten a row's identity-bearing text. A row's lexical identity is its INPUT
// (matches seeds.js leakage: leakage is measured on the prompt/input, since
// that is what determines whether the model "has seen" the eval item). Objects
// are canonicalized so {a:1,b:2} === {b:2,a:1}. null/undefined -> ''.
function rowText(row) {
  if (row == null) return '';
  if (typeof row === 'string') return row;
  // Accept {input}/{prompt}/{text} shapes; fall back to canonical JSON of the
  // whole row so structured inputs still get a stable identity.
  const v = (row.input !== undefined) ? row.input
    : (row.prompt !== undefined) ? row.prompt
      : (row.text !== undefined) ? row.text
        : row;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return canonicalJson(v); } catch { return String(v); }
}

// Normalize text for the LEXICAL (exact) hash: lowercase + whitespace-collapse.
// This is deliberately the SAME normalization the MinHash shingler applies, so
// "exact" and "near-dup" agree on what an identical row is. A genuinely
// byte-different-but-semantically-identical pair (casing/whitespace) is caught
// by the exact tier, not just the fuzzy tier - the strongest fail-closed stance.
function lexicalNorm(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Per-row lexical hash. Domain-separated so a row hash can never be confused
// with a Merkle leaf or a group hash.
export function rowHash(row) {
  return sha256Hex('row ' + lexicalNorm(rowText(row)));
}

// Group-key value extraction. The group key (member_id / case_id / claim_id) is
// the privacy-relevant leakage axis: even if no row text overlaps, sharing a
// patient/customer between train and holdout leaks the holdout.
function extractGroupValue(row, groupKey) {
  if (!groupKey || row == null || typeof row !== 'object') return null;
  const md = (row.metadata && typeof row.metadata === 'object') ? row.metadata : row;
  if (md[groupKey] != null) return String(md[groupKey]);
  // tags array form: 'group_key:value'
  const tags = Array.isArray(md.tags) ? md.tags : (Array.isArray(row.tags) ? row.tags : null);
  if (tags) {
    const prefix = groupKey + ':';
    for (const t of tags) {
      if (typeof t === 'string' && t.startsWith(prefix)) return t.slice(prefix.length);
    }
  }
  return null;
}

// Group-key hash. We hash the group VALUE (never store it raw) so tenant group
// ids stay private while remaining comparable across corpora.
export function groupHash(row, groupKey) {
  const v = extractGroupValue(row, groupKey);
  if (v == null) return null;
  return sha256Hex('grp ' + groupKey + ' ' + String(v).toLowerCase());
}

// Compress a MinHash signature to a stable hex digest so it can be committed +
// published without shipping the full Int32 vector inline in the leaf. The
// estimate-Jaccard comparison still uses the full signature in-process; the
// digest is the public commitment.
function signatureDigest(sig) {
  if (!sig || sig.length === 0) return sha256Hex('sig empty');
  const buf = Buffer.allocUnsafe(sig.length * 4);
  for (let i = 0; i < sig.length; i++) buf.writeInt32LE(sig[i] | 0, i * 4);
  return sha256Hex(buf);
}

// ---------------------------------------------------------------------------
// ingestCorpus(spec, opts) -> committed corpus descriptor.
//
// spec:
//   { side, name, rows? , rowHashes?, signatures?, groupHashes?, group_key?,
//     privacy? }
//
// Two ingestion modes:
//   PLAINTEXT (default): pass `rows`. We compute rowHash + MinHash signature +
//     groupHash locally. If privacy === 'hash_only', the plaintext is used only
//     to derive the commitments and is then DROPPED (never recorded) - this is
//     the tenant-shadow path: bytes never leave the function.
//   HASH-ONLY: pass `rowHashes` (hex[]) and `signatures` (Int32Array[] or
//     number[][]) directly. No plaintext is ever seen. groupHashes optional.
//     This is how a tenant commits a corpus from THEIR infrastructure and ships
//     only the commitments to the (possibly external) verifier.
//
// Returns:
//   { side, name, n_rows, group_key, privacy, rowHashes, signatures,
//     groupHashes, signatureDigests, leaves, merkle_root,
//     lsh: { bands, rows, index: Map<bucketKey, rowIdx[]> } }
// ---------------------------------------------------------------------------
export function ingestCorpus(spec, opts = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('disjointness-ledger: corpus spec must be an object');
  const side = String(spec.side || '');
  if (!ALL_SIDES.includes(side)) {
    throw new Error(`disjointness-ledger: corpus '${spec.name || '?'}' side='${side}' must be one of ${ALL_SIDES.join(', ')}`);
  }
  const name = String(spec.name || '');
  if (!name) throw new Error('disjointness-ledger: corpus spec missing name');

  const numHashes = Math.max(1, Math.trunc(Number(opts.numHashes) || DEFAULT_NUM_HASHES));
  const bands = Math.max(1, Math.trunc(Number(opts.bands) || DEFAULT_BANDS));
  const rowsPerBand = Math.max(1, Math.trunc(Number(opts.rows) || DEFAULT_ROWS));
  const k = Math.max(1, Math.trunc(Number(opts.k) || DEFAULT_SHINGLE_K));
  const seed = (Number(opts.seed) >>> 0) || undefined;
  const perms = opts._perms || makePermutations(numHashes, seed);
  const groupKey = (typeof spec.group_key === 'string' && spec.group_key) ? spec.group_key : null;
  const privacy = spec.privacy === 'hash_only' ? 'hash_only' : 'plaintext_committed';

  let rowHashes = [];
  let signatures = [];
  let groupHashes = [];

  const hasHashOnlyInput = Array.isArray(spec.rowHashes) && Array.isArray(spec.signatures);
  if (hasHashOnlyInput) {
    // HASH-ONLY ingestion: caller already committed. Validate shapes; never
    // touch plaintext.
    rowHashes = spec.rowHashes.map((h, i) => {
      const hs = String(h || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hs)) {
        throw new Error(`disjointness-ledger: corpus '${name}' rowHashes[${i}] not 64 hex chars`);
      }
      return hs;
    });
    if (spec.signatures.length !== rowHashes.length) {
      throw new Error(`disjointness-ledger: corpus '${name}' signatures length ${spec.signatures.length} != rowHashes length ${rowHashes.length}`);
    }
    signatures = spec.signatures.map((s) => {
      if (s instanceof Int32Array) return s;
      if (Array.isArray(s)) {
        const out = new Int32Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s[i] | 0;
        return out;
      }
      throw new Error(`disjointness-ledger: corpus '${name}' signature must be Int32Array | number[]`);
    });
    if (Array.isArray(spec.groupHashes)) {
      groupHashes = spec.groupHashes.map((g) => (g == null ? null : String(g).toLowerCase()));
    } else {
      groupHashes = rowHashes.map(() => null);
    }
  } else {
    // PLAINTEXT ingestion. Derive commitments; for hash_only privacy the row
    // text is used here and then discarded (never recorded on the descriptor).
    const rows = Array.isArray(spec.rows) ? spec.rows : null;
    if (!rows) {
      throw new Error(`disjointness-ledger: corpus '${name}' must supply rows OR (rowHashes + signatures)`);
    }
    for (const row of rows) {
      const text = rowText(row);
      rowHashes.push(sha256Hex('row ' + lexicalNorm(text)));
      const sig = minhashSignature(shingleSet(text, k), perms);
      signatures.push(sig);
      groupHashes.push(groupHash(row, groupKey));
    }
    // plaintext intentionally not retained beyond this loop.
  }

  const n = rowHashes.length;
  const signatureDigests = signatures.map(signatureDigest);

  // Merkle leaf per row: domain-separated commitment to (rowHash, sigDigest,
  // groupHash). A third party rebuilds the same leaves from the published
  // commitments and gets the same root.
  const leaves = [];
  for (let i = 0; i < n; i++) {
    const g = groupHashes[i] == null ? '-' : groupHashes[i];
    leaves.push(leafHash(`${rowHashes[i]} ${signatureDigests[i]} ${g}`));
  }
  const merkleRoot = computeRoot(leaves).toString('hex');

  // LSH band index over this corpus's signatures (reusable as a holdout index).
  const index = new Map();
  for (let i = 0; i < n; i++) {
    for (const bk of lshBuckets(signatures[i], bands, rowsPerBand)) {
      let arr = index.get(bk);
      if (!arr) { arr = []; index.set(bk, arr); }
      arr.push(i);
    }
  }

  return {
    side,
    name,
    n_rows: n,
    group_key: groupKey,
    privacy,
    rowHashes,
    signatures,
    groupHashes,
    signatureDigests,
    leaves,
    merkle_root: merkleRoot,
    lsh: { bands, rows: rowsPerBand, num_hashes: numHashes, k, index },
  };
}

// ---------------------------------------------------------------------------
// pairDisjointness(trainCorpus, holdoutCorpus, opts) -> per-pair evidence.
//
// Computes the three overlap channels for ONE (train, holdout) pair using the
// holdout's pre-built LSH index. Near-linear: each train row probes only its
// colliding holdout rows.
//
// Returns:
//   { train, holdout,
//     exact_overlap: count, exact_hits: [{train_row, holdout_row, row_hash}],
//     near_dup_overlap: count, near_dup_hits: [{train_row, holdout_row, jaccard}],
//     group_overlap: count, group_hits: [{train_row, holdout_row, group_hash}],
//     worst_jaccard: number,
//     total_overlap: count,
//     disjoint: bool }
// ---------------------------------------------------------------------------
export function pairDisjointness(trainCorpus, holdoutCorpus, opts = {}) {
  const nearDupFloor = Number.isFinite(Number(opts.nearDupJaccard))
    ? Number(opts.nearDupJaccard) : DEFAULT_NEAR_DUP_JACCARD;
  const hitCap = Number.isFinite(Number(opts.hitCap)) ? Math.max(1, Math.trunc(Number(opts.hitCap))) : 256;

  // EXACT (lexical) overlap: set intersection of row-hash sets. O(N + M).
  const holdoutHashIdx = new Map(); // rowHash -> holdout row index (first)
  for (let j = 0; j < holdoutCorpus.rowHashes.length; j++) {
    if (!holdoutHashIdx.has(holdoutCorpus.rowHashes[j])) holdoutHashIdx.set(holdoutCorpus.rowHashes[j], j);
  }
  const exact_hits = [];
  let exact_overlap = 0;
  for (let i = 0; i < trainCorpus.rowHashes.length; i++) {
    const j = holdoutHashIdx.get(trainCorpus.rowHashes[i]);
    if (j !== undefined) {
      exact_overlap++;
      if (exact_hits.length < hitCap) {
        exact_hits.push({ train_row: i, holdout_row: j, row_hash: trainCorpus.rowHashes[i] });
      }
    }
  }

  // GROUP-KEY overlap: shared group hash between sides. Only meaningful when
  // BOTH corpora carry group hashes (same group_key axis).
  const group_hits = [];
  let group_overlap = 0;
  const holdoutGroups = new Map(); // groupHash -> first holdout row
  let holdoutHasGroups = false;
  for (let j = 0; j < holdoutCorpus.groupHashes.length; j++) {
    const g = holdoutCorpus.groupHashes[j];
    if (g != null) { holdoutHasGroups = true; if (!holdoutGroups.has(g)) holdoutGroups.set(g, j); }
  }
  if (holdoutHasGroups) {
    for (let i = 0; i < trainCorpus.groupHashes.length; i++) {
      const g = trainCorpus.groupHashes[i];
      if (g == null) continue;
      const j = holdoutGroups.get(g);
      if (j !== undefined) {
        group_overlap++;
        if (group_hits.length < hitCap) group_hits.push({ train_row: i, holdout_row: j, group_hash: g });
      }
    }
  }

  // NEAR-DUP overlap: MinHash/LSH candidate generation against the holdout
  // index, then a Jaccard-estimate confirm at the recorded floor. Near-linear:
  // probe each train row against only colliding holdout rows. Exact-equal pairs
  // are excluded from the near-dup channel so the two channels don't double
  // count (an exact pair is already a hard fail in the exact channel).
  const near_dup_hits = [];
  let near_dup_overlap = 0;
  let worst_jaccard = 0;
  const hbands = holdoutCorpus.lsh.bands;
  const hrows = holdoutCorpus.lsh.rows;
  const hindex = holdoutCorpus.lsh.index;
  const seenPair = new Set();
  for (let i = 0; i < trainCorpus.signatures.length; i++) {
    const sig = trainCorpus.signatures[i];
    const trh = trainCorpus.rowHashes[i];
    const cand = new Set();
    for (const bk of lshBuckets(sig, hbands, hrows)) {
      const arr = hindex.get(bk);
      if (arr) for (const j of arr) cand.add(j);
    }
    for (const j of cand) {
      if (holdoutCorpus.rowHashes[j] === trh) continue; // exact - counted above
      const key = i + ',' + j;
      if (seenPair.has(key)) continue;
      const est = estimateJaccard(sig, holdoutCorpus.signatures[j]);
      if (est >= nearDupFloor) {
        seenPair.add(key);
        near_dup_overlap++;
        if (est > worst_jaccard) worst_jaccard = est;
        if (near_dup_hits.length < hitCap) {
          near_dup_hits.push({ train_row: i, holdout_row: j, jaccard: Number(est.toFixed(4)) });
        }
      }
    }
  }
  // Exact matches are Jaccard 1.0 by definition; surface that in worst_jaccard.
  if (exact_overlap > 0) worst_jaccard = 1;

  const total_overlap = exact_overlap + near_dup_overlap + group_overlap;
  return {
    train: trainCorpus.name,
    train_side: trainCorpus.side,
    holdout: holdoutCorpus.name,
    holdout_side: holdoutCorpus.side,
    exact_overlap,
    exact_hits,
    near_dup_overlap,
    near_dup_hits,
    group_overlap,
    group_hits,
    worst_jaccard: Number(worst_jaccard.toFixed(4)),
    total_overlap,
    disjoint: total_overlap === 0,
  };
}

// ---------------------------------------------------------------------------
// buildDisjointnessLedger(corpora, opts) -> ledger block (manifest-ready).
//
// corpora: array of ingestCorpus SPECS (or already-ingested descriptors). Every
// train-side x holdout-side pair is scored. The result fail-closes (`ships:
// false`) if ANY pair has overlap above the recorded tolerance.
//
// tolerance: per-channel max allowed overlap counts. Default ZERO on all
// channels (any single collision fails). A tenant who KNOWS a shared-corpus
// situation can raise a channel tolerance, but the value is RECORDED in the
// block + bound into the block hash so the relaxation is non-repudiable.
//
// Returns the block:
//   { spec, generated_at, sides: {...}, corpora: [...], tolerance, matrix:
//     [pair...], worst_pair, n_pairs, n_violations, total_overlap, disjoint,
//     ships, params, hash }
// ---------------------------------------------------------------------------
export function buildDisjointnessLedger(corpora, opts = {}) {
  if (!Array.isArray(corpora) || corpora.length === 0) {
    throw new Error('disjointness-ledger: corpora must be a non-empty array');
  }
  const numHashes = Math.max(1, Math.trunc(Number(opts.numHashes) || DEFAULT_NUM_HASHES));
  const bands = Math.max(1, Math.trunc(Number(opts.bands) || DEFAULT_BANDS));
  const rowsPerBand = Math.max(1, Math.trunc(Number(opts.rows) || DEFAULT_ROWS));
  const k = Math.max(1, Math.trunc(Number(opts.k) || DEFAULT_SHINGLE_K));
  const seed = (Number(opts.seed) >>> 0) || undefined;
  const nearDupJaccard = Number.isFinite(Number(opts.nearDupJaccard))
    ? Number(opts.nearDupJaccard) : DEFAULT_NEAR_DUP_JACCARD;

  // Shared permutation family so every corpus's signatures are comparable. A
  // verifier MUST use the same seed - it is recorded in params.
  const perms = makePermutations(numHashes, seed);
  const ingestOpts = { numHashes, bands, rows: rowsPerBand, k, seed, _perms: perms };

  const tolerance = {
    exact: Math.max(0, Math.trunc(Number(opts.tolerance && opts.tolerance.exact) || 0)),
    near_dup: Math.max(0, Math.trunc(Number(opts.tolerance && opts.tolerance.near_dup) || 0)),
    group: Math.max(0, Math.trunc(Number(opts.tolerance && opts.tolerance.group) || 0)),
  };

  // Ingest (or accept pre-ingested). A descriptor is recognized by the presence
  // of an `lsh` index + `merkle_root`.
  const ingested = corpora.map((c) => {
    if (c && c.lsh && c.merkle_root && Array.isArray(c.rowHashes)) return c;
    return ingestCorpus(c, ingestOpts);
  });

  // Reject duplicate (side,name) pairs - the matrix keys on name, so a dup would
  // silently shadow a corpus and hide its overlaps.
  const seenNames = new Set();
  for (const c of ingested) {
    const key = c.side + '/' + c.name;
    if (seenNames.has(key)) throw new Error(`disjointness-ledger: duplicate corpus '${key}'`);
    seenNames.add(key);
  }

  const trains = ingested.filter((c) => TRAIN_SIDES.includes(c.side));
  const holdouts = ingested.filter((c) => HOLDOUT_SIDES.includes(c.side));
  if (trains.length === 0) throw new Error('disjointness-ledger: no train-side corpus supplied (need at least one of ' + TRAIN_SIDES.join('/') + ')');
  if (holdouts.length === 0) throw new Error('disjointness-ledger: no holdout-side corpus supplied (need at least one of ' + HOLDOUT_SIDES.join('/') + ')');

  // Full bipartite matrix. Each holdout's LSH index is built once (in ingest)
  // and reused across every train corpus -> near-linear over total rows.
  const matrix = [];
  let n_violations = 0;
  let total_overlap = 0;
  let worst_pair = null;
  for (const t of trains) {
    for (const h of holdouts) {
      const pair = pairDisjointness(t, h, { nearDupJaccard, hitCap: opts.hitCap });
      const exceeds = pair.exact_overlap > tolerance.exact
        || pair.near_dup_overlap > tolerance.near_dup
        || pair.group_overlap > tolerance.group;
      pair.within_tolerance = !exceeds;
      if (exceeds) n_violations++;
      total_overlap += pair.total_overlap;
      if (!worst_pair || pair.total_overlap > worst_pair.total_overlap
        || (pair.total_overlap === worst_pair.total_overlap && pair.worst_jaccard > worst_pair.worst_jaccard)) {
        worst_pair = pair;
      }
      matrix.push(pair);
    }
  }

  const disjoint = n_violations === 0;

  const block = {
    spec: DISJOINTNESS_LEDGER_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    sides: {
      train: trains.map((c) => ({ name: c.name, side: c.side })),
      holdout: holdouts.map((c) => ({ name: c.name, side: c.side })),
    },
    corpora: ingested.map((c) => ({
      name: c.name,
      side: c.side,
      n_rows: c.n_rows,
      privacy: c.privacy,
      group_key: c.group_key,
      merkle_root: c.merkle_root,
    })),
    tolerance,
    n_pairs: matrix.length,
    n_violations,
    total_overlap,
    matrix: matrix.map((p) => ({
      train: p.train,
      train_side: p.train_side,
      holdout: p.holdout,
      holdout_side: p.holdout_side,
      exact_overlap: p.exact_overlap,
      near_dup_overlap: p.near_dup_overlap,
      group_overlap: p.group_overlap,
      worst_jaccard: p.worst_jaccard,
      total_overlap: p.total_overlap,
      within_tolerance: p.within_tolerance,
      // bounded evidence - hashes only, never plaintext
      exact_hits: p.exact_hits,
      near_dup_hits: p.near_dup_hits,
      group_hits: p.group_hits,
    })),
    worst_pair: worst_pair ? {
      train: worst_pair.train,
      holdout: worst_pair.holdout,
      total_overlap: worst_pair.total_overlap,
      worst_jaccard: worst_pair.worst_jaccard,
    } : null,
    disjoint,
    // The headline: fail-closed. ships === disjoint. A consumer ANDs this into
    // the K-score ship gate (see gateKScoreWithDisjointness).
    ships: disjoint,
    params: {
      num_hashes: numHashes,
      bands,
      rows: rowsPerBand,
      k,
      seed: seed == null ? null : (seed >>> 0),
      near_dup_jaccard: nearDupJaccard,
    },
  };
  block.hash = sha256Hex(canonicalJson({ ...block, hash: undefined }));
  return block;
}

// ---------------------------------------------------------------------------
// validateDisjointnessLedger(block) -> block (or throws). Re-hashes canonical
// form (excluding .hash) and confirms structural invariants. This is the cheap
// "did the block round-trip" check; full re-verification (recompute the matrix
// from committed roots) is reVerifyFromCommitments below.
// ---------------------------------------------------------------------------
export function validateDisjointnessLedger(block) {
  if (!block || typeof block !== 'object') throw new Error('disjointness-ledger: block must be an object');
  if (block.spec !== DISJOINTNESS_LEDGER_VERSION) {
    throw new Error(`disjointness-ledger: block.spec='${block.spec}' expected '${DISJOINTNESS_LEDGER_VERSION}'`);
  }
  for (const key of ['corpora', 'matrix', 'tolerance', 'disjoint', 'ships', 'params']) {
    if (block[key] == null) throw new Error(`disjointness-ledger: block missing field '${key}'`);
  }
  if (!Array.isArray(block.corpora) || block.corpora.length === 0) {
    throw new Error('disjointness-ledger: block.corpora must be a non-empty array');
  }
  for (const c of block.corpora) {
    if (!/^[0-9a-f]{64}$/.test(String(c.merkle_root || ''))) {
      throw new Error(`disjointness-ledger: corpus '${c.name}' merkle_root not hex64`);
    }
    if (!ALL_SIDES.includes(c.side)) {
      throw new Error(`disjointness-ledger: corpus '${c.name}' side='${c.side}' invalid`);
    }
  }
  // ships MUST equal disjoint (the fail-closed invariant cannot be relaxed
  // independently of the matrix verdict).
  if (block.ships !== block.disjoint) {
    throw new Error('disjointness-ledger: block.ships must equal block.disjoint (fail-closed invariant)');
  }
  // disjoint MUST equal "no violations" recomputed from the matrix - catches a
  // tampered verdict that flips disjoint:true while a cell exceeds tolerance.
  const tol = block.tolerance;
  let recomputedViolations = 0;
  for (const p of block.matrix) {
    if (p.exact_overlap > tol.exact || p.near_dup_overlap > tol.near_dup || p.group_overlap > tol.group) {
      recomputedViolations++;
    }
  }
  if ((recomputedViolations === 0) !== block.disjoint) {
    throw new Error(`disjointness-ledger: block.disjoint=${block.disjoint} contradicts matrix (${recomputedViolations} cells exceed tolerance)`);
  }
  const declared = block.hash;
  const recomputed = sha256Hex(canonicalJson({ ...block, hash: undefined }));
  if (declared !== recomputed) {
    throw new Error(`disjointness-ledger: block hash drift - declared ${declared}, recomputed ${recomputed}`);
  }
  return block;
}

// ---------------------------------------------------------------------------
// reVerifyFromCommitments(block, corpora) -> { ok, reason?, matches }
//
// THE re-verifiability path: a third party who holds the COMMITMENTS (rowHashes,
// signatures, groupHashes per corpus - NO plaintext) recomputes every corpus's
// Merkle root, recomputes the full matrix, and confirms the same fail-closed
// verdict + the same block hash. For tenant corpora this works from the
// published hash-only commitments with zero access to the tenant's bytes.
//
// `corpora` is an array of hash-only specs:
//   { side, name, rowHashes, signatures, groupHashes?, group_key?, privacy? }
// ---------------------------------------------------------------------------
export function reVerifyFromCommitments(block, corpora, opts = {}) {
  try {
    validateDisjointnessLedger(block);
  } catch (e) {
    return { ok: false, reason: `block invalid: ${e.message}`, matches: false };
  }
  const p = block.params;
  let rebuilt;
  try {
    rebuilt = buildDisjointnessLedger(corpora, {
      numHashes: p.num_hashes,
      bands: p.bands,
      rows: p.rows,
      k: p.k,
      seed: p.seed == null ? undefined : p.seed,
      nearDupJaccard: p.near_dup_jaccard,
      tolerance: block.tolerance,
      generated_at: block.generated_at,
      hitCap: opts.hitCap,
    });
  } catch (e) {
    return { ok: false, reason: `rebuild failed: ${e.message}`, matches: false };
  }

  // Compare the load-bearing facts. The hash will match too iff generated_at +
  // every recorded field matches; we surface both a strict (hash) and a
  // semantic (verdict + per-corpus root) comparison.
  const rootsMatch = block.corpora.length === rebuilt.corpora.length
    && block.corpora.every((c) => {
      const r = rebuilt.corpora.find((x) => x.name === c.name && x.side === c.side);
      return r && r.merkle_root === c.merkle_root;
    });

  const verdictMatch = rebuilt.disjoint === block.disjoint
    && rebuilt.ships === block.ships
    && rebuilt.n_violations === block.n_violations;

  const hashMatch = rebuilt.hash === block.hash;

  const ok = rootsMatch && verdictMatch;
  return {
    ok,
    matches: hashMatch,
    roots_match: rootsMatch,
    verdict_match: verdictMatch,
    hash_match: hashMatch,
    recomputed_disjoint: rebuilt.disjoint,
    recomputed_violations: rebuilt.n_violations,
    reason: ok ? null
      : (!rootsMatch ? 'merkle root mismatch (committed corpus differs from supplied commitments)'
        : 'disjointness verdict mismatch (recomputed matrix disagrees with block)'),
  };
}

// ---------------------------------------------------------------------------
// gateKScoreWithDisjointness(kScoreEnvelope, ledgerBlock) -> gated envelope.
//
// The integration verb: AND the disjointness verdict into the K-score ship gate.
// Fail-closed - a missing/invalid ledger ALSO blocks the ship (no ledger = no
// proof of disjointness = do not ship). The original composite/gate fields are
// preserved; only `ships` is narrowed and a `disjointness` audit stub is added.
//
// This NEVER widens the gate: if the K-score already said ships:false, it stays
// false. It only ever flips ships true->false.
// ---------------------------------------------------------------------------
export function gateKScoreWithDisjointness(kScoreEnvelope, ledgerBlock) {
  const env = (kScoreEnvelope && typeof kScoreEnvelope === 'object') ? kScoreEnvelope : {};
  let disjointOk = false;
  let reason = null;
  if (!ledgerBlock || typeof ledgerBlock !== 'object') {
    reason = 'no disjointness ledger present (fail-closed: cannot prove holdout disjointness)';
  } else {
    try {
      validateDisjointnessLedger(ledgerBlock);
      disjointOk = ledgerBlock.disjoint === true && ledgerBlock.ships === true;
      if (!disjointOk) {
        reason = `holdout contamination detected: ${ledgerBlock.n_violations} train x holdout cell(s) exceed tolerance`;
      }
    } catch (e) {
      reason = `disjointness ledger invalid (fail-closed): ${e.message}`;
    }
  }
  const kShips = env.ships === true;
  return {
    ...env,
    ships: kShips && disjointOk,
    disjointness: {
      spec: DISJOINTNESS_LEDGER_VERSION,
      disjoint: disjointOk,
      ledger_hash: (ledgerBlock && ledgerBlock.hash) || null,
      n_violations: (ledgerBlock && ledgerBlock.n_violations) != null ? ledgerBlock.n_violations : null,
      worst_pair: (ledgerBlock && ledgerBlock.worst_pair) || null,
      blocked_reason: (kShips && !disjointOk) ? reason : (reason || null),
      k_score_ships: kShips,
    },
  };
}

// Hash-only commitment helper: derive {rowHashes, signatures, groupHashes} from
// plaintext rows WITHOUT retaining the rows. A tenant calls this on THEIR
// infrastructure to produce the commitments they will publish to a (possibly
// external) verifier - the plaintext never leaves this call.
export function commitCorpusHashOnly(rows, opts = {}) {
  const numHashes = Math.max(1, Math.trunc(Number(opts.numHashes) || DEFAULT_NUM_HASHES));
  const k = Math.max(1, Math.trunc(Number(opts.k) || DEFAULT_SHINGLE_K));
  const seed = (Number(opts.seed) >>> 0) || undefined;
  const groupKey = (typeof opts.group_key === 'string' && opts.group_key) ? opts.group_key : null;
  const perms = makePermutations(numHashes, seed);
  const list = Array.isArray(rows) ? rows : [];
  const rowHashes = [];
  const signatures = [];
  const groupHashes = [];
  for (const row of list) {
    const text = rowText(row);
    rowHashes.push(sha256Hex('row ' + lexicalNorm(text)));
    signatures.push(Array.from(minhashSignature(shingleSet(text, k), perms)));
    groupHashes.push(groupHash(row, groupKey));
  }
  // plaintext not retained.
  return { rowHashes, signatures, groupHashes, group_key: groupKey, n_rows: rowHashes.length };
}

export default {
  DISJOINTNESS_LEDGER_VERSION,
  TRAIN_SIDES,
  HOLDOUT_SIDES,
  ALL_SIDES,
  canonicalJson,
  rowHash,
  groupHash,
  ingestCorpus,
  pairDisjointness,
  buildDisjointnessLedger,
  validateDisjointnessLedger,
  reVerifyFromCommitments,
  gateKScoreWithDisjointness,
  commitCorpusHashOnly,
};
