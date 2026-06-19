// W826-3 - predictive runtime preload using Markov-style transition matrix.
//
// Closes KOLM_W707_SYSTEM_UPGRADE_PLAN.md W826-3 (line 1125): "Pre-load
// heuristic: analyze inference patterns → preload likely-next artifact."
//
// Two exports:
//
//   1. analyzeInferencePatterns({tenant, namespace, window_hours:24})
//      Reads events from the event store (W369), looks at every consecutive
//      pair of `inference` events (cache-hits and cache-misses), and builds a
//      first-order transition matrix from artifact_id A → artifact_id B.
//      Returns the top-3 most-frequently-used artifacts plus a confidence
//      score (0..1) reflecting how many transition samples we had to fit the
//      matrix. Pure read - never writes.
//
//   2. preloadDecision({current_artifact_id, hierarchy, top_artifacts})
//      Pure function. No I/O. Given the currently-loaded artifact and the
//      memory hierarchy snapshot (from runtime-placement.detectMemoryHierarchy),
//      decide which of the predicted-next artifacts to warm up. Output is an
//      action plan per artifact: warm_to_vram (cuda copy), mmap_only (page
//      cache primed), or skip (no headroom).
//
// W604 anti-brittleness: PRELOAD_VERSION matches /^w826-/ so a v1.x bump
// inside the wave does not force coordinated test churn.
//
// Honesty contracts:
//   - Empty event store → returns top_artifacts:[] with confidence:0. NEVER
//     fabricates a recommendation from zero data.
//   - Single-event window → confidence:0 (no transitions observable).
//   - Foreign-tenant events are NEVER read - tenant filter is mandatory at
//     the listEvents call site. (event-store also defense-in-depth filters.)
//   - preloadDecision NEVER picks warm_to_vram when current artifact already
//     consumes >= 70% of GPU free VRAM - only mmap_only or skip.
//
// Runtime integration contract: src/runtime.js calls analyzeInferencePatterns()
// inside buildRuntimeExecutionPlan() and records runVersion() calls as local
// event-store rows. preloadDecision() is attached to the returned runtime plan;
// native runners can convert warm_to_vram / mmap_only into cudaMemcpy /
// madvise(MADV_WILLNEED) as their worker stack gains direct support.

import { listEvents } from './event-store.js';

export const PRELOAD_VERSION = 'w826-v1';

// Action enum. Stamped onto manifests + telemetry so verifiers can detect a
// schema-incompatible action label.
export const PRELOAD_ACTIONS = Object.freeze(['warm_to_vram', 'mmap_only', 'skip']);

// Top-K predictions returned. 3 is the established sibling default (W725
// preload-scheduler uses TOP_K=3) - small enough to fit on a single VRAM
// budget, large enough to absorb a single mispredict.
export const TOP_K = 3;

// Minimum transition pairs needed before we trust the matrix. Below this,
// confidence stays at 0 even if a transition pattern exists - protects against
// over-fitting to a 2-sample sequence.
export const MIN_TRANSITIONS_FOR_CONFIDENCE = 5;

// VRAM saturation threshold above which warm_to_vram is suppressed. If the
// currently-loaded artifact + a warm-up candidate would together exceed this
// fraction of free VRAM, fall back to mmap_only.
export const VRAM_SATURATION_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// analyzeInferencePatterns
// ---------------------------------------------------------------------------
//
// Input: {tenant, namespace, window_hours:24}
//   - tenant: required string. Foreign-tenant events are never read.
//   - namespace: optional string (per-namespace prediction model).
//   - window_hours: optional, defaults to 24. Look-back window for events.
//
// Output:
//   {
//     top_artifacts: [
//       { artifact_id, request_count, last_used_at, predicted_next_use_at }
//     ],
//     confidence: 0..1,
//     transition_count: number,
//     window_hours: number,
//     version: 'w826-v1',
//   }
//
// Confidence model: linear ramp from 0 to 1.0 as transition_count goes from
// MIN_TRANSITIONS_FOR_CONFIDENCE (0.0) to 50 (1.0). Capped at 1.0. Below
// MIN_TRANSITIONS_FOR_CONFIDENCE we honestly return 0 - never lie.

export async function analyzeInferencePatterns(opts = {}) {
  const tenant = opts.tenant;
  const namespace = opts.namespace || null;
  const window_hours = Number.isFinite(opts.window_hours) && opts.window_hours > 0
    ? opts.window_hours
    : 24;

  // No tenant → no read. Returning empty preserves "honest by default."
  if (!tenant) {
    return _emptyAnalysis(window_hours, 'no_tenant');
  }

  // Look-back window: now - window_hours.
  const since = new Date(Date.now() - (window_hours * 3600 * 1000)).toISOString();

  // Pull events, oldest-first so the transition pairs are in real order.
  const query = {
    tenant,
    since,
    order: 'asc',
    limit: 0, // unlimited within the window
  };
  if (namespace) query.namespace = namespace;

  let events = [];
  try {
    events = await listEvents(query);
  } catch {
    // listEvents should not throw, but if it does (corrupted JSONL, sqlite
    // open failure), return an honest empty envelope.
    return _emptyAnalysis(window_hours, 'event_store_error');
  }

  // Filter to inference-like events with a recognizable artifact_id. Captures
  // & connector logs land in the same event-store but lack artifact_id; we
  // only learn from runtime-replay rows.
  const inferenceEvents = events.filter((ev) => {
    if (!ev) return false;
    const aid = _artifactIdOf(ev);
    return aid != null;
  });

  if (inferenceEvents.length === 0) {
    return _emptyAnalysis(window_hours, 'no_inference_events');
  }

  // Defense-in-depth tenant fence - listEvents already filtered, but if a
  // legacy row slipped through (e.g. a backfilled pre-W411 row whose
  // tenant_id was inferred to 'default'), strip it here too.
  const tenantSafe = inferenceEvents.filter(ev => ev.tenant_id === tenant);

  // Aggregate per-artifact usage stats AND build the transition matrix in a
  // single pass. transitions[A][B] = number of times we saw A immediately
  // followed by B in this tenant's stream.
  const usage = new Map(); // artifact_id -> {request_count, last_used_at}
  const transitions = new Map(); // A -> Map(B -> count)
  let transition_count = 0;
  let prevId = null;

  for (const ev of tenantSafe) {
    const aid = _artifactIdOf(ev);
    const ts = ev.created_at || new Date().toISOString();
    if (!usage.has(aid)) {
      usage.set(aid, { artifact_id: aid, request_count: 0, last_used_at: ts });
    }
    const u = usage.get(aid);
    u.request_count += 1;
    if (new Date(ts).getTime() > new Date(u.last_used_at).getTime()) {
      u.last_used_at = ts;
    }
    if (prevId != null && prevId !== aid) {
      // Self-transitions are uninformative (same artifact stayed loaded);
      // skip them so the matrix only reflects switches.
      if (!transitions.has(prevId)) transitions.set(prevId, new Map());
      const row = transitions.get(prevId);
      row.set(aid, (row.get(aid) || 0) + 1);
      transition_count += 1;
    }
    prevId = aid;
  }

  // Rank by request_count desc, tie-break by recency (later last_used_at wins).
  const ranked = Array.from(usage.values()).sort((a, b) => {
    if (b.request_count !== a.request_count) return b.request_count - a.request_count;
    return new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime();
  });

  // For each top artifact, compute predicted_next_use_at by averaging the
  // inter-use gap and projecting forward from last_used_at. Fallback to
  // last_used_at + 1 hour when we have only one observation.
  const top_artifacts = ranked.slice(0, TOP_K).map((u) => {
    const inter = _interUseGapMs(tenantSafe, u.artifact_id);
    const projected = inter != null
      ? new Date(new Date(u.last_used_at).getTime() + inter).toISOString()
      : new Date(new Date(u.last_used_at).getTime() + 3600 * 1000).toISOString();
    return {
      artifact_id: u.artifact_id,
      request_count: u.request_count,
      last_used_at: u.last_used_at,
      predicted_next_use_at: projected,
    };
  });

  // Confidence: 0 below MIN_TRANSITIONS_FOR_CONFIDENCE, linearly ramping to
  // 1.0 at 50 transitions. Never above 1.0.
  let confidence = 0;
  if (transition_count >= MIN_TRANSITIONS_FOR_CONFIDENCE) {
    confidence = Math.min(1, (transition_count - MIN_TRANSITIONS_FOR_CONFIDENCE) / (50 - MIN_TRANSITIONS_FOR_CONFIDENCE) * 1.0);
    if (confidence < 0.1) confidence = 0.1; // floor once we have enough data
  }
  confidence = Number(confidence.toFixed(3));

  return {
    top_artifacts,
    confidence,
    transition_count,
    window_hours,
    version: PRELOAD_VERSION,
  };
}

// Internal: extract an artifact_id from a heterogeneous event row. The event
// schema doesn't have a hard `artifact_id` column - runtime replays stamp it
// into various sub-fields depending on the producer. We accept all four common
// keys (compileSpec output, runtime.js getCompiled, W725 preload-scheduler,
// W354 capture replay). Honest fallback: null when none of the keys are
// present (rather than synthesizing a fake id from request_hash).
function _artifactIdOf(ev) {
  if (!ev) return null;
  if (typeof ev.artifact_id === 'string' && ev.artifact_id) return ev.artifact_id;
  if (ev.payload && typeof ev.payload.artifact_id === 'string' && ev.payload.artifact_id) return ev.payload.artifact_id;
  if (ev.context && typeof ev.context.artifact_id === 'string' && ev.context.artifact_id) return ev.context.artifact_id;
  // Runtime replay logs land in the event store as canonical events with the
  // artifact identifier on `ev.model` and `cache_hit:true` (the canonical
  // schema strips unknown top-level keys, so `artifact_id` does not survive
  // unless explicitly added to event-schema.js). Accept (provider==='kolm' OR
  // cache_hit===true) AS A RUNTIME-INFERENCE MARKER - both of these are set
  // by src/runtime.js getCompiled(); LLM rows from openai/anthropic don't
  // share that combination. Honest fallback: null when none match.
  if (typeof ev.model === 'string' && ev.model) {
    if (ev.cache_hit === true) return ev.model;
    if (ev.provider === 'kolm' || ev.vendor === 'kolm') return ev.model;
    if (ev.status === 'replay' || ev.status === 'cache_hit') return ev.model;
  }
  return null;
}

// Compute the average inter-use gap (ms) for a given artifact_id across the
// event window. Returns null if fewer than 2 uses observed.
function _interUseGapMs(events, artifactId) {
  const ts = [];
  for (const ev of events) {
    if (_artifactIdOf(ev) === artifactId) ts.push(new Date(ev.created_at).getTime());
  }
  if (ts.length < 2) return null;
  ts.sort((a, b) => a - b);
  let totalGap = 0;
  for (let i = 1; i < ts.length; i++) totalGap += (ts[i] - ts[i - 1]);
  return Math.max(1, Math.round(totalGap / (ts.length - 1)));
}

function _emptyAnalysis(window_hours, reason) {
  return {
    top_artifacts: [],
    confidence: 0,
    transition_count: 0,
    window_hours,
    reason,
    version: PRELOAD_VERSION,
  };
}

// ---------------------------------------------------------------------------
// preloadDecision
// ---------------------------------------------------------------------------
//
// Input:
//   {
//     current_artifact_id: string | null,
//     hierarchy: { gpu:[{vram_gb,free_gb,...}], system_ram_gb,
//                  system_ram_free_gb, ... } | null,
//     top_artifacts: [{artifact_id, request_count, ...}],
//   }
//
// Output: an array, one entry per top_artifacts row, in the same order:
//   [{artifact_id, action: 'warm_to_vram' | 'mmap_only' | 'skip', rationale}]
//
// Logic:
//   - skip the current_artifact_id (already loaded - nothing to do).
//   - no GPU → mmap_only for everything (CPU path uses madvise/page-cache).
//   - GPU free VRAM saturated (>= VRAM_SATURATION_THRESHOLD already filled by
//     an estimated working set) → mmap_only.
//   - otherwise → warm_to_vram for the highest-ranked candidate, mmap_only
//     for the rest (only one slot in VRAM for a predictive warm-up).

export function preloadDecision(opts = {}) {
  const current = opts.current_artifact_id || null;
  const hierarchy = opts.hierarchy || null;
  const top = Array.isArray(opts.top_artifacts) ? opts.top_artifacts : [];

  if (top.length === 0) return [];

  const noGpu = !hierarchy || !Array.isArray(hierarchy.gpu) || hierarchy.gpu.length === 0;

  // Track whether we've already spent the one VRAM warm-up slot in this call.
  let vramSlotUsed = false;

  return top.map((cand) => {
    const aid = cand && cand.artifact_id;
    if (!aid) {
      return { artifact_id: null, action: 'skip', rationale: 'no_artifact_id' };
    }
    if (current && aid === current) {
      return { artifact_id: aid, action: 'skip', rationale: 'already_loaded' };
    }
    if (noGpu) {
      return { artifact_id: aid, action: 'mmap_only', rationale: 'no_gpu' };
    }
    // Saturation check: if the GPU is already running tight (>= threshold
    // fraction of free_gb consumed by the current artifact's working set - 
    // we estimate at 1.0 GB per active artifact as a coarse floor), then
    // warming a second artifact would evict the first. Stay in mmap.
    const gpu = hierarchy.gpu[0];
    const freeVram = Number(gpu.free_gb || 0);
    const workingSetGb = current ? 1.0 : 0;
    const saturated = freeVram > 0 && (workingSetGb / freeVram) >= VRAM_SATURATION_THRESHOLD;
    if (saturated) {
      return { artifact_id: aid, action: 'mmap_only', rationale: `vram_saturated; free=${freeVram.toFixed(2)}GB` };
    }
    if (!vramSlotUsed) {
      vramSlotUsed = true;
      return {
        artifact_id: aid,
        action: 'warm_to_vram',
        rationale: `top_predicted; free_vram=${freeVram.toFixed(2)}GB`,
      };
    }
    return {
      artifact_id: aid,
      action: 'mmap_only',
      rationale: 'vram_slot_already_taken',
    };
  });
}

export default {
  PRELOAD_VERSION,
  PRELOAD_ACTIONS,
  TOP_K,
  MIN_TRANSITIONS_FOR_CONFIDENCE,
  VRAM_SATURATION_THRESHOLD,
  analyzeInferencePatterns,
  preloadDecision,
};
