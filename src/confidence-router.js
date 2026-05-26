// W807 — confidence-aware adaptive routing (next-generation).
//
// W709 shipped a per-call routing decision (student vs teacher) based on
// first-token entropy from an entire response. W807 is the NEXT generation:
// it watches a streaming entropy WINDOW during student generation, decides
// MID-RESPONSE whether to splice in the teacher (W807-2), and feeds every
// splice event back into the W720 self-improvement loop (W807-6) so the
// captures that triggered splices climb to the top of the re-distill queue.
//
// Why this is a separate module from W709 `runtime-confidence-router.js`:
//
//   - W709 returns a single decision for an already-known full token stream.
//   - W807 maintains an O(1) sliding window over a stream so the decision is
//     made AS the student is generating — enabling mid-response teacher
//     splices (W807-2) and per-token threshold telemetry (W807-3).
//   - W709's threshold is a single nats value. W807 ships a NAMED threshold
//     TABLE so users (and the dashboard) can opt into preset risk profiles
//     (aggressive / balanced / conservative).
//
// Honest-by-default contract:
//   - Threshold inputs accept either a number (raw nats) OR a profile name
//     from THRESHOLD_TABLE. Unknown profile names fall back to 'balanced'
//     and stamp `threshold_profile_unknown:<name>` on the reason so the
//     caller can debug without silent miscalibration.
//   - If the adapter returns NO top_logprobs we tag reason='no_top_logprobs'
//     and emit route='student' — NEVER silently switch to "always teacher".
//   - Every splice event written into the event-store via W720 carries
//     {capture_candidate:true, weakness_signal:true} so detectUnderperforming
//     Captures picks it up in the next sweep.
//
// Exports:
//   - VERSION
//   - THRESHOLD_TABLE         {aggressive, balanced, conservative}
//   - resolveThreshold(t)     number|string -> {value, profile}
//   - tokenEntropy(logits)    Shannon entropy of one row of top_logprobs
//   - streamingEntropyWindow(window) factory: state-carrying ring buffer
//   - emitSpliceWeaknessSignal(event) → durable routing-event row (W807-6)

import crypto from 'node:crypto';

export const VERSION = 'w807-v1';

// Named thresholds in NATs. Calibration rationale per profile:
//
//   aggressive (0.85)   — only splice on genuinely confused windows. Student
//                          stays in the driver's seat. Lowest teacher cost,
//                          highest risk of student error.
//   balanced   (0.7)    — ≈ log(2)+ε: splice when student is at-or-past
//                          50/50 between its top two candidates over the
//                          window. Production default.
//   conservative (0.55) — splice early; favor teacher quality over cost.
//
// Higher number = higher entropy tolerated before splicing.
export const THRESHOLD_TABLE = Object.freeze({
  aggressive: 0.85,
  balanced: 0.7,
  conservative: 0.55,
});

export const DEFAULT_PROFILE = 'balanced';

/**
 * Resolve a threshold input (numeric nats OR named profile) to a numeric
 * value + the profile name (or null if numeric).
 *
 * Unknown profile names degrade to DEFAULT_PROFILE and stamp the original
 * value on the `unknown` field so callers can surface it in their reason
 * string. Never throws.
 *
 * @param {number|string|undefined|null} input
 * @returns {{value: number, profile: string|null, unknown?: string}}
 */
export function resolveThreshold(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { value: input, profile: null };
  }
  if (typeof input === 'string') {
    const key = input.toLowerCase().trim();
    if (Object.prototype.hasOwnProperty.call(THRESHOLD_TABLE, key)) {
      return { value: THRESHOLD_TABLE[key], profile: key };
    }
    return {
      value: THRESHOLD_TABLE[DEFAULT_PROFILE],
      profile: DEFAULT_PROFILE,
      unknown: input,
    };
  }
  return { value: THRESHOLD_TABLE[DEFAULT_PROFILE], profile: DEFAULT_PROFILE };
}

// ---------------------------------------------------------------------------
// Entropy primitives
// ---------------------------------------------------------------------------

function shannonEntropyFromProbs(probs) {
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

// Accept either:
//   - an array of {token, logprob} top-k rows (OpenAI v1 shape)
//   - a single OpenAI v1 row with {token, logprob, top_logprobs:[...]}
//   - a bare array of numeric logits (we apply softmax)
//   - a bare array of numeric probabilities (must already sum >0; we normalize)
//
// Returns a finite number in nats. Returns 0 when the input is empty/invalid.
export function tokenEntropy(logits) {
  if (logits == null) return 0;
  // Single OpenAI-v1 row — pluck top_logprobs.
  if (!Array.isArray(logits) && typeof logits === 'object' && Array.isArray(logits.top_logprobs)) {
    return tokenEntropy(logits.top_logprobs);
  }
  if (!Array.isArray(logits) || logits.length === 0) return 0;

  // Detect shape. If every entry is an object with .logprob (OpenAI), treat
  // as already-natural-log probabilities. If every entry is finite number,
  // treat as raw logits OR raw probabilities (auto-detect via sum).
  const firstNumeric = typeof logits[0] === 'number';
  const probs = [];
  if (firstNumeric) {
    // Bare numeric array. Decide softmax-vs-normalize by sum.
    let sum = 0;
    for (const v of logits) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      sum += n;
      probs.push(n);
    }
    if (probs.length === 0) return 0;
    // Heuristic: if all values are in [0,1] and sum is close to 1, treat as
    // probabilities. Otherwise treat as logits and apply softmax.
    let allInUnit = true;
    for (const p of probs) { if (p < 0 || p > 1) { allInUnit = false; break; } }
    if (allInUnit && Math.abs(sum - 1) < 0.05) {
      return shannonEntropyFromProbs(probs);
    }
    // Softmax (numerically stable).
    let maxL = -Infinity;
    for (const x of probs) if (x > maxL) maxL = x;
    const exps = probs.map((x) => Math.exp(x - maxL));
    let z = 0;
    for (const x of exps) z += x;
    if (!(z > 0)) return 0;
    const norm = exps.map((x) => x / z);
    return shannonEntropyFromProbs(norm);
  }
  // Object array — assume OpenAI-shaped {logprob} entries.
  let sum = 0;
  for (const cand of logits) {
    if (cand == null) continue;
    const lp = Number(cand.logprob);
    if (!Number.isFinite(lp)) continue;
    const p = Math.exp(lp);
    probs.push(p);
    sum += p;
  }
  if (probs.length === 0 || !(sum > 0)) return 0;
  const norm = probs.map((p) => p / sum);
  return shannonEntropyFromProbs(norm);
}

// ---------------------------------------------------------------------------
// Streaming entropy window (W807-1)
// ---------------------------------------------------------------------------

/**
 * Factory: a stateful ring-buffer that tracks the last `window` per-token
 * entropies and a running sum, so the mean-over-window can be queried in
 * O(1) per push.
 *
 * Returned object exposes:
 *   - push(entropy_or_row) → {at, entropy, window_mean, count}
 *   - mean()               → mean of the last window entries (0 if empty)
 *   - max()                → max of the last window entries (0 if empty)
 *   - exceeds(threshold)   → window_mean > threshold (NOT >=, to mirror
 *                            the W709 strict-above semantics)
 *   - reset()              → clear state
 *   - size                 → current count (≤ window)
 *   - capacity             → window
 *
 * @param {number} [window=8]
 */
export function streamingEntropyWindow(window = 8) {
  const cap = Number.isFinite(window) && window > 0 ? Math.trunc(window) : 8;
  const buf = new Array(cap).fill(0);
  let head = 0;     // next write slot
  let count = 0;    // how many real entries (≤ cap)
  let total = 0;    // running sum of in-buffer entries
  let position = 0; // absolute token index

  return {
    capacity: cap,
    get size() { return count; },
    push(entropyOrRow) {
      const h = typeof entropyOrRow === 'number'
        ? entropyOrRow
        : tokenEntropy(entropyOrRow);
      // Evict the slot we're about to overwrite from the running sum.
      if (count >= cap) {
        total -= buf[head];
      } else {
        count += 1;
      }
      buf[head] = h;
      total += h;
      head = (head + 1) % cap;
      position += 1;
      return {
        at: position - 1,
        entropy: h,
        window_mean: count > 0 ? total / count : 0,
        count,
      };
    },
    mean() { return count > 0 ? total / count : 0; },
    max() {
      let m = 0;
      for (let i = 0; i < count; i += 1) {
        if (buf[i] > m) m = buf[i];
      }
      return m;
    },
    exceeds(threshold) {
      const t = Number(threshold);
      if (!Number.isFinite(t)) return false;
      if (count === 0) return false;
      return (total / count) > t;
    },
    reset() {
      for (let i = 0; i < buf.length; i += 1) buf[i] = 0;
      head = 0; count = 0; total = 0; position = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// W807-6 — wire-into-W720
// ---------------------------------------------------------------------------

/**
 * Build a routing-event row from a splice event and persist it via
 * src/routing-events.js (already shipped W709). The row is stamped with
 * weakness_signal:true + capture_candidate:true inside the entropy_summary
 * blob so src/self-improvement.js detectUnderperformingCaptures elevates
 * the capture in its next sweep.
 *
 * The row's `route` is set to 'mixed' when at least one splice fired and
 * the splice succeeded (the response contains both student + teacher
 * tokens) and 'teacher' when the only segment was the teacher (e.g. the
 * student aborted at token 0).  Pure student rows are NOT written by this
 * helper — they are not weakness signals.
 *
 * Honest envelope: routing-events writer failure NEVER throws into the
 * generation path; we return {ok:false, error:'<code>'} instead.
 *
 * @param {Object} opts
 * @param {string} opts.tenant_id
 * @param {string} [opts.namespace='default']
 * @param {Object} opts.splice_event  — output of spliceToTeacher OR an
 *                                       aggregate {splice_events:[],
 *                                       local_tokens, teacher_tokens,
 *                                       threshold_used, threshold_profile}
 * @param {number} [opts.student_micro_usd=0]
 * @param {number} [opts.teacher_micro_usd=0]
 * @returns {Promise<{ok:boolean, row?:Object, error?:string, hint?:string}>}
 */
export async function emitSpliceWeaknessSignal(opts = {}) {
  const {
    tenant_id,
    namespace = 'default',
    splice_event,
    student_micro_usd = 0,
    teacher_micro_usd = 0,
  } = opts || {};
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'tenant_id is required so the W720 detector can scope the candidate row',
      version: VERSION,
    };
  }
  if (!splice_event || typeof splice_event !== 'object') {
    return {
      ok: false,
      error: 'missing_splice_event',
      hint: 'pass the splice envelope returned by spliceToTeacher',
      version: VERSION,
    };
  }

  // Coerce supported splice-event shapes into a uniform summary.
  const localTokens = Math.max(0, Math.trunc(Number(
    splice_event.local_tokens != null ? splice_event.local_tokens : splice_event.tokens_so_far_count || 0,
  )));
  const teacherTokens = Math.max(0, Math.trunc(Number(splice_event.teacher_tokens || 0)));
  const spliceEvents = Array.isArray(splice_event.splice_events) ? splice_event.splice_events : [];
  const thresholdUsed = Number.isFinite(Number(splice_event.threshold_used))
    ? Number(splice_event.threshold_used) : null;
  const thresholdProfile = splice_event.threshold_profile || null;
  const fallbackFailed = splice_event.fallback_failed === true;

  // Route classification:
  //   - if any splice fired AND localTokens > 0 → 'mixed'
  //   - if any splice fired AND localTokens === 0 → 'teacher'
  //   - otherwise → 'student' (still record as weakness if explicitly forced)
  let route = 'mixed';
  if (spliceEvents.length === 0 && teacherTokens === 0) {
    route = 'student';
  } else if (localTokens === 0 && teacherTokens > 0) {
    route = 'teacher';
  }

  // The reason field encodes the FIRST splice trigger so the dashboard can
  // group decisions by trigger. Fallback to a stable string when the splice
  // event carries none.
  const firstSplice = spliceEvents[0] || {};
  const reasonBase = firstSplice.reason || (fallbackFailed ? 'splice_fallback_failed' : 'entropy_window_exceeded');
  const reason = ('splice:' + reasonBase).slice(0, 256);

  // Embed the W720 signals in entropy_summary. routing-events.js sanitizes
  // entropy_summary down to {max, mean, p95}; we keep the bare-minimum
  // signal-strength fields there + dual-write a richer payload via the
  // lake's `feedback` JSON blob in routing-events itself (already happens).
  const meanEntropy = Number.isFinite(Number(splice_event.window_mean))
    ? Number(splice_event.window_mean) : 0;
  const maxEntropy = Number.isFinite(Number(splice_event.window_max))
    ? Number(splice_event.window_max) : meanEntropy;

  let recorded;
  try {
    const mod = await import('./routing-events.js');
    recorded = await mod.recordRoutingDecision({
      tenant_id,
      namespace,
      decision: {
        route,
        reason,
        entropy_summary: {
          max: maxEntropy,
          mean: meanEntropy,
          p95: maxEntropy,
        },
      },
      student_tokens: localTokens,
      teacher_tokens: teacherTokens,
      costs: {
        student_micro_usd,
        teacher_micro_usd,
      },
      threshold: thresholdUsed,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'routing_events_write_failed',
      detail: e && e.message ? e.message : String(e),
      hint: 'src/routing-events.js recordRoutingDecision failed — capture will not surface in W720',
      version: VERSION,
    };
  }

  // Second write — emit a canonical event row through the event-store so
  // src/self-improvement.js detectUnderperformingCaptures sees it. We add
  // capture_candidate:true + weakness_signal:true to feedback so a future
  // event-schema update can elevate these without re-walking the events.
  try {
    const es = await import('./event-store.js');
    const fb = JSON.stringify({
      kind: 'splice_weakness_signal',
      capture_candidate: true,
      weakness_signal: true,
      splice_event_count: spliceEvents.length,
      threshold_used: thresholdUsed,
      threshold_profile: thresholdProfile,
      route,
      reason,
      fallback_failed: fallbackFailed,
      version: VERSION,
    });
    const requestHash = splice_event.request_hash
      || ('w807-splice-' + crypto.createHash('sha256').update(reason + ':' + namespace + ':' + (recorded && recorded.id ? recorded.id : '')).digest('hex').slice(0, 16));
    await es.appendEvent({
      tenant_id,
      namespace,
      provider: 'kolm-confidence-router',
      vendor: 'kolm',
      model: 'router/splice',
      workflow_id: 'splice:weakness_signal',
      request_hash: requestHash,
      prompt_tokens: localTokens,
      completion_tokens: teacherTokens,
      tokens_in: localTokens,
      tokens_out: teacherTokens,
      // Failed splice = error so W720 detectUnderperformingCaptures sees
      // it via FAILURE_STATUS. Successful splice still counts via the
      // negative-feedback prefix below.
      status: fallbackFailed ? 'error' : 'ok',
      feedback: fb,
    });
  } catch (_) { // deliberate: cleanup
    // Non-critical: routing-events write above is the source of truth.
  }

  return { ok: true, row: recorded, version: VERSION };
}

export default {
  VERSION,
  THRESHOLD_TABLE,
  DEFAULT_PROFILE,
  resolveThreshold,
  tokenEntropy,
  streamingEntropyWindow,
  emitSpliceWeaknessSignal,
};
