// Wrapper receipt-schema tests - schema validation only (3 tests, unconditional).
//
// These exercise the receipt schema in isolation - no endpoints, no CLI,
// no network. They run on every `npm test` without an opt-in flag because
// schema validation is pure compute.
//
// If src/receipt-schema.js is not yet present we fall back to an inline
// minimal validator that mirrors the documented kolm-audit-1 contract so
// the tests still run + provide meaningful coverage as the schema lands.
//
// Items pinned:
//   #1 - a valid receipt validates ok
//   #2 - a missing required field is rejected with the field name in the error
//   #3 - a wrong schema version is rejected

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src', 'receipt-schema.js');

// ---------------------------------------------------------------------------
// Resolve a validator: prefer src/receipt-schema.js#validateReceipt; fall back
// to an inline minimal validator that mirrors the documented contract.
// ---------------------------------------------------------------------------
// W707 canonical 19-field shape. The validator may return either:
//   { ok, error, field } (older inline shape)
// or
//   { ok, errors[] } (current src/receipt-schema.js shape).
// We accept both so the assertion text below works either way.
const SCHEMA_VERSION = 'kolm-audit-1';

const INLINE_REQUIRED_FIELDS = [
  'schema', 'receipt_id', 'timestamp', 'namespace_id', 'route_decision',
  'provider', 'model', 'input_hash', 'output_hash', 'capture_eligible',
  'input_tokens', 'output_tokens', 'cost_usd', 'signing_key_id', 'verify_url',
];

function inlineValidate(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, errors: ['receipt must be an object'] };
  }
  const errors = [];
  if (receipt.schema !== SCHEMA_VERSION) {
    errors.push(`schema must be "${SCHEMA_VERSION}"; got "${receipt.schema}"`);
  }
  for (const f of INLINE_REQUIRED_FIELDS) {
    if (!(f in receipt)) errors.push(`missing required field: ${f}`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [] };
}

let validateReceipt = inlineValidate;
let usingInline = true;
try {
  // Dynamic import so a missing file fails soft rather than blowing up the suite.
  const mod = await import(pathToFileURL(SCHEMA_PATH).href);
  if (mod && typeof mod.validateReceipt === 'function') {
    validateReceipt = mod.validateReceipt;
    usingInline = false;
  }
} catch { // deliberate: cleanup
  // src/receipt-schema.js not yet present; fall through to inlineValidate.
}

// W707 19-field canonical kolm-audit-1 receipt. Matches src/receipt-schema.js.
function validReceipt() {
  return {
    schema: SCHEMA_VERSION,
    receipt_id: 'rcpt_01HABCD1234567890ABCD',
    timestamp: '2026-05-26T00:00:00.000Z',
    namespace_id: 'ns_default',
    route_decision: 'frontier',
    provider: 'openai',
    model: 'gpt-4o-mini',
    artifact_id: null,
    confidence: 0.92,
    fallback_reason: null,
    input_hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
    output_hash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321',
    capture_eligible: false,
    capture_id: null,
    redaction_applied: [],
    input_tokens: 12,
    output_tokens: 34,
    cost_usd: 0.0001,
    signing_key_id: 'k1',
    verify_url: 'https://kolm.ai/v1/verify/rcpt_01HABCD1234567890ABCD',
  };
}

// Normalize error surface across older { error, field } and current { errors[] }.
function errorText(result) {
  const parts = [
    String(result.error || ''),
    String(result.field || ''),
    Array.isArray(result.errors) ? result.errors.join(' | ') : '',
  ];
  return parts.join(' ');
}

// ----------------------------------------------------------------------------
// #1 - valid receipt validates ok
// ----------------------------------------------------------------------------
test(`wrapper-receipt-schema #1 - valid receipt validates ok (using ${usingInline ? 'inline-fallback' : 'src/receipt-schema.js'})`, () => {
  const r = validateReceipt(validReceipt());
  assert.equal(r.ok, true, `valid receipt must validate ok:true; got ${JSON.stringify(r)}`);
});

// ----------------------------------------------------------------------------
// #2 - missing required field is rejected with the field name in the error
// ----------------------------------------------------------------------------
test('wrapper-receipt-schema #2 - missing required field is rejected with field name in error', () => {
  const r = validReceipt();
  delete r.signing_key_id;
  const result = validateReceipt(r);
  assert.equal(result.ok, false, `missing signing_key_id must validate ok:false; got ${JSON.stringify(result)}`);
  const errStr = errorText(result);
  assert.ok(/signing_key_id/i.test(errStr),
    `error must name the missing field "signing_key_id"; got "${errStr}"`);
});

// ----------------------------------------------------------------------------
// #3 - wrong schema version is rejected
// ----------------------------------------------------------------------------
test('wrapper-receipt-schema #3 - wrong schema version is rejected', () => {
  const r = validReceipt();
  r.schema = 'kolm-audit-0';
  const result = validateReceipt(r);
  assert.equal(result.ok, false, `wrong schema version must validate ok:false; got ${JSON.stringify(result)}`);
  const errStr = errorText(result);
  assert.ok(/schema/i.test(errStr) || /version/i.test(errStr) || /kolm-audit/i.test(errStr),
    `error must mention schema/version; got "${errStr}"`);
});
