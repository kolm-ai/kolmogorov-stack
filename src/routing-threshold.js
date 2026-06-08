// W709-3 - runtime routing threshold knob.
//
// The runtime confidence router (src/runtime-confidence-router.js, W709-1)
// compares per-token Shannon entropy from the student against a numeric
// threshold to decide whether to escalate to the teacher API. This module
// owns where that threshold comes from:
//
//   1. defaultThreshold() - process-wide default. Reads
//      KOLM_ROUTE_ENTROPY_THRESHOLD (parseFloat) or falls back to 1.5.
//      1.5 nats is a reasonable "ambiguous next token" line - Shannon entropy
//      of a uniform distribution over k tokens is ln(k); at H≈1.5 nats the
//      effective branching factor exp(H) ≈ 4.5 candidates, which is a
//      common cutoff used by speculative-decoding and confidence-routing
//      papers (eg. Big Little Decoder, FrugalGPT, MoE routing).
//
//   2. getNamespaceThreshold(namespace, tenantId) - per-namespace override,
//      durable across restarts via the event-store (kind == 'routing_threshold_override').
//      Most-recent wins so an admin can tighten or loosen routing for a
//      single workload without touching the env var.
//
//   3. setNamespaceThreshold(namespace, tenantId, threshold) - writes the
//      override row. Validates threshold ∈ [0, 10]. 10 nats is the Shannon
//      entropy of a uniform 1024-vocab distribution (ln(1024) ≈ 6.93,
//      rounded up so callers can still set "essentially never escalate").
//
// Storage shape: the canonical event schema (src/event-schema.js) does not
// declare a free-form `kind` column, so we encode the override using two
// canonical fields:
//
//   - provider = 'kolm_routing_threshold'   (so listEvents({provider}) is O(1))
//   - feedback = JSON.stringify({ kind: 'routing_threshold_override',
//                                 threshold, set_at, source: 'set_namespace_threshold' })
//
// This keeps the event row inside the schema validator and lets us read it
// back via listEvents() without schema migrations.

import { appendEvent, listEvents } from './event-store.js';

export const DEFAULT_THRESHOLD = 1.5;
export const MIN_THRESHOLD = 0;
// 10 nats is the upper bound: ln(1024) ≈ 6.93, so 10 leaves headroom for
// even larger vocab models while still rejecting nonsense like "100".
export const MAX_THRESHOLD = 10;
export const OVERRIDE_KIND = 'routing_threshold_override';
export const OVERRIDE_PROVIDER_TAG = 'kolm_routing_threshold';

// defaultThreshold(): process-wide default. Honors
// KOLM_ROUTE_ENTROPY_THRESHOLD; falls back to DEFAULT_THRESHOLD. Never
// throws - bad env values collapse to the default rather than crashing the
// router on startup.
export function defaultThreshold() {
  const raw = process.env.KOLM_ROUTE_ENTROPY_THRESHOLD;
  if (raw == null || raw === '') return DEFAULT_THRESHOLD;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  // Clamp to the legal range - out-of-range env vars collapse to the
  // default so an operator typo can never produce a negative threshold
  // (which would route every token to teacher).
  if (n < MIN_THRESHOLD || n > MAX_THRESHOLD) return DEFAULT_THRESHOLD;
  return n;
}

// _validateThreshold(t): shared check used by both the setter and any
// caller that wants to validate a user-supplied threshold before writing.
function _validateThreshold(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) {
    const err = new Error('invalid_threshold: must be a finite number');
    err.code = 'invalid_threshold';
    throw err;
  }
  if (n < MIN_THRESHOLD || n > MAX_THRESHOLD) {
    const err = new Error(`invalid_threshold: ${n} out of range [${MIN_THRESHOLD}, ${MAX_THRESHOLD}]`);
    err.code = 'invalid_threshold';
    err.min = MIN_THRESHOLD;
    err.max = MAX_THRESHOLD;
    throw err;
  }
  return n;
}

// getNamespaceThreshold(namespace, tenantId): returns the per-namespace
// override if any, else defaultThreshold(). Defensive - any read/parse
// failure falls back to the default so the router stays serving traffic.
export async function getNamespaceThreshold(namespace, tenantId) {
  if (!namespace || !tenantId) return defaultThreshold();
  try {
    // listEvents returns newest-first by default; filter to the override
    // marker provider tag + namespace + tenant. Take the first row whose
    // feedback parses as a valid override blob.
    const rows = await listEvents({
      namespace: String(namespace),
      tenant_id: String(tenantId),
      provider: OVERRIDE_PROVIDER_TAG,
      limit: 50,
    });
    for (const row of rows) {
      if (!row || !row.feedback) continue;
      let blob;
      try { blob = JSON.parse(row.feedback); }
      catch { continue; }
      if (!blob || blob.kind !== OVERRIDE_KIND) continue;
      const n = Number(blob.threshold);
      if (!Number.isFinite(n)) continue;
      if (n < MIN_THRESHOLD || n > MAX_THRESHOLD) continue;
      return n;
    }
  } catch (_) { // deliberate: cleanup
    // Fall through to default on any error - never let the threshold
    // lookup break the routing path.
  }
  return defaultThreshold();
}

// setNamespaceThreshold(namespace, tenantId, threshold): write a durable
// override row. Validates threshold ∈ [0, 10] and throws `invalid_threshold`
// otherwise. Returns the persisted event row.
export async function setNamespaceThreshold(namespace, tenantId, threshold) {
  if (!namespace) {
    const err = new Error('invalid_threshold: namespace is required');
    err.code = 'invalid_threshold';
    throw err;
  }
  if (!tenantId) {
    const err = new Error('invalid_threshold: tenantId is required');
    err.code = 'invalid_threshold';
    throw err;
  }
  const n = _validateThreshold(threshold);
  const payload = {
    kind: OVERRIDE_KIND,
    threshold: n,
    set_at: new Date().toISOString(),
    source: 'set_namespace_threshold',
  };
  const ev = await appendEvent({
    tenant_id: String(tenantId),
    namespace: String(namespace),
    provider: OVERRIDE_PROVIDER_TAG,
    feedback: JSON.stringify(payload),
    status: 'ok',
    source_type: 'real',
  });
  return ev;
}

// validateThreshold(t): exported convenience for callers (eg. CLI / HTTP
// route handlers) that want to pre-validate before calling
// setNamespaceThreshold. Throws `invalid_threshold` on bad input.
export function validateThreshold(t) {
  return _validateThreshold(t);
}
