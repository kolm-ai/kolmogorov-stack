// W-D / wrapper-completion - gateway receipt builder.
//
// Builds full 19-field kolm-audit-1 receipts (see src/receipt-schema.js)
// from the gateway's pipeline outputs (provider id, model name, route
// decision, capture id, redaction findings, token counts, cost, ...) and
// signs them with Ed25519 (see src/ed25519.js).
//
// Public surface:
//   - buildAndSignReceipt({...}) -> { receipt, signed_at, key_fingerprint }
//     where `receipt` has signature_ed25519 attached at the tail.
//   - newReceiptId() -> "rcpt_<22-char base32-friendly ULID>"
//   - hashInput(s) / hashOutput(s) -> "sha256:<32-hex>" (first 32 hex chars
//     of the full sha256 digest - short enough to grep, long enough that
//     a deliberate collision is still expensive)
//   - verifyReceipt(receipt) -> { ok, key_fingerprint, reason? }
//
// The builder pairs with src/receipt-schema.js (validation + canonicalization)
// and src/ed25519.js (signing). It deliberately does NOT cost-estimate or
// price; the gateway is expected to pass {input_tokens, output_tokens,
// cost_usd} already resolved by src/cost-estimator.js.

import crypto from 'node:crypto';
import {
  RECEIPT_SCHEMA,
  ALL_FIELDS,
  FALLBACK_REASONS,
  validateReceipt,
  canonicalForSigning,
  emptyReceipt,
} from './receipt-schema.js';
import {
  loadOrCreateDefaultSigner,
  buildSignatureBlock,
  verifySignatureBlock,
} from './ed25519.js';
// key-revocation is leaf-level on store.js (no cycle with gateway-receipt).
// Static import is safe and keeps verifyReceipt() synchronous.
import { status as issuerKeyStatus } from './key-revocation.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * newReceiptId - generate a fresh receipt id like rcpt_01HXYZ...
 *
 * Uses crypto.randomBytes to produce a 22-char Crockford-style base32 body
 * (no I, L, O, U). Sortable when stored as text because the leading bytes
 * are time-derived (millisecond timestamp, big-endian, 6 bytes).
 */
export function newReceiptId() {
  const ts = Date.now();
  const tsBytes = Buffer.alloc(6);
  tsBytes.writeUIntBE(ts, 0, 6);
  const rand = crypto.randomBytes(10);
  const body = Buffer.concat([tsBytes, rand]);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    // map each byte to two base32 chars (0..31 + 0..31)
    out += ULID_ALPHABET[body[i] >> 3];
    out += ULID_ALPHABET[(body[i] & 0x1f) % 32];
  }
  // 16 bytes -> 32 chars; trim to 22 to match canonical ULID length feel.
  return `rcpt_${out.slice(0, 22)}`;
}

function _sha256Short(s) {
  const h = crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
  return `sha256:${h.slice(0, 32)}`;
}

export function hashInput(s)  { return _sha256Short(s); }
export function hashOutput(s) { return _sha256Short(s); }

function _verifyUrl(receiptId, baseUrl) {
  const base = (baseUrl || process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
  return `${base}/v1/verify/${receiptId}`;
}

/**
 * buildAndSignReceipt - assemble a kolm-audit-1 receipt and sign it.
 *
 * Inputs (all optional unless noted):
 *   - namespace_id       (string, REQUIRED) - namespace this call ran under
 *   - route_decision     ('local' | 'frontier', default 'frontier')
 *   - provider           (string, REQUIRED) - e.g. 'anthropic', 'local-kolm'
 *   - model              (string, REQUIRED) - e.g. 'claude-opus-4-7'
 *   - artifact_id        (string | null) - set when route_decision='local'
 *   - confidence         (number 0..1 | null)
 *   - fallback_reason    (string | null) - set when local→frontier fallback
 *   - input_text         (string) - raw input, used to derive hash
 *   - output_text        (string) - raw output, used to derive hash
 *   - input_hash         (string) - override (else derived from input_text)
 *   - output_hash        (string) - override (else derived from output_text)
 *   - capture_eligible   (bool, default false)
 *   - capture_id         (string | null)
 *   - redaction_applied  (string[]) - e.g. ['email','phone']
 *   - input_tokens       (number, default 0)
 *   - output_tokens      (number, default 0)
 *   - cost_usd           (number, default 0)
 *   - signer             (signer object from loadOrCreateDefaultSigner) - optional
 *   - signing_key_id     (string) - defaults to env or signer fingerprint
 *   - verify_url_base    (string) - defaults to env or https://kolm.ai
 *   - timestamp          (string ISO-8601) - defaults to now
 *
 * Returns { receipt, signed_at, key_fingerprint }. The receipt has a
 * `signature_ed25519` block appended at the tail. Throws if the assembled
 * receipt fails validateReceipt - that means the caller passed bad inputs
 * and a corrupt signature is the worst possible recovery.
 */
export function buildAndSignReceipt(opts = {}) {
  const r = emptyReceipt();
  r.receipt_id   = opts.receipt_id || newReceiptId();
  r.timestamp    = opts.timestamp  || new Date().toISOString();
  r.namespace_id = String(opts.namespace_id || '').slice(0, 128);
  r.route_decision = opts.route_decision === 'local' ? 'local' : 'frontier';
  r.provider     = String(opts.provider || '').slice(0, 64);
  r.model        = String(opts.model || '').slice(0, 128);
  r.artifact_id  = opts.artifact_id == null ? null : String(opts.artifact_id).slice(0, 128);
  r.confidence   = (typeof opts.confidence === 'number' && Number.isFinite(opts.confidence))
    ? Math.max(0, Math.min(1, opts.confidence))
    : null;
  // W921 P0: clamp to the schema enum so an unexpected logging value can NEVER
  // throw in validateReceipt and abort a live gateway call (fail-open). Unknown
  // reasons collapse to null; the attempted[] array still carries the detail.
  const _fr = opts.fallback_reason == null ? null : String(opts.fallback_reason).slice(0, 64);
  r.fallback_reason = FALLBACK_REASONS.includes(_fr) ? _fr : null;

  r.input_hash  = opts.input_hash  || hashInput(opts.input_text ?? '');
  r.output_hash = opts.output_hash || hashOutput(opts.output_text ?? '');

  r.capture_eligible = !!opts.capture_eligible;
  r.capture_id = opts.capture_id == null ? null : String(opts.capture_id).slice(0, 128);
  r.redaction_applied = Array.isArray(opts.redaction_applied) ? opts.redaction_applied.slice(0, 64) : [];

  r.input_tokens  = Number.isFinite(opts.input_tokens)  ? Math.max(0, Math.trunc(opts.input_tokens))  : 0;
  r.output_tokens = Number.isFinite(opts.output_tokens) ? Math.max(0, Math.trunc(opts.output_tokens)) : 0;
  r.cost_usd      = Number.isFinite(opts.cost_usd)      ? Math.max(0, opts.cost_usd)                  : 0;

  const signer = opts.signer || loadOrCreateDefaultSigner();
  r.signing_key_id = opts.signing_key_id
    || process.env.KOLM_SIGNING_KEY_ID
    || signer.key_fingerprint;
  r.verify_url = _verifyUrl(r.receipt_id, opts.verify_url_base);

  const v = validateReceipt(r);
  if (!v.ok) {
    const err = new Error('gateway-receipt: receipt failed validation: ' + v.errors.join('; '));
    err.code = 'receipt_invalid';
    err.errors = v.errors;
    throw err;
  }

  const canonical = canonicalForSigning(r);
  const sigBlock = buildSignatureBlock({
    privateKey: signer.privateKey,
    publicKey:  signer.publicKey,
    key_fingerprint: signer.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: r.timestamp,
  });
  r.signature_ed25519 = sigBlock;
  return {
    receipt: r,
    signed_at: sigBlock.signed_at,
    key_fingerprint: sigBlock.key_fingerprint,
  };
}

/**
 * verifyReceipt - recompute canonical, verify the attached signature.
 *
 * Returns {ok, reason?, key_fingerprint?}. Pure (no network - does NOT
 * call verify_url). The `kolm receipts verify --offline` mode exercises
 * exactly this path; the online path additionally fetches the receipt
 * from /v1/verify/<id> and compares hash + signature blocks.
 */
export function verifyReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, reason: 'receipt missing or not an object' };
  }
  const v = validateReceipt(receipt);
  if (!v.ok) return { ok: false, reason: 'receipt failed schema validation: ' + v.errors.join('; ') };
  const sigBlock = receipt.signature_ed25519;
  if (!sigBlock) return { ok: false, reason: 'receipt has no signature_ed25519 block' };
  const stripped = { ...receipt };
  delete stripped.signature_ed25519;
  const canonical = canonicalForSigning(stripped);
  const result = verifySignatureBlock(sigBlock, canonical);
  // Parity with the HTTP verify route: a mathematically-valid signature made by
  // a REVOKED issuer key must NOT be treated as verified. Consult the (sync)
  // revocation store so 'verified' means the same thing offline and online.
  if (result.ok) {
    const fp = sigBlock.key_fingerprint;
    if (fp) {
      try {
        const st = issuerKeyStatus(fp);
        if (st && st.valid === false) {
          return { ok: false, reason: 'issuer_key_revoked', key_fingerprint: fp };
        }
      } catch {
        // store unavailable: do not silently pass - surface the gap to the caller.
        return { ...result, revocation_check: 'unavailable' };
      }
    }
  }
  return result;
}

export { RECEIPT_SCHEMA, ALL_FIELDS };
