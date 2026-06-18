// src/namespace-fingerprint.js - W715 cross-namespace transfer learning.
//
// Closes W707 system-upgrade item: "New user starts with zero captures →
// bootstrap from anonymized patterns of similar namespaces". The mechanism
// is a privacy-safe similarity vector computed from a tenant's captures:
//   token-frequency hashes + topic word-bag SHA256.
//
// PRIVACY LOCK (W715-5):
//   The fingerprint payload is the ONLY thing that can ever cross a tenant
//   boundary in this surface. By construction it contains:
//     - hashes (sha256 hex)
//     - integer counts
//     - one vertical guess label from a closed enum
//   It MUST NOT contain raw capture text, usernames, emails, API keys, IPs,
//   or any free-form string sourced from the captures themselves. The
//   wave715 #8 test scans JSON.stringify(fp) with anti-leak regexes; do not
//   weaken that assertion.
//
// VERTICAL STUBS (W715-3):
//   The vertical dictionary below is a SCAFFOLD for W751-W755 (per-vertical
//   warm-start libraries). It is intentionally tiny - ~20 seed terms each - 
//   enough to route a brand-new namespace to one of {legal, medical, code,
//   finance, support, general}. W751-W755 will replace the per-vertical
//   stub arrays with curated, attested term lists; the function shape
//   (verticalGuess(token_counts)) does not change.
//
// OPT-IN DEFAULT OFF (W715-4):
//   Computing a fingerprint is free for the owning tenant. SHARING a
//   fingerprint to seed siblings requires explicit opt-in via the new
//   namespace consent form; src/binder.js recordFingerprintShare audits
//   every cross-tenant share so a tenant can prove what left their account.
//
// No external deps. Pure node:crypto + array math.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FINGERPRINT_VERSION = 'w715-v1';
export const FINGERPRINT_CONTRACT_VERSION = 'w712-v1';
export const TOP_TERMS_K = 32;
export const MIN_TOKEN_LENGTH = 2;
export const MAX_TOKEN_LENGTH = 32;
export const FINGERPRINT_LIMITS = Object.freeze({
  max_captures: 5000,
  max_text_chars_per_capture: 24000,
  max_messages_per_capture: 64,
  max_nearest_k: 50,
  max_fingerprint_file_bytes: 1024 * 1024,
  max_namespace_chars: 128,
});

const SAFE_NAMESPACE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const FP_ID_RE = /^fp_[a-f0-9]{24}$/;

// VERTICAL_STUBS - scaffold for W751-W755. Each list is a tiny seed of
// distinctive single-word terms for the vertical. The matcher is dumb on
// purpose: count overlap between captured tokens and each vertical's
// dictionary, pick the max. Tie → 'general'. Do NOT add PII categories
// here; per-tenant verticals belong in tenant config, not this scaffold.
//
// Each list is normalized to lowercase a-z0-9 (the same alphabet
// _tokenize() emits) so the dictionary lookup is exact-match cheap.
export const VERTICAL_STUBS = Object.freeze({
  legal: Object.freeze([
    'contract', 'plaintiff', 'defendant', 'clause', 'jurisdiction',
    'liability', 'tort', 'indemnify', 'covenant', 'arbitration',
    'breach', 'damages', 'statute', 'precedent', 'litigation',
    'discovery', 'deposition', 'subpoena', 'counsel', 'redaction',
  ]),
  medical: Object.freeze([
    'patient', 'diagnosis', 'symptom', 'prognosis', 'dosage',
    'mgkg', 'icd10', 'cpt', 'ehr', 'phi',
    'clinical', 'pharmacy', 'allergy', 'comorbid', 'biopsy',
    'oncology', 'cardiology', 'radiology', 'triage', 'discharge',
  ]),
  code: Object.freeze([
    'function', 'method', 'class', 'import', 'return',
    'await', 'async', 'const', 'export', 'throw',
    'commit', 'pullrequest', 'compiler', 'stacktrace', 'segfault',
    'mutex', 'closure', 'pointer', 'kernel', 'syscall',
  ]),
  finance: Object.freeze([
    'invoice', 'refund', 'chargeback', 'payable', 'receivable',
    'amortize', 'depreciation', 'liability', 'equity', 'asset',
    'gaap', 'ifrs', 'audit', 'reconcile', 'ledger',
    'journal', 'subscription', 'mrr', 'arr', 'churn',
  ]),
  support: Object.freeze([
    'ticket', 'reset', 'login', 'password', 'reproduce',
    'bug', 'crash', 'workaround', 'install', 'uninstall',
    'subscription', 'cancel', 'upgrade', 'downgrade', 'refund',
    'screenshot', 'log', 'console', 'error', 'timeout',
  ]),
});

function _tokenize(text) {
  // Lowercase, strip non a-z0-9 + space, split, length-bound. The bounds
  // both compress the fingerprint (drop 'a', 'i', filler) and remove
  // accidental leak vectors (an entire stack-trace path is one giant
  // "word" until split).
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const lowered = text.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ');
  for (const raw of lowered.split(/\s+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (raw.length > MAX_TOKEN_LENGTH) continue;
    out.push(raw);
  }
  return out;
}

function _bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(tokens[i] + ' ' + tokens[i + 1]);
  return out;
}

function _sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function _namespaceHash(namespace) {
  if (namespace == null || namespace === '') return null;
  return _sha256Hex(FINGERPRINT_VERSION + ':namespace:' + String(namespace));
}

function _safeNamespace(namespace) {
  if (namespace == null || namespace === '') return null;
  const s = String(namespace).slice(0, FINGERPRINT_LIMITS.max_namespace_chars);
  if (SAFE_NAMESPACE_RE.test(s)) return s;
  return 'ns_' + _namespaceHash(namespace).slice(0, 24);
}

function _boundedText(s) {
  return String(s == null ? '' : s).slice(0, FINGERPRINT_LIMITS.max_text_chars_per_capture);
}

function _extractText(capture) {
  // Captures land in many shapes from many surfaces (chat, agent trace,
  // connector). We read in priority order: explicit text fields first,
  // then output/response, never raw_body/raw_text (those keep PII).
  if (!capture || typeof capture !== 'object') return '';
  if (typeof capture.text === 'string') return _boundedText(capture.text);
  const parts = [];
  if (typeof capture.prompt === 'string') parts.push(capture.prompt);
  if (typeof capture.input === 'string') parts.push(capture.input);
  if (typeof capture.user_input === 'string') parts.push(capture.user_input);
  if (typeof capture.output === 'string') parts.push(capture.output);
  if (typeof capture.response === 'string') parts.push(capture.response);
  if (typeof capture.completion === 'string') parts.push(capture.completion);
  if (typeof capture.assistant === 'string') parts.push(capture.assistant);
  // Tool-call style messages - pull every string-typed message[].content.
  if (Array.isArray(capture.messages)) {
    for (const m of capture.messages.slice(0, FINGERPRINT_LIMITS.max_messages_per_capture)) {
      if (m && typeof m.content === 'string') parts.push(m.content);
    }
  }
  return _boundedText(parts.join(' '));
}

// verticalGuess(token_counts) → one of {legal, medical, code, finance,
// support, general}. Pure overlap-count over VERTICAL_STUBS; tie or zero
// overlap → 'general'.
export function verticalGuess(token_counts) {
  if (!token_counts || typeof token_counts !== 'object') return 'general';
  const scores = {};
  let best = 'general';
  let bestScore = 0;
  for (const [v, terms] of Object.entries(VERTICAL_STUBS)) {
    let s = 0;
    for (const term of terms) {
      const c = token_counts[term];
      if (typeof c === 'number' && c > 0) s += c;
    }
    scores[v] = s;
    if (s > bestScore) {
      bestScore = s;
      best = v;
    } else if (s === bestScore && bestScore > 0 && v < best) {
      // Deterministic tie-break: alphabetical wins. Avoids the "first
      // vertical inserted" leak that would let an attacker probe ordering.
      best = v;
    }
  }
  return bestScore > 0 ? best : 'general';
}

// computeFingerprint({captures, namespace}) → fingerprint object.
//
// Honest empty: captures=[] returns {ok:true, n_captures:0, ...} with empty
// hashes - never throws. (W715 standing directive #1.)
//
// Privacy lock: returned object passes through JSON.stringify with NO raw
// capture text (W715 test #8 enforces).
export function computeFingerprint(opts = {}) {
  const rawCaptures = Array.isArray(opts.captures) ? opts.captures : [];
  const captures = rawCaptures.slice(0, FINGERPRINT_LIMITS.max_captures);
  const rawNamespace = typeof opts.namespace === 'string' ? opts.namespace : null;
  const namespace = _safeNamespace(rawNamespace);
  const namespace_hash = _namespaceHash(rawNamespace);

  if (captures.length === 0) {
    // Honest empty envelope. Same shape as the populated path so consumers
    // never have to branch - they just see n_captures=0 + zeroed hashes.
    return {
      version: FINGERPRINT_VERSION,
      contract_version: FINGERPRINT_CONTRACT_VERSION,
      namespace,
      namespace_hash,
      n_captures: 0,
      n_captures_seen: rawCaptures.length,
      captures_truncated: rawCaptures.length > FINGERPRINT_LIMITS.max_captures,
      n_tokens: 0,
      n_unique_terms: 0,
      token_bag_hash: ''.padEnd(64, '0'),
      top_terms_hash_array: [],
      vertical_guess: 'general',
      fingerprint_id: 'fp_' + _sha256Hex(FINGERPRINT_VERSION + ':empty:' + (namespace || '')).slice(0, 24),
      computed_at: new Date().toISOString(),
    };
  }

  // Count single tokens (for vertical guess) + bigrams (for the top-terms
  // hash array - bigrams give better discrimination than unigrams over
  // small N while still being privacy-safe under sha256).
  const token_counts = Object.create(null);
  const bigram_counts = Object.create(null);
  let n_tokens = 0;
  for (const c of captures) {
    const text = _extractText(c);
    const toks = _tokenize(text);
    n_tokens += toks.length;
    for (const t of toks) token_counts[t] = (token_counts[t] || 0) + 1;
    for (const bg of _bigrams(toks)) bigram_counts[bg] = (bigram_counts[bg] || 0) + 1;
  }

  // token_bag_hash = sha256 over the sorted (term, count) pairs of EVERY
  // bigram. This is determinstic across calls on the same captures. It is
  // intentionally a single hash (not a vector) - used as a quick "are these
  // two fingerprints byte-identical?" check for caching / dedup.
  const bagEntries = Object.entries(bigram_counts).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const bagCanonical = bagEntries.map(([k, v]) => k + ':' + v).join('|');
  const token_bag_hash = _sha256Hex(FINGERPRINT_VERSION + ':bag:' + bagCanonical);

  // top_terms_hash_array = sha256(bigram) for the top-K bigrams by count,
  // breaking ties alphabetically. K=32 is enough to compute Jaccard over.
  // We hash each bigram individually so the receiver sees a vector of
  // opaque IDs - they cannot reverse a hash to a phrase but they CAN take
  // set intersections (the W715 cosineSimilarity primitive).
  const ranked = Object.entries(bigram_counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : 1;
  }).slice(0, TOP_TERMS_K);
  const top_terms_hash_array = ranked.map(([bg]) => _sha256Hex(FINGERPRINT_VERSION + ':term:' + bg));

  const vertical_guess = verticalGuess(token_counts);
  const fingerprint_id = 'fp_' + _sha256Hex(
    FINGERPRINT_VERSION + ':' + (namespace || '') + ':' + token_bag_hash
  ).slice(0, 24);

  return {
    version: FINGERPRINT_VERSION,
    contract_version: FINGERPRINT_CONTRACT_VERSION,
    namespace,
    namespace_hash,
    n_captures: captures.length,
    n_captures_seen: rawCaptures.length,
    captures_truncated: rawCaptures.length > FINGERPRINT_LIMITS.max_captures,
    n_tokens,
    n_unique_terms: Object.keys(bigram_counts).length,
    token_bag_hash,
    top_terms_hash_array,
    vertical_guess,
    fingerprint_id,
    computed_at: new Date().toISOString(),
  };
}

// cosineSimilarity(fp1, fp2) - Jaccard over top_terms_hash_array (the
// hashed bigram set), since the underlying tokens are opaque. Named
// `cosineSimilarity` because callers think in cosine-of-vectors terms,
// but Jaccard is the honest math for a set of opaque hashes:
//   |A ∩ B| / |A ∪ B|
// Range [0, 1]; identical → 1.0; disjoint → 0.0.
export function cosineSimilarity(fp1, fp2) {
  if (!fp1 || !fp2) return 0;
  const a = _hashArray(fp1.top_terms_hash_array);
  const b = _hashArray(fp2.top_terms_hash_array);
  if (a.length === 0 && b.length === 0) {
    // Two empty fingerprints. Returning 1 would say "perfect siblings"
    // which is misleading; returning 0 is honest "no signal to compare".
    return 0;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// findNearestNamespaces(target_fp, candidate_fps, k) - ranked list of the
// top-K siblings by cosineSimilarity, descending. Each entry carries only a
// safe namespace ref/hash, fingerprint_id, similarity, vertical_guess, and a
// checkpoint hash ref. Raw warm_start_checkpoint_path is returned only when
// explicitly requested with {include_paths:true} by a same-tenant caller.
export function findNearestNamespaces(target_fp, candidate_fps, k = 5) {
  if (!target_fp || !Array.isArray(candidate_fps)) return [];
  let limit = k;
  let opts = {};
  if (k && typeof k === 'object') {
    opts = k;
    limit = opts.k == null ? 5 : opts.k;
  }
  const n = Math.max(0, Math.min(FINGERPRINT_LIMITS.max_nearest_k, Math.trunc(Number(limit) || 0)));
  const includePaths = opts.include_paths === true;
  const ranked = candidate_fps
    .filter(c => c && c.fingerprint_id !== target_fp.fingerprint_id)
    .map(c => {
      const out = {
        namespace: _safeNamespace(c.namespace),
        namespace_hash: _safeHash(c.namespace_hash) || _namespaceHash(c.namespace),
        fingerprint_id: (typeof c.fingerprint_id === 'string' && FP_ID_RE.test(c.fingerprint_id)) ? c.fingerprint_id : null,
        vertical_guess: _safeVertical(c.vertical_guess),
        similarity: cosineSimilarity(target_fp, c),
      };
      if (c.warm_start_checkpoint_path) {
        out.warm_start_checkpoint_ref = _checkpointRef(c.warm_start_checkpoint_path);
        if (includePaths) out.warm_start_checkpoint_path = String(c.warm_start_checkpoint_path);
      } else {
        out.warm_start_checkpoint_ref = null;
        if (includePaths) out.warm_start_checkpoint_path = null;
      }
      return out;
    })
    .sort((a, b) => b.similarity - a.similarity);
  return ranked.slice(0, n);
}

// Lower-level helper exported for tests + the federated trainer warm-start
// loader. Reads a JSON fingerprint file from disk + validates the version
// stamp matches what this module emits.
export function readFingerprintFile(filePath, opts = {}) {
  const p = _resolveFingerprintPath(filePath, opts);
  const st = fs.statSync(p);
  const maxBytes = Number.isFinite(Number(opts.max_bytes))
    ? Math.max(1, Math.trunc(Number(opts.max_bytes)))
    : FINGERPRINT_LIMITS.max_fingerprint_file_bytes;
  if (st.size > maxBytes) {
    throw new Error('fingerprint file too large: max_bytes=' + maxBytes);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const fp = JSON.parse(raw);
  if (!fp || fp.version !== FINGERPRINT_VERSION) {
    throw new Error(
      'fingerprint version mismatch: file=' + (fp && fp.version) +
      ' expected=' + FINGERPRINT_VERSION
    );
  }
  return _validateFingerprintShape(fp);
}

function _hashArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, TOP_TERMS_K)) {
    if (typeof item === 'string' && HEX64_RE.test(item)) out.push(item);
  }
  return out;
}

function _safeVertical(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VERTICAL_STUBS, v) ? v : 'general';
}

function _checkpointRef(value) {
  const s = String(value || '');
  return {
    present: true,
    sha256: _sha256Hex(FINGERPRINT_VERSION + ':checkpoint:' + s),
  };
}

function _safeHash(value) {
  return typeof value === 'string' && HEX64_RE.test(value) ? value : null;
}

function _resolveFingerprintPath(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('fingerprint file path required');
  }
  const resolved = path.resolve(filePath);
  if (opts.allowed_root) {
    const root = path.resolve(String(opts.allowed_root));
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('fingerprint file outside allowed_root');
    }
  }
  return resolved;
}

function _validateFingerprintShape(fp) {
  if (!fp || typeof fp !== 'object') throw new Error('fingerprint must be an object');
  if (!HEX64_RE.test(String(fp.token_bag_hash || ''))) {
    throw new Error('fingerprint token_bag_hash must be sha256 hex');
  }
  if (fp.fingerprint_id != null && !FP_ID_RE.test(String(fp.fingerprint_id))) {
    throw new Error('fingerprint_id must be fp_<24hex>');
  }
  const top = _hashArray(fp.top_terms_hash_array);
  if (Array.isArray(fp.top_terms_hash_array) && top.length !== fp.top_terms_hash_array.length) {
    throw new Error('top_terms_hash_array must contain only sha256 hex strings');
  }
  const namespace = _safeNamespace(fp.namespace);
  return {
    ...fp,
    contract_version: fp.contract_version || FINGERPRINT_CONTRACT_VERSION,
    namespace,
    namespace_hash: _safeHash(fp.namespace_hash) || _namespaceHash(fp.namespace),
    vertical_guess: _safeVertical(fp.vertical_guess),
    top_terms_hash_array: top,
  };
}
