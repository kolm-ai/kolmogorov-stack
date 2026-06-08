// W721 - Task-Specific Attention Compiler (TSAC) per-layer-per-head sparsity profile schema.
//
// Background (per docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md
// Invention 2 - Task-Specific Attention Compiler, lines 1321-1378):
//
//   Problem: long-context serving pays for dense attention even when
//   task-specific distilled models use stable sparse patterns. Per-head
//   sparsity patterns are knowable AT COMPILE TIME for a given task; serve
//   time should not re-discover them.
//
//   Kolm invention: TSAC. A per-layer-per-head profile that names a prefill
//   sparsity pattern (vertical_slash / blocked_local / sink_plus_local /
//   head_pruned / dense), a decode policy (query_page_topk / dense /
//   sink_plus_window / head_pruned_decode), a page_topk integer, a
//   sink_keep, a local_window, a dense_fallback_threshold, and a
//   quality_guard. The compiler walks captured attention traces per head
//   and picks the cheapest pattern that preserves output quality. The
//   serve-time kernel selector reads this profile and dispatches the
//   matching kernel.
//
// This file holds the SCHEMA + VALIDATORS + DEFAULT BUILDER + SUMMARY only.
// The compile-from-captures loop lives in src/tsac-compiler.js; the kernel
// selector stub lives in workers/tsac/tsac.mjs; the runtime kernel dispatch
// is a future wave. All four pieces share the canonical schema below so a
// later kernel-selector implementation can plug in without re-deriving the
// shape.
//
// Honesty contract:
//   * dense_fallback_threshold is load-bearing - a serve-time kernel that
//     ignores it can quietly degrade quality. A compiler that omits it
//     fails validation here.
//   * quality_guard names the specific guard (logit_delta_and_kscore by
//     default). A serve-time kernel that does not implement the named
//     guard MUST refuse to dispatch - the profile is the contract.
//   * Safety-tagged heads (is_safety_critical:true) get a dense prefill
//     and dense decode regardless of sparsity affinity. The compiler is
//     responsible for setting that flag; the validator enforces the
//     consequence.

import crypto from 'node:crypto';

// =============================================================================
// Version + canonical enums
// =============================================================================

export const TSAC_VERSION = 'w721-v1';

// Prefill patterns: how the prefill kernel walks the attention matrix.
//   dense - full O(n^2) matrix (safety / fallback default).
//   vertical_slash - keep columns matching task-specific token IDs +
//                        a vertical slash window around the diagonal.
//   blocked_local - block-sparse local window (M=128 typical).
//   sink_plus_local - keep sink_keep tokens at the front + a
//                        local_window slice at the back.
//   head_pruned - skip this head entirely (output = zero contribution
// - only valid if compile-time KL test shows the
//                        head contributes < 0.001 to final logits).
export const DEFAULT_PREFILL_PATTERNS = Object.freeze([
  'dense',
  'vertical_slash',
  'blocked_local',
  'sink_plus_local',
  'head_pruned',
]);

// Decode policies: how the decode kernel selects K/V pages.
//   dense - full attention (safety / fallback default).
//   query_page_topk - score every K/V page against the new query,
//                          attend to the top page_topk pages.
//   sink_plus_window - keep sink_keep at the front + local_window
//                          at the tail, drop the middle (Streaming-LLM).
//   head_pruned_decode - skip the head at decode too (paired with
//                          head_pruned prefill).
export const DEFAULT_DECODE_POLICIES = Object.freeze([
  'dense',
  'query_page_topk',
  'sink_plus_window',
  'head_pruned_decode',
]);

// Quality guards. The serve-time kernel must implement the named guard;
// the compiler picks it based on what telemetry is available.
//   logit_delta_and_kscore - sample-level logit delta vs dense + K-score
//                            shadow on every Nth request.
//   logit_delta_only - sample-level logit delta vs dense (cheaper).
//   kscore_only - K-score shadow every Nth request, no per-sample.
//   none - no guard (only valid for explicitly safe heads
//                            that are also marked is_safety_critical:false).
export const DEFAULT_QUALITY_GUARDS = Object.freeze([
  'logit_delta_and_kscore',
  'logit_delta_only',
  'kscore_only',
  'none',
]);

// Numeric bounds (load-bearing - validators below reject out-of-range).
const PAGE_TOPK_MIN = 1;
const PAGE_TOPK_MAX = 4096;
const SINK_KEEP_MIN = 0;
const SINK_KEEP_MAX = 1024;
const LOCAL_WINDOW_MIN = 0;
const LOCAL_WINDOW_MAX = 32768;
const DENSE_FALLBACK_THRESHOLD_MIN = 0.0;
const DENSE_FALLBACK_THRESHOLD_MAX = 1.0;

// =============================================================================
// Per-entry schema
// =============================================================================
//
// One profile entry per (layer, head). The compiler emits one entry per
// pair; the runtime kernel selector dispatches per entry.
//
// {
//   task: string,
//   layer: int >= 0,
//   head: int >= 0,
//   prefill_pattern: one-of DEFAULT_PREFILL_PATTERNS,
//   decode_policy:   one-of DEFAULT_DECODE_POLICIES,
//   page_topk:       int in [PAGE_TOPK_MIN, PAGE_TOPK_MAX],
//   sink_keep:       int in [SINK_KEEP_MIN, SINK_KEEP_MAX],
//   local_window:    int in [LOCAL_WINDOW_MIN, LOCAL_WINDOW_MAX],
//   dense_fallback_threshold: float in [0.0, 1.0],
//   quality_guard:   one-of DEFAULT_QUALITY_GUARDS,
//   is_safety_critical: bool (default false; when true forces
//                       prefill=dense + decode=dense regardless of pattern),
// }

const REQUIRED_FIELDS = Object.freeze([
  'task', 'layer', 'head',
  'prefill_pattern', 'decode_policy',
  'page_topk', 'sink_keep', 'local_window',
  'dense_fallback_threshold', 'quality_guard',
]);

const DEFAULT_PAGE_TOPK = 16;
const DEFAULT_SINK_KEEP = 8;
const DEFAULT_LOCAL_WINDOW = 512;
const DEFAULT_DENSE_FALLBACK_THRESHOLD = 0.06;
const DEFAULT_QUALITY_GUARD = 'logit_delta_and_kscore';
const DEFAULT_PREFILL_PATTERN = 'vertical_slash';
const DEFAULT_DECODE_POLICY = 'query_page_topk';

// =============================================================================
// validateProfile
// =============================================================================
//
// Accepts either ONE per-(layer,head) entry OR a full profile (array of
// entries OR object {task, entries:[...]}). Returns {ok:true} on success,
// {ok:false, errors:[...]} on any schema violation.
//
// This is the load-bearing contract - every consumer (compileTsacProfile,
// worker tsac.mjs, artifact.js hash chain) calls validateProfile before
// trusting a profile.

export function validateProfile(profile) {
  const errors = [];
  if (profile == null) {
    return { ok: false, errors: ['profile is null or undefined'] };
  }
  if (Array.isArray(profile)) {
    // Array of entries - validate each one independently.
    if (profile.length === 0) {
      return { ok: false, errors: ['profile array is empty'] };
    }
    for (let i = 0; i < profile.length; i += 1) {
      const sub = validateProfileEntry(profile[i]);
      if (!sub.ok) {
        for (const e of sub.errors) errors.push(`entry[${i}]: ${e}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  if (typeof profile === 'object'
      && profile.entries !== undefined
      && Array.isArray(profile.entries)) {
    // Wrapped {task, entries:[...]} object.
    if (profile.entries.length === 0) {
      return { ok: false, errors: ['profile.entries array is empty'] };
    }
    if (profile.task != null && typeof profile.task !== 'string') {
      errors.push('profile.task must be a string when present');
    }
    for (let i = 0; i < profile.entries.length; i += 1) {
      const sub = validateProfileEntry(profile.entries[i]);
      if (!sub.ok) {
        for (const e of sub.errors) errors.push(`entries[${i}]: ${e}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  // Single per-(layer,head) entry.
  return validateProfileEntry(profile);
}

function validateProfileEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, errors: ['entry is not an object'] };
  }
  for (const k of REQUIRED_FIELDS) {
    if (!(k in entry)) errors.push(`missing required field: ${k}`);
  }
  if (entry.task != null && typeof entry.task !== 'string') {
    errors.push('task must be a string');
  }
  if (!Number.isInteger(entry.layer) || entry.layer < 0) {
    errors.push(`layer must be a non-negative integer, got ${entry.layer}`);
  }
  if (!Number.isInteger(entry.head) || entry.head < 0) {
    errors.push(`head must be a non-negative integer, got ${entry.head}`);
  }
  if (!DEFAULT_PREFILL_PATTERNS.includes(entry.prefill_pattern)) {
    errors.push(`prefill_pattern=${JSON.stringify(entry.prefill_pattern)} not in {${DEFAULT_PREFILL_PATTERNS.join(',')}}`);
  }
  if (!DEFAULT_DECODE_POLICIES.includes(entry.decode_policy)) {
    errors.push(`decode_policy=${JSON.stringify(entry.decode_policy)} not in {${DEFAULT_DECODE_POLICIES.join(',')}}`);
  }
  if (!Number.isInteger(entry.page_topk)
      || entry.page_topk < PAGE_TOPK_MIN
      || entry.page_topk > PAGE_TOPK_MAX) {
    errors.push(`page_topk=${entry.page_topk} out of range [${PAGE_TOPK_MIN}, ${PAGE_TOPK_MAX}]`);
  }
  if (!Number.isInteger(entry.sink_keep)
      || entry.sink_keep < SINK_KEEP_MIN
      || entry.sink_keep > SINK_KEEP_MAX) {
    errors.push(`sink_keep=${entry.sink_keep} out of range [${SINK_KEEP_MIN}, ${SINK_KEEP_MAX}]`);
  }
  if (!Number.isInteger(entry.local_window)
      || entry.local_window < LOCAL_WINDOW_MIN
      || entry.local_window > LOCAL_WINDOW_MAX) {
    errors.push(`local_window=${entry.local_window} out of range [${LOCAL_WINDOW_MIN}, ${LOCAL_WINDOW_MAX}]`);
  }
  if (!Number.isFinite(entry.dense_fallback_threshold)
      || entry.dense_fallback_threshold < DENSE_FALLBACK_THRESHOLD_MIN
      || entry.dense_fallback_threshold > DENSE_FALLBACK_THRESHOLD_MAX) {
    errors.push(`dense_fallback_threshold=${entry.dense_fallback_threshold} out of range [${DENSE_FALLBACK_THRESHOLD_MIN}, ${DENSE_FALLBACK_THRESHOLD_MAX}]`);
  }
  if (!DEFAULT_QUALITY_GUARDS.includes(entry.quality_guard)) {
    errors.push(`quality_guard=${JSON.stringify(entry.quality_guard)} not in {${DEFAULT_QUALITY_GUARDS.join(',')}}`);
  }
  if ('is_safety_critical' in entry && typeof entry.is_safety_critical !== 'boolean') {
    errors.push('is_safety_critical must be a boolean when present');
  }
  // Safety invariant: safety-critical heads MUST run dense on both axes.
  if (entry.is_safety_critical === true) {
    if (entry.prefill_pattern !== 'dense') {
      errors.push(`safety-critical head must use prefill_pattern=dense, got ${entry.prefill_pattern}`);
    }
    if (entry.decode_policy !== 'dense') {
      errors.push(`safety-critical head must use decode_policy=dense, got ${entry.decode_policy}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// =============================================================================
// buildDefaultProfile
// =============================================================================
//
// Emits one entry per (layer, head) populated with the W721 defaults from
// the research doc (page_topk:16, sink_keep:8, local_window:512,
// dense_fallback_threshold:0.06, quality_guard:'logit_delta_and_kscore').
// The prefill pattern defaults to 'vertical_slash' and decode to
// 'query_page_topk' (the dominant pattern in the published research).
//
// This is the safe starting point a caller can hand to
// compileTsacProfile as a baseline before per-head telemetry refinement.

export function buildDefaultProfile({ task, num_layers, num_heads }) {
  if (!task || typeof task !== 'string') {
    throw new TypeError('buildDefaultProfile requires task:string');
  }
  if (!Number.isInteger(num_layers) || num_layers <= 0) {
    throw new RangeError(`num_layers must be a positive integer, got ${num_layers}`);
  }
  if (!Number.isInteger(num_heads) || num_heads <= 0) {
    throw new RangeError(`num_heads must be a positive integer, got ${num_heads}`);
  }
  const entries = [];
  for (let layer = 0; layer < num_layers; layer += 1) {
    for (let head = 0; head < num_heads; head += 1) {
      entries.push({
        task,
        layer,
        head,
        prefill_pattern: DEFAULT_PREFILL_PATTERN,
        decode_policy: DEFAULT_DECODE_POLICY,
        page_topk: DEFAULT_PAGE_TOPK,
        sink_keep: DEFAULT_SINK_KEEP,
        local_window: DEFAULT_LOCAL_WINDOW,
        dense_fallback_threshold: DEFAULT_DENSE_FALLBACK_THRESHOLD,
        quality_guard: DEFAULT_QUALITY_GUARD,
        is_safety_critical: false,
      });
    }
  }
  return {
    task,
    tsac_version: TSAC_VERSION,
    num_layers,
    num_heads,
    entries,
  };
}

// =============================================================================
// summarizeProfile
// =============================================================================
//
// {
//   total_heads:           int,
//   dense_heads:           int (entries with prefill_pattern=dense or
//                               decode_policy=dense),
//   sparse_heads:          int (everything else, excluding head_pruned),
//   pruned_heads:          int (entries with head_pruned* on either axis),
//   avg_page_topk:         float (mean over all entries),
//   safety_critical_heads: int (is_safety_critical:true count),
// }

export function summarizeProfile(profile) {
  if (!profile) {
    throw new TypeError('summarizeProfile requires a profile');
  }
  let entries;
  if (Array.isArray(profile)) {
    entries = profile;
  } else if (profile.entries && Array.isArray(profile.entries)) {
    entries = profile.entries;
  } else {
    throw new TypeError('summarizeProfile: profile must be an array OR an object with entries[]');
  }
  if (entries.length === 0) {
    return {
      total_heads: 0,
      dense_heads: 0,
      sparse_heads: 0,
      pruned_heads: 0,
      avg_page_topk: 0,
      safety_critical_heads: 0,
    };
  }
  let dense = 0;
  let pruned = 0;
  let sparse = 0;
  let safety = 0;
  let sumPageTopk = 0;
  for (const e of entries) {
    const isPruned = e.prefill_pattern === 'head_pruned' || e.decode_policy === 'head_pruned_decode';
    const isDense = e.prefill_pattern === 'dense' && e.decode_policy === 'dense';
    if (isPruned) {
      pruned += 1;
    } else if (isDense) {
      dense += 1;
    } else {
      sparse += 1;
    }
    if (e.is_safety_critical === true) safety += 1;
    if (Number.isFinite(e.page_topk)) sumPageTopk += Number(e.page_topk);
  }
  return {
    total_heads: entries.length,
    dense_heads: dense,
    sparse_heads: sparse,
    pruned_heads: pruned,
    avg_page_topk: Number((sumPageTopk / entries.length).toFixed(4)),
    safety_critical_heads: safety,
  };
}

// =============================================================================
// canonicalJsonStringify + hashProfile
// =============================================================================
//
// Stable JSON serialization used by src/artifact.js to bind the profile
// into artifact_hash via the W460-pattern conditional hash slot. Sorts
// object keys recursively so a re-encoded profile hashes identically.

export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(value[k]));
  }
  return '{' + parts.join(',') + '}';
}

export function hashProfile(profile) {
  return crypto.createHash('sha256').update(canonicalJsonStringify(profile)).digest('hex');
}
