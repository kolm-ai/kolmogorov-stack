// W890-9 — API completeness lock-in.
//
// Twelve invariants ratify the audit produced by
// `node scripts/w890-9-api-audit.cjs`. The audit writes nine JSON reports
// under data/ and a canonical reference at docs/reference/api-policy.md.
//
//   1. OpenAPI is in sync with src/router.js (no gap)
//   2. Every endpoint has a documented request schema (POST/PUT/PATCH)
//      and response schema; no exceptions.
//   3. Every endpoint has at least one example (count <= 10 missing).
//   4. Every endpoint lives under /v1/ except a documented exempt list.
//   5. No dead endpoints still routed (curated orphans removed).
//   6. CORS preflight handled by global middleware on every endpoint.
//   7. Content-Type validation on POST/PUT/PATCH via global body parser.
//   8. Pagination on every list endpoint (limit/offset/cursor OR bounded).
//   9. Every sampled error response uses the canonical envelope shape.
//   10. docs/reference/api-policy.md exists and references all nine
//       data files.
//   11. No banned vocabulary in any W890-9 artifact or policy doc.
//   12. ship-gate 52/52 still green (snapshotted to
//       data/w890-9-ship-gate-snapshot.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const NODE = process.execPath;

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('lock-in 1: openapi coverage is in sync with src routes', () => {
  const r = readJSON('data/w890-9-openapi-coverage.json');
  assert.strictEqual(r.in_sync, true,
    `openapi coverage must be in sync; gap=${JSON.stringify(r.gap)} orphans=${JSON.stringify(r.orphan_in_openapi)}`);
  assert.ok(Array.isArray(r.gap), 'gap must be an array');
  assert.strictEqual(r.gap.length, 0, `gap must be empty; got ${JSON.stringify(r.gap)}`);
  assert.ok(Array.isArray(r.orphan_in_openapi), 'orphan_in_openapi must be an array');
  assert.strictEqual(r.orphan_in_openapi.length, 0,
    `orphan_in_openapi must be empty (no dead curated ops); got ${JSON.stringify(r.orphan_in_openapi)}`);
  assert.ok(r.routes_in_src > 700, 'expected > 700 routes in src');
  assert.strictEqual(r.routes_in_openapi, r.routes_in_src,
    'routes_in_openapi must equal routes_in_src');
});

test('lock-in 2: every endpoint has request and response schemas', () => {
  const r = readJSON('data/w890-9-schemas.json');
  assert.ok(Array.isArray(r.missing_request), 'missing_request must be an array');
  assert.strictEqual(r.missing_request.length, 0,
    `missing_request must be empty; got ${r.missing_request.length} ops without requestBody schema. Sample: ${JSON.stringify(r.missing_request.slice(0,5))}`);
  assert.ok(Array.isArray(r.missing_response), 'missing_response must be an array');
  assert.strictEqual(r.missing_response.length, 0,
    `missing_response must be empty; got ${r.missing_response.length} ops without response schema`);
  assert.deepStrictEqual(r.request_required_methods, ['post', 'put', 'patch'],
    'request_required_methods must list exactly POST/PUT/PATCH');
});

test('lock-in 3: every endpoint has at least one example (missing <= 10)', () => {
  const r = readJSON('data/w890-9-examples.json');
  assert.ok(Array.isArray(r.missing_example), 'missing_example must be an array');
  assert.ok(r.missing_example.length <= 10,
    `missing_example must be <= 10 (W890-9 budget); got ${r.missing_example.length}. Sample: ${JSON.stringify(r.missing_example.slice(0,5))}`);
});

test('lock-in 4: versioning — every non-v1 path is in the documented exempt list', () => {
  const r = readJSON('data/w890-9-versioning.json');
  assert.ok(typeof r.nonconformant_count === 'number',
    'nonconformant_count must be a number');
  assert.strictEqual(r.nonconformant_count, 0,
    `nonconformant_count must be 0; got ${r.nonconformant_count}. non_v1: ${JSON.stringify(r.non_v1)}`);
  // Every non-v1 entry must have a documented reason (not "NONCONFORMANT").
  for (const e of r.non_v1) {
    assert.notStrictEqual(e.reason, 'NONCONFORMANT',
      `non_v1 entry ${e.path} has reason=NONCONFORMANT — add it to the documented exempt list or move it under /v1/`);
  }
});

test('lock-in 5: deprecation — no dead endpoints still routed', () => {
  const r = readJSON('data/w890-9-deprecation.json');
  assert.ok(Array.isArray(r.dead_endpoints_detected),
    'dead_endpoints_detected must be an array');
  assert.strictEqual(r.dead_endpoints_detected.length, 0,
    `dead_endpoints_detected must be empty; got ${JSON.stringify(r.dead_endpoints_detected)}`);
  // Stale routes (same handler mounted twice) are allowed up to 1 — the
  // documented /v1/evidence intentional dual-mount.
  assert.ok(Array.isArray(r.stale_routes), 'stale_routes must be an array');
  assert.ok(r.stale_routes.length <= 1,
    `stale_routes must be <= 1 (intentional /v1/evidence alias); got ${r.stale_routes.length}`);
});

test('lock-in 6: CORS preflight covered by global middleware', () => {
  const r = readJSON('data/w890-9-cors-preflight.json');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.strictEqual(r.missing.length, 0,
    `cors.missing must be 0; got ${r.missing.length}`);
  assert.strictEqual(r.mechanism, 'global-middleware',
    'cors mechanism must be global-middleware');
  assert.strictEqual(r.cors_allow_origin, '*',
    'cors_allow_origin must be * (SDK-friendly)');
  assert.ok(Array.isArray(r.cors_allow_methods) && r.cors_allow_methods.includes('OPTIONS'),
    'cors_allow_methods must include OPTIONS');
  assert.strictEqual(r.with_options_handler, r.total_endpoints,
    'with_options_handler must equal total_endpoints (global covers all)');
});

test('lock-in 7: Content-Type validation via global body parser', () => {
  const r = readJSON('data/w890-9-content-type-validation.json');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.strictEqual(r.missing.length, 0,
    `content-type missing must be 0; got ${r.missing.length}`);
  assert.strictEqual(r.mechanism, 'global-body-parser',
    'content-type mechanism must be global-body-parser');
  assert.strictEqual(r.parsers_detected.express_json, true,
    'express.json must be mounted globally in server.js');
  assert.strictEqual(r.parsers_detected.express_urlencoded, true,
    'express.urlencoded must be mounted globally in server.js');
  assert.strictEqual(r.parsers_detected.express_raw_stripe_webhook, true,
    'express.raw must be mounted for /v1/stripe/webhook (HMAC verification)');
  assert.strictEqual(r.parsers_detected.helmet_no_sniff_response_header, true,
    'helmet noSniff must be enabled');
});

test('lock-in 8: pagination on every list endpoint', () => {
  const r = readJSON('data/w890-9-pagination.json');
  assert.ok(Array.isArray(r.list_endpoints), 'list_endpoints must be an array');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.strictEqual(r.missing.length, 0,
    `pagination.missing must be 0; got ${r.missing.length}. Sample: ${JSON.stringify(r.missing.slice(0,5))}`);
  // Every list endpoint must satisfy at least one of paged/bounded.
  for (const e of r.list_endpoints) {
    assert.ok(e.paged || e.bounded,
      `list endpoint ${e.path} has neither pagination nor bounded results`);
  }
  assert.ok(r.list_endpoints_count > 0,
    'expected at least one list endpoint detected');
});

test('lock-in 9: error format — every sampled error response is conformant', () => {
  const r = readJSON('data/w890-9-error-format.json');
  assert.ok(Array.isArray(r.non_conformant), 'non_conformant must be an array');
  assert.strictEqual(r.non_conformant.length, 0,
    `non_conformant must be empty; got ${r.non_conformant.length}. Sample: ${JSON.stringify(r.non_conformant.slice(0,3))}`);
  assert.ok(typeof r.sampled_error_responses === 'number',
    'sampled_error_responses must be a number');
  assert.ok(r.sampled_error_responses > 500,
    `expected > 500 sampled error responses; got ${r.sampled_error_responses}`);
  // The canonical envelope variant counts must agree with the totals.
  const conformantViaShapeCounts =
    r.shape_counts.w890_9_canonical_error_object +
    r.shape_counts.legacy_ok_false_error_keyed +
    r.shape_counts.legacy_short_error_keyed +
    r.shape_counts.conformant_with_expression_error;
  assert.strictEqual(r.conformant_to_schema, conformantViaShapeCounts,
    'conformant_to_schema must equal sum of conformant shape buckets');
});

test('lock-in 10: docs/reference/api-policy.md exists and references all nine data files', () => {
  const docPath = path.join(ROOT, 'docs/reference/api-policy.md');
  assert.ok(fs.existsSync(docPath), 'api-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const f of [
    'w890-9-openapi-coverage.json',
    'w890-9-schemas.json',
    'w890-9-examples.json',
    'w890-9-versioning.json',
    'w890-9-deprecation.json',
    'w890-9-cors-preflight.json',
    'w890-9-content-type-validation.json',
    'w890-9-pagination.json',
    'w890-9-error-format.json',
  ]) {
    assert.ok(txt.includes(f), `api-policy.md must reference ${f}`);
  }
  // Must describe the W890-9 canonical envelope + the legacy envelope.
  assert.ok(/W890-9 canonical/.test(txt), 'must describe W890-9 canonical envelope');
  assert.ok(/Legacy kolm/.test(txt), 'must describe legacy envelope');
  assert.ok(/build-openapi\.cjs/.test(txt), 'must reference build-openapi.cjs');
  assert.ok(/JsonEnvelope/.test(txt), 'must reference JsonEnvelope shared response');
  assert.ok(/GenericRequest/.test(txt), 'must reference GenericRequest schema');
});

test('lock-in 11: no banned vocabulary in any W890-9 artifact or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1..8 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-9-openapi-coverage.json',
    'data/w890-9-schemas.json',
    'data/w890-9-examples.json',
    'data/w890-9-versioning.json',
    'data/w890-9-deprecation.json',
    'data/w890-9-cors-preflight.json',
    'data/w890-9-content-type-validation.json',
    'data/w890-9-pagination.json',
    'data/w890-9-error-format.json',
    'docs/reference/api-policy.md',
    'scripts/w890-9-api-audit.cjs',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 12: ship-gate snapshot exists and reports 52/52 green', () => {
  // Snapshot pattern (mirrors W890-4 + W890-8). The ship-gate snapshot is
  // captured by running `node scripts/ship-gate.cjs --json` outside the
  // node --test runner (because ship-gate #51/#52 internally invoke node
  // --test and Node refuses to nest test runs). The snapshot is committed
  // to data/w890-9-ship-gate-snapshot.json by the audit closeout.
  const snapPath = path.join(ROOT, 'data/w890-9-ship-gate-snapshot.json');
  assert.ok(fs.existsSync(snapPath),
    'data/w890-9-ship-gate-snapshot.json must exist (run scripts/ship-gate.cjs --json > data/w890-9-ship-gate-snapshot.json)');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const passed = snap.passed != null ? snap.passed
    : (snap.summary && snap.summary.passed) || 0;
  const total = snap.total != null ? snap.total
    : (snap.summary && snap.summary.total) || 0;
  assert.strictEqual(passed, 52,
    `ship-gate snapshot passed must be 52; got ${passed}/${total}`);
  assert.strictEqual(total, 52,
    `ship-gate snapshot total must be 52; got ${passed}/${total}`);
});
