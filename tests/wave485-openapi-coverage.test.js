// W485 P1-11 — OpenAPI coverage lock-in.
//
// Audit flagged: public/openapi.json only declared 11 ops while src/router.js
// has 344+ live routes — the SDKs and consumers can't trust the doc.
//
// scripts/build-openapi.cjs now merges api-routes.json (source of truth) into
// openapi.json on every build. This test pins three invariants:
//   1) openapi.json declares an Operation for EVERY non-stub route in
//      api-routes.json (the stub guard is documented but not required since
//      they're returning honest 501s).
//   2) The curated 7 ops (auth/login, auth/signup, account, compile, etc.)
//      keep their rich request/response schemas — the build script is merge-
//      not-replace.
//   3) The doc parses as valid OpenAPI 3.0.3 shape: every operation has a
//      summary + a 200/2xx response entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const OPENAPI = JSON.parse(fs.readFileSync(path.join(REPO, 'public', 'openapi.json'), 'utf8'));
const ROUTES = JSON.parse(fs.readFileSync(path.join(REPO, 'public', 'docs', 'api-routes.json'), 'utf8'));

function expressToOpenapi(p) {
  return p
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(\*\)/g, ':$1')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

test('W485 #1 — openapi.json covers every non-stub route from api-routes.json', () => {
  const missing = [];
  for (const g of ROUTES.groups || []) {
    for (const r of g.routes || []) {
      if (r.stub) continue;
      const op = expressToOpenapi(r.path);
      const m = r.method.toLowerCase();
      if (!OPENAPI.paths[op] || !OPENAPI.paths[op][m]) {
        missing.push(`${r.method} ${r.path}`);
      }
    }
  }
  assert.deepEqual(missing, [], `${missing.length} non-stub routes missing from OpenAPI: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`);
});

test('W485 #2 — openapi.json declares ≥ 300 operations (was 11 before the audit fix)', () => {
  let count = 0;
  for (const p of Object.keys(OPENAPI.paths)) {
    for (const m of Object.keys(OPENAPI.paths[p])) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m)) count++;
    }
  }
  assert.ok(count >= 300, `expected ≥300 operations, got ${count}`);
});

test('W485 #3 — curated /v1/auth/login keeps its rich request/response schemas (merge-not-replace)', () => {
  const op = OPENAPI.paths['/v1/auth/login']?.post;
  assert.ok(op, '/v1/auth/login POST must exist');
  // The curated operation referenced LoginRequest + AuthResponse schemas.
  // The build script must NOT have overwritten these with the generic shape.
  const reqRef = op.requestBody?.content?.['application/json']?.schema?.$ref || '';
  assert.match(reqRef, /LoginRequest|loginRequest/i,
    'curated /v1/auth/login lost its LoginRequest schema — build script overwrote a hand-curated op');
  assert.ok(op.responses && (op.responses['200'] || op.responses['2XX']),
    '/v1/auth/login must declare a 2xx response');
});

test('W485 #4 — every operation declares a summary and at least one 2xx-class response', () => {
  const bad = [];
  for (const p of Object.keys(OPENAPI.paths)) {
    for (const m of Object.keys(OPENAPI.paths[p])) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      const op = OPENAPI.paths[p][m];
      if (!op.summary) bad.push(`${m.toUpperCase()} ${p}: missing summary`);
      const responses = op.responses || {};
      const hasSuccess = Object.keys(responses).some(c => /^2/.test(c) || c === 'default');
      if (!hasSuccess) bad.push(`${m.toUpperCase()} ${p}: no 2xx response declared`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} ops fail OpenAPI 3.0 shape: ${bad.slice(0, 6).join(' | ')}${bad.length > 6 ? '...' : ''}`);
});

test('W485 #5 — JsonEnvelope schema and shared responses exist in components (no dangling $refs)', () => {
  assert.ok(OPENAPI.components, 'openapi.components must exist');
  assert.ok(OPENAPI.components.schemas && OPENAPI.components.schemas.JsonEnvelope,
    'JsonEnvelope schema must exist for $ref resolution');
  const resps = (OPENAPI.components.responses || {});
  for (const name of ['JsonEnvelope', 'BadRequest', 'Unauthorized', 'RateLimited', 'ServerError']) {
    assert.ok(resps[name], `components.responses.${name} must exist`);
  }
});

test('W485 #6 — every operationId is unique', () => {
  const seen = new Map();
  const dupes = [];
  for (const p of Object.keys(OPENAPI.paths)) {
    for (const m of Object.keys(OPENAPI.paths[p])) {
      const op = OPENAPI.paths[p][m];
      if (!op || !op.operationId) continue;
      if (seen.has(op.operationId)) {
        dupes.push(`${op.operationId}: ${seen.get(op.operationId)} vs ${m.toUpperCase()} ${p}`);
      } else {
        seen.set(op.operationId, `${m.toUpperCase()} ${p}`);
      }
    }
  }
  assert.deepEqual(dupes, [], `duplicate operationIds: ${dupes.slice(0, 5).join(' | ')}`);
});
