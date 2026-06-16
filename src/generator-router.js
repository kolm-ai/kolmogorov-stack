// Synthetic-data generator routing gate - never-to-hyperscaler enforcement.
//
// This module sits IN FRONT of synthesis callsites (lingual-synthesize.js and
// any future syn-3 generator) and decides generator LOCALITY from seed
// sensitivity BEFORE any text reaches a hosted teacher. It is fail-closed: a
// sensitive corpus is NEVER handed to a hosted/proprietary teacher. The only
// sensitive+hosted-requested outcomes are forced-local or a loud fail-closed
// envelope - there is no code path that returns hosted egress for sensitive
// data. That is the load-bearing moat invariant (assertPrivacyBoundary in
// distillation-pipeline-c1.js guards the C1 distill path; this guards the
// synthesis path and complements - never replaces - that check).
//
// It REUSES existing primitives and never re-implements / weakens them:
//   - scanSensitive + detectorCoverage   (src/sensitive-data.js)
//   - applyMode                          (src/pii-redactor.js)
//   - classifyTeacherSource              (src/distillation-pipeline-c1.js)
//   - isTeacherLocal / verifyTeacherIsLocal (src/airgap-teacher.js)
//   - captureFromLocalOllama / wrapFetch / localTeacherUrl (src/airgap-mode.js)
//
// No new npm deps. ESM. ASCII only. Never-throw envelopes from route(); the
// only thing that throws is the adapter translateFn, which the synth loop
// already tolerates (null translation -> row skipped). Matched secret values
// are NEVER echoed - we never re-print raw seed text in any error or stamp.

import { scanSensitive, detectorCoverage } from './sensitive-data.js';
import { applyMode } from './pii-redactor.js';
import { classifyTeacherSource } from './distillation-pipeline-c1.js';
import { isTeacherLocal, verifyTeacherIsLocal } from './airgap-teacher.js';
import {
  captureFromLocalOllama,
  wrapFetch,
  localTeacherUrl,
} from './airgap-mode.js';

export const GENERATOR_ROUTER_VERSION = 'gr-v1';

// verifyTeacherIsLocal is reused indirectly by the air-gap predicate below; we
// import it to keep the dependency explicit and to fail loudly if the upstream
// contract ever drops it.
void verifyTeacherIsLocal;

// =============================================================================
// A. SENSITIVITY CLASSIFICATION (namespace-level aggregation by monotone OR)
// =============================================================================
//
// A leak boundary admits exactly one safe aggregation: UNION. A single
// sensitive seed taints the whole namespace for hosted egress, so we OR
// has_sensitive and set-union the class lists across every scanned seed.
//
// We scan the RAW input+output text (input/output preferred, prompt/response
// fallback) - NOT the *_redacted fields - because the raw text is what a
// teacher prompt would actually carry; scanning the pre-redacted copy would
// understate the risk.

function _rawSeedText(seed) {
  if (!seed || typeof seed !== 'object') return '';
  const inp = (typeof seed.input === 'string' && seed.input !== '')
    ? seed.input
    : (typeof seed.prompt === 'string' ? seed.prompt : '');
  const out = (typeof seed.output === 'string' && seed.output !== '')
    ? seed.output
    : (typeof seed.response === 'string' ? seed.response : '');
  // Concatenate with a newline so a token spanning the seam never appears
  // glued into a different token.
  return [inp, out].filter((s) => typeof s === 'string' && s !== '').join('\n');
}

function _sortedUnion(a, b) {
  const set = new Set();
  for (const x of (Array.isArray(a) ? a : [])) set.add(x);
  for (const x of (Array.isArray(b) ? b : [])) set.add(x);
  return [...set].sort();
}

function _intEnv(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') return 0;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * classifySensitivity(seeds, opts) -> namespace verdict.
 *
 * @param {Array<object>} seeds
 * @param {object} [opts]
 *   - maxScan {number}        cap on seeds scanned (0 = unlimited). Falls back
 *                             to env KOLM_ROUTER_MAX_SCAN, then 0.
 *   - allowSampledClean {bool} when true, a fully-clean-but-SAMPLED pool may
 *                             report 'clean'. Default false => an unproven-clean
 *                             sampled pool is treated as 'sensitive' so we never
 *                             hand a possibly-tainted pool to a hyperscaler on a
 *                             partial scan (false-negative-averse default).
 *
 * Verdict:
 *   { sensitivity, pii_classes, secret_classes, scanned_count, pool_count,
 *     sampled, detector_coverage, reason? }
 *
 * Complexity: O(scanned_count * scanSensitive); scanSensitive is regex-linear
 * in text length, so the total is linear in scanned bytes. No quadratic paths.
 */
export function classifySensitivity(seeds, opts = {}) {
  const pool = Array.isArray(seeds) ? seeds : [];
  const poolCount = pool.length;
  const maxScan = (typeof opts.maxScan === 'number' && opts.maxScan >= 0)
    ? Math.floor(opts.maxScan)
    : _intEnv('KOLM_ROUTER_MAX_SCAN');

  const willSample = maxScan > 0 && poolCount > maxScan;
  const scanLimit = willSample ? maxScan : poolCount;

  let anySensitive = false;
  let piiClasses = [];
  let secretClasses = [];
  let scanned = 0;

  for (let i = 0; i < scanLimit; i += 1) {
    const text = _rawSeedText(pool[i]);
    scanned += 1;
    const scan = scanSensitive(text); // never throws; never echoes values
    if (scan.has_sensitive) anySensitive = true;
    if (scan.pii_classes && scan.pii_classes.length) {
      piiClasses = _sortedUnion(piiClasses, scan.pii_classes);
    }
    if (scan.secret_classes && scan.secret_classes.length) {
      secretClasses = _sortedUnion(secretClasses, scan.secret_classes);
    }
  }

  let coverage = null;
  try {
    coverage = detectorCoverage();
  } catch (_) {
    coverage = null; // detector edge case must not sink a routing decision
  }

  // Asymmetric, false-negative-averse decision under sampling:
  //   - ANY scanned seed sensitive  -> sensitive (correct, even if sampled).
  //   - NONE scanned sensitive, full scan -> clean (proven).
  //   - NONE scanned sensitive, SAMPLED -> 'clean' ONLY with explicit
  //     allowSampledClean opt-in; otherwise 'sensitive'/'sampled_unproven_clean'
  //     so a partial scan can never green-light hosted egress. This is the
  //     conservative default.
  let sensitivity;
  let reason;
  if (anySensitive) {
    sensitivity = 'sensitive';
  } else if (willSample && opts.allowSampledClean !== true) {
    sensitivity = 'sensitive';
    reason = 'sampled_unproven_clean';
  } else {
    sensitivity = 'clean';
  }

  const verdict = {
    sensitivity,
    pii_classes: piiClasses,
    secret_classes: secretClasses,
    scanned_count: scanned,
    pool_count: poolCount,
    sampled: willSample,
    detector_coverage: coverage,
  };
  if (reason) verdict.reason = reason;
  return verdict;
}

// =============================================================================
// B. HOSTED-vs-LOCAL CLASSIFICATION (reuse classifyTeacherSource - no fork)
// =============================================================================
//
// 'unknown' is safe-denied to hosted, matching the existing C1 boundary's
// safe-deny posture. We do NOT relax this.

export function requestedLocalityOf({ teacher, slug } = {}) {
  const t = (typeof teacher === 'string') ? teacher.trim().toLowerCase() : '';
  const s = (typeof slug === 'string') ? slug.trim().toLowerCase() : '';

  // Explicit local signals.
  if (t === 'local') return 'local';
  if (s.startsWith('local:') || s.startsWith('hf:')) return 'local';

  // Reuse the C1 family classifier on whichever identifier we have.
  const ident = s || t;
  const source = classifyTeacherSource(ident);
  if (source === 'open-weights') return 'local';

  // Explicit hosted providers + safe-deny on proprietary/unknown.
  if (t === 'anthropic' || t === 'openai' || t === 'google') return 'hosted';
  if (source === 'proprietary' || source === 'unknown') return 'hosted';

  // 'none' (no teacher named) -> local-permissible. Any non-local, non-'none'
  // token already returned 'hosted' above via the safe-deny branch.
  return 'local';
}

// =============================================================================
// D. SEED REDACTION BEFORE PROMPT (clean path still redacts; defense-in-depth)
// =============================================================================
//
// Even a 'clean' verdict is redacted before the text enters a teacher prompt
// (the regex detector may miss). 'redact_all' zeroes both output/capture for
// findings. Forced-local also redacts by default but allows a localRedactMode
// override (operator on own metal may want detect_only).

export function prepareSeedForPrompt(text, { mode } = {}) {
  if (typeof text !== 'string' || text === '') return '';
  const res = applyMode({ text, mode: mode || 'redact_all' });
  // output_text is the text destined for the prompt; on findings it is the
  // redacted copy under redact_all, the raw under detect_only.
  return (res && typeof res.output_text === 'string') ? res.output_text : '';
}

// =============================================================================
// E. LOCAL ADAPTER WIRING CONTRACT (real local generator; no echo in prod)
// =============================================================================
//
// makeLocalTranslateFn(opts) -> async translateFn matching the signature
// lingual-synthesize.js expects: ({text, source_lang, target_lang, teacher})
// -> {text, model}. It calls the REAL captureFromLocalOllama (Ollama native
// /api/generate) or, for localTransport:'openai', POSTs to
// /v1/chat/completions through the SAME wrapFetch guard so airgap egress
// policy still applies. On any fail-closed envelope it THROWS a typed error
// the synth loop already tolerates (-> null translation -> row skipped), so
// generated_count:0 is explainable, NOT a silent echo.
//
// The [lang]-prefixed echo remains reachable ONLY when opts.ciStub === true.

export class LocalGeneratorError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LocalGeneratorError';
    this.code = opts.code || 'local_generator_failed';
    if (opts.detail) this.detail = opts.detail;
    // Marker the synth loop / router can branch on without string matching.
    this.local_generator_error = true;
  }
}

function _translationPrompt({ text, source_lang, target_lang }) {
  const from = source_lang || 'auto';
  const to = target_lang || 'en';
  return 'Translate the following from ' + from + ' to ' + to +
    '. Output only the translation:\n' + (typeof text === 'string' ? text : '');
}

async function _openAiTranslate({ prompt, model, fetchImpl }) {
  const teacher = localTeacherUrl();
  if (!teacher) {
    return { ok: false, error: 'local_teacher_unconfigured' };
  }
  const real = fetchImpl || globalThis.fetch;
  if (typeof real !== 'function') {
    return { ok: false, error: 'no_fetch_available' };
  }
  // Reuse wrapFetch so airgap egress policy still gates this call.
  const wrapped = wrapFetch(real);
  const endpoint = teacher.replace(/\/$/, '') + '/v1/chat/completions';
  const body = {
    model: model || process.env.KOLM_LOCAL_TEACHER_MODEL || 'llama3',
    messages: [{ role: 'user', content: prompt }],
  };
  try {
    const resp = await wrapped(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const status = resp.status;
    let json;
    try { json = await resp.json(); } catch (_) { json = null; }
    if (status < 200 || status >= 300) {
      return { ok: false, error: 'local_teacher_http_error', http_status: status };
    }
    const txt = json
      && Array.isArray(json.choices)
      && json.choices[0]
      && json.choices[0].message
      && typeof json.choices[0].message.content === 'string'
      ? json.choices[0].message.content
      : null;
    return { ok: true, response_text: txt, model_used: (json && json.model) || body.model };
  } catch (e) {
    if (e && e.airgap_blocked) return e.envelope;
    return { ok: false, error: 'local_teacher_unreachable', detail: String((e && e.message) || e) };
  }
}

export function makeLocalTranslateFn(opts = {}) {
  const localTransport = opts.localTransport === 'openai' ? 'openai' : 'ollama';
  const ciStub = opts.ciStub === true;
  const fetchImpl = opts.fetch;

  return async function localTranslate({ text, source_lang, target_lang, teacher }) {
    void teacher; // signature parity with lingual-synthesize; locality already decided
    if (ciStub) {
      // Explicit CI path only: deterministic prefix echo. NOT a real
      // translation and never reachable in production.
      const tag = '[' + (target_lang || 'en') + ']';
      return { text: tag + ' ' + (typeof text === 'string' ? text : ''), model: 'local-echo' };
    }

    const prompt = _translationPrompt({ text, source_lang, target_lang });

    let env;
    if (localTransport === 'openai') {
      env = await _openAiTranslate({ prompt, model: opts.model, fetchImpl });
    } else {
      // Ollama native /api/generate via the REAL captureFromLocalOllama.
      env = await captureFromLocalOllama({ prompt, model: opts.model, fetch: fetchImpl });
    }

    if (!env || env.ok !== true) {
      const code = (env && env.error) || 'local_generator_failed';
      // Fail-closed: throw so the synth loop skips the row (null translation),
      // and the router can surface generated_count:0 with a reason. NEVER fall
      // back to an echo and NEVER fall back to a hosted teacher.
      throw new LocalGeneratorError(
        'local_generator_failed: ' + code,
        { code, detail: env && env.detail }
      );
    }

    const outText = (typeof env.response_text === 'string') ? env.response_text : null;
    if (outText == null) {
      throw new LocalGeneratorError(
        'local_generator_empty_response',
        { code: 'local_generator_empty_response' }
      );
    }
    return { text: outText, model: env.model_used || opts.model || 'local' };
  };
}

// =============================================================================
// C. FAIL-CLOSED ROUTING STATE MACHINE
// =============================================================================
//
// route() computes the verdict (A) and the requested locality (B), then applies
// the state machine. It NEVER throws and NEVER downgrades sensitive -> hosted.

function _hasReachableLocalGenerator() {
  const url = localTeacherUrl();
  if (!url) return false;
  // Reuse the air-gap local-URL predicate. KOLM_LOCAL_TEACHER_URL must itself
  // be a local endpoint - we do not trust a non-local URL even if configured.
  return isTeacherLocal({ teacher_url: url });
}

/**
 * route({seeds, teacher, slug?, teacher_url?, opts}) -> envelope.
 *
 * opts (all optional):
 *   - maxScan, allowSampledClean  (forwarded to classifySensitivity)
 *   - localRedactMode             redaction mode for the forced/clean-local path
 *                                 (default 'redact_all')
 *   - localTransport, model, fetch, ciStub (forwarded to makeLocalTranslateFn)
 *
 * Success: { ok:true, decision:{effectiveLocality, forced_local, routing_reason,
 *            sensitivity_verdict, redaction_mode}, translateFn, version }
 * Failure: fail-closed envelope { ok:false, error, ..., version }.
 */
export function route(args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  const opts = (a.opts && typeof a.opts === 'object') ? a.opts : {};
  const seeds = a.seeds;
  const teacher = a.teacher;
  const slug = a.slug;

  let verdict;
  try {
    verdict = classifySensitivity(seeds, {
      maxScan: opts.maxScan,
      allowSampledClean: opts.allowSampledClean,
    });
  } catch (e) {
    // Should not happen (classifySensitivity is defensive), but fail closed.
    return {
      ok: false,
      error: 'sensitivity_scan_failed',
      detail: String((e && e.message) || e),
      requested_locality: 'unknown',
      forced_local: false,
      version: GENERATOR_ROUTER_VERSION,
    };
  }

  const requestedLocality = requestedLocalityOf({ teacher, slug });
  const isSensitive = verdict.sensitivity === 'sensitive';

  // Compact verdict for stamping (drops detector_coverage to keep stamps tight;
  // coverage stays available on the full verdict for callers that want it).
  const sv = {
    sensitivity: verdict.sensitivity,
    pii_classes: verdict.pii_classes,
    secret_classes: verdict.secret_classes,
    scanned_count: verdict.scanned_count,
    pool_count: verdict.pool_count,
    sampled: verdict.sampled,
  };
  if (verdict.reason) sv.reason = verdict.reason;

  // ---- Clean corpus ------------------------------------------------------
  if (!isSensitive) {
    if (requestedLocality === 'hosted') {
      // ALLOW hosted, but still redact seeds before the prompt (defense-in-depth).
      return _success({
        effectiveLocality: 'hosted',
        forced_local: false,
        routing_reason: 'clean_corpus_hosted_ok',
        sensitivity_verdict: sv,
        redaction_mode: 'redact_all',
      }, null);
    }
    // clean + local-requested
    const redactionMode = opts.localRedactMode || 'redact_all';
    return _success({
      effectiveLocality: 'local',
      forced_local: false,
      routing_reason: 'local_requested',
      sensitivity_verdict: sv,
      redaction_mode: redactionMode,
    }, makeLocalTranslateFn(opts));
  }

  // ---- Sensitive corpus --------------------------------------------------
  if (requestedLocality === 'local') {
    const redactionMode = opts.localRedactMode || 'redact_all';
    return _success({
      effectiveLocality: 'local',
      forced_local: false,
      routing_reason: 'sensitive_corpus_local_requested',
      sensitivity_verdict: sv,
      redaction_mode: redactionMode,
    }, makeLocalTranslateFn(opts));
  }

  // sensitive + hosted-requested: the load-bearing branch. NEVER hosted.
  if (_hasReachableLocalGenerator()) {
    const redactionMode = opts.localRedactMode || 'redact_all';
    return _success({
      effectiveLocality: 'local',
      forced_local: true,
      routing_reason: 'sensitive_corpus_forced_local',
      sensitivity_verdict: sv,
      redaction_mode: redactionMode,
    }, makeLocalTranslateFn(opts));
  }

  // No local generator configured/reachable -> FAIL CLOSED. Do NOT fall back
  // to hosted. Do NOT fabricate. The error never echoes any seed text.
  return {
    ok: false,
    error: 'sensitive_corpus_requires_local_generator',
    install_hint: 'Set KOLM_LOCAL_TEACHER_URL=http://127.0.0.1:11434 (Ollama) ' +
      'or a vLLM/llama.cpp OpenAI-compatible endpoint; sensitive corpora are ' +
      'NEVER sent to a hosted teacher',
    sensitivity_verdict: sv,
    requested_locality: 'hosted',
    forced_local: false,
    version: GENERATOR_ROUTER_VERSION,
  };
}

function _success(decision, translateFn) {
  const out = {
    ok: true,
    decision,
    version: GENERATOR_ROUTER_VERSION,
  };
  if (translateFn) out.translateFn = translateFn;
  return out;
}

// Reachability self-check helper exported for the wiring step + tests: verifies
// a configured local generator actually passes the local-URL policy.
export function localGeneratorReachable() {
  return _hasReachableLocalGenerator();
}

// =============================================================================
// F. PROVENANCE STAMP (moat-preserving; folded into the SIGNED body later)
// =============================================================================

/**
 * stampRow(row, decision) -> a NEW row carrying the generator provenance block.
 * Does not mutate the input. Never embeds raw seed text or secret values.
 */
export function stampRow(row, decision) {
  const base = (row && typeof row === 'object') ? row : {};
  const d = (decision && typeof decision === 'object') ? decision : {};
  const sv = (d.sensitivity_verdict && typeof d.sensitivity_verdict === 'object')
    ? d.sensitivity_verdict
    : {};
  return {
    ...base,
    generator_locality: d.effectiveLocality || null,
    forced_local: d.forced_local === true,
    routing_reason: d.routing_reason || null,
    sensitivity_verdict: {
      sensitivity: sv.sensitivity || null,
      pii_classes: Array.isArray(sv.pii_classes) ? sv.pii_classes : [],
      secret_classes: Array.isArray(sv.secret_classes) ? sv.secret_classes : [],
      scanned_count: typeof sv.scanned_count === 'number' ? sv.scanned_count : 0,
      pool_count: typeof sv.pool_count === 'number' ? sv.pool_count : 0,
      sampled: sv.sampled === true,
    },
    redaction_mode: d.redaction_mode || null,
    router_version: GENERATOR_ROUTER_VERSION,
  };
}

/**
 * buildRoutingAssertions(decision) -> plain object of kolm.* assertions suitable
 * to fold into the syn-3 provenance assertions namespace. The later wiring step
 * folds these into buildArtifactCredential ingredients/assertions (inside the
 * SIGNED body) without weakening signature coverage. No raw seed text, no
 * secret values - only class ids and the routing verdict.
 */
export function buildRoutingAssertions(decision) {
  const d = (decision && typeof decision === 'object') ? decision : {};
  const sv = (d.sensitivity_verdict && typeof d.sensitivity_verdict === 'object')
    ? d.sensitivity_verdict
    : {};
  return {
    'kolm.generator_locality': d.effectiveLocality || null,
    'kolm.forced_local': d.forced_local === true,
    'kolm.routing_reason': d.routing_reason || null,
    'kolm.sensitivity': sv.sensitivity || null,
    'kolm.sensitivity_pii_classes': Array.isArray(sv.pii_classes) ? sv.pii_classes : [],
    'kolm.sensitivity_secret_classes': Array.isArray(sv.secret_classes) ? sv.secret_classes : [],
    'kolm.redaction_mode': d.redaction_mode || null,
    'kolm.router_version': GENERATOR_ROUTER_VERSION,
  };
}

// =============================================================================
// G. COST-PREVIEW FIELD
// =============================================================================
//
// hosted_egress_usd is 0 whenever effectiveLocality === 'local' (forced or not)
// - local synthesis incurs no hosted token cost - and equals hostedEstimate
// only when effectiveLocality === 'hosted'. The wiring step adds a `routing`
// field to cost-estimator preview output using this; estimateBatchCost math is
// untouched.

export function routingCostField(decision, hostedEstimate) {
  const d = (decision && typeof decision === 'object') ? decision : {};
  const local = d.effectiveLocality === 'local';
  const est = (typeof hostedEstimate === 'number' && Number.isFinite(hostedEstimate))
    ? hostedEstimate
    : 0;
  return {
    locality: d.effectiveLocality || null,
    forced_local: d.forced_local === true,
    routing_reason: d.routing_reason || null,
    hosted_egress_usd: local ? 0 : est,
  };
}

export default {
  GENERATOR_ROUTER_VERSION,
  classifySensitivity,
  requestedLocalityOf,
  prepareSeedForPrompt,
  makeLocalTranslateFn,
  LocalGeneratorError,
  route,
  localGeneratorReachable,
  stampRow,
  buildRoutingAssertions,
  routingCostField,
};
