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

test('W485 #3 — curated /v1/auth/login op exists and declares a stable contract', () => {
  // Original W485 intent: a curated path must not be overwritten by the
  // auto-generated build pass. W890-9 closes the parallel issue: the
  // /v1/auth/login + /v1/auth/signup paths were aspirational — Kolm never
  // implemented password auth, only API key + OAuth — so the curated
  // LoginRequest / AuthResponse schemas were dead. W890-9 converts both to
  // explicit `deprecated:true` 410-Gone shells. The merge guarantee still
  // holds (build-openapi.cjs preserves the curated op verbatim); only the
  // contract itself changed from aspirational to deprecation-aliased.
  const op = OPENAPI.paths['/v1/auth/login']?.post;
  assert.ok(op, '/v1/auth/login POST must exist');
  assert.strictEqual(op.deprecated, true,
    '/v1/auth/login must declare deprecated:true (W890-9 deprecation contract)');
  // The op must declare at least one response. The 200 of the original
  // curated op or the 410 of the W890-9 deprecation contract both qualify.
  assert.ok(op.responses && (op.responses['200'] || op.responses['2XX'] || op.responses['410']),
    '/v1/auth/login must declare a response');
});

test('W485 #4 — every operation declares a summary and at least one terminal response', () => {
  // Original W485 required a 2xx-class response on every op. W890-9 introduced
  // an explicit deprecation contract for /v1/auth/login + /v1/auth/signup whose
  // ONLY response is 410 Gone — those ops have no 2xx by design. Widened: ops
  // marked `deprecated:true` may declare 410 (or any 4xx) as their terminal
  // contract; all other ops still require 2xx or `default`.
  const bad = [];
  for (const p of Object.keys(OPENAPI.paths)) {
    for (const m of Object.keys(OPENAPI.paths[p])) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      const op = OPENAPI.paths[p][m];
      if (!op.summary) bad.push(`${m.toUpperCase()} ${p}: missing summary`);
      const responses = op.responses || {};
      const codes = Object.keys(responses);
      const hasSuccess = codes.some(c => /^2/.test(c) || c === 'default');
      const hasDeprecationTerminal = op.deprecated === true && codes.some(c => /^4/.test(c));
      if (!hasSuccess && !hasDeprecationTerminal) {
        bad.push(`${m.toUpperCase()} ${p}: no terminal response declared`);
      }
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
