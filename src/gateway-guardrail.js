// src/gateway-guardrail.js
//
// W921 — Inline prompt-injection / jailbreak guardrail for the gateway
// input stage (OWASP LLM01:2025).
//
// This module is the LIVE-PATH wrapper around the existing, tested
// heuristic classifier in src/adversarial-prompts.js (w762). It mirrors
// the {mode, action, blocked, ...} envelope of pii-redactor.applyMode so
// the /v1/gateway/dispatch handler can treat an injection verdict exactly
// the way it already treats a PII verdict: run a scan on the assembled
// input text BEFORE forwarding to any upstream model, and on action ===
// 'block' return HTTP 400 injection_blocked for $0 (no upstream token is
// ever spent).
//
// DESIGN (two-tier, matches every production gateway):
//   Tier 0 — heuristic/regex (this module's default detector). Zero
//            dependencies, sub-millisecond on inputs under 8KB. Moderate
//            recall, brittle to paraphrase — so the default mode is
//            'detect_only' (never auto-blocks) and 'block' is opt-in per
//            namespace. The verdict ALWAYS records detector:'heuristic'
//            so the screening is never overclaimed.
//   Tier 1 — a small fine-tuned transformer (Prompt-Guard-2-22M /
//            deberta-v3) run OUT-OF-PROCESS behind the `detector` arg.
//            Phase-2 only — kolm core stays dependency-free. The
//            maxPoolChunks + classifyTransformer seams below are the
//            forward-looking hooks; they add NO runtime dependency.
//
// RECEIPT: the verdict is stamped into receipt.guardrail as an ADDITIVE,
// NON-SIGNED top-level field. canonicalForSigning (receipt-schema.js)
// iterates ALL_FIELDS only, so receipt.guardrail is stripped before
// signing and every existing Ed25519 verifier stays byte-for-byte green
// — the exact precedent already used for receipt.latency_breakdown.
//
// HONESTY: the heuristic is a HEURISTIC. For security-critical decisions
// layer the Phase-2 transformer behind the detector seam. The receipt
// records the detector name and version so a verdict is always traceable
// to the engine that produced it.

import {
  classifyPromptAdversarial,
  ADVERSARIAL_CATEGORIES,
} from './adversarial-prompts.js';

// ---------------------------------------------------------------------------
// Public surface — version + modes
// ---------------------------------------------------------------------------

export const GUARDRAIL_VERSION = 'w921-v1';

// The decision ladder per namespace.
//   off          — guardrail disabled; never scans, always allow.
//   detect_only  — scan + record the verdict, but NEVER act on it (the
//                  safe conservative default; surfaces is_adversarial in
//                  the receipt without ever rejecting a request).
//   flag         — scan + mark action:'flag' when the score clears the
//                  threshold, but still forward the request.
//   block        — scan + reject (HTTP 400) when the score clears the
//                  threshold; below threshold the request still 'flag's so
//                  the caller sees the near-miss.
export const GUARDRAIL_MODES = Object.freeze(['off', 'detect_only', 'flag', 'block']);

// Default block threshold (probability 0..1). 0.85 holds the heuristic
// FPR low on PINT-style benign hard-negatives.
export const DEFAULT_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// classifyHeuristic — thin normalizing adapter over classifyPromptAdversarial
// ---------------------------------------------------------------------------

/**
 * classifyHeuristic(text) — run the in-repo regex classifier and return a
 * NORMALIZED verdict shaped for this module:
 *
 *   { ok, is_adversarial, categories: string[], score: number,
 *     evidence: Array<{pattern, span:[number,number], category}>,
 *     detector: 'heuristic', version }
 *
 * NEVER throws — bad input degrades to a benign envelope (score 0). The
 * underlying classifier already maps confidence to 0 when no pattern
 * matches and caps at 0.95 otherwise (it never claims 100% from a
 * heuristic), so `score` is a faithful pass-through of `confidence`.
 */
export function classifyHeuristic(text) {
  let raw = '';
  try {
    raw = typeof text === 'string' ? text : (text == null ? '' : String(text));
  } catch (_) {
    raw = '';
  }

  let v;
  try {
    v = classifyPromptAdversarial(raw);
  } catch (_) {
    // The classifier is documented never-throw, but the live path must be
    // bulletproof: a guardrail that crashes is worse than one that misses.
    v = null;
  }

  if (!v || typeof v !== 'object') {
    return {
      ok: true,
      is_adversarial: false,
      categories: [],
      score: 0,
      evidence: [],
      detector: 'heuristic',
      version: GUARDRAIL_VERSION,
    };
  }

  const categories = Array.isArray(v.categories_matched) ? v.categories_matched.slice() : [];
  const evidence = Array.isArray(v.evidence) ? v.evidence : [];
  const score = Number.isFinite(v.confidence) ? v.confidence : 0;

  return {
    ok: true,
    is_adversarial: Boolean(v.is_adversarial) && categories.length > 0,
    categories,
    score: Math.max(0, Math.min(1, score)),
    evidence,
    detector: 'heuristic',
    version: GUARDRAIL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// scoreToAction — the decision ladder
// ---------------------------------------------------------------------------

/**
 * scoreToAction(score, mode, threshold) -> 'allow' | 'flag' | 'block'
 *
 *   off          -> always 'allow'.
 *   detect_only  -> always 'allow' (verdict recorded, never acted on).
 *   flag         -> 'flag' when score >= threshold, else 'allow'.
 *   block        -> 'block' when score >= threshold; otherwise 'flag' when
 *                   there is SOME positive signal (score > 0) so the caller
 *                   sees the near-miss, else 'allow'.
 *
 * Defensive: a non-numeric score is treated as 0; an unknown mode degrades
 * to 'detect_only' semantics (always allow); a non-finite threshold falls
 * back to the default.
 */
export function scoreToAction(score, mode, threshold) {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  const m = GUARDRAIL_MODES.includes(mode) ? mode : 'detect_only';
  const t = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : DEFAULT_THRESHOLD;

  if (m === 'off' || m === 'detect_only') return 'allow';

  if (m === 'flag') {
    return s >= t ? 'flag' : 'allow';
  }

  // m === 'block'
  if (s >= t) return 'block';
  return s > 0 ? 'flag' : 'allow';
}

// ---------------------------------------------------------------------------
// applyGuardrail — the gateway's single entry point (mirrors applyMode)
// ---------------------------------------------------------------------------

/**
 * applyGuardrail({ text, mode, threshold, categories_block, detector })
 *   -> verdict envelope:
 *
 *   { mode, action: 'allow'|'flag'|'block', blocked: boolean,
 *     is_adversarial: boolean, categories: string[], score: number,
 *     evidence: object[], detector: string, version: string,
 *     block_reason?: string }
 *
 * - `mode`           one of GUARDRAIL_MODES; invalid -> 'detect_only'.
 * - `threshold`      0..1; invalid -> DEFAULT_THRESHOLD.
 * - `categories_block` optional allow-list of OWASP categories that may
 *                    trigger a block. When provided, the request is only
 *                    blocked/flagged on the strength of matches in those
 *                    categories (others still surface in the verdict for
 *                    auditing but do not drive the action). null/empty ->
 *                    all categories count.
 * - `detector`       optional (text) => normalized-verdict function. When
 *                    omitted the zero-dependency heuristic is used. A
 *                    custom detector that throws is caught and degrades to
 *                    a benign verdict so the live path never crashes.
 *
 * mode 'off' short-circuits with NO scan at all (cheapest path). Otherwise
 * the detector runs and scoreToAction maps the (filtered) score to an
 * action.
 *
 * This function NEVER throws.
 */
export function applyGuardrail({
  text,
  mode,
  threshold,
  categories_block = null,
  detector = null,
} = {}) {
  const m = GUARDRAIL_MODES.includes(mode) ? mode : 'detect_only';
  const t = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : DEFAULT_THRESHOLD;

  // 'off' — fully disabled. No scan, no cost, always allow.
  if (m === 'off') {
    return {
      mode: m,
      action: 'allow',
      blocked: false,
      is_adversarial: false,
      categories: [],
      score: 0,
      evidence: [],
      detector: 'off',
      version: GUARDRAIL_VERSION,
    };
  }

  // Run the detector (heuristic by default). Bulletproof: a thrown
  // detector degrades to a benign verdict rather than aborting the call.
  let verdict;
  try {
    const fn = typeof detector === 'function' ? detector : classifyHeuristic;
    verdict = fn(typeof text === 'string' ? text : (text == null ? '' : String(text)));
  } catch (_) {
    verdict = null;
  }
  if (!verdict || typeof verdict !== 'object') {
    verdict = {
      ok: true,
      is_adversarial: false,
      categories: [],
      score: 0,
      evidence: [],
      detector: 'heuristic',
      version: GUARDRAIL_VERSION,
    };
  }

  const allCategories = Array.isArray(verdict.categories) ? verdict.categories.slice() : [];
  const allEvidence = Array.isArray(verdict.evidence) ? verdict.evidence : [];
  const fullScore = Number.isFinite(verdict.score) ? Math.max(0, Math.min(1, verdict.score)) : 0;
  const detectorName = typeof verdict.detector === 'string' ? verdict.detector : 'heuristic';
  const version = typeof verdict.version === 'string' ? verdict.version : GUARDRAIL_VERSION;

  // Resolve the category allow-list. An empty/invalid list means "all
  // categories can drive an action".
  const blockSet = _normalizeCategoryList(categories_block);

  // The score that actually drives the action. With no allow-list it is
  // the full score; with one, it is gated on whether ANY matched category
  // is in the allow-list (and we recompute a proportional score from the
  // in-list evidence so a single in-list match still clears like the
  // classifier intended).
  let actionScore = fullScore;
  let actioning_categories = allCategories;
  if (blockSet) {
    const inList = allCategories.filter((c) => blockSet.has(c));
    actioning_categories = inList;
    if (inList.length === 0) {
      actionScore = 0;
    } else if (inList.length < allCategories.length) {
      // Re-derive a heuristic-style score from the in-list evidence count
      // so partial matches don't inherit credit from out-of-list hits.
      const inListEvidence = allEvidence.filter((e) => e && blockSet.has(e.category)).length;
      actionScore = inListEvidence > 0
        ? Math.min(0.95, 0.5 + 0.1 * inListEvidence)
        : Math.min(fullScore, 0.5);
    }
    // else: every matched category is in-list -> keep the full score.
  }

  const action = scoreToAction(actionScore, m, t);
  const blocked = action === 'block';

  const out = {
    mode: m,
    action,
    blocked,
    is_adversarial: Boolean(verdict.is_adversarial) && allCategories.length > 0,
    categories: allCategories,
    score: fullScore,
    evidence: allEvidence,
    detector: detectorName,
    version,
  };

  if (blocked) {
    out.block_reason = 'prompt_injection_detected';
    out.block_categories = actioning_categories.length ? actioning_categories : allCategories;
  }

  return out;
}

// Resolve a caller-supplied category allow-list to a Set of VALID OWASP
// categories, or null when no usable list was given (=> all categories
// count). Unknown category names are dropped silently.
function _normalizeCategoryList(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const valid = list.filter((c) => ADVERSARIAL_CATEGORIES.includes(c));
  if (valid.length === 0) return null;
  return new Set(valid);
}

// ---------------------------------------------------------------------------
// buildGuardrailReceiptField — the additive non-signed receipt block
// ---------------------------------------------------------------------------

/**
 * buildGuardrailReceiptField(verdict) -> {
 *   screened: true, is_adversarial, categories, score, action,
 *   detector, version
 * }
 *
 * Stamped onto the signed receipt as the ADDITIVE, NON-SIGNED top-level
 * field receipt.guardrail. Because receipt-schema.canonicalForSigning
 * walks ALL_FIELDS only (and 'guardrail' is intentionally NOT in
 * ALL_FIELDS), this field is invisible to the Ed25519 signature — adding
 * it cannot change the signed bytes, so every existing verifier stays
 * green. This is the same guarantee receipt.latency_breakdown has.
 *
 * The full evidence array is intentionally OMITTED from the receipt to
 * keep it compact and to avoid persisting raw prompt spans; evidence
 * lives on the queryable observation row, not the cryptographic receipt.
 */
export function buildGuardrailReceiptField(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const categories = Array.isArray(v.categories) ? v.categories.slice() : [];
  const action = ['allow', 'flag', 'block'].includes(v.action) ? v.action : 'allow';
  return {
    screened: true,
    is_adversarial: Boolean(v.is_adversarial),
    categories,
    score: Number.isFinite(v.score) ? Math.max(0, Math.min(1, v.score)) : 0,
    action,
    detector: typeof v.detector === 'string' ? v.detector : 'heuristic',
    version: typeof v.version === 'string' ? v.version : GUARDRAIL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 seams — pluggable transformer detector + long-input chunking.
//
// These are forward-looking hooks. They add NO runtime dependency: the
// transformer lives OUT-OF-PROCESS behind an HTTP endpoint (fronted by
// src/services/redactor.js in Phase 2). They are exported now so the
// dispatch wiring and the recipe loader can reference a stable contract,
// and so Phase 2 can drop in the detector without touching this module.
// ---------------------------------------------------------------------------

// Approximate "tokens" with a chars-per-token heuristic so chunking works
// with zero tokenizer dependency. Real Phase-2 detectors should pass a
// scoreFn that tokenizes precisely; this fallback keeps windows roughly at
// the model's 512-token limit (~4 chars/token).
const CHARS_PER_TOKEN = 4;

/**
 * maxPoolChunks(text, windowTokens, scoreFn) -> Promise<{score, window_index}>
 *
 * Phase-2 long-input handling. Injections are LOCAL — a single injected
 * span anywhere in a long document should trip the detector — so the
 * correct pooling is MAX over fixed-size windows, not mean (mean dilutes a
 * single malicious span). Splits `text` into <= windowTokens-sized windows
 * (approximated via CHARS_PER_TOKEN), scores each with the async `scoreFn`,
 * and returns the highest score plus the index of the window that produced
 * it. NEVER throws; a failing scoreFn contributes score 0 for that window.
 */
export async function maxPoolChunks(text, windowTokens, scoreFn) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const winTok = Number.isFinite(windowTokens) && windowTokens > 0 ? Math.trunc(windowTokens) : 512;
  const winChars = Math.max(1, winTok * CHARS_PER_TOKEN);

  if (typeof scoreFn !== 'function' || s.length === 0) {
    return { score: 0, window_index: 0 };
  }

  const windows = [];
  for (let i = 0; i < s.length; i += winChars) {
    windows.push(s.slice(i, i + winChars));
  }
  if (windows.length === 0) windows.push('');

  let best = 0;
  let bestIdx = 0;
  for (let i = 0; i < windows.length; i++) {
    let sc = 0;
    try {
      sc = await scoreFn(windows[i]);
    } catch (_) {
      sc = 0;
    }
    sc = Number.isFinite(sc) ? Math.max(0, Math.min(1, sc)) : 0;
    if (sc > best) {
      best = sc;
      bestIdx = i;
    }
  }
  return { score: best, window_index: bestIdx };
}

/**
 * classifyTransformer(text, { endpoint, timeoutMs }) ->
 *   Promise<{ score, label: 'benign'|'malicious', detector, version }>
 *
 * Phase-2 pluggable transformer detector (Prompt-Guard-2-22M /
 * deberta-v3, served out-of-process over HTTP). Posts the text to a
 * scoring endpoint that returns P(malicious). NEVER throws — on any
 * transport/parse failure it degrades to a benign score:0 verdict so the
 * live path is unaffected when the sidecar is down (fail-open for the
 * detector, NOT for a confirmed block). The caller wraps the returned
 * score in applyGuardrail's `detector` seam (max-pooling long inputs via
 * maxPoolChunks first).
 */
export async function classifyTransformer(text, { endpoint, timeoutMs = 2000 } = {}) {
  const benign = {
    score: 0,
    label: 'benign',
    detector: 'prompt-guard-2-22m',
    version: GUARDRAIL_VERSION,
  };
  if (!endpoint || typeof endpoint !== 'string' || typeof fetch !== 'function') {
    return benign;
  }

  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(); } catch (_) { /* ignore */ }
  }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: s }),
      signal: ac.signal,
    });
    if (!resp || !resp.ok) return benign;
    const body = await resp.json();
    const score = Number.isFinite(body && body.score) ? Math.max(0, Math.min(1, body.score)) : 0;
    const label = (body && body.label === 'malicious') || score >= 0.5 ? 'malicious' : 'benign';
    const detector = typeof (body && body.detector) === 'string' ? body.detector : 'prompt-guard-2-22m';
    return { score, label, detector, version: GUARDRAIL_VERSION };
  } catch (_) {
    return benign;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Convenience default export.
// ---------------------------------------------------------------------------

export default {
  GUARDRAIL_VERSION,
  GUARDRAIL_MODES,
  DEFAULT_THRESHOLD,
  classifyHeuristic,
  scoreToAction,
  applyGuardrail,
  buildGuardrailReceiptField,
  maxPoolChunks,
  classifyTransformer,
};
