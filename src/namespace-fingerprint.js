// src/namespace-fingerprint.js — W715 cross-namespace transfer learning.
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
//   warm-start libraries). It is intentionally tiny — ~20 seed terms each —
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

export const FINGERPRINT_VERSION = 'w715-v1';
export const TOP_TERMS_K = 32;
export const MIN_TOKEN_LENGTH = 2;
export const MAX_TOKEN_LENGTH = 32;

// VERTICAL_STUBS — scaffold for W751-W755. Each list is a tiny seed of
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

function _extractText(capture) {
  // Captures land in many shapes from many surfaces (chat, agent trace,
  // connector). We read in priority order: explicit text fields first,
  // then output/response, never raw_body/raw_text (those keep PII).
  if (!capture || typeof capture !== 'object') return '';
  if (typeof capture.text === 'string') return capture.text;
  const parts = [];
  if (typeof capture.prompt === 'string') parts.push(capture.prompt);
  if (typeof capture.input === 'string') parts.push(capture.input);
  if (typeof capture.user_input === 'string') parts.push(capture.user_input);
  if (typeof capture.output === 'string') parts.push(capture.output);
  if (typeof capture.response === 'string') parts.push(capture.response);
  if (typeof capture.completion === 'string') parts.push(capture.completion);
  if (typeof capture.assistant === 'string') parts.push(capture.assistant);
  // Tool-call style messages — pull every string-typed message[].content.
  if (Array.isArray(capture.messages)) {
    for (const m of capture.messages) {
      if (m && typeof m.content === 'string') parts.push(m.content);
    }
  }
  return parts.join(' ');
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
// hashes — never throws. (W715 standing directive #1.)
//
// Privacy lock: returned object passes through JSON.stringify with NO raw
// capture text (W715 test #8 enforces).
export function computeFingerprint(opts = {}) {
  const captures = Array.isArray(opts.captures) ? opts.captures : [];
  const namespace = typeof opts.namespace === 'string' ? opts.namespace : null;

  if (captures.length === 0) {
    // Honest empty envelope. Same shape as the populated path so consumers
    // never have to branch — they just see n_captures=0 + zeroed hashes.
    return {
      version: FINGERPRINT_VERSION,
      namespace,
      n_captures: 0,
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
  // hash array — bigrams give better discrimination than unigrams over
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
  // intentionally a single hash (not a vector) — used as a quick "are these
  // two fingerprints byte-identical?" check for caching / dedup.
  const bagEntries = Object.entries(bigram_counts).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const bagCanonical = bagEntries.map(([k, v]) => k + ':' + v).join('|');
  const token_bag_hash = _sha256Hex(FINGERPRINT_VERSION + ':bag:' + bagCanonical);

  // top_terms_hash_array = sha256(bigram) for the top-K bigrams by count,
  // breaking ties alphabetically. K=32 is enough to compute Jaccard over.
  // We hash each bigram individually so the receiver sees a vector of
  // opaque IDs — they cannot reverse a hash to a phrase but they CAN take
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
    namespace,
    n_captures: captures.length,
    n_tokens,
    n_unique_terms: Object.keys(bigram_counts).length,
    token_bag_hash,
    top_terms_hash_array,
    vertical_guess,
    fingerprint_id,
    computed_at: new Date().toISOString(),
  };
}

// cosineSimilarity(fp1, fp2) — Jaccard over top_terms_hash_array (the
// hashed bigram set), since the underlying tokens are opaque. Named
// `cosineSimilarity` because callers think in cosine-of-vectors terms,
// but Jaccard is the honest math for a set of opaque hashes:
//   |A ∩ B| / |A ∪ B|
// Range [0, 1]; identical → 1.0; disjoint → 0.0.
export function cosineSimilarity(fp1, fp2) {
  if (!fp1 || !fp2) return 0;
  const a = Array.isArray(fp1.top_terms_hash_array) ? fp1.top_terms_hash_array : [];
  const b = Array.isArray(fp2.top_terms_hash_array) ? fp2.top_terms_hash_array : [];
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

// findNearestNamespaces(target_fp, candidate_fps, k) — ranked list of the
// top-K siblings by cosineSimilarity, descending. Each entry is
// {namespace, fingerprint_id, similarity, vertical_guess,
//  warm_start_checkpoint_path?}. The optional checkpoint path is
// preserved from the candidate fingerprint when present — that is the
// hook W715-2 trainer reads with --warm-start-from-fingerprint.
export function findNearestNamespaces(target_fp, candidate_fps, k = 5) {
  if (!target_fp || !Array.isArray(candidate_fps)) return [];
  const ranked = candidate_fps
    .filter(c => c && c.fingerprint_id !== target_fp.fingerprint_id)
    .map(c => ({
      namespace: c.namespace,
      fingerprint_id: c.fingerprint_id,
      vertical_guess: c.vertical_guess,
      similarity: cosineSimilarity(target_fp, c),
      warm_start_checkpoint_path: c.warm_start_checkpoint_path || null,
    }))
    .sort((a, b) => b.similarity - a.similarity);
  return ranked.slice(0, Math.max(0, k | 0));
}

// Lower-level helper exported for tests + the federated trainer warm-start
// loader. Reads a JSON fingerprint file from disk + validates the version
// stamp matches what this module emits.
export function readFingerprintFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fp = JSON.parse(raw);
  if (!fp || fp.version !== FINGERPRINT_VERSION) {
    throw new Error(
      'fingerprint version mismatch: file=' + (fp && fp.version) +
      ' expected=' + FINGERPRINT_VERSION
    );
  }
  return fp;
}
