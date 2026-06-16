// src/eval-decontam.js
//
// Synthetic provenance tagging, dedup-against-eval, and contamination-proof
// K-score attestation. This is a pre-K-score COMPILE STAGE that runs AFTER
// synthetic generation + curation but BEFORE k-score / artifact build.
//
// It deliberately lives OUTSIDE data-curate.js (which by contract never sees
// the holdout) so the holdout-disjointness invariant is structurally provable:
// a module that imports eval/holdout corpora to test synthetic rows against
// them must NOT be the same module that curates training data. A test asserts
// this file never imports data-curate.js.
//
// What it composes (no primitive is reimplemented):
//   - merkle.js        - RFC 6962 dual Merkle roots (synthetic + eval universe)
//   - minhash-dedup.js - shingle/MinHash/LSH near-dup substrate (tier 2)
//   - external-holdout.js / tenant-holdout.js - eval/holdout corpora (read-only)
//   - seeds.js         - canonicalJson for the signed manifest block
//
// New math object: a ONE-SIDED membership predicate (3-tier fail-closed
// cascade). Direction = over-flag / reject (sensitivity over specificity,
// matching lm-eval-harness / GPT-3 decontam). ANY tier hit flags a synthetic
// row as contaminated; the row is dropped from train and counted. A miss at
// all enabled tiers passes. The operating point is calibrated and RECORDED,
// never silently tuned.
//
// New manifest block: eval-decontam-v1, shaped exactly like the
// external-holdout / tenant-shadow blocks (canonical-hash, re-validatable,
// tamper-evident).
//
// PRIVACY (load-bearing): tenant-holdout rows are indexed IN-PROCESS only;
// their CONTENT never leaves the tenant and is never written into the artifact.
// eval_universe_root commits to sha256(canonical(row)) - hashes, not rows. No
// tenant/eval data passes to a hyperscaler on the default path. Tier 3
// (semantic paraphrase) is env-gated and REFUSES to run if a hyperscaler-only
// provider is configured while tenant rows are in the universe.
//
// Complexity: build index O(E*g) for E eval rows, g grams; cascade O(S*g)
// tier1 + O(S*bands) tier2 candidate lookup. Near-linear; scales past tens of
// thousands of rows without python. ZERO new npm deps; node:crypto + existing
// src/* only; ASCII-only.

import crypto from 'node:crypto';
import { buildTree } from './merkle.js';
import {
  shingleSet,
  makePermutations,
  minhashSignature,
  lshBuckets,
  estimateJaccard,
  optimalBands,
} from './minhash-dedup.js';
import { loadHoldouts } from './external-holdout.js';
import { loadCorpus } from './tenant-holdout.js';
import { canonicalJson } from './seeds.js';

export const EVAL_DECONTAM_SPEC_VERSION = 'eval-decontam-v1';

// The 13-gram contiguous-token n-gram is the lm-eval-harness / GPT-3 decontam
// standard. Hard-coded into the operating point; recorded in every block.
const NGRAM = 13;
const DEFAULT_LSH_THRESHOLD = 0.80;
const DEFAULT_MINHASH_SEED = 0x6b6f6c6d; // 'kolm' - shared with minhash-dedup
const DEFAULT_NUM_HASHES = 128;
const SHINGLE_K = 5; // tier-2 shingle width (matches minhash-dedup default)

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// Replicates minhash-dedup._normalizeText rules verbatim (lowercase, collapse
// whitespace runs to a single space, trim). _normalizeText is module-private in
// minhash-dedup; we mirror its exact contract here so canonical text agrees.
function normalizeText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Canonical text for a row = normalize(input + '\n' + output). Field accessors
// tolerate both canonical {input, output} and legacy {input, expected} /
// {prompt, completion} shapes seen across the codebase.
function rowInput(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.input != null) return typeof r.input === 'string' ? r.input : canonicalJson(r.input);
  if (r.prompt != null) return typeof r.prompt === 'string' ? r.prompt : canonicalJson(r.prompt);
  return '';
}

function rowOutput(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.output != null) return typeof r.output === 'string' ? r.output : canonicalJson(r.output);
  if (r.expected != null) return typeof r.expected === 'string' ? r.expected : canonicalJson(r.expected);
  if (r.completion != null) return typeof r.completion === 'string' ? r.completion : canonicalJson(r.completion);
  if (r.teacher_output != null) return typeof r.teacher_output === 'string' ? r.teacher_output : canonicalJson(r.teacher_output);
  return '';
}

function canonicalRowText(r) {
  return normalizeText(rowInput(r) + '\n' + rowOutput(r));
}

// ===========================================================================
// A. PROVENANCE UNIFICATION
// ===========================================================================

// normalizeProvenance(row) -> canonical provenance block. Folds the two stamp
// dialects:
//   synthetic-data.js stamp(): {source_type:'synthetic', teacher_model, mode,
//                               generation_prompt_hash}
//   synthetic-augment.js     : {kolm_synthetic:true, parent_seed_cids, ...}
// kolm_synthetic:true maps to source_type:'synthetic'. source_type is the
// canonical discriminator; absent => 'real'. Never throws on malformed rows.
export function normalizeProvenance(row) {
  const r = (row && typeof row === 'object') ? row : {};
  let source_type = typeof r.source_type === 'string' ? r.source_type : null;
  if (!source_type) {
    source_type = (r.kolm_synthetic === true) ? 'synthetic' : 'real';
  }
  const teacher_model = (typeof r.teacher_model === 'string' && r.teacher_model) ? r.teacher_model : null;
  const mode = (typeof r.mode === 'string' && r.mode) ? r.mode : null;
  const generation_prompt_hash = (typeof r.generation_prompt_hash === 'string' && r.generation_prompt_hash)
    ? r.generation_prompt_hash : null;
  const generator_version = (typeof r.version === 'string' && r.version)
    ? r.version
    : (typeof r.generator_version === 'string' && r.generator_version ? r.generator_version : null);
  const parent_seed_cids = Array.isArray(r.parent_seed_cids) ? r.parent_seed_cids.slice() : [];
  return {
    source_type,
    teacher_model,
    mode,
    generation_prompt_hash,
    generator_version,
    parent_seed_cids,
  };
}

// partitionBySource(rows) -> { real[], synthetic[] }. Discriminates on the
// canonical source_type from normalizeProvenance. Never throws.
export function partitionBySource(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const real = [];
  const synthetic = [];
  for (const r of list) {
    const prov = normalizeProvenance(r);
    if (prov.source_type === 'synthetic') synthetic.push(r);
    else real.push(r);
  }
  return { real, synthetic };
}

function round4(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

// syntheticShare(rows) = synthetic.length / max(1, total), rounded to 4 dp.
export function syntheticShare(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { synthetic } = partitionBySource(list);
  return round4(synthetic.length / Math.max(1, list.length));
}

// ===========================================================================
// B. 3-TIER FAIL-CLOSED MEMBERSHIP CASCADE (one-sided)
// ===========================================================================

// Contiguous-token n-grams over a normalized text. Each n-gram is the joined
// token string; we hash it (sha256 hex) so the membership Set is O(1) per gram
// and memory-bounded. Returns Set<string> of n-gram hashes.
function ngramHashes(normText, n = NGRAM) {
  const out = new Set();
  if (!normText) return out;
  const toks = normText.split(' ').filter(Boolean);
  const nn = Math.max(1, Math.trunc(Number(n) || NGRAM));
  if (toks.length < nn) return out; // shorter than one n-gram contributes none
  for (let i = 0; i <= toks.length - nn; i++) {
    out.add(sha256(toks.slice(i, i + nn).join(' ')));
  }
  return out;
}

// buildEvalIndex({ holdoutNames, seedHoldoutRows, tenantCorpus, opts }).
// Builds all three tier indexes ONCE per compile:
//   - tier1: exactHashes Set<sha256(canonicalText)> + ngramSet Set<sha256(13gram)>
//   - tier2: LSH bucketMap (bucketKey -> [evalSignatureIdx]) + signatures[]
//   - eval_universe_commitments: sha256(canonicalText) per eval row, in a stable
//     order, for the eval_universe_root (commitments NOT rows - tenant content
//     never written into the artifact).
//
// Inputs:
//   holdoutNames    - names resolvable via external-holdout.loadHoldouts (rows
//                     ship under repo root, so their commitments re-anchor)
//   seedHoldoutRows - rows from seed_provenance.holdout split (already loaded)
//   tenantCorpus    - { tenant_id, corpus_id } | array of such | loaded corpus
//                     objects; rows indexed in-process, COMMITTED BY HASH ONLY
//   opts            - { lshThreshold, minhashSeed, numHashes, ngram, root }
export function buildEvalIndex({ holdoutNames, seedHoldoutRows, tenantCorpus, opts } = {}) {
  const o = opts || {};
  const lshThreshold = Number.isFinite(Number(o.lshThreshold)) ? Number(o.lshThreshold) : DEFAULT_LSH_THRESHOLD;
  const minhashSeed = (Number(o.minhashSeed) >>> 0) || DEFAULT_MINHASH_SEED;
  const numHashes = Math.max(1, Math.trunc(Number(o.numHashes) || DEFAULT_NUM_HASHES));
  const ngram = Math.max(1, Math.trunc(Number(o.ngram) || NGRAM));
  const k = Math.max(1, Math.trunc(Number(o.shingleK) || SHINGLE_K));

  const opt = optimalBands(lshThreshold, numHashes);
  const bands = opt.bands;
  const rows = opt.rows;
  const perms = makePermutations(numHashes, minhashSeed);

  // Collect eval/holdout rows from all three sources. Each entry carries an
  // origin tag so tenant rows can be committed by hash only (privacy boundary).
  const evalRows = []; // { text, origin: 'external'|'seed'|'tenant', tenant }
  let tenantPresent = false;

  // 1. external + adversarial holdouts (rows ship under repo root)
  if (Array.isArray(holdoutNames) && holdoutNames.length > 0) {
    const loaded = loadHoldouts(holdoutNames, o);
    for (const h of loaded) {
      for (const r of (h.rows || [])) {
        evalRows.push({ text: canonicalRowText(r), origin: 'external' });
      }
    }
  }

  // 2. seed-holdout rows (already split out of seeds.jsonl by the caller)
  if (Array.isArray(seedHoldoutRows)) {
    for (const r of seedHoldoutRows) {
      evalRows.push({ text: canonicalRowText(r), origin: 'seed' });
    }
  }

  // 3. tenant shadow corpora (in-process only; committed by hash, never bytes)
  const tenantSpecs = normalizeTenantSpecs(tenantCorpus);
  for (const spec of tenantSpecs) {
    let loaded = spec;
    if (!Array.isArray(spec.rows)) {
      loaded = loadCorpus(spec.tenant_id, spec.corpus_id, o);
    }
    tenantPresent = true;
    for (const r of (loaded.rows || [])) {
      evalRows.push({ text: canonicalRowText(r), origin: 'tenant' });
    }
  }

  // ---- tier 1 indexes: exact hashes + 13-gram membership Set ----
  const exactHashes = new Set();
  const ngramSet = new Set();
  for (const e of evalRows) {
    if (!e.text) continue;
    exactHashes.add(sha256(e.text));
    for (const g of ngramHashes(e.text, ngram)) ngramSet.add(g);
  }

  // ---- tier 2 index: eval LSH buckets + signatures ----
  const evalSignatures = [];
  const evalShingles = [];
  const bucketMap = new Map(); // bucketKey -> [evalSigIdx]
  for (const e of evalRows) {
    const sh = shingleSet(e.text, k);
    const sig = minhashSignature(sh, perms);
    const idx = evalSignatures.length;
    evalSignatures.push(sig);
    evalShingles.push(sh);
    for (const bk of lshBuckets(sig, bands, rows)) {
      let arr = bucketMap.get(bk);
      if (!arr) { arr = []; bucketMap.set(bk, arr); }
      arr.push(idx);
    }
  }

  // ---- eval_universe commitments (for the eval_universe_root) ----
  // Commit to sha256(canonicalText). For EVERY origin we store ONLY the hash -
  // external rows could carry plaintext (they ship under repo root) but we keep
  // the leaf uniform and hash-only so the artifact never embeds eval/tenant
  // plaintext and a third party with the eval corpus can re-anchor by hashing.
  const evalCommitments = evalRows
    .filter(e => e.text)
    .map(e => sha256(e.text))
    .sort(); // stable order -> deterministic eval_universe_root

  return {
    spec: EVAL_DECONTAM_SPEC_VERSION,
    operating_point: {
      ngram,
      lsh_threshold: lshThreshold,
      minhash_seed: minhashSeed,
      bands,
      rows,
      num_hashes: numHashes,
      shingle_k: k,
    },
    perms,
    bands,
    rows,
    tier1: { exactHashes, ngramSet },
    tier2: { signatures: evalSignatures, shingles: evalShingles, bucketMap },
    eval_commitments: evalCommitments,
    eval_row_count: evalRows.length,
    tenant_present: tenantPresent,
  };
}

// Normalize the tenantCorpus argument into an array of specs. Accepts:
//   undefined/null              -> []
//   { tenant_id, corpus_id }    -> [spec]
//   { rows: [...] }             -> [loadedCorpus]   (already loaded)
//   array of any of the above   -> flattened
function normalizeTenantSpecs(tenantCorpus) {
  if (tenantCorpus == null) return [];
  const arr = Array.isArray(tenantCorpus) ? tenantCorpus : [tenantCorpus];
  return arr.filter(x => x && typeof x === 'object');
}

// Tier-3 provider classification. A hyperscaler provider must NEVER receive
// tenant/eval rows. Open-weight / local providers are permitted.
const HYPERSCALER_PROVIDERS = new Set([
  'openai', 'azure', 'azure-openai', 'anthropic', 'google', 'gemini', 'vertex',
  'aws', 'bedrock', 'cohere', 'mistral-api',
]);

function classifyEmbedProvider(provider) {
  const p = String(provider || '').toLowerCase().trim();
  if (!p) return { provider: '', kind: 'unset' };
  if (HYPERSCALER_PROVIDERS.has(p)) return { provider: p, kind: 'hyperscaler' };
  return { provider: p, kind: 'local' };
}

// runMembershipCascade({ syntheticRows, evalIndex, opts }) -> cascade result.
// One-sided fail-closed: ANY tier hit flags+drops the row; an internal error in
// a tier treats the candidate as contaminated (drop) and records the error.
// Never throws.
export function runMembershipCascade({ syntheticRows, evalIndex, opts } = {}) {
  const rows = Array.isArray(syntheticRows) ? syntheticRows : [];
  const idx = evalIndex || {};
  const o = opts || {};
  const op = idx.operating_point || {};
  const ngram = Math.max(1, Math.trunc(Number(op.ngram) || NGRAM));
  const k = Math.max(1, Math.trunc(Number(op.shingle_k) || SHINGLE_K));
  const lshThreshold = Number.isFinite(Number(op.lsh_threshold)) ? Number(op.lsh_threshold) : DEFAULT_LSH_THRESHOLD;
  const bands = Math.max(1, Math.trunc(Number(idx.bands || op.bands) || 16));
  const rowsPerBand = Math.max(1, Math.trunc(Number(idx.rows || op.rows) || 8));
  const perms = idx.perms;

  // ---- tier 3 gating + privacy refusal (resolved ONCE, recorded) ----
  const tier3 = resolveTier3({ evalIndex: idx, opts: o });

  const flagged = [];
  const passed = [];
  const errors = [];
  const per_tier_counts = { tier1: 0, tier2: 0, tier3: 0 };

  // If tier 3 was REFUSED (privacy boundary violated), the entire cascade
  // fails closed: we cannot safely run, so we abstain by flagging nothing as
  // passed and surfacing the refusal. Caller's predicate sees the error.
  if (tier3.refused) {
    return {
      flagged: [],
      passed: [],
      per_tier_counts,
      operating_point: { ...op, tier3_status: tier3.status },
      contamination_count: 0,
      contamination_rate: 0,
      contamination_coverage: tier3.coverage,
      tier3_status: tier3.status,
      tier3_install_hint: tier3.install_hint,
      refused: true,
      refusal_reason: tier3.refusal_reason,
      errors: [{ stage: 'tier3-gate', message: tier3.refusal_reason }],
      embed_calls: tier3.embed_calls || 0,
    };
  }

  const exactHashes = (idx.tier1 && idx.tier1.exactHashes) || new Set();
  const ngramSet = (idx.tier1 && idx.tier1.ngramSet) || new Set();
  const evalSignatures = (idx.tier2 && idx.tier2.signatures) || [];
  const evalShingles = (idx.tier2 && idx.tier2.shingles) || [];
  const bucketMap = (idx.tier2 && idx.tier2.bucketMap) || new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let hitTier = 0;
    let hadError = false;

    // ---- tier 1: exact + 13-gram containment ----
    try {
      const text = canonicalRowText(row);
      const fullHash = sha256(text);
      if (exactHashes.has(fullHash)) {
        hitTier = 1;
      } else {
        for (const g of ngramHashes(text, ngram)) {
          if (ngramSet.has(g)) { hitTier = 1; break; }
        }
      }
    } catch (e) {
      hadError = true;
      errors.push({ row_index: i, tier: 1, message: String(e && e.message || e) });
    }

    // ---- tier 2: MinHash/LSH near-dup (only if tier 1 missed) ----
    if (hitTier === 0 && !hadError) {
      try {
        const text = canonicalRowText(row);
        const sh = shingleSet(text, k);
        const sig = minhashSignature(sh, perms);
        const buckets = lshBuckets(sig, bands, rowsPerBand);
        const candidates = new Set();
        for (const bk of buckets) {
          const arr = bucketMap.get(bk);
          if (arr) for (const c of arr) candidates.add(c);
        }
        for (const c of candidates) {
          const est = estimateJaccard(sig, evalSignatures[c]);
          if (est >= lshThreshold) {
            // verify against the true shingle Jaccard to kill LSH FPs
            const tj = trueJaccard(sh, evalShingles[c]);
            if (tj >= lshThreshold) { hitTier = 2; break; }
          }
        }
      } catch (e) {
        hadError = true;
        errors.push({ row_index: i, tier: 2, message: String(e && e.message || e) });
      }
    }

    // ---- tier 3: semantic paraphrase (env-gated, only if 1+2 missed) ----
    if (hitTier === 0 && !hadError && tier3.enabled) {
      try {
        const text = canonicalRowText(row);
        const hit = tier3.embedHit(text, idx);
        if (hit) hitTier = 3;
      } catch (e) {
        hadError = true;
        errors.push({ row_index: i, tier: 3, message: String(e && e.message || e) });
      }
    }

    // Fail-closed: an internal error in ANY tier -> drop as contaminated.
    if (hadError) {
      flagged.push({ row, tier: -1, error: true });
      continue;
    }
    if (hitTier > 0) {
      per_tier_counts['tier' + hitTier] += 1;
      flagged.push({ row, tier: hitTier, error: false });
    } else {
      passed.push(row);
    }
  }

  const contamination_count = flagged.length;
  const total = rows.length;
  const contamination_rate = round4(contamination_count / Math.max(1, total));

  return {
    flagged,
    passed,
    per_tier_counts,
    operating_point: {
      ngram,
      lsh_threshold: lshThreshold,
      minhash_seed: (idx.operating_point && idx.operating_point.minhash_seed) || DEFAULT_MINHASH_SEED,
      bands,
      rows: rowsPerBand,
      tier3_status: tier3.status,
    },
    contamination_count,
    contamination_rate,
    contamination_coverage: tier3.coverage,
    tier3_status: tier3.status,
    tier3_install_hint: tier3.install_hint,
    refused: false,
    errors,
    embed_calls: tier3.embed_calls || 0,
  };
}

// True Jaccard over two shingle Sets (mirrors minhash-dedup._trueJaccard, which
// is module-private). Used by tier 2 to verify LSH candidates.
function trueJaccard(setA, setB) {
  if (!setA || !setB) return 0;
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// resolveTier3 - decides tier-3 status from env + privacy boundary. Returns:
//   { enabled, status, coverage, install_hint, embedHit?, refused?, refusal_reason?, embed_calls }
// Tier 3 is the OPT-IN semantic paraphrase catcher. When KOLM_DECONTAM_EMBED is
// unset it is SKIPPED (loud, recorded). When set it requires a provider; a
// hyperscaler provider with tenant rows in the universe is REFUSED (fail-closed
// - never exfiltrate). An injectable embedder (opts.embedder) lets the real
// code path be exercised without a live provider in tests.
const TIER3_INSTALL_HINT = 'set KOLM_DECONTAM_EMBED=1 and KOLM_LLM_PROVIDER to enable semantic paraphrase decontam';

export function resolveTier3({ evalIndex, opts } = {}) {
  const o = opts || {};
  const env = o.env || process.env || {};
  const enabledFlag = String(env.KOLM_DECONTAM_EMBED || '') === '1';
  const tenantPresent = !!(evalIndex && evalIndex.tenant_present);

  if (!enabledFlag) {
    return {
      enabled: false,
      status: 'skipped',
      coverage: 'lexical_only',
      install_hint: TIER3_INSTALL_HINT,
      embed_calls: 0,
    };
  }

  // Enabled. Determine the provider (injected embedder takes precedence over
  // env so the real path is testable without a live hyperscaler).
  const provider = o.embedder && o.embedder.provider
    ? o.embedder.provider
    : (env.KOLM_LLM_PROVIDER || '');
  const cls = classifyEmbedProvider(provider);

  // PRIVACY REFUSAL: a hyperscaler provider must never receive tenant rows.
  if (cls.kind === 'hyperscaler' && tenantPresent) {
    return {
      enabled: false,
      refused: true,
      status: 'refused_privacy',
      coverage: 'lexical_only',
      install_hint: TIER3_INSTALL_HINT,
      refusal_reason:
        `tier3 refused: hyperscaler provider '${cls.provider}' configured while tenant-holdout rows are in the eval universe; ` +
        'refusing to exfiltrate tenant/eval content. Use a local/open-weight embedder (KOLM_LLM_PROVIDER=local|ollama|...) instead.',
      embed_calls: 0,
    };
  }

  if (cls.kind === 'unset') {
    // Enabled but no provider configured -> fail loud, treat as skipped (cannot
    // run the real path). Recorded distinctly so the operator sees the gap.
    return {
      enabled: false,
      status: 'skipped_no_provider',
      coverage: 'lexical_only',
      install_hint: TIER3_INSTALL_HINT,
      embed_calls: 0,
    };
  }

  // Real path enabled. An embedder must be injected (or wired to a local
  // open-weight model). We never ship a hyperscaler default. The embedder is a
  // function (text, evalIndex) -> boolean (paraphrase hit). It must operate on
  // hashed embeddings or a LOCAL model only.
  const embedder = o.embedder;
  if (!embedder || typeof embedder.embedHit !== 'function') {
    return {
      enabled: false,
      status: 'skipped_no_embedder',
      coverage: 'lexical_only',
      install_hint:
        'KOLM_DECONTAM_EMBED=1 set but no local embedder wired; provide opts.embedder.embedHit(text, evalIndex) ' +
        'backed by a local/open-weight model. Hyperscaler embedders are refused when tenant rows are present.',
      embed_calls: 0,
    };
  }

  let calls = 0;
  return {
    enabled: true,
    status: 'enabled',
    coverage: 'lexical_and_semantic',
    install_hint: null,
    embedHit(text, idx) {
      calls += 1;
      return embedder.embedHit(text, idx);
    },
    get embed_calls() { return calls; },
  };
}

// ===========================================================================
// C. DUAL MERKLE ROOTS
// ===========================================================================

// buildSyntheticRoot(passedSyntheticRows) -> { tree, rootHex }. Merkle root
// over canonical-serialized synthetic rows (post-decontam - the rows that ship
// to train). tree.proof(i)/verifyProof gives O(log n) inclusion proofs.
export function buildSyntheticRoot(passedSyntheticRows) {
  const rows = Array.isArray(passedSyntheticRows) ? passedSyntheticRows : [];
  const leaves = rows.map(r => canonicalSyntheticLeaf(r));
  const tree = buildTree(leaves);
  return { tree, rootHex: tree.rootHex, leaves };
}

// Canonical leaf bytes for a synthetic row: a stable serialization of the
// row's content + canonical provenance. Tampering any byte breaks the proof.
function canonicalSyntheticLeaf(row) {
  const prov = normalizeProvenance(row);
  return canonicalJson({
    input: rowInput(row),
    output: rowOutput(row),
    provenance: prov,
  });
}

// buildEvalUniverseRoot(evalIndex) -> { tree, rootHex }. Merkle root over the
// SHA-256 COMMITMENTS of eval/holdout rows (commitments, NOT rows). A third
// party with the eval corpus can re-anchor by hashing; tenant rows commit to
// hash only and their plaintext never enters the tree.
export function buildEvalUniverseRoot(evalIndex) {
  const commitments = (evalIndex && Array.isArray(evalIndex.eval_commitments))
    ? evalIndex.eval_commitments : [];
  // Each leaf IS the hex64 commitment string (already sha256(canonicalText)).
  const tree = buildTree(commitments);
  return { tree, rootHex: tree.rootHex, leaves: commitments };
}

// ===========================================================================
// D. CONTAMINATION PREDICATE + K-SCORE GATE
// ===========================================================================

// contaminationPredicate(cascadeResult, opts) -> { contaminated, contamination_rate,
//   max_allowed_rate, reason }. Zero-tolerance by default (max_allowed_rate=0).
// Fails (contaminated:true) if contamination_rate > max_allowed_rate after
// decontam, OR if the cascade refused (privacy fail-closed).
export function contaminationPredicate(cascadeResult, opts = {}) {
  const cr = cascadeResult || {};
  const max_allowed_rate = Number.isFinite(Number(opts.maxAllowedRate))
    ? Number(opts.maxAllowedRate) : 0.0;
  // After decontam, the SHIPPED set is cascadeResult.passed - so the residual
  // contamination rate over the shipped set is 0 unless a post-hoc/shadow check
  // re-flagged. We expose the rate the caller passes through; default to the
  // residual computed from any post-decontam re-check (opts.residualRate).
  const residual = Number.isFinite(Number(opts.residualRate))
    ? Number(opts.residualRate)
    : (cr.refused ? 1 : 0);

  if (cr.refused) {
    return {
      contaminated: true,
      contamination_rate: 1,
      max_allowed_rate,
      reason: 'cascade refused (privacy fail-closed): ' + (cr.refusal_reason || 'tier3 boundary'),
    };
  }

  const contaminated = residual > max_allowed_rate;
  return {
    contaminated,
    contamination_rate: round4(residual),
    max_allowed_rate,
    reason: contaminated
      ? `residual contamination_rate ${round4(residual)} exceeds max_allowed_rate ${max_allowed_rate}`
      : 'no residual contamination above tolerance after decontam',
  };
}

// applyContaminationGate(k_score, predicate, opts) -> k_score (mutated copy).
// Follows the EXACT existing conformal-overlay precedent (artifact.js:382-404):
// STRICTER-ONLY, fail-closed, can NEVER flip ships=false -> true. When
// predicate.contaminated and !allow_below_gate, downgrade ships=false with a
// contamination_block_reason. allow_below_gate=true stamps the below-gate path.
export function applyContaminationGate(k_score, predicate, opts = {}) {
  const ks = (k_score && typeof k_score === 'object') ? { ...k_score } : {};
  const pred = predicate || {};
  const allow_below_gate = opts.allow_below_gate === true;

  if (!pred.contaminated) {
    return ks; // clean - never relax an existing gate
  }

  if (allow_below_gate) {
    // Preserve the below-gate stamp path (identical to the existing
    // allow_below_gate behavior): the manifest records the override; ships is
    // NOT forced true (we only ever make the gate stricter or abstain).
    ks.contamination_block_reason = pred.reason || 'contamination predicate flagged';
    ks.allow_below_gate = true;
    ks.contamination_overridden = true;
    return ks;
  }

  // Stricter-only downgrade: force ships=false. NEVER flip a false to true.
  ks.ships = false;
  ks.contamination_block_reason = pred.reason || 'contamination predicate flagged';
  return ks;
}

// ===========================================================================
// E. SIGNED MANIFEST BLOCK
// ===========================================================================

// buildEvalDecontamBlock({ provenance_summary, cascadeResult, synthetic_root,
//   eval_universe_root, predicate }) -> the eval-decontam-v1 block, shaped like
// external-holdout / tenant-shadow blocks. block.hash = sha256(canonicalJson(
// block-minus-hash)).
export function buildEvalDecontamBlock({
  provenance_summary,
  cascadeResult,
  synthetic_root,
  eval_universe_root,
  predicate,
  generated_at,
} = {}) {
  const ps = provenance_summary || {};
  const cr = cascadeResult || {};
  const pred = predicate || {};
  const block = {
    spec: EVAL_DECONTAM_SPEC_VERSION,
    synthetic_share: round4(ps.synthetic_share),
    synthetic_count: Math.trunc(Number(ps.synthetic_count) || 0),
    real_count: Math.trunc(Number(ps.real_count) || 0),
    synthetic_root: String(synthetic_root || ''),
    eval_universe_root: String(eval_universe_root || ''),
    operating_point: cr.operating_point || {},
    per_tier_counts: cr.per_tier_counts || { tier1: 0, tier2: 0, tier3: 0 },
    contamination_count: Math.trunc(Number(cr.contamination_count) || 0),
    contamination_rate: round4(cr.contamination_rate),
    contamination_coverage: cr.contamination_coverage || 'lexical_only',
    tier3_status: cr.tier3_status || 'skipped',
    predicate: {
      contaminated: pred.contaminated === true,
      max_allowed_rate: Number.isFinite(Number(pred.max_allowed_rate)) ? Number(pred.max_allowed_rate) : 0.0,
    },
    generated_at: generated_at || new Date().toISOString(),
  };
  block.hash = sha256(canonicalJson(block));
  return block;
}

// validateEvalDecontamBlock(block) - re-hashes canonical-minus-hash and
// re-checks hex64 roots + spec, throwing on drift. Identical discipline to
// validateExternalHoldoutBlock / validateTenantShadowBlock.
export function validateEvalDecontamBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('eval-decontam: block must be an object');
  }
  if (block.spec !== EVAL_DECONTAM_SPEC_VERSION) {
    throw new Error(`eval-decontam: block.spec='${block.spec}' expected '${EVAL_DECONTAM_SPEC_VERSION}'`);
  }
  for (const k of ['synthetic_share', 'synthetic_count', 'real_count', 'synthetic_root',
    'eval_universe_root', 'operating_point', 'per_tier_counts', 'contamination_count',
    'contamination_rate', 'contamination_coverage', 'tier3_status', 'predicate', 'generated_at']) {
    if (block[k] == null) {
      throw new Error(`eval-decontam: block missing field '${k}'`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(block.synthetic_root)) {
    throw new Error('eval-decontam: synthetic_root not hex64');
  }
  if (!/^[0-9a-f]{64}$/.test(block.eval_universe_root)) {
    throw new Error('eval-decontam: eval_universe_root not hex64');
  }
  if (block.operating_point && Number(block.operating_point.ngram) !== NGRAM) {
    throw new Error(`eval-decontam: operating_point.ngram=${block.operating_point.ngram} expected ${NGRAM}`);
  }
  const { hash: declared, ...rest } = block;
  const recomputed = sha256(canonicalJson(rest));
  if (declared !== recomputed) {
    throw new Error(`eval-decontam: block hash drift - declared ${declared}, recomputed ${recomputed}`);
  }
  return block;
}

// ===========================================================================
// Convenience driver: compose the full stage in one call. The COMPILE driver
// calls this AFTER curate returns (curate never sees the holdout); it passes
// curate's synthetic-tagged output as `rows`.
// ===========================================================================
export function runEvalDecontamStage({ rows, evalIndexArgs, cascadeOpts, predicateOpts, gateOpts, k_score, generated_at } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const { real, synthetic } = partitionBySource(all);

  const evalIndex = buildEvalIndex(evalIndexArgs || {});
  const cascade = runMembershipCascade({ syntheticRows: synthetic, evalIndex, opts: cascadeOpts });

  const synthRootBuilt = buildSyntheticRoot(cascade.passed);
  const evalRootBuilt = buildEvalUniverseRoot(evalIndex);

  const predicate = contaminationPredicate(cascade, predicateOpts || {});
  const block = buildEvalDecontamBlock({
    provenance_summary: {
      synthetic_share: syntheticShare(all),
      synthetic_count: synthetic.length,
      real_count: real.length,
    },
    cascadeResult: cascade,
    synthetic_root: synthRootBuilt.rootHex,
    eval_universe_root: evalRootBuilt.rootHex,
    predicate,
    generated_at,
  });

  const gatedKScore = applyContaminationGate(k_score, predicate, gateOpts || {});

  return {
    real,
    synthetic,
    passed_synthetic: cascade.passed,
    cascade,
    evalIndex,
    synthetic_tree: synthRootBuilt.tree,
    eval_universe_tree: evalRootBuilt.tree,
    predicate,
    block,
    k_score: gatedKScore,
  };
}

export default {
  EVAL_DECONTAM_SPEC_VERSION,
  normalizeProvenance,
  partitionBySource,
  syntheticShare,
  buildEvalIndex,
  runMembershipCascade,
  resolveTier3,
  buildSyntheticRoot,
  buildEvalUniverseRoot,
  contaminationPredicate,
  applyContaminationGate,
  buildEvalDecontamBlock,
  validateEvalDecontamBlock,
  runEvalDecontamStage,
};
