#!/usr/bin/env node
// W485 P1-11 — sync public/openapi.json to live routes.
//
// Single source of truth: public/docs/api-routes.json (built by
// scripts/build-api-ref.cjs from src/router.js).
//
// What this does:
//   1. Loads api-routes.json and pulls every (method, path) tuple from every
//      group.
//   2. Merges the existing public/openapi.json so hand-curated rich operations
//      (e.g. /v1/auth/login with explicit request/response schemas) survive.
//   3. For routes NOT in the curated OpenAPI yet, emits a minimal but valid
//      Operation Object — tags, operationId, summary (from the route comment),
//      and a default response pointing at #/components/responses/JsonEnvelope.
//   4. Writes public/openapi.json with everything sorted deterministically.
//
// Re-run: `node scripts/build-openapi.cjs`. Lock-in test: wave485 (below).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API_ROUTES = path.join(ROOT, 'public', 'docs', 'api-routes.json');
const OUT = path.join(ROOT, 'public', 'openapi.json');

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function baseOpenapi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Kolm API',
      version: '1.0.0',
      description: 'HTTP contract for the kolm compiler. Auto-generated from src/router.js via scripts/build-openapi.cjs.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [
      { url: 'https://kolm.ai', description: 'Managed production' },
      { url: 'http://localhost:8080', description: 'Local dev (kolm serve)' },
    ],
    paths: {},
    components: {},
  };
}

function loadExistingOpenapi(p) {
  if (!fs.existsSync(p)) return baseOpenapi();
  try {
    return loadJson(p);
  } catch (err) {
    console.warn(`build-openapi: existing ${path.relative(ROOT, p)} is not valid JSON (${err.message}); rebuilding from route manifest`);
    return baseOpenapi();
  }
}

const routes = loadJson(API_ROUTES);
const existing = loadExistingOpenapi(OUT);

// Convert Express-style :param to OpenAPI {param}.
function publicRoutePath(p) {
  return String(p).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(\*\)/g, ':$1');
}

function openapiPath(p) {
  let s = publicRoutePath(p).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function extractPathParams(p) {
  const out = [];
  const rx = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  p = publicRoutePath(p);
  while ((m = rx.exec(p))) out.push(m[1]);
  return out;
}

function slugId(method, p) {
  // operationId: lower_camel-ish unique id, e.g. /v1/account/keys + POST -> postV1AccountKeys
  const parts = p.replace(/:/g, '').split('/').filter(Boolean);
  const cased = parts.map((x, i) => i === 0 ? x.toLowerCase() : x.charAt(0).toUpperCase() + x.slice(1));
  return method.toLowerCase() + cased.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '');
}

function summaryFor(route) {
  if (route.short && route.short.trim()) return route.short.trim().replace(/\s+/g, ' ').slice(0, 240);
  if (route.stub) return '(source-indexed route; contract generated from route source)';
  return route.path;
}

function descriptionFor(route) {
  const lines = (route.comments || []).map(s => String(s || '').trim()).filter(Boolean);
  if (!lines.length) return null;
  // Drop short repeats and keep up to 600 chars.
  let s = lines.join(' ').replace(/\s+/g, ' ');
  if (s.length > 600) s = s.slice(0, 597) + '...';
  return s;
}

function buildOperation(route, tagLabel) {
  const op = {
    tags: [tagLabel],
    operationId: slugId(route.method, route.path),
    summary: summaryFor(route),
  };
  const desc = descriptionFor(route);
  if (desc) op.description = desc;
  const params = extractPathParams(route.path);
  if (params.length) {
    op.parameters = params.map(name => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: name + ' path parameter',
    }));
  }
  if (route.stub) {
    op['x-kolm-source-indexed'] = true;
  }
  op.responses = {
    '200': { $ref: '#/components/responses/JsonEnvelope' },
    '400': { $ref: '#/components/responses/BadRequest' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '429': { $ref: '#/components/responses/RateLimited' },
    '500': { $ref: '#/components/responses/ServerError' },
  };
  return op;
}

const FORBIDDEN_ROUTE_FAMILY_STRINGS = [
  '/v1/*',
  '/v1/agents/*',
  '/v1/audio/*',
  '/v1/label-queue/*',
  '/v1/labels/*',
  '/v1/openrouter/*',
  '/v1/recipes/*',
];

function operationContainsForbiddenRouteFamily(op) {
  const text = JSON.stringify(op || {});
  return FORBIDDEN_ROUTE_FAMILY_STRINGS.some((family) => text.includes(family));
}

function operationContainsDecorativeSectionDivider(op) {
  const text = [
    op && op.summary,
    op && op.description,
  ].filter(Boolean).join(' ');
  return /={4,}/.test(text);
}

function operationHasStaleStubFlag(op, route) {
  return !!(op && op['x-kolm-stub'] && route);
}

function operationHasStaleUndocumentedFlag(op, route) {
  if (!op || !route) return false;
  if (op['x-kolm-undocumented']) return true;
  if (op['x-kolm-source-indexed'] && !route.stub) return true;
  // W511 #3: route just became stub:true but op still lacks the flag — must refresh.
  if (route.stub && !op['x-kolm-source-indexed']) return true;
  // W511 #3: stub op must use the canonical source-indexed summary.
  if (route.stub && op['x-kolm-source-indexed']) {
    const summary = String(op.summary || '');
    if (!/source-indexed route; contract generated from route source/.test(summary)) return true;
  }
  return false;
}

function operationContainsStaleDeviceCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/device')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /\bdevice\b/i.test(String(op.summary || '').trim()) && String(op.summary || '').trim().length <= 12
    || /devices\.html POSTs/i.test(text)
    || /without writing the heuristic/i.test(text);
}

function operationContainsStaleNotificationsCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/notifications')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /GET\s+\/v1\/notifications\/push-subscriptions/i.test(text)
    || /POST\s+\/v1\/notifications\/test\s+.*preview/i.test(text);
}

function operationContainsStaleAdminCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/admin')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /Admin console endpoints/i.test(text)
    || /\/v1\/admin\/tenants.*diagnostics/i.test(text)
    || /list waitlist \+ submissions for triage/i.test(text);
}

function operationContainsStaleTraceCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/trace')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /req\.tenant_record\.id down into trace-capture/i.test(text)
    || /pre-seeds the IR/i.test(text)
    || /Closes audit P1 Agent Trace cluster/i.test(text);
}

function operationContainsStaleAccountCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/account')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /ONE api_key_hash/i.test(text)
    || /multi-key was\s+never wired/i.test(text);
}

function operationContainsStaleFederatedCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/federated')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /GET\s+\/v1\/federated\/audit\?limit=N/i.test(text)
    || /POST\s+\/v1\/federated\/opt-in\s+\{scope/i.test(text);
}

function operationContainsStaleSpecialistsCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/specialists')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return (route.path === '/v1/specialists/waitlist' && String(op.summary || '').trim() === 'Specialists')
    || /\bW364\b/i.test(text)
    || /KOLM_TRAINER_BRIDGE_URL/i.test(text)
    || /legacy operator-managed cluster/i.test(text);
}

function operationContainsStaleKeysCopy(op, route) {
  if (!op || !route || !String(route.path || '').startsWith('/v1/keys')) return false;
  const text = [
    op.summary,
    op.description,
  ].filter(Boolean).join(' ');
  return /GET\s+\/v1\/keys\/public/i.test(text)
    || /\/v1\/keys\/challenge and POST \/v1\/keys\/register are also public/i.test(text)
    || /DELETE requires admin because key removal/i.test(text);
}

function refreshRouteDerivedFields(op, route, tagLabel) {
  const generated = buildOperation(route, tagLabel);
  op.summary = generated.summary;
  if (generated.description) op.description = generated.description;
  else delete op.description;
  delete op['x-kolm-stub'];
  delete op['x-kolm-undocumented'];
  if (generated['x-kolm-source-indexed']) op['x-kolm-source-indexed'] = true;
  else delete op['x-kolm-source-indexed'];
}

// Pull tag labels from api-routes.json
const tags = (routes.groups || []).map(g => ({
  name: (g.key || g.label || 'misc').toLowerCase(),
  description: g.label || g.key,
}));

function normalizeServers(list) {
  const servers = Array.isArray(list) && list.length
    ? list
    : [
        { url: 'https://kolm.ai', description: 'Managed production' },
        { url: 'http://localhost:8080', description: 'Local dev (kolm serve)' },
      ];
  return servers.map((server) => {
    if (server && typeof server.url === 'string' && /^https:\/\/api\./.test(server.url)) {
      const canonical = server.url.replace(/^https:\/\/api\./, 'https://');
      return { ...server, url: canonical };
    }
    return server;
  });
}

// Merge: keep any path in existing.paths verbatim (curated), add missing ones.
const merged = {
  openapi: existing.openapi || '3.0.3',
  info: existing.info || {
    title: 'Kolm API',
    version: '1.0.0',
    description: 'HTTP contract for the kolm compiler. Auto-generated from src/router.js via scripts/build-openapi.cjs.',
    license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  },
  servers: normalizeServers(existing.servers),
  tags: tags,
  paths: { ...(existing.paths || {}) },
  components: existing.components || {},
};

for (const p of Object.keys(merged.paths)) {
  if (p.includes('(*)')) delete merged.paths[p];
}

// Ensure shared response objects exist.
if (!merged.components) merged.components = {};
if (!merged.components.responses) merged.components.responses = {};
const RESPS = merged.components.responses;
function ensureResp(name, description) {
  if (!RESPS[name]) {
    RESPS[name] = {
      description,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/JsonEnvelope' },
        },
      },
    };
  }
}
ensureResp('JsonEnvelope', 'Standard {ok, ...} envelope. Successful 2xx responses share this shape unless overridden.');
ensureResp('BadRequest', '400 — input validation failed. body: { ok:false, error, hint }.');
ensureResp('Unauthorized', '401 — missing or invalid API key.');
ensureResp('RateLimited', '429 — per-tenant rate limit hit. Retry-After header included.');
ensureResp('ServerError', '500 — unexpected upstream error. The envelope describes the failure mode.');

// Ensure shared schema exists.
if (!merged.components.schemas) merged.components.schemas = {};
if (!merged.components.schemas.JsonEnvelope) {
  merged.components.schemas.JsonEnvelope = {
    type: 'object',
    description: 'Canonical envelope. Successful responses set ok=true; failures carry ok=false plus error/hint.',
    properties: {
      ok: { type: 'boolean' },
      error: { type: 'string', nullable: true },
      hint: { type: 'string', nullable: true },
    },
    additionalProperties: true,
    required: ['ok'],
  };
}

// Walk every route, populate merged.paths if missing.
let added = 0;
let skipped = 0;
let refreshed = 0;
for (const g of routes.groups || []) {
  const tagLabel = (g.key || g.label || 'misc').toLowerCase();
  for (const route of g.routes || []) {
    const oapiPath = openapiPath(route.path);
    const m = route.method.toLowerCase();
    if (!merged.paths[oapiPath]) merged.paths[oapiPath] = {};
    if (merged.paths[oapiPath][m]) {
      if (
        operationContainsForbiddenRouteFamily(merged.paths[oapiPath][m]) ||
        operationContainsDecorativeSectionDivider(merged.paths[oapiPath][m]) ||
        operationHasStaleStubFlag(merged.paths[oapiPath][m], route) ||
        operationHasStaleUndocumentedFlag(merged.paths[oapiPath][m], route) ||
        operationContainsStaleDeviceCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleNotificationsCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleAdminCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleTraceCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleAccountCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleFederatedCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleSpecialistsCopy(merged.paths[oapiPath][m], route) ||
        operationContainsStaleKeysCopy(merged.paths[oapiPath][m], route)
      ) {
        refreshRouteDerivedFields(merged.paths[oapiPath][m], route, tagLabel);
        refreshed++;
      }
      skipped++;
      continue;
    }
    merged.paths[oapiPath][m] = buildOperation(route, tagLabel);
    added++;
  }
}

// Backfill operationId on any curated path that does not have one. OpenAPI 3
// does not require operationId but code-generators do; keep the spec fully
// usable.
for (const [oapiPath, methods] of Object.entries(merged.paths)) {
  for (const [m, op] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(m)) continue;
    if (!op || op.operationId) continue;
    op.operationId = slugId(m, oapiPath.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1'));
  }
}

// Sort paths and methods for determinism.
const sortedPaths = {};
const pathKeys = Object.keys(merged.paths).sort();
for (const p of pathKeys) {
  const methods = merged.paths[p];
  const sorted = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
    if (methods[m]) sorted[m] = methods[m];
  }
  sortedPaths[p] = sorted;
}
merged.paths = sortedPaths;

// Write.
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n', 'utf8');

console.log('public/openapi.json updated:');
console.log('  total path entries: ' + Object.keys(merged.paths).length);
console.log('  ops added:          ' + added);
console.log('  ops kept (curated): ' + skipped);
console.log('  ops refreshed:      ' + refreshed);
console.log('  tags:               ' + (merged.tags ? merged.tags.length : 0));
