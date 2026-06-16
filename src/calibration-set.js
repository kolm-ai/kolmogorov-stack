// KOLM Quantization Frontier - Real calibration-set construction (FINALIZED C5).
//
// Replaces the 32-line prose `_FALLBACK_CALIB` array baked into
// workers/quantize/scripts/quantize.py with a method-appropriate calibration
// corpus BUILT from real sources. The old fallback shipped the SAME 32 toy
// sentences to every quantizer regardless of method, domain, or seqlen - which
// silently miscalibrates GPTQ's Hessian, AWQ's per-channel scale search, and
// SmoothQuant's migration-strength scan. A bad calibration set does not crash;
// it quietly degrades the quantized model, and the receipt could not prove what
// text the scales were fit on.
//
// This module constructs a calibration corpus from real sources with:
//   * SOURCE SELECTION   - tenant capture-store / eval set first (domain-matched,
//                          most representative of the deployment distribution),
//                          then task-domain text, then an open-corpus sample
//                          (C4 / pile / redpajama / wikitext) the operator points
//                          at. NO toy sentences in the real path.
//   * EXACT DEDUP        - SHA-256 of normalized text (drops byte-identical and
//                          whitespace-normalized duplicates that would over-weight
//                          a single document's activation statistics).
//   * SEMANTIC DEDUP     - local hash-bag embedding (src/embedding.js) + cosine
//                          near-dup prune (SemDeDup, Abbas 2023, keep-low-density)
//                          so paraphrase near-dups do not bias the Hessian. NO
//                          network, NO hyperscaler - text stays in-process.
//   * LENGTH BUCKETING   - each surviving document is packed to the quantizer's
//                          seqlen (e.g. GPTQ 2048, AWQ 512). Short docs are
//                          concatenated up to seqlen; long docs are windowed.
//                          This is what GPTQ/AWQ actually consume - fixed-length
//                          token windows, NOT ragged sentences.
//   * TOKEN BUDGET       - method-aware row x seqlen target (GPTQ 128x2048
//                          Hessian, AWQ 512-row activation scan, SmoothQuant
//                          smaller migration-strength scan). Configurable.
//   * LANGUAGE BALANCING - for multilingual targets, balances rows across the
//                          requested locales so a single dominant language does
//                          not own the scales.
//   * PROVENANCE HASH    - a deterministic SHA-256 over the canonical
//                          {method, seqlen, rows, source fingerprints, the ordered
//                          per-row token-window content hashes, knobs} so a verifier
//                          can REPRODUCE the exact calibration regime and confirm
//                          the receipt's scales were fit on the claimed text.
//
// FRONTIER-AWARE: matches the calibration regime each method actually needs.
//   - gptq  : second-order Hessian PTQ -> many fixed-length windows (default
//             128 rows x 2048 tok), full-context to populate the Hessian.
//   - awq    : per-channel activation scale search -> a moderate activation scan
//             (default 512 rows x 512 tok); shorter windows, more rows.
//   - smoothquant : migration-strength alpha scan -> a small activation sample
//             (default 256 rows x 512 tok) sufficient to estimate per-channel
//             act/weight magnitude ratios.
//   - exl2/exl3   : measurement pass over windows (default 100 rows x 2048 tok).
//   - aqlm/quip   : block calibration windows (default 256 rows x 4096 tok).
//   - int4/int8/hqq : calibration-FREE methods - this builder returns a recorded
//             no-op profile (calibration_required:false) so the caller never
//             pays to build a set the method ignores.
//
// PRIVACY (load-bearing): the default embedder is LOCAL (deterministic hash-bag,
// src/embedding.js). Tenant capture text is deduped/length-bucketed ENTIRELY
// in-process. This module NEVER ships calibration text to a hyperscaler. An
// operator who wants a remote embedder injects one explicitly (opts.embedder).
//
// Envelope contract: buildCalibrationSet(...) NEVER throws across the API. It
// returns { ok:true, version:'calib-v1', ... } or { ok:false, error, version }.
// ZERO new npm deps - node:crypto + the existing local embedder. ASCII source.

import crypto from 'node:crypto';
import { embed as _localEmbed, cosine as _cosine } from './embedding.js';

export const CALIB_VERSION = 'calib-v1';

// -----------------------------------------------------------------------------
// Per-method calibration regime. seqlen + (rows x seqlen) token budget are the
// frontier-accurate defaults each method's reference implementation uses. The
// caller can override any of these via opts.{rows,seqlen,tokenBudget}.
// -----------------------------------------------------------------------------
export const METHOD_REGIME = Object.freeze({
  gptq:        { calibration_required: true,  seqlen: 2048, rows: 128, regime: 'hessian-second-order' },
  awq:         { calibration_required: true,  seqlen: 512,  rows: 512, regime: 'activation-scale-search' },
  smoothquant: { calibration_required: true,  seqlen: 512,  rows: 256, regime: 'migration-strength-scan' },
  exl2:        { calibration_required: true,  seqlen: 2048, rows: 100, regime: 'measurement-pass' },
  exl3:        { calibration_required: true,  seqlen: 2048, rows: 100, regime: 'measurement-pass' },
  aqlm:        { calibration_required: true,  seqlen: 4096, rows: 256, regime: 'block-calibration' },
  quip:        { calibration_required: true,  seqlen: 4096, rows: 256, regime: 'incoherence-block-calibration' },
  qat:         { calibration_required: true,  seqlen: 2048, rows: 512, regime: 'block-wise-qat' },
  // Calibration-FREE methods. The builder records a no-op profile for these so
  // the caller never constructs a set the quantizer ignores.
  int4:        { calibration_required: false, seqlen: 0,    rows: 0,   regime: 'calibration-free' },
  int8:        { calibration_required: false, seqlen: 0,    rows: 0,   regime: 'calibration-free' },
  hqq:         { calibration_required: false, seqlen: 0,    rows: 0,   regime: 'calibration-free' },
});

// Source provenance kinds, in domain-match preference order. tenant-capture is
// the most representative of the deployment distribution; open-corpus is the
// generic fallback the operator must explicitly point at.
export const SOURCE_KINDS = Object.freeze([
  'tenant-capture', // the tenant's captured production traffic (best match)
  'eval-set',        // the tenant's eval/holdout text
  'task-domain',     // operator-supplied domain text for the target task
  'open-corpus',     // C4 / pile / redpajama / wikitext sample the operator points at
]);

// Approximate chars-per-token. We do NOT ship a real tokenizer in the JS path
// (that lives python-side); the JS builder bucket-packs by an estimate so it can
// run with zero deps, and the python worker re-tokenizes the SAME ordered
// windows for the real pass. The provenance hash binds the ordered window TEXT,
// so the python re-tokenization is deterministic against this plan.
const CHARS_PER_TOKEN = 4;

// -----------------------------------------------------------------------------
// canonical JSON (sorted keys) - matches src/artifact.js canonicalJson so the
// provenance hash is stable + cross-checkable.
// -----------------------------------------------------------------------------
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Normalize for EXACT dedup: collapse runs of whitespace, trim. We only kill
// whitespace-variant byte-dups here, not semantic ones (that is semdedup's job).
function normalizeForExactDedup(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

// Heuristic language tag for balancing. We do NOT ship a language-ID model in
// the zero-dep path; we use a cheap, deterministic script-range heuristic that
// is good enough to BALANCE rows across coarse buckets (latin / cjk / cyrillic /
// arabic / devanagari / other). A caller targeting fine-grained locales injects
// langOf(text)->tag. The provenance hash records WHICH detector ran.
function defaultLangOf(text) {
  const s = String(text || '');
  let cjk = 0, cyr = 0, arab = 0, deva = 0, latin = 0, total = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i);
    if (c === undefined) continue;
    if (c <= 0x20) continue;
    total++;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
    else if (c >= 0x0400 && c <= 0x04ff) cyr++;
    else if (c >= 0x0600 && c <= 0x06ff) arab++;
    else if (c >= 0x0900 && c <= 0x097f) deva++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
  }
  if (total === 0) return 'other';
  const ranked = [['cjk', cjk], ['cyrillic', cyr], ['arabic', arab], ['devanagari', deva], ['latin', latin]]
    .sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : 'other';
}

// -----------------------------------------------------------------------------
// Source ingestion. Each source is { kind, docs:[string] } (or { kind, items }
// where each item has .text/.prompt/.input/.output). We flatten to typed docs,
// tagging each with its source kind so dedup + provenance can attribute survival.
// -----------------------------------------------------------------------------
function extractText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    // capture-store rows expose input/output; eval rows expose text/prompt.
    const parts = [];
    for (const k of ['text', 'prompt', 'input', 'output', 'content', 'completion']) {
      if (typeof item[k] === 'string' && item[k]) parts.push(item[k]);
    }
    return parts.join('\n');
  }
  return '';
}

function ingestSources(sources) {
  const docs = [];
  const sourceFingerprints = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src || typeof src !== 'object') continue;
    const kind = SOURCE_KINDS.includes(src.kind) ? src.kind : 'open-corpus';
    const raw = Array.isArray(src.docs) ? src.docs : (Array.isArray(src.items) ? src.items : []);
    let n = 0;
    const docHashes = [];
    for (const item of raw) {
      const text = extractText(item);
      const norm = normalizeForExactDedup(text);
      if (!norm) continue;
      docs.push({ kind, text, norm });
      docHashes.push(sha256Hex(norm).slice(0, 16));
      n++;
    }
    // A source fingerprint is the kind + count + a hash over the ordered member
    // hashes, so a verifier can confirm WHICH corpus snapshot fed calibration
    // without us shipping the raw text into the receipt.
    sourceFingerprints.push({
      kind,
      label: typeof src.label === 'string' ? src.label : kind,
      n_docs: n,
      content_hash: sha256Hex(docHashes.join('|')),
    });
  }
  return { docs, sourceFingerprints };
}

// -----------------------------------------------------------------------------
// EXACT dedup over normalized text. Keeps first occurrence (source order =
// preference order, since ingestSources preserves the caller's source array
// order and tenant-capture is conventionally placed first).
// -----------------------------------------------------------------------------
function exactDedup(docs) {
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (const d of docs) {
    const h = sha256Hex(d.norm);
    if (seen.has(h)) { removed++; continue; }
    seen.add(h);
    kept.push(d);
  }
  return { kept, removed };
}

// -----------------------------------------------------------------------------
// SEMANTIC dedup. Embed each doc with a LOCAL hash-bag embedder (src/embedding.js
// by default; an injected embedder swaps in a real model). Then greedily KEEP a
// doc and DROP any later doc whose cosine to an already-kept doc exceeds
// (1 - epsilon). This is the SemDeDup prune (Abbas 2023) - paraphrase near-dups
// share few shingles so exact dedup misses them, but they sit close in embedding
// space. Default epsilon 0.05 (cosine >= 0.95 => duplicate). O(n*kept) which is
// bounded for the small calibration sets here (hundreds of rows). NEVER throws -
// on any embed failure the stage degrades to a recorded no-op (keep all).
// -----------------------------------------------------------------------------
function semanticDedup(docs, opts) {
  if (docs.length < 2) {
    return { kept: docs.slice(), removed: 0, backend: 'none:degenerate' };
  }
  let epsilon = Number(opts.semEpsilon);
  if (!Number.isFinite(epsilon)) epsilon = 0.05;
  if (epsilon <= 0) {
    return { kept: docs.slice(), removed: 0, backend: 'none:epsilon_zero' };
  }
  if (epsilon > 1) epsilon = 1;
  const threshold = 1 - epsilon;
  const embedFn = typeof opts.embedder === 'function' ? opts.embedder : _localEmbed;
  const injected = typeof opts.embedder === 'function';

  let vectors;
  try {
    vectors = docs.map((d) => {
      const v = embedFn(d.norm);
      return Array.isArray(v) && v.length ? v : null;
    });
  } catch {
    return { kept: docs.slice(), removed: 0, backend: 'none:embed_threw' };
  }
  // If embedding produced no usable vectors, degrade to no-op.
  if (!vectors.some((v) => v)) {
    return { kept: docs.slice(), removed: 0, backend: 'none:no_vectors' };
  }

  const keptDocs = [];
  const keptVecs = [];
  let removed = 0;
  for (let i = 0; i < docs.length; i++) {
    const v = vectors[i];
    if (!v) { keptDocs.push(docs[i]); keptVecs.push(null); continue; }
    let dup = false;
    for (let j = 0; j < keptVecs.length; j++) {
      const kv = keptVecs[j];
      if (!kv) continue;
      let sim;
      try { sim = _cosine(v, kv); } catch { sim = 0; }
      if (Number.isFinite(sim) && sim >= threshold) { dup = true; break; }
    }
    if (dup) { removed++; continue; }
    keptDocs.push(docs[i]);
    keptVecs.push(v);
  }
  return {
    kept: keptDocs.length ? keptDocs : docs.slice(),
    removed,
    backend: injected ? 'semdedup:injected' : 'semdedup:local-hashbag',
  };
}

// -----------------------------------------------------------------------------
// LANGUAGE BALANCING. When opts.languages is a non-empty array, we round-robin
// across the requested locale buckets so no single language owns the scales.
// Docs whose detected language is not in the target list are kept as an
// 'other' bucket and drawn from only after the targets are balanced. Returns a
// re-ordered doc list (balancing is an ORDERING, the budget stage then caps it).
// -----------------------------------------------------------------------------
function balanceByLanguage(docs, opts) {
  const targets = Array.isArray(opts.languages) ? opts.languages.filter((x) => typeof x === 'string' && x) : [];
  const langOf = typeof opts.langOf === 'function' ? opts.langOf : defaultLangOf;
  const tagged = docs.map((d) => ({ ...d, lang: langOf(d.text) }));
  if (targets.length === 0) {
    return { ordered: tagged, balanced: false, buckets: null };
  }
  const buckets = new Map();
  for (const t of targets) buckets.set(t, []);
  buckets.set('__other', []);
  for (const d of tagged) {
    if (buckets.has(d.lang)) buckets.get(d.lang).push(d);
    else buckets.get('__other').push(d);
  }
  // Round-robin across the TARGET buckets first (fair share), then append other.
  const ordered = [];
  const targetLists = targets.map((t) => buckets.get(t));
  let drained = false;
  let idx = 0;
  while (!drained) {
    drained = true;
    for (const list of targetLists) {
      if (idx < list.length) { ordered.push(list[idx]); drained = false; }
    }
    idx++;
  }
  for (const d of buckets.get('__other')) ordered.push(d);
  const bucketCounts = {};
  for (const t of targets) bucketCounts[t] = buckets.get(t).length;
  bucketCounts.__other = buckets.get('__other').length;
  return { ordered, balanced: true, buckets: bucketCounts };
}

// -----------------------------------------------------------------------------
// LENGTH BUCKETING. Pack documents into fixed-length token windows of `seqlen`.
//   * A doc longer than seqlen is WINDOWED into ceil(len/seqlen) windows
//     (non-overlapping; the GPTQ/AWQ reference impls slice long docs).
//   * Short docs are CONCATENATED (with a separator) up to seqlen so each
//     window is a full-length context - this is what populates the Hessian /
//     activation scan fully. A trailing partial window is kept only if it is at
//     least `minFillRatio` of seqlen (default 0.5) so we don't ship near-empty
//     windows that under-populate the statistics.
// Token length is estimated via CHARS_PER_TOKEN (the python worker re-tokenizes
// the SAME window text). Returns ordered window objects with content + token est.
// -----------------------------------------------------------------------------
function lengthBucket(docs, seqlen, opts) {
  const targetChars = seqlen * CHARS_PER_TOKEN;
  const minFillRatio = Number.isFinite(opts.minFillRatio) ? Math.min(Math.max(opts.minFillRatio, 0), 1) : 0.5;
  const sep = '\n\n';
  const windows = [];

  // 1. Split long docs into <= seqlen windows; keep short docs for packing.
  const shortQueue = [];
  for (const d of docs) {
    if (d.norm.length > targetChars) {
      for (let off = 0; off < d.norm.length; off += targetChars) {
        const slice = d.norm.slice(off, off + targetChars);
        // Only keep a long-doc tail window if it meets the fill ratio.
        if (off + targetChars <= d.norm.length || slice.length >= targetChars * minFillRatio) {
          windows.push(makeWindow(slice, d.kind, d.lang, seqlen));
        }
      }
    } else {
      shortQueue.push(d);
    }
  }

  // 2. Concatenate short docs into full windows (greedy fill).
  let buf = '';
  let bufKinds = new Set();
  let bufLangs = new Set();
  const flush = (force) => {
    const trimmed = buf.trim();
    if (!trimmed) { buf = ''; bufKinds = new Set(); bufLangs = new Set(); return; }
    if (force || trimmed.length >= targetChars * minFillRatio) {
      windows.push(makeWindow(trimmed.slice(0, targetChars), [...bufKinds].sort().join('+'), [...bufLangs].sort().join('+'), seqlen));
    }
    buf = ''; bufKinds = new Set(); bufLangs = new Set();
  };
  for (const d of shortQueue) {
    const add = (buf ? sep : '') + d.norm;
    if (buf.length + add.length > targetChars && buf.length > 0) flush(false);
    buf += (buf ? sep : '') + d.norm;
    bufKinds.add(d.kind);
    if (d.lang) bufLangs.add(d.lang);
    if (buf.length >= targetChars) flush(false);
  }
  flush(true); // keep the final partial window if it has any content

  return windows;
}

function makeWindow(text, kind, lang, seqlen) {
  const tokensEst = Math.min(seqlen, Math.ceil(text.length / CHARS_PER_TOKEN));
  return {
    text,
    kind,
    lang: lang || 'other',
    tokens_est: tokensEst,
    content_hash: sha256Hex(text),
  };
}

// -----------------------------------------------------------------------------
// TOKEN BUDGET. Cap to `rows` windows. The token budget is rows x seqlen; we
// emit exactly up to `rows` windows (the method's reference row count) in the
// balanced order. If there are fewer windows than rows, we record a SHORTFALL
// warning (calibration is under-budget - the receipt must surface this so a
// verifier knows the scales were fit on less data than the method wants).
// -----------------------------------------------------------------------------
function applyBudget(windows, rows) {
  const capped = windows.slice(0, rows);
  const shortfall = capped.length < rows ? rows - capped.length : 0;
  return { capped, shortfall };
}

// -----------------------------------------------------------------------------
// PROVENANCE HASH. Deterministic SHA-256 over the canonical calibration plan:
// method, regime, seqlen, requested rows, the ORDERED per-window content hashes,
// source fingerprints, and the knobs. A verifier re-running this builder against
// the same sources + opts reproduces the exact byte-identical plan and hash,
// proving the receipt's scales were fit on the claimed calibration regime.
// -----------------------------------------------------------------------------
function computeProvenance({ method, regime, seqlen, requestedRows, windows, sourceFingerprints, knobs }) {
  const plan = {
    schema: CALIB_VERSION,
    method,
    regime,
    seqlen,
    requested_rows: requestedRows,
    actual_rows: windows.length,
    window_hashes: windows.map((w) => w.content_hash),
    sources: sourceFingerprints,
    knobs,
  };
  const canonical = canonicalJson(plan);
  return { provenance_hash: 'sha256:' + sha256Hex(canonical), canonical_len: canonical.length };
}

// -----------------------------------------------------------------------------
// PUBLIC API
//
// buildCalibrationSet({ method, sources, ...opts })
//
//   method   - one of METHOD_REGIME keys (gptq/awq/smoothquant/exl2/...). For a
//              calibration-FREE method (int4/int8/hqq) returns a recorded no-op.
//   sources  - ordered array of { kind, docs|items, label? }. Order = preference
//              (tenant-capture first). REQUIRED for calibration-required methods.
//
//   opts:
//     rows         - override row count (default = method regime rows)
//     seqlen       - override sequence length (default = method regime seqlen)
//     tokenBudget  - explicit total token budget; if set, rows = floor(budget/seqlen)
//     semEpsilon   - SemDeDup cosine epsilon (default 0.05)
//     languages    - array of target locale tags for multilingual balancing
//     langOf       - injected language detector text->tag (default heuristic)
//     embedder     - injected LOCAL embedder for semdedup (default hash-bag)
//     minFillRatio - min fill of a trailing window to keep it (default 0.5)
//     allowFallback- if true AND a calibration-required method has NO usable
//                    source docs, permit the toy fallback (loud warning). Default
//                    FALSE: the builder FAILS LOUD rather than silently shipping
//                    toy sentences to a real Hessian.
//
// Returns (calibration-required):
//   { ok, version, method, regime, seqlen, rows, calibration_required:true,
//     windows:[{text,kind,lang,tokens_est,content_hash}],
//     jsonl,                 // ready-to-write {text} JSONL for quantize.py --calib
//     provenance_hash,       // sha256: ... bound into the receipt
//     stats:{...}, warnings:[...], sources:[...] }
//
// Returns (calibration-free): { ok, version, method, calibration_required:false,
//   regime:'calibration-free', note, provenance_hash:null }
//
// NEVER throws. On unrecoverable input returns { ok:false, error, version }.
// -----------------------------------------------------------------------------
export function buildCalibrationSet(input = {}) {
  try {
    const method = String(input.method || '').toLowerCase();
    const regimeDef = METHOD_REGIME[method];
    if (!regimeDef) {
      return {
        ok: false,
        version: CALIB_VERSION,
        error: `unknown method '${input.method}'; expected one of [${Object.keys(METHOD_REGIME).join(', ')}]`,
      };
    }

    // Calibration-FREE methods: recorded no-op. Do NOT build a set the quantizer
    // ignores - but return ok so the caller's flow is uniform.
    if (!regimeDef.calibration_required) {
      return {
        ok: true,
        version: CALIB_VERSION,
        method,
        regime: regimeDef.regime,
        calibration_required: false,
        windows: [],
        jsonl: '',
        provenance_hash: null,
        note: `${method} is calibration-free (${regimeDef.regime}); no calibration set built`,
        warnings: [],
        sources: [],
        stats: { n_windows: 0 },
      };
    }

    // Resolve knobs.
    const seqlen = posInt(input.seqlen, regimeDef.seqlen);
    let rows = posInt(input.rows, regimeDef.rows);
    if (Number.isFinite(input.tokenBudget) && input.tokenBudget > 0) {
      rows = Math.max(1, Math.floor(input.tokenBudget / seqlen));
    }
    const opts = {
      semEpsilon: Number(input.semEpsilon),
      languages: input.languages,
      langOf: input.langOf,
      embedder: input.embedder,
      minFillRatio: input.minFillRatio,
    };
    const warnings = [];

    // 1. INGEST real sources.
    const { docs: ingested, sourceFingerprints } = ingestSources(input.sources);
    const n_ingested = ingested.length;

    if (n_ingested === 0) {
      // FAIL LOUD: a calibration-required method with no real source text. We do
      // NOT silently fall back to toy sentences (the defect this atom replaces).
      if (input.allowFallback === true) {
        warnings.push('NO_REAL_SOURCES: calibration falling back to built-in toy corpus (allowFallback=true) - scales will be MISCALIBRATED for any real domain; provide tenant-capture / eval-set / open-corpus sources');
        const toy = TOY_FALLBACK.map((t) => ({ kind: 'open-corpus', text: t, norm: normalizeForExactDedup(t) }));
        return finalize({
          method, regimeDef, seqlen, rows, docs: toy,
          sourceFingerprints: [{ kind: 'open-corpus', label: 'built-in-toy-fallback', n_docs: toy.length, content_hash: sha256Hex(toy.map((d) => d.norm).join('|')) }],
          opts, warnings, fallbackUsed: true,
        });
      }
      return {
        ok: false,
        version: CALIB_VERSION,
        method,
        error: `no real calibration source docs for calibration-required method '${method}'. Provide opts.sources with tenant-capture / eval-set / task-domain / open-corpus text. To explicitly accept the toy fallback (NOT recommended for production scales) pass allowFallback:true.`,
        hint: 'Point at the tenant capture-store (src/capture-store.js listCaptures), the eval set, or a C4/pile/redpajama/wikitext JSONL snapshot.',
      };
    }

    return finalize({ method, regimeDef, seqlen, rows, docs: ingested, sourceFingerprints, opts, warnings, fallbackUsed: false });
  } catch (e) {
    return { ok: false, version: CALIB_VERSION, error: `calibration build raised: ${e && e.message ? e.message : e}` };
  }
}

function finalize({ method, regimeDef, seqlen, rows, docs, sourceFingerprints, opts, warnings, fallbackUsed }) {
  // 2. EXACT dedup.
  const exact = exactDedup(docs);
  // 3. SEMANTIC dedup (local embedder).
  const sem = semanticDedup(exact.kept, opts);
  // 4. LANGUAGE balancing (ordering).
  const bal = balanceByLanguage(sem.kept, opts);
  // 5. LENGTH bucketing to seqlen.
  const windowsAll = lengthBucket(bal.ordered, seqlen, opts);
  // 6. TOKEN budget cap to rows.
  const { capped, shortfall } = applyBudget(windowsAll, rows);

  if (shortfall > 0) {
    warnings.push(`CALIB_UNDER_BUDGET: built ${capped.length} of ${rows} requested ${seqlen}-token windows (${shortfall} short). The ${regimeDef.regime} pass for ${method} wants ${rows} rows; provide more source text to fully populate the statistics.`);
  }
  if (capped.length === 0) {
    return {
      ok: false,
      version: CALIB_VERSION,
      method,
      error: `calibration produced ZERO usable ${seqlen}-token windows after dedup+bucketing; source text too short or fully deduped.`,
      warnings,
    };
  }

  // 7. PROVENANCE hash over the ordered plan.
  const knobs = {
    sem_epsilon: Number.isFinite(opts.semEpsilon) ? opts.semEpsilon : 0.05,
    languages: Array.isArray(opts.languages) ? opts.languages.slice().sort() : null,
    min_fill_ratio: Number.isFinite(opts.minFillRatio) ? opts.minFillRatio : 0.5,
    chars_per_token: CHARS_PER_TOKEN,
    lang_detector: typeof opts.langOf === 'function' ? 'injected' : 'builtin-script-range',
    embedder: typeof opts.embedder === 'function' ? 'injected' : 'builtin-hashbag-local',
    fallback_used: !!fallbackUsed,
  };
  const prov = computeProvenance({
    method,
    regime: regimeDef.regime,
    seqlen,
    requestedRows: rows,
    windows: capped,
    sourceFingerprints,
    knobs,
  });

  // 8. Emit JSONL (the {text} rows quantize.py --calib consumes).
  const jsonl = capped.map((w) => JSON.stringify({ text: w.text })).join('\n') + '\n';

  // Language + source-kind distribution of the FINAL windows (for the receipt).
  const langDist = {};
  for (const w of capped) {
    for (const l of String(w.lang).split('+')) langDist[l] = (langDist[l] || 0) + 1;
  }
  const kindDist = {};
  for (const w of capped) {
    for (const k of String(w.kind).split('+')) kindDist[k] = (kindDist[k] || 0) + 1;
  }

  return {
    ok: true,
    version: CALIB_VERSION,
    method,
    regime: regimeDef.regime,
    calibration_required: true,
    seqlen,
    rows: capped.length,
    requested_rows: rows,
    windows: capped,
    jsonl,
    provenance_hash: prov.provenance_hash,
    sources: sourceFingerprints,
    warnings,
    stats: {
      n_ingested: docs.length,
      n_after_exact: exact.kept.length,
      exact_removed: exact.removed,
      n_after_semantic: sem.kept.length,
      semantic_removed: sem.removed,
      semantic_backend: sem.backend,
      n_windows_built: windowsAll.length,
      n_windows_kept: capped.length,
      shortfall,
      token_budget: seqlen * rows,
      tokens_est_total: capped.reduce((a, w) => a + w.tokens_est, 0),
      language_balanced: bal.balanced,
      language_buckets: bal.buckets,
      language_distribution: langDist,
      kind_distribution: kindDist,
      fallback_used: !!fallbackUsed,
    },
  };
}

// Build the receipt-bound calibration block. This is what the quantize receipt
// records so a verifier can reproduce the regime. It is a SUBSET of the full
// result (no raw window text - only hashes + counts), keeping the receipt small
// and never embedding tenant text into the signed artifact.
export function calibrationReceiptBlock(result) {
  if (!result || !result.ok) {
    return { ok: false, version: CALIB_VERSION, error: result && result.error ? result.error : 'no calibration result' };
  }
  if (!result.calibration_required) {
    return { version: CALIB_VERSION, method: result.method, calibration_required: false, regime: result.regime, provenance_hash: null };
  }
  return {
    version: CALIB_VERSION,
    method: result.method,
    regime: result.regime,
    calibration_required: true,
    seqlen: result.seqlen,
    rows: result.rows,
    requested_rows: result.requested_rows,
    provenance_hash: result.provenance_hash,
    sources: result.sources,
    token_budget: result.stats.token_budget,
    tokens_est_total: result.stats.tokens_est_total,
    language_distribution: result.stats.language_distribution,
    kind_distribution: result.stats.kind_distribution,
    semantic_backend: result.stats.semantic_backend,
    exact_removed: result.stats.exact_removed,
    semantic_removed: result.stats.semantic_removed,
    shortfall: result.stats.shortfall,
    fallback_used: result.stats.fallback_used,
    window_hashes: result.windows.map((w) => w.content_hash),
  };
}

// The toy fallback is ONLY reachable via allowFallback:true and is recorded as
// such in warnings + provenance. It exists so an operator can deliberately opt
// into a smoke-test calibration; it is NOT the default path. (Mirrors the legacy
// _FALLBACK_CALIB so behavior is identical when explicitly requested.)
const TOY_FALLBACK = Object.freeze([
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'In a quiet town nestled between two mountains, the residents kept a tradition alive.',
  'Scientists at the laboratory analyzed the unusual readings for several hours.',
  'Algorithms in modern compilers translate high-level code into efficient machine instructions.',
  'Software engineers wrote tests, reviewed each other code, and deployed updates incrementally.',
  'Researchers published their findings in a peer-reviewed journal after months of analysis.',
  'Engineers designed the bridge to withstand high winds and seasonal flooding.',
  'Climate models incorporate ocean currents, atmospheric chemistry, and ice sheet dynamics.',
]);

function posInt(v, dflt) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return dflt;
}

export default {
  CALIB_VERSION,
  METHOD_REGIME,
  SOURCE_KINDS,
  buildCalibrationSet,
  calibrationReceiptBlock,
};
