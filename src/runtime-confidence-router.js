// W709 - runtime confidence-aware router. Token-level entropy of a student
// model's logprobs decides whether to (a) emit the student response as-is or
// (b) escalate a high-entropy span to the teacher API. The "moat" feature:
// distilled student models stay effectively as-good-as-teacher at student
// cost, paying for the teacher only on tokens where the student is unsure.
//
// Honest-by-default contract:
//   - If the upstream adapter does NOT return logprobs (e.g. Anthropic does
//     not expose per-token distributions; OpenAI without `logprobs:true`
//     returns none either) the router emits route:'student' with
//     reason:'no_entropy_signal_available'. It NEVER silently switches to
//     "always teacher" - that would defeat the cost-saving point and lie
//     about why the teacher was called.
//   - Entropy is Shannon entropy in NATs (natural log), computed over the
//     top_logprobs distribution per token. Top-K is necessarily truncated so
//     the entropy is a lower bound on the true distribution's entropy. We
//     still mass-normalize the top-K probabilities to a proper distribution
//     before scoring.
//
// Shapes:
//   logprobs (OpenAI v1 format) =
//     [{ token, logprob, top_logprobs: [{ token, logprob }, ...] }, ...]
//
//   tokenEntropy(logprobs) returns:
//     { per_token: number[], max: number, mean: number, count: number,
//       reason: 'ok' | 'empty' | 'no_top_logprobs' }
//
//   decideRouting({ tokens, threshold, hasLogprobs }) returns:
//     { route: 'student' | 'teacher' | 'mixed',
//       confidence: number | null,
//       reason: string,
//       entropy_per_token: number[] | null,
//       segments: [{ start, end, source }] }
//
//   shouldEscalateToTeacher(decision) -> boolean

// Default threshold in nats. log(2) ≈ 0.693 corresponds to the entropy of a
// fair coin between the top-2 candidates: at that point the student is
// genuinely 50/50, which is where teacher escalation has the highest leverage.
export const DEFAULT_ENTROPY_THRESHOLD_NATS = Math.log(2);

// Shannon entropy of a distribution given in NORMALIZED probabilities. NATs.
function shannonEntropyFromProbs(probs) {
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

// Given a top_logprobs row, normalize the top-K log-probs back to a proper
// (truncated) distribution and return per-token entropy. The OpenAI API
// already returns natural-log values; we exponentiate, sum, then divide to
// re-normalize since the top-K may not sum to 1.
function entropyFromTopLogprobs(topLogprobs) {
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) return null;
  const probs = [];
  let sum = 0;
  for (const cand of topLogprobs) {
    if (cand == null) continue;
    const lp = Number(cand.logprob);
    if (!Number.isFinite(lp)) continue;
    const p = Math.exp(lp);
    probs.push(p);
    sum += p;
  }
  if (probs.length === 0 || !(sum > 0)) return null;
  const norm = probs.map((p) => p / sum);
  return shannonEntropyFromProbs(norm);
}

/**
 * Compute per-token Shannon entropy from an OpenAI-format logprobs array.
 * @param {Array<{token: string, logprob: number, top_logprobs?: Array<{token: string, logprob: number}>}>} logprobs
 * @returns {{ per_token: number[], max: number, mean: number, count: number, reason: string }}
 */
export function tokenEntropy(logprobs) {
  if (!Array.isArray(logprobs) || logprobs.length === 0) {
    return { per_token: [], max: 0, mean: 0, count: 0, reason: 'empty' };
  }
  const per = [];
  let anyTop = false;
  for (const row of logprobs) {
    if (!row || typeof row !== 'object') continue;
    if (Array.isArray(row.top_logprobs) && row.top_logprobs.length > 0) {
      anyTop = true;
      const h = entropyFromTopLogprobs(row.top_logprobs);
      per.push(h == null ? 0 : h);
    } else {
      // Row carries only the chosen token's logprob. We CANNOT compute a real
      // entropy without the alternative-candidate distribution; the honest
      // floor is "0 known mass, infinite unknown" - but a non-disturbing
      // numeric is needed for the summary so we mark it as 0 and signal the
      // shape via reason='no_top_logprobs' upstream.
      per.push(0);
    }
  }
  if (!anyTop) {
    return {
      per_token: per,
      max: 0,
      mean: 0,
      count: per.length,
      reason: 'no_top_logprobs',
    };
  }
  let max = 0;
  let sum = 0;
  for (const h of per) {
    if (h > max) max = h;
    sum += h;
  }
  return {
    per_token: per,
    max,
    mean: per.length > 0 ? sum / per.length : 0,
    count: per.length,
    reason: 'ok',
  };
}

// Group consecutive indices into [start, end] inclusive ranges.
function groupRuns(indices) {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const runs = [];
  let s = sorted[0];
  let e = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === e + 1) {
      e = sorted[i];
    } else {
      runs.push([s, e]);
      s = sorted[i];
      e = sorted[i];
    }
  }
  runs.push([s, e]);
  return runs;
}

/**
 * Decide whether to route a response to student, teacher, or mixed.
 *
 * @param {Object} opts
 * @param {Array}  [opts.tokens]       OpenAI-format logprobs array (per-token).
 * @param {number} [opts.threshold]    Entropy threshold in NATs.
 * @param {boolean} [opts.hasLogprobs] Whether the adapter supplied logprobs.
 * @returns {{
 *   route: 'student'|'teacher'|'mixed',
 *   confidence: number|null,
 *   reason: string,
 *   entropy_per_token: number[]|null,
 *   segments: Array<{ start: number, end: number, source: 'student'|'teacher' }>
 * }}
 */
export function decideRouting({ tokens, threshold, hasLogprobs } = {}) {
  const thr = Number.isFinite(threshold) ? Number(threshold) : DEFAULT_ENTROPY_THRESHOLD_NATS;
  if (hasLogprobs === false) {
    return {
      route: 'student',
      confidence: null,
      reason: 'no_entropy_signal_available',
      entropy_per_token: null,
      segments: [],
    };
  }
  const summary = tokenEntropy(tokens || []);
  if (summary.reason === 'empty') {
    return {
      route: 'student',
      confidence: null,
      reason: 'empty_token_stream',
      entropy_per_token: [],
      segments: [],
    };
  }
  if (summary.reason === 'no_top_logprobs') {
    // Adapter returned chosen-token logprob but no alternatives - we cannot
    // measure uncertainty, so behave like hasLogprobs===false but tag it
    // distinctly so callers can debug which arm fired.
    return {
      route: 'student',
      confidence: null,
      reason: 'no_top_logprobs',
      entropy_per_token: summary.per_token,
      segments: [],
    };
  }
  const highIdx = [];
  for (let i = 0; i < summary.per_token.length; i += 1) {
    if (summary.per_token[i] > thr) highIdx.push(i);
  }
  // Confidence = 1 - normalized_max_entropy. Normalize against the maximum
  // possible entropy for a K-way distribution. Without knowing K we use
  // log(top_logprobs.length) per row; for the summary we use the largest
  // candidate set seen.
  let kMax = 1;
  for (const row of (tokens || [])) {
    if (row && Array.isArray(row.top_logprobs)) {
      kMax = Math.max(kMax, row.top_logprobs.length);
    }
  }
  const maxPossible = Math.log(Math.max(2, kMax));
  const confidence = Math.max(0, Math.min(1, 1 - (summary.max / maxPossible)));
  if (highIdx.length === 0) {
    return {
      route: 'student',
      confidence,
      reason: 'all_tokens_below_threshold',
      entropy_per_token: summary.per_token,
      segments: [
        { start: 0, end: summary.count - 1, source: 'student' },
      ],
    };
  }
  // Mixed route: build segment list of alternating student/teacher spans.
  const runs = groupRuns(highIdx);
  const segments = [];
  let cursor = 0;
  for (const [rs, re] of runs) {
    if (rs > cursor) {
      segments.push({ start: cursor, end: rs - 1, source: 'student' });
    }
    segments.push({ start: rs, end: re, source: 'teacher' });
    cursor = re + 1;
  }
  if (cursor < summary.count) {
    segments.push({ start: cursor, end: summary.count - 1, source: 'student' });
  }
  // If EVERY token is above threshold the whole stream is teacher-only.
  const allTeacher = runs.length === 1
    && runs[0][0] === 0
    && runs[0][1] === summary.count - 1;
  return {
    route: allTeacher ? 'teacher' : 'mixed',
    confidence,
    reason: allTeacher ? 'all_tokens_above_threshold' : 'high_entropy_span_detected',
    entropy_per_token: summary.per_token,
    segments,
  };
}

/**
 * @param {ReturnType<typeof decideRouting>} decision
 * @returns {boolean}
 */
export function shouldEscalateToTeacher(decision) {
  if (!decision || typeof decision !== 'object') return false;
  return decision.route === 'mixed' || decision.route === 'teacher';
}

export default {
  DEFAULT_ENTROPY_THRESHOLD_NATS,
  tokenEntropy,
  decideRouting,
  shouldEscalateToTeacher,
};
