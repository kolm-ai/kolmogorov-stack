/**
 * src/otel-attrs.js
 *
 * W823-1 - OpenTelemetry span attribute envelope helper.
 *
 * Canonicalizes a free-form input object into the W823-compliant kolm.*
 * attribute envelope so call sites don't have to know the W733/W823 wire
 * keys. The output is a flat `{ key: value }` map ready to drop into:
 *
 *   - otel.startSpan(name, attrs)         (kolm-native exporter - src/otel.js)
 *   - span.setAttributes(attrs)           (@opentelemetry/api Span)
 *   - emitSpan({name, attrs}) wrappers    (host-side instrumentation)
 *
 * Integration point:
 *   import { kolmSpanAttrs } from './src/otel-attrs.js';
 *   import * as otel from './src/otel.js';
 *
 *   const span = otel.startSpan('kolm.run',
 *     kolmSpanAttrs({
 *       artifact_id:           'art_2026_05_24_a18',
 *       routing_decision:      'student',
 *       token_confidence_p50:  0.91,
 *       token_confidence_p95:  0.97,
 *       kscore_drift:          -0.012,
 *       namespace:             'prod',
 *     }));
 *
 * Why we ship this as a tiny helper instead of expanding setRoutingAttributes:
 *   - Many call sites only want the attrs map; they assemble the span
 *     themselves (e.g. when handing off to @opentelemetry/api or to a
 *     buyer's existing instrumentation library).
 *   - Keeping the canonicalization in one pure function makes it trivially
 *     testable and prevents key drift across call sites.
 *   - We never invent new keys here - every output key lives in
 *     src/otel.js#KOLM_OTEL_ATTRS so the contract has one source of truth.
 *
 * Honesty contract:
 *   - Unknown input fields are dropped silently (no key explosion).
 *   - Numeric fields fall through Number.isFinite gates so NaN/Infinity
 *     never reach the OTel collector.
 *   - tenant_id (if present) is sha256-hashed via the same 12-char prefix
 *     convention used elsewhere in src/otel.js (W733 privacy contract).
 */

import crypto from 'node:crypto';
import { KOLM_OTEL_ATTRS } from './otel.js';

function _hashTenant(rawTenantId) {
  if (!rawTenantId) return null;
  return crypto.createHash('sha256').update(String(rawTenantId)).digest('hex').slice(0, 12);
}

function _finite(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * Canonicalize an arbitrary kolm-shaped input object into the W823 span
 * attribute envelope. Returns a flat object; never throws on missing fields.
 *
 * Recognized input keys (all optional):
 *   artifact_id            -> kolm.artifact.id            (W823-1)
 *   artifact_cid           -> kolm.artifact.cid           (W733)
 *   routing_decision       -> kolm.routing.decision       (W823-1)
 *   token_confidence_p50   -> kolm.token.confidence_p50   (W823-1)
 *   token_confidence_p95   -> kolm.token.confidence_p95   (W823-1)
 *   token_confidence       -> kolm.token.confidence       (W733)
 *   kscore                 -> kolm.kscore.value           (W733)
 *   kscore_drift           -> kolm.kscore.drift           (W823-1)
 *   kscore_drift_24h       -> kolm.kscore.drift_24h       (W733)
 *   routing_entropy_nats   -> kolm.routing.entropy_nats   (W733)
 *   namespace              -> kolm.namespace              (W733)
 *   tenant_id              -> kolm.tenant.id_hash (sha256 12-char prefix)
 */
function kolmSpanAttrs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  // String passthroughs.
  if (typeof input.artifact_id === 'string' && input.artifact_id) {
    out[KOLM_OTEL_ATTRS.ARTIFACT_ID] = input.artifact_id;
  }
  if (typeof input.artifact_cid === 'string' && input.artifact_cid) {
    out[KOLM_OTEL_ATTRS.ARTIFACT_CID] = input.artifact_cid;
  }
  if (typeof input.routing_decision === 'string' && input.routing_decision) {
    out[KOLM_OTEL_ATTRS.ROUTING_DECISION] = input.routing_decision;
  } else if (input.routing_decision && typeof input.routing_decision === 'object'
             && typeof input.routing_decision.route === 'string') {
    out[KOLM_OTEL_ATTRS.ROUTING_DECISION] = input.routing_decision.route;
  }
  if (typeof input.namespace === 'string' && input.namespace) {
    out[KOLM_OTEL_ATTRS.NAMESPACE] = input.namespace;
  }

  // Numeric passthroughs - Number.isFinite gates so NaN never crosses the
  // OTel boundary.
  const tcP50 = _finite(input.token_confidence_p50);
  if (tcP50 !== null) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P50] = tcP50;
  const tcP95 = _finite(input.token_confidence_p95);
  if (tcP95 !== null) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P95] = tcP95;
  const tc = _finite(input.token_confidence);
  if (tc !== null) out[KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE] = tc;
  const kscore = _finite(input.kscore);
  if (kscore !== null) out[KOLM_OTEL_ATTRS.KSCORE_VALUE] = kscore;
  const kdrift = _finite(input.kscore_drift);
  if (kdrift !== null) out[KOLM_OTEL_ATTRS.KSCORE_DRIFT] = kdrift;
  const kdrift24 = _finite(input.kscore_drift_24h);
  if (kdrift24 !== null) out[KOLM_OTEL_ATTRS.KSCORE_DRIFT_24H] = kdrift24;
  const ent = _finite(input.routing_entropy_nats);
  if (ent !== null) out[KOLM_OTEL_ATTRS.ROUTING_ENTROPY_NATS] = ent;

  // Privacy boundary - raw tenant_id NEVER crosses to OTel; only the
  // 12-char sha256 prefix.
  if (input.tenant_id) {
    const hashed = _hashTenant(input.tenant_id);
    if (hashed) out[KOLM_OTEL_ATTRS.TENANT_ID_HASH] = hashed;
  }

  return out;
}

/**
 * Returns the list of W823-1 attribute keys for introspection
 * (e.g. by test fixtures and the dashboard template).
 */
function w823AttrKeys() {
  return [
    KOLM_OTEL_ATTRS.ARTIFACT_ID,
    KOLM_OTEL_ATTRS.ROUTING_DECISION,
    KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P50,
    KOLM_OTEL_ATTRS.TOKEN_CONFIDENCE_P95,
    KOLM_OTEL_ATTRS.KSCORE_DRIFT,
  ];
}

const OTEL_ATTRS_W823_VERSION = 'w823-v1';

export {
  kolmSpanAttrs,
  w823AttrKeys,
  OTEL_ATTRS_W823_VERSION,
};
