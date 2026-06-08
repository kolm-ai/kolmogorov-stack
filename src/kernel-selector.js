// W726 - Batch-vs-latency kernel selector.
//
// Two orthogonal axes that decide which compiled kernel a `.kolm` artifact
// should use at runtime:
//
//   - latency-optimized  (default, batch_size_hint=1)
//       Single-user desktop. Minimize per-token wall-clock. Beam=1, small
//       prefill chunks, no batch padding waste. Picked when a hint says
//       so or when there is no signal that we are inside an API server.
//
//   - batching-optimized (batch_size_hint=32)
//       Many concurrent requests (API serving). Pad to a batch boundary,
//       prefer kernels that amortize HBM reads (FlashAttention v2/v3, paged
//       KV cache with batch-major layout) over per-request latency. Picked
//       when the hint says so OR a runtime probe sees serving conditions.
//
// The selection is PURE. Callers (CLI `kolm run`, server-side compile
// dispatch, tests) pass everything in - we never poke at real sockets or
// libuv internals inside this module. The runtime probe takes the
// already-observed concurrent_connections count as input so this module
// stays trivially unit-testable.
//
// Decision precedence (first match wins):
//   1. Explicit workload_hint string ('serving'/'batching' or 'desktop'/'latency').
//   2. env.KOLM_WORKLOAD matches one of the above words.
//   3. concurrency_estimate >= 4 → 'batching'.
//   4. Default 'latency' (single-user desktop assumption).
//
// probeRuntimeWorkload is a separate helper that turns a runtime snapshot
// into a workload_hint string: if there are >= 4 concurrent connections
// already, OR env.PORT is set AND env.KOLM_DESKTOP !== '1', we are serving.
// Otherwise we assume desktop.
//
// Anti-brittleness: KERNEL_PROFILES is the canonical enum so callers can
// validate user input against it instead of hardcoding the two strings.
// KERNEL_SELECTOR_VERSION lets verifiers detect spec migrations the same
// way ITKV_VERSION / TSAC_VERSION do in their siblings.

export const KERNEL_PROFILES = ['latency', 'batching'];
export const KERNEL_SELECTOR_VERSION = 'w726-v1';

// Map every accepted workload word onto its kernel profile. The two
// orthogonal vocabularies ('serving'/'desktop' from the product brief and
// 'batching'/'latency' from the kernel implementation side) both flow
// through this single mapping so a typo in one place can't drift from a
// typo in the other.
const WORKLOAD_WORD_TO_PROFILE = Object.freeze({
  serving: 'batching',
  batching: 'batching',
  desktop: 'latency',
  latency: 'latency',
});

// Internal: normalize a possibly-mixed-case hint to one of the known words,
// returning null when the input is not a recognized workload word so the
// caller can fall through to the next precedence rule.
function normalizeHintWord(raw) {
  if (typeof raw !== 'string') return null;
  const w = raw.trim().toLowerCase();
  if (!w) return null;
  if (Object.prototype.hasOwnProperty.call(WORKLOAD_WORD_TO_PROFILE, w)) {
    return w;
  }
  return null;
}

// selectKernelProfile - pure function. Returns one of:
//   'latency' - default, batch_size_hint=1
//   'batching' - batch_size_hint=32
//
// Inputs (all optional):
//   workload_hint        : explicit user-supplied workload word
//   env                  : object whose KOLM_WORKLOAD field is treated as a hint
//                          when no explicit workload_hint is supplied
//   concurrency_estimate : observed concurrent-connection count; >= 4 -> batching
//
// The function NEVER throws. Bad input falls through to the default branch
// rather than rejecting the build - selection is advisory.
export function selectKernelProfile({ workload_hint, env, concurrency_estimate } = {}) {
  // Rule 1 + 2 (precedence): explicit hint, then env.KOLM_WORKLOAD.
  // Both go through the same normalize+lookup so a typo in either path
  // falls through identically.
  const direct = normalizeHintWord(workload_hint);
  if (direct) return WORKLOAD_WORD_TO_PROFILE[direct];
  const envWord = (env && typeof env === 'object') ? normalizeHintWord(env.KOLM_WORKLOAD) : null;
  if (envWord) return WORKLOAD_WORD_TO_PROFILE[envWord];
  // Rule 3: concurrency signal. Threshold 4 matches probeRuntimeWorkload so
  // that selecting from a runtime snapshot lines up with selecting from a
  // probed snapshot - there is no two-thresholds-drifting bug.
  if (typeof concurrency_estimate === 'number' && Number.isFinite(concurrency_estimate)
      && concurrency_estimate >= 4) {
    return 'batching';
  }
  // Rule 4: default - single-user desktop. Matches W726-2 brief.
  return 'latency';
}

// probeRuntimeWorkload - pure function. Returns 'serving' or 'desktop'.
//
// Callers (server bootstrap, CLI `kolm run --workload-probe`) pass in the
// runtime snapshot they have. We do NOT poke at real sockets here so the
// function is trivially unit-testable.
//
// Decision:
//   - concurrent_connections_seen >= 4  → 'serving' (already under serving load)
//   - env.PORT set AND env.KOLM_DESKTOP !== '1' → 'serving' (we look like a server)
//   - otherwise                                  → 'desktop'
//
// The two-pronged check matters: a developer running `node server.js` on
// localhost with PORT=3000 should still default to 'serving' kernels even
// before the first connection lands. KOLM_DESKTOP=1 is the escape hatch
// for someone who runs an experimental http server on their laptop and
// genuinely wants latency-optimized kernels.
export function probeRuntimeWorkload({ env, concurrent_connections_seen } = {}) {
  const conns = (typeof concurrent_connections_seen === 'number'
      && Number.isFinite(concurrent_connections_seen))
    ? concurrent_connections_seen
    : 0;
  if (conns >= 4) return 'serving';
  if (env && typeof env === 'object') {
    const hasPort = typeof env.PORT === 'string' && env.PORT.length > 0;
    const desktopOverride = env.KOLM_DESKTOP === '1';
    if (hasPort && !desktopOverride) return 'serving';
  }
  return 'desktop';
}
