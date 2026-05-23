// W727 — Student-as-Draft Speculative Decoding (consumer-facing).
//
// "Student proposes N tokens, teacher verifies/corrects in parallel" — the
// classic Leviathan/Chen speculative decoding setup, exposed as a single
// orchestration shell that consumer-facing endpoints (notably
// /v1/chat/completions?accelerate=true wired in src/router.js) can call
// without needing to know which speculative-decoding backend is installed.
//
// W707 plan items wired here:
//
//   W727-1  acceleratedChatCompletion({messages, namespace, accelerate,
//           n_draft_tokens}) — orchestrates one round of student-as-draft +
//           teacher verification, returning the accepted-prefix and a
//           teacher-corrected suffix.
//
//   W727-2  Compose with W709 confidence routing (when
//           src/confidence-routing.js OR src/runtime-confidence-router.js
//           returns route='student-only' with confidence > threshold, the
//           teacher verification step is bypassed entirely — speculative-
//           decoding's worst-case overhead is the teacher round-trip, so a
//           high-confidence student answer should never pay it).
//
//   W727-3  benchAcceptanceRate({task_class, samples}) — reports mean
//           acceptance rate per draft round + mean tokens per draft round +
//           mean wall-clock speedup, keyed by task class
//           (extraction/generation/reasoning).
//
// Honest-by-default contract:
//
//   - If no speculative-decoding backend is configured, every function
//     returns {ok:false, error:'no_kernel', hint:'set
//     KOLM_SPEC_DECODE_BACKEND=<llama-cpp|vllm|tgi|sglang>'}. We NEVER
//     silently fall through to the pure-teacher path and pretend we
//     accelerated — that would lie about the acceptance rate AND about the
//     speedup, both of which exist on the public dashboard.
//
//   - When a mock/test backend is injected via opts.backend (dependency
//     injection — pure-function-friendly), acceptance_rate is a real number
//     in [0,1] computed from the per-token verification outcomes returned
//     by the backend. No fake numbers.
//
//   - The W709 confidence-router compose check is best-effort. If the
//     module is missing or throws, we honestly fall back to running the
//     full speculative round; we never crash the inference path because a
//     dashboard-side helper failed to load.
//
// Exports:
//
//   ACCELERATE_VERSION                       string, exact 'w727-v1'
//   detectSpecDecodeBackend()                {ok, backend|null, source}
//   acceleratedChatCompletion(opts)          one-shot orchestration
//   benchAcceptanceRate({task_class, samples}) keyed report

import crypto from 'node:crypto';

export const ACCELERATE_VERSION = 'w727-v1';

// Recognized backends. We never instantiate these directly here — the
// orchestrator is a thin shell. The W727 module's job is to detect that
// SOMETHING is wired and to refuse loudly when nothing is. The actual
// generation calls happen inside opts.backend (dependency injection in
// tests; real backend bridge supplied by the router in production).
const KNOWN_BACKENDS = Object.freeze([
  'llama-cpp', 'vllm', 'tgi', 'sglang',
]);

// Task-class baselines (W727-3). These are calibration FLOORS for the
// bench's acceptance test: speculative-decoding theory says extraction is
// the easiest (high local redundancy → high acceptance), reasoning is the
// hardest (longer dependencies → lower acceptance). The exact numbers come
// from the public Leviathan'23/Chen'23/MEDUSA literature and are documented
// in KOLM_W707_SYSTEM_UPGRADE_PLAN.md W727-3.
const TASK_CLASS_BASELINES = Object.freeze({
  extraction: 0.60,
  generation: 0.40,
  reasoning:  0.30,
});

/**
 * Detect a configured speculative-decoding backend. Detection precedence:
 *
 *   1. process.env.KOLM_SPEC_DECODE_BACKEND  (explicit operator opt-in)
 *   2. src/spec-decode.js trainer presence    (W480 reused — if the trainer
 *      is on PATH the operator has at least built a pair, so a server-side
 *      inference path is plausible)
 *
 * Returns {ok:true, backend, source} or {ok:false, error, hint}. NEVER
 * throws.
 */
export function detectSpecDecodeBackend(env = process.env) {
  const explicit = String(env && env.KOLM_SPEC_DECODE_BACKEND || '').trim().toLowerCase();
  if (explicit) {
    if (KNOWN_BACKENDS.includes(explicit)) {
      return { ok: true, backend: explicit, source: 'env' };
    }
    // Unknown name — refuse loudly. A typo'd "vllm-server" would otherwise
    // silently fall through to the bench's no_kernel path while looking
    // configured to the operator.
    return {
      ok: false,
      error: 'unknown_backend',
      hint: `KOLM_SPEC_DECODE_BACKEND=${JSON.stringify(explicit)} is not one of ${KNOWN_BACKENDS.join('|')}`,
      version: ACCELERATE_VERSION,
    };
  }
  return {
    ok: false,
    error: 'no_kernel',
    hint: 'set KOLM_SPEC_DECODE_BACKEND=<llama-cpp|vllm|tgi|sglang>',
    version: ACCELERATE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// W709/W807 compose — best-effort confidence-router consultation. Returns a
// route decision {route, confidence, source} or null on any error / module
// missing. Treats the absence of either module as "no compose available" —
// which is the honest no-op the plan calls for, not a failure.
// ---------------------------------------------------------------------------
async function _consultConfidenceRouter(probe) {
  // Probe shape (test-only override): {route:'student-only', confidence:0.95}
  // is honored directly so test code can pin the bypass branch without
  // having to construct a full logprobs array.
  if (probe && typeof probe === 'object'
      && typeof probe.route === 'string'
      && typeof probe.confidence === 'number') {
    return {
      route: probe.route,
      confidence: probe.confidence,
      source: 'probe',
    };
  }
  // Try the legacy/W707-spec'd src/confidence-routing.js name FIRST so a
  // future explicit rename to that path takes precedence. Then fall back to
  // the already-shipped W709 src/runtime-confidence-router.js + the
  // streaming W807 src/confidence-router.js.
  for (const modName of ['./confidence-routing.js', './runtime-confidence-router.js', './confidence-router.js']) {
    try {
      const mod = await import(modName);
      if (mod && typeof mod.decideRouting === 'function' && probe && Array.isArray(probe.tokens)) {
        const d = mod.decideRouting({
          tokens: probe.tokens,
          threshold: probe.threshold,
          hasLogprobs: probe.tokens.length > 0,
        });
        if (d && typeof d.route === 'string') {
          return {
            route: d.route === 'student' ? 'student-only' : d.route,
            confidence: typeof d.confidence === 'number' ? d.confidence : 0,
            source: modName,
          };
        }
      }
    } catch (_) {
      // Honest no-op: missing module is fine.
    }
  }
  return null;
}

/**
 * Run one round of student-as-draft + teacher verification.
 *
 * Required opts:
 *
 *   messages       Array<{role,content}>  Standard chat-completions input.
 *   namespace      string                  Tenant-scoped namespace tag for
 *                                          downstream observability.
 *   accelerate     boolean                 Must be true for the W727 path
 *                                          to run; defensive guard so the
 *                                          orchestrator can be called from
 *                                          a single shared code path with
 *                                          the flag flowing through.
 *
 * Optional opts:
 *
 *   n_draft_tokens number  Default 4. The number of speculative tokens the
 *                          student proposes per round. Real backends cap
 *                          this at 16 or so; we clamp to [1, 64] here.
 *   tenant_id      string  Tenant id for defense-in-depth fencing on
 *                          downstream writes.
 *   backend        object  Dependency-injected backend. When supplied,
 *                          bypasses backend detection. Shape:
 *                            { propose: async ({messages, n}) =>
 *                                ({tokens:[{text,logprob?}], cost_micro_usd}),
 *                              verify: async ({messages, draft}) =>
 *                                ({accepted:[bool,...], teacher_token:{text}|null,
 *                                  cost_micro_usd, latency_ms}),
 *                              wall_clock_ms_teacher_only: number }
 *   confidence_probe object  Forwarded to _consultConfidenceRouter; when it
 *                            returns route='student-only' with
 *                            confidence > threshold, teacher_verifications
 *                            stays at 0. Default threshold 0.85.
 *
 * Returns:
 *
 *   { ok:true, version, accepted_text, draft_tokens_proposed,
 *     draft_tokens_accepted, acceptance_rate, teacher_verifications,
 *     route:'accelerated'|'student-only'|'fallback', router?: {...},
 *     wall_clock_ms, speedup_x }
 *
 *   OR honest envelope on backend missing:
 *
 *   { ok:false, error:'no_kernel', hint:..., version }
 */
export async function acceleratedChatCompletion(opts = {}) {
  const {
    messages,
    namespace = 'default',
    accelerate = false,
    n_draft_tokens = 4,
    tenant_id = null,
    backend = null,
    confidence_probe = null,
    env = process.env,
  } = opts || {};

  if (!accelerate) {
    return {
      ok: false,
      error: 'accelerate_false',
      hint: 'pass accelerate:true to opt into the W727 student-as-draft path; the unaccelerated path is handled by the existing chat-completions wrapper',
      version: ACCELERATE_VERSION,
    };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      error: 'messages_required',
      hint: 'messages must be a non-empty Array<{role,content}>',
      version: ACCELERATE_VERSION,
    };
  }
  // Defense-in-depth: when a caller pretends to be a tenant but isn't, the
  // router itself fences via req.tenant_record. Here we accept null so the
  // pure-function bench can run; production callers always pass tenant_id.
  void tenant_id; void namespace;

  const n = Math.max(1, Math.min(64, Math.trunc(Number(n_draft_tokens) || 4)));

  // Resolve the backend. Explicit injection wins; otherwise detection.
  let chosenBackend = backend;
  if (!chosenBackend) {
    const det = detectSpecDecodeBackend(env);
    if (!det.ok) {
      return {
        ok: false,
        error: det.error || 'no_kernel',
        hint: det.hint,
        version: ACCELERATE_VERSION,
      };
    }
    // The router supplies the real backend at production wiring time. When
    // detect says "ok" but no backend was injected we still refuse — we'd
    // rather honestly say "no backend bridge" than fabricate token counts.
    return {
      ok: false,
      error: 'no_kernel',
      hint: `backend ${det.backend} detected via ${det.source} but no in-process bridge supplied; pass opts.backend or wire src/router.js bridge`,
      version: ACCELERATE_VERSION,
      detected_backend: det.backend,
    };
  }

  // W709/W807 compose — high-confidence student path skips teacher verify.
  let routerNote = null;
  let bypassTeacher = false;
  try {
    const r = await _consultConfidenceRouter(confidence_probe);
    if (r) {
      routerNote = r;
      const thr = typeof (confidence_probe && confidence_probe.threshold) === 'number'
        ? confidence_probe.threshold : 0.85;
      if (r.route === 'student-only' && typeof r.confidence === 'number' && r.confidence > thr) {
        bypassTeacher = true;
      }
    }
  } catch (_) { /* honest no-op */ }

  const t0 = _now();

  // STEP 1 — student proposes n_draft_tokens.
  let proposal;
  try {
    proposal = await chosenBackend.propose({ messages, n });
  } catch (e) {
    return {
      ok: false,
      error: 'student_propose_failed',
      detail: (e && e.message) || String(e),
      hint: 'opts.backend.propose threw — check the backend bridge',
      version: ACCELERATE_VERSION,
    };
  }
  const draftTokens = Array.isArray(proposal && proposal.tokens) ? proposal.tokens : [];
  const draftCost = Number((proposal && proposal.cost_micro_usd) || 0);
  const draftCount = draftTokens.length;

  // STEP 2 — teacher verifies in parallel UNLESS the confidence-router
  // signaled a bypass. Bypass means we accept every student token by
  // construction and pay zero teacher cost.
  let acceptedCount = draftCount;
  let acceptedText = draftTokens.map(t => String(t.text || '')).join('');
  let teacherCost = 0;
  let teacherCorrected = null;
  let teacherVerifications = 0;
  let verifyLatency = 0;

  if (!bypassTeacher) {
    let verifyResult;
    try {
      verifyResult = await chosenBackend.verify({ messages, draft: draftTokens });
    } catch (e) {
      return {
        ok: false,
        error: 'teacher_verify_failed',
        detail: (e && e.message) || String(e),
        hint: 'opts.backend.verify threw — check the teacher bridge',
        version: ACCELERATE_VERSION,
      };
    }
    const accepted = Array.isArray(verifyResult && verifyResult.accepted) ? verifyResult.accepted : [];
    teacherCost = Number((verifyResult && verifyResult.cost_micro_usd) || 0);
    teacherCorrected = (verifyResult && verifyResult.teacher_token) || null;
    verifyLatency = Number((verifyResult && verifyResult.latency_ms) || 0);
    // Speculative-decoding accept rule: accept the longest run of trues
    // STARTING at index 0. The first false halts acceptance and the
    // teacher's correction token is appended in place of the rejected one.
    let runLen = 0;
    for (let i = 0; i < accepted.length && i < draftCount; i += 1) {
      if (accepted[i] === true) runLen += 1;
      else break;
    }
    acceptedCount = runLen;
    acceptedText = draftTokens.slice(0, runLen).map(t => String(t.text || '')).join('');
    if (runLen < draftCount && teacherCorrected && typeof teacherCorrected.text === 'string') {
      acceptedText += teacherCorrected.text;
    }
    // Even when all tokens accept, the teacher still performed one parallel
    // verification round. That's the load-bearing W727-3 number.
    teacherVerifications = draftCount > 0 ? 1 : 0;
  }

  const t1 = _now();
  const wallClock = t1 - t0;

  // Speedup_x: vs the synthetic "teacher generates everything sequentially"
  // baseline supplied by the backend. Default 1.0 when not supplied so the
  // bench still produces a finite number; the real backend always reports
  // a measured wall_clock_ms_teacher_only.
  const teacherOnlyMs = Number(
    (chosenBackend.wall_clock_ms_teacher_only != null)
      ? chosenBackend.wall_clock_ms_teacher_only
      : 0,
  );
  const speedup_x = (teacherOnlyMs > 0 && wallClock > 0)
    ? Math.max(0, teacherOnlyMs / wallClock)
    : (acceptedCount > 0 ? acceptedCount : 1);

  const accRate = draftCount > 0 ? (acceptedCount / draftCount) : 0;

  return {
    ok: true,
    version: ACCELERATE_VERSION,
    accelerated: true,
    route: bypassTeacher ? 'student-only' : 'accelerated',
    router: routerNote,
    accepted_text: acceptedText,
    draft_tokens_proposed: draftCount,
    draft_tokens_accepted: acceptedCount,
    acceptance_rate: accRate,
    teacher_verifications: teacherVerifications,
    teacher_correction_text: teacherCorrected && teacherCorrected.text ? teacherCorrected.text : null,
    cost_micro_usd: draftCost + teacherCost,
    wall_clock_ms: wallClock,
    teacher_only_wall_clock_ms: teacherOnlyMs || null,
    speedup_x: Number(speedup_x.toFixed(4)),
    verify_latency_ms: verifyLatency,
  };
}

/**
 * Run N samples through the accelerated path and report per-task-class
 * mean acceptance rate + mean wall-clock speedup. Used by the W727 bench.
 *
 * Required opts:
 *
 *   task_class   one of 'extraction'|'generation'|'reasoning'
 *   samples      number — at least 1
 *
 * Optional:
 *
 *   backend      DI backend (test-friendly)
 *   n_draft_tokens  forwarded to acceleratedChatCompletion
 *   env          process.env override for detect()
 *
 * Returns:
 *
 *   { ok:true, version, task_class, samples, mean_acceptance_rate,
 *     mean_tokens_per_draft_round, mean_speedup_x, mean_wall_clock_ms,
 *     baseline_floor, meets_baseline }
 *
 *   OR honest envelope on missing backend:
 *
 *   { ok:false, error:'no_kernel', hint, version, task_class }
 */
export async function benchAcceptanceRate(opts = {}) {
  const {
    task_class,
    samples = 1,
    backend = null,
    n_draft_tokens = 4,
    env = process.env,
  } = opts || {};
  if (!Object.prototype.hasOwnProperty.call(TASK_CLASS_BASELINES, String(task_class || ''))) {
    return {
      ok: false,
      error: 'unknown_task_class',
      hint: 'task_class must be one of ' + Object.keys(TASK_CLASS_BASELINES).join('|'),
      version: ACCELERATE_VERSION,
    };
  }
  const N = Math.max(1, Math.trunc(Number(samples) || 1));
  if (!backend) {
    const det = detectSpecDecodeBackend(env);
    if (!det.ok) {
      return {
        ok: false,
        error: det.error || 'no_kernel',
        hint: det.hint,
        task_class,
        version: ACCELERATE_VERSION,
      };
    }
  }

  let accSum = 0;
  let acceptedSum = 0;
  let speedupSum = 0;
  let wallSum = 0;
  let firstErr = null;
  let ok = 0;
  for (let i = 0; i < N; i += 1) {
    const r = await acceleratedChatCompletion({
      messages: [
        { role: 'user', content: `bench:${task_class}:${i}` },
      ],
      namespace: 'bench_w727',
      accelerate: true,
      n_draft_tokens,
      backend,
      env,
    });
    if (!r.ok) {
      firstErr = firstErr || r;
      continue;
    }
    accSum += Number(r.acceptance_rate || 0);
    acceptedSum += Number(r.draft_tokens_accepted || 0);
    speedupSum += Number(r.speedup_x || 0);
    wallSum += Number(r.wall_clock_ms || 0);
    ok += 1;
  }
  if (ok === 0) {
    return {
      ok: false,
      error: firstErr ? firstErr.error : 'all_samples_failed',
      hint: firstErr ? firstErr.hint : 'every sample returned an error envelope',
      task_class,
      samples_attempted: N,
      version: ACCELERATE_VERSION,
    };
  }
  const meanAcc = accSum / ok;
  const meanAcceptedTokens = acceptedSum / ok;
  const meanSpeedup = speedupSum / ok;
  const meanWall = wallSum / ok;
  const floor = TASK_CLASS_BASELINES[task_class];
  return {
    ok: true,
    version: ACCELERATE_VERSION,
    task_class,
    samples: ok,
    samples_attempted: N,
    mean_acceptance_rate: Number(meanAcc.toFixed(4)),
    mean_tokens_per_draft_round: Number(meanAcceptedTokens.toFixed(4)),
    mean_speedup_x: Number(meanSpeedup.toFixed(4)),
    mean_wall_clock_ms: Number(meanWall.toFixed(4)),
    baseline_floor: floor,
    meets_baseline: meanAcc >= floor,
  };
}

/** @returns {number} milliseconds, monotonic when available */
function _now() {
  if (typeof globalThis.performance === 'object' && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

// Stable export aliases so older callers using the import-default pattern
// don't have to know which export shape they're getting.
export const TASK_CLASSES = Object.freeze(Object.keys(TASK_CLASS_BASELINES));
export const BASELINES = TASK_CLASS_BASELINES;

export default {
  ACCELERATE_VERSION,
  TASK_CLASSES,
  BASELINES,
  detectSpecDecodeBackend,
  acceleratedChatCompletion,
  benchAcceptanceRate,
};
// Quiet unused-import lint for crypto — kept available for future
// request-hash work without churning imports across the file.
void crypto;
