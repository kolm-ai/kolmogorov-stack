// W-D / wrapper-completion — kolm-audit-1 receipt schema definition.
//
// Receipts are the Wrapper's signed proof-of-call. Every gateway call,
// every captured response, every routing decision emits exactly one
// Ed25519-signed receipt under the kolm-audit-1 schema. Receipts are
// what makes the gateway auditable — a third party can `kolm receipts
// verify <id>` and replay the signature without needing access to the
// underlying call history.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN + this wrapper completion directive):
//   - 19 fields total, ordered for canonical signing
//   - signature_ed25519 lives at the end and is excluded from the signed
//     payload (the signer canonicalizes the rest and signs that)
//   - schema version "kolm-audit-1" lets clients pin verifiers
//   - input/output hashes are sha256, kept short (16 hex) for grep-ability
//
// Public surface:
//   - RECEIPT_SCHEMA = 'kolm-audit-1'
//   - REQUIRED_FIELDS, OPTIONAL_FIELDS, ALL_FIELDS (frozen arrays)
//   - validateReceipt(obj) -> { ok, errors[] }
//   - canonicalForSigning(receipt) -> string (sorted keys + signature_ed25519
//     stripped — the EXACT input to ed25519.sign)
//   - emptyReceipt() -> a fresh receipt scaffold with required keys present

export const RECEIPT_SCHEMA = 'kolm-audit-1';

// Fields the receipt MUST have. The signer rejects receipts missing any
// of these.
export const REQUIRED_FIELDS = Object.freeze([
  'schema',
  'receipt_id',
  'timestamp',
  'namespace_id',
  'route_decision',
  'provider',
  'model',
  'input_hash',
  'output_hash',
  'capture_eligible',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'signing_key_id',
  'verify_url',
]);

// Fields the receipt MAY have. May be present-but-null for sparse rows
// (e.g. artifact_id is null when route_decision == 'frontier').
export const OPTIONAL_FIELDS = Object.freeze([
  'artifact_id',
  'confidence',
  'fallback_reason',
  'capture_id',
  'redaction_applied',
]);

// All fields in CANONICAL ORDER. Signers must emit keys in this order so
// the signature is deterministic across implementations.
export const ALL_FIELDS = Object.freeze([
  'schema',
  'receipt_id',
  'timestamp',
  'namespace_id',
  'route_decision',
  'provider',
  'model',
  'artifact_id',
  'confidence',
  'fallback_reason',
  'input_hash',
  'output_hash',
  'capture_eligible',
  'capture_id',
  'redaction_applied',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'signing_key_id',
  'verify_url',
]);

// Valid values for the enumerated fields.
export const ROUTE_DECISIONS = Object.freeze(['local', 'frontier']);
export const FALLBACK_REASONS = Object.freeze([
  'low_confidence',
  'class_mismatch',
  'upstream_timeout',
  'upstream_429',
  'upstream_5xx',
  'poison_detected',
  null,
]);
export const VALID_PROVIDERS = Object.freeze([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'openrouter',
  'local-vllm',
  'local-ollama',
  'local-kolm',
  '.kolm',
]);

// Conservative bounds on numeric fields. Wider than the gateway will ever
// realistically emit, but tight enough to catch sign bugs (negative tokens,
// etc.).
const BOUNDS = {
  input_tokens:  { min: 0, max: 4_000_000 },
  output_tokens: { min: 0, max: 4_000_000 },
  cost_usd:      { min: 0, max: 10_000 },
  confidence:    { min: 0, max: 1 },
};

/**
 * validateReceipt — verify the SHAPE and TYPES of a receipt envelope.
 *
 * Does NOT verify the signature (that's verifySignatureBlock in ed25519.js).
 * Does NOT call the verify URL (that's `kolm receipts verify`). This is
 * purely a structural check used by the gateway builder + the schema lock-in
 * tests.
 *
 * Returns {ok:true} when the receipt is valid, or {ok:false, errors:[...]}
 * with one error per violation (so callers can show all errors at once
 * rather than fix-one-find-another).
 */
export function validateReceipt(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['receipt must be a non-null object'] };
  }
  if (obj.schema !== RECEIPT_SCHEMA) {
    errors.push(`schema must be "${RECEIPT_SCHEMA}", got ${JSON.stringify(obj.schema)}`);
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) errors.push(`missing required field: ${f}`);
  }
  if (typeof obj.receipt_id === 'string' && !/^rcpt_[A-Za-z0-9]{20,}$/.test(obj.receipt_id)) {
    errors.push(`receipt_id must match /^rcpt_[A-Za-z0-9]{20,}$/, got ${JSON.stringify(obj.receipt_id)}`);
  }
  if (typeof obj.timestamp === 'string' && isNaN(Date.parse(obj.timestamp))) {
    errors.push(`timestamp must be ISO-8601 parseable, got ${JSON.stringify(obj.timestamp)}`);
  }
  if (obj.route_decision != null && !ROUTE_DECISIONS.includes(obj.route_decision)) {
    errors.push(`route_decision must be one of ${JSON.stringify(ROUTE_DECISIONS)}, got ${JSON.stringify(obj.route_decision)}`);
  }
  if (obj.fallback_reason !== undefined && !FALLBACK_REASONS.includes(obj.fallback_reason)) {
    errors.push(`fallback_reason must be one of ${JSON.stringify(FALLBACK_REASONS)}, got ${JSON.stringify(obj.fallback_reason)}`);
  }
  if (obj.provider != null && !VALID_PROVIDERS.includes(obj.provider)) {
    errors.push(`provider must be one of ${JSON.stringify(VALID_PROVIDERS)}, got ${JSON.stringify(obj.provider)}`);
  }
  if (typeof obj.input_hash === 'string' && !/^sha256:[0-9a-f]{16,64}$/.test(obj.input_hash)) {
    errors.push(`input_hash must match /^sha256:[0-9a-f]{16,64}$/`);
  }
  if (typeof obj.output_hash === 'string' && !/^sha256:[0-9a-f]{16,64}$/.test(obj.output_hash)) {
    errors.push(`output_hash must match /^sha256:[0-9a-f]{16,64}$/`);
  }
  if (typeof obj.capture_eligible !== 'boolean' && obj.capture_eligible !== undefined) {
    errors.push(`capture_eligible must be boolean`);
  }
  if (obj.redaction_applied !== undefined && !Array.isArray(obj.redaction_applied)) {
    errors.push(`redaction_applied must be an array when present`);
  }
  for (const [field, bound] of Object.entries(BOUNDS)) {
    const v = obj[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${field} must be a finite number, got ${JSON.stringify(v)}`);
      continue;
    }
    if (v < bound.min || v > bound.max) {
      errors.push(`${field} out of range [${bound.min}, ${bound.max}]: ${v}`);
    }
  }
  if (typeof obj.verify_url === 'string' && !/^https?:\/\//.test(obj.verify_url)) {
    errors.push(`verify_url must be a fully qualified http(s) URL`);
  }
  if (typeof obj.signing_key_id === 'string' && obj.signing_key_id.length === 0) {
    errors.push(`signing_key_id must be non-empty when present`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [] };
}

/**
 * canonicalForSigning — produce the EXACT string the Ed25519 signer signs.
 *
 * Strips signature_ed25519 (the signature MUST NOT cover itself) and emits
 * keys in ALL_FIELDS order. Uses JSON.stringify with no spaces so the bytes
 * are deterministic across implementations.
 */
export function canonicalForSigning(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('canonicalForSigning: receipt must be an object');
  }
  const out = {};
  for (const k of ALL_FIELDS) {
    if (k in receipt) out[k] = receipt[k];
  }
  return JSON.stringify(out);
}

/**
 * emptyReceipt — return a fresh receipt scaffold with all required keys
 * present and the optional ones explicitly null. Useful for builders that
 * fill in fields one at a time.
 */
export function emptyReceipt() {
  return {
    schema: RECEIPT_SCHEMA,
    receipt_id: '',
    timestamp: '',
    namespace_id: '',
    route_decision: 'frontier',
    provider: '',
    model: '',
    artifact_id: null,
    confidence: null,
    fallback_reason: null,
    input_hash: '',
    output_hash: '',
    capture_eligible: false,
    capture_id: null,
    redaction_applied: [],
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    signing_key_id: '',
    verify_url: '',
  };
}

export const RECEIPT_SCHEMA_VERSION = 'kolm-audit-1';
