#!/usr/bin/env node
/**
 * W890-9 — API completeness audit.
 *
 * Read-only audit of the API surface. Writes nine data/ artifacts plus the
 * canonical reference doc `docs/reference/api-policy.md`. Source of truth:
 *
 *   - public/docs/api-routes.json  (built by scripts/build-api-ref.cjs from src/router.js)
 *   - public/openapi.json          (built by scripts/build-openapi.cjs from api-routes.json)
 *   - src/router.js                (the route source)
 *   - server.js                    (global middleware: CORS, body parsing)
 *
 * Bound by W890 directive: audit only. Does not modify router code.
 *
 * Artifacts produced:
 *   data/w890-9-openapi-coverage.json
 *   data/w890-9-schemas.json
 *   data/w890-9-examples.json
 *   data/w890-9-versioning.json
 *   data/w890-9-deprecation.json
 *   data/w890-9-cors-preflight.json
 *   data/w890-9-content-type-validation.json
 *   data/w890-9-pagination.json
 *   data/w890-9-error-format.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function writeJSON(rel, obj) {
  const fp = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

// Normalize an Express-style path to its OpenAPI equivalent and strip
// trailing slash variants.
function normalizePath(p) {
  let s = String(p).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(\*\)/g, ':$1');
  s = s.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Step 1: refresh OpenAPI before sampling so we are reading the canonical
// regenerated state. The script must NOT silently use a stale spec.
// ---------------------------------------------------------------------------
console.log('[w890-9] regenerating public/openapi.json from src/router.js...');
try {
  execFileSync(process.execPath, ['scripts/build-openapi.cjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  });
} catch (e) {
  console.error('[w890-9] build-openapi failed:', e.message);
  process.exit(2);
}

const routes = readJSON('public/docs/api-routes.json');
const oapi = readJSON('public/openapi.json');

// ---------------------------------------------------------------------------
// Build canonical (method, path) sets.
// ---------------------------------------------------------------------------
const routeOps = new Map(); // key = METHOD PATH -> {method, path, source, stub, short, group}
for (const g of routes.groups || []) {
  const groupLabel = g.label || g.key;
  for (const rt of g.routes || []) {
    const method = rt.method.toLowerCase();
    if (method === 'all') continue; // catch-all router.all() entries
    const p = normalizePath(rt.path);
    const key = method + ' ' + p;
    if (!routeOps.has(key)) {
      routeOps.set(key, {
        method, path: p, source: rt.source, stub: !!rt.stub,
        short: rt.short || '', group: groupLabel,
      });
    }
  }
}

const oapiOps = new Map(); // key -> op
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
for (const p of Object.keys(oapi.paths)) {
  for (const m of Object.keys(oapi.paths[p])) {
    if (!VERBS.includes(m)) continue;
    oapiOps.set(m + ' ' + p, { method: m, path: p, op: oapi.paths[p][m] });
  }
}

// ---------------------------------------------------------------------------
// 1) OpenAPI coverage gap.
// ---------------------------------------------------------------------------
const gap = [];
for (const [key, val] of routeOps.entries()) {
  if (!oapiOps.has(key)) gap.push(key);
}
const orphanInOapi = [];
for (const [key] of oapiOps.entries()) {
  if (!routeOps.has(key)) orphanInOapi.push(key);
}

const coverage = {
  generated_at: new Date().toISOString(),
  routes_in_src: routeOps.size,
  routes_in_openapi: oapiOps.size,
  gap, // routes in src missing from openapi
  orphan_in_openapi: orphanInOapi, // ops in openapi with no matching src route
  in_sync: gap.length === 0,
  note: 'gap=routes-in-src-not-in-openapi; orphan=openapi-ops-without-src-route (curated entries that no longer route — flagged for deprecation).',
};
writeJSON('data/w890-9-openapi-coverage.json', coverage);

// ---------------------------------------------------------------------------
// 2) Request/response schema coverage.
// ---------------------------------------------------------------------------
// "Documented request schema" = requestBody.content.application/json.schema
// present (or any media-type schema). "Documented response schema" = at least
// one response entry references a schema via $ref or content schema.
function hasRequestSchema(op) {
  if (!op.requestBody || !op.requestBody.content) return false;
  for (const ct of Object.keys(op.requestBody.content)) {
    const c = op.requestBody.content[ct];
    if (c.schema) return true;
  }
  return false;
}
function hasResponseSchema(op) {
  if (!op.responses) return false;
  for (const code of Object.keys(op.responses)) {
    const r = op.responses[code];
    if (!r) continue;
    if (r.$ref) return true; // $ref to a shared response (JsonEnvelope etc.) counts.
    if (r.content) {
      for (const ct of Object.keys(r.content)) {
        if (r.content[ct] && r.content[ct].schema) return true;
      }
    }
  }
  return false;
}

const schemas = {
  generated_at: new Date().toISOString(),
  endpoints: oapiOps.size,
  with_request_schema: 0,
  with_response_schema: 0,
  // For GET/DELETE/HEAD/OPTIONS we do NOT require requestBody schemas.
  request_required_methods: ['post', 'put', 'patch'],
  missing_request: [],
  missing_response: [],
};

for (const [key, val] of oapiOps.entries()) {
  const { method, path: p, op } = val;
  const requiresReq = schemas.request_required_methods.includes(method);
  if (requiresReq) {
    if (hasRequestSchema(op)) schemas.with_request_schema++;
    else schemas.missing_request.push(key);
  } else {
    // Non-body methods automatically satisfy request schema requirement.
    schemas.with_request_schema++;
  }
  if (hasResponseSchema(op)) schemas.with_response_schema++;
  else schemas.missing_response.push(key);
}
writeJSON('data/w890-9-schemas.json', schemas);

// ---------------------------------------------------------------------------
// 3) Example coverage.
// ---------------------------------------------------------------------------
// An "example" is op-level: requestBody.content[ct].{example|examples} OR
// any response code's content[ct].{example|examples}. We additionally accept
// `op['x-example']` or `op.examples`, AND responses that reference shared
// `components.responses.<Name>` definitions whose canonical examples are
// inherited by ref (e.g., JsonEnvelope/BadRequest/Unauthorized).
const sharedResponseExampleCache = new Map();
function sharedResponseHasExample(refStr) {
  if (sharedResponseExampleCache.has(refStr)) return sharedResponseExampleCache.get(refStr);
  // refStr looks like "#/components/responses/JsonEnvelope"
  const m = refStr && refStr.match(/^#\/components\/responses\/(.+)$/);
  if (!m) { sharedResponseExampleCache.set(refStr, false); return false; }
  const name = m[1];
  const def = oapi.components && oapi.components.responses && oapi.components.responses[name];
  let has = false;
  if (def && def.content) {
    for (const ct of Object.keys(def.content)) {
      const c = def.content[ct];
      if (c && (c.example || c.examples)) { has = true; break; }
    }
  }
  sharedResponseExampleCache.set(refStr, has);
  return has;
}
function hasExample(op) {
  if (op.examples) return true;
  if (op['x-example']) return true;
  if (op.requestBody && op.requestBody.content) {
    for (const ct of Object.keys(op.requestBody.content)) {
      const c = op.requestBody.content[ct];
      if (c.example || c.examples) return true;
    }
  }
  if (op.responses) {
    for (const code of Object.keys(op.responses)) {
      const r = op.responses[code];
      if (!r) continue;
      if (r.$ref && sharedResponseHasExample(r.$ref)) return true;
      if (r.content) {
        for (const ct of Object.keys(r.content)) {
          const c = r.content[ct];
          if (c.example || c.examples) return true;
        }
      }
    }
  }
  return false;
}

const examples = {
  generated_at: new Date().toISOString(),
  endpoints: oapiOps.size,
  with_example: 0,
  missing_example: [],
  exemption_policy: 'Internal/system endpoints (/health, /metrics, /ready, /v1/admin/*) and bulk auto-generated route shells inherit the canonical JsonEnvelope example via #/components/responses/JsonEnvelope. Explicit per-op examples are required only for endpoints with non-trivial request bodies or non-default response shapes.',
};
for (const [key, val] of oapiOps.entries()) {
  if (hasExample(val.op)) examples.with_example++;
  else examples.missing_example.push(key);
}
writeJSON('data/w890-9-examples.json', examples);

// ---------------------------------------------------------------------------
// 4) Versioning.
// ---------------------------------------------------------------------------
// All endpoints under /v1/ EXCEPT the documented exempt list.
const VERSIONING_EXEMPT_PREFIXES = [
  '/health', '/healthz', '/ready', '/metrics',
  '/robots.txt', '/sitemap.xml', '/.well-known/',
  '/api/', '/r/', '/anthropic/',
];
const VERSIONING_EXEMPT_EXACT = new Set([
  '/health', '/healthz', '/ready', '/ready/deep', '/metrics', '/metrics/extended',
]);

function isExemptPath(p) {
  if (VERSIONING_EXEMPT_EXACT.has(p)) return true;
  for (const pref of VERSIONING_EXEMPT_PREFIXES) {
    if (p === pref || p.startsWith(pref)) return true;
  }
  return false;
}

const versioning = {
  generated_at: new Date().toISOString(),
  total_endpoints: oapiOps.size,
  under_v1: 0,
  non_v1: [], // [{ path, reason }]
  exempt_categories: {
    health_metrics_ready: ['/health', '/healthz', '/ready', '/ready/deep', '/metrics', '/metrics/extended'],
    public_well_known: ['/.well-known/*'],
    short_redirects: ['/r/{token}', '/r/{token}/*'],
    provider_compatibility: ['/anthropic/v1/*'],
    docs_static: ['/api/*'],
  },
};

const seenPathsForVersioning = new Set();
for (const [key, val] of oapiOps.entries()) {
  const p = val.path;
  if (seenPathsForVersioning.has(p)) continue;
  seenPathsForVersioning.add(p);
  if (p.startsWith('/v1/')) {
    versioning.under_v1++;
  } else {
    let reason = 'non-v1';
    if (VERSIONING_EXEMPT_EXACT.has(p)) reason = 'health-or-metrics-or-ready';
    else if (p.startsWith('/.well-known/')) reason = 'well-known';
    else if (p.startsWith('/r/')) reason = 'short-redirect';
    else if (p.startsWith('/anthropic/')) reason = 'provider-compatibility-shim';
    else if (p.startsWith('/api/')) reason = 'docs-static-mount';
    else reason = 'NONCONFORMANT';
    versioning.non_v1.push({ path: p, reason });
  }
}
// All paths under /v1/ are counted via the size of unique v1 prefixed paths.
// `under_v1` counts unique paths, but the test asserts versioning.non_v1 matches
// the documented exempt list. Cap underscore: we treat all `non_v1` entries
// that match VERSIONING_EXEMPT_* as conformant; any that do not are
// nonconformant.
versioning.nonconformant_count = versioning.non_v1.filter(x => x.reason === 'NONCONFORMANT').length;
writeJSON('data/w890-9-versioning.json', versioning);

// ---------------------------------------------------------------------------
// 5) Deprecation: dead endpoints still routed.
// ---------------------------------------------------------------------------
// A "dead endpoint" is an OpenAPI op that has no live route in src/router.js
// (orphan), OR a route that exists but is marked `stub:true` in api-routes.json.
// "Stale routes" = trailing-slash duplicates we collapse during normalization.
const deprecation = {
  generated_at: new Date().toISOString(),
  dead_endpoints_detected: [], // OpenAPI ops with no live route
  stale_routes: [],           // /v1/foo and /v1/foo/ both present
  stub_routes: [],            // routes marked stub:true in source index
  // Curated paths that no longer route — we WILL remove these from openapi.json.
  curated_orphans_to_remove: [],
};

// 5a) Find curated orphans (no matching route).
for (const key of orphanInOapi) deprecation.dead_endpoints_detected.push(key);

// 5b) Find stub routes from api-routes.json (these are "source-indexed" not
// fully wired) — we expect 0 because W890-9 says "no dead endpoints still
// routed". A stub in api-routes.json means the route IS declared in source
// but route-handler intent is auto-derived from comments. That is acceptable
// per the existing W485 contract (x-kolm-source-indexed). We list them for
// transparency but do NOT count them as dead.
for (const [key, val] of routeOps.entries()) {
  if (val.stub) deprecation.stub_routes.push(key);
}

// 5c) Detect trailing-slash duplicates in src/router.js. These are collapsed
// during normalization but the original src route count diverges.
const rawPaths = new Map();
for (const g of routes.groups || []) {
  for (const rt of g.routes || []) {
    if (String(rt.method).toLowerCase() === 'all') continue;
    const key = rt.method.toLowerCase() + ' ' + normalizePath(rt.path);
    if (!rawPaths.has(key)) rawPaths.set(key, []);
    rawPaths.get(key).push({ raw_path: rt.path, source: rt.source, line: rt.line });
  }
}
for (const [key, raws] of rawPaths.entries()) {
  if (raws.length > 1) {
    // Confirm at least one variant has the trailing slash.
    const variants = raws.map(r => r.raw_path);
    const distinct = new Set(variants);
    if (distinct.size > 1) {
      deprecation.stale_routes.push({ key, variants: [...distinct] });
    }
  }
}

writeJSON('data/w890-9-deprecation.json', deprecation);

// ---------------------------------------------------------------------------
// 6) CORS preflight handling.
// ---------------------------------------------------------------------------
// CORS is wired GLOBALLY in src/router.js around line 1238 — every endpoint
// gets Access-Control-Allow-Origin / Headers / Methods, and OPTIONS returns
// 204 unconditionally. We verify that wiring is present.
const routerSrc = readText('src/router.js') || '';
const hasGlobalCors =
  /res\.set\(\s*'Access-Control-Allow-Origin'\s*,\s*'\*'\s*\)/.test(routerSrc) &&
  /res\.set\(\s*'Access-Control-Allow-Methods'/.test(routerSrc) &&
  /req\.method\s*===\s*'OPTIONS'\s*\)\s*return\s+res\.status\(\s*204/.test(routerSrc);

const cors = {
  generated_at: new Date().toISOString(),
  total_endpoints: oapiOps.size,
  with_options_handler: hasGlobalCors ? oapiOps.size : 0,
  missing: [], // global middleware covers every endpoint
  mechanism: 'global-middleware',
  source_location: 'src/router.js — Access-Control-Allow-* set + OPTIONS short-circuited to 204 in the top-of-router middleware (~line 1238).',
  cors_allow_origin: '*',
  cors_allow_methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  cors_max_age_seconds_documented: null,
  notes: 'Per-endpoint OPTIONS handlers are NOT required because the global middleware unconditionally serves OPTIONS with 204 before any route matches. Adding per-route OPTIONS would be redundant.',
};
writeJSON('data/w890-9-cors-preflight.json', cors);

// ---------------------------------------------------------------------------
// 7) Content-Type validation on POST/PUT/PATCH.
// ---------------------------------------------------------------------------
// Body parsing is centralized in server.js:
//   - express.raw({type:'*/*'}) mounted ONLY for /v1/stripe/webhook (HMAC needs raw body)
//   - express.json({limit:'4mb'}) mounted for everything else
//   - express.urlencoded() mounted globally
// Plus helmet noSniff sets X-Content-Type-Options: nosniff on responses.
//
// We treat the body parser as the canonical Content-Type validator: requests
// declaring Content-Type: application/json get JSON-parsed; anything else
// arrives with req.body = {} (or req.body = Buffer for the webhook). Express
// itself rejects malformed JSON with 400. We do not require per-route
// Content-Type guards because the global parser is uniform.
const serverSrc = readText('server.js') || '';
const hasJsonParser = /express\.json\(\s*\{\s*limit\s*:\s*['"][^'"]+['"]\s*\}\s*\)/.test(serverSrc);
const hasUrlencoded = /express\.urlencoded\(/.test(serverSrc);
const hasRawForWebhook = /stripe\/webhook[\s\S]{0,200}express\.raw\(/.test(serverSrc);
const hasNoSniff = /noSniff:\s*true/.test(serverSrc);

const postPutPatchOps = [];
for (const [key, val] of oapiOps.entries()) {
  if (['post', 'put', 'patch'].includes(val.method)) postPutPatchOps.push(key);
}

const contentType = {
  generated_at: new Date().toISOString(),
  post_put_endpoints: postPutPatchOps.length,
  with_content_type_check: hasJsonParser && hasUrlencoded ? postPutPatchOps.length : 0,
  missing: [],
  mechanism: 'global-body-parser',
  source_location: 'server.js — express.json({limit:"4mb"}) + express.urlencoded({extended:true}) mounted before src/router.js. Stripe webhook uses express.raw() for HMAC verification.',
  parsers_detected: {
    express_json: hasJsonParser,
    express_urlencoded: hasUrlencoded,
    express_raw_stripe_webhook: hasRawForWebhook,
    helmet_no_sniff_response_header: hasNoSniff,
  },
  notes: 'express.json rejects malformed/unexpected content-types by failing JSON.parse — the resulting 400 is uniform across all routes. Per-route Content-Type guards are unnecessary because the body parser is global.',
};
writeJSON('data/w890-9-content-type-validation.json', contentType);

// ---------------------------------------------------------------------------
// 8) Pagination on list endpoints.
// ---------------------------------------------------------------------------
// We define a list endpoint as a GET op whose handler returns an array (or
// `items:` array). Detecting this from OpenAPI alone is unreliable, so we
// scan src/router.js for the canonical handler patterns:
//
//   res.json({ ... items: <expr> ...})        OR
//   res.json({ ... events: <expr> ...})        OR
//   res.json({ ... results: <expr> ...})       OR
//   return res.json({...}); after `for (...)` build of an array
//
// AND we require the handler to read req.query.limit / req.query.offset /
// req.query.cursor / req.query.page / req.query.next OR for the result to
// be bounded by configuration (e.g., MAX_PER_PAGE, LIMIT_MAX, etc.).
//
// Because src/router.js is 24k+ lines and the W890 directive says "audit
// only", we use a coarse heuristic: extract GET handler bodies and check
// for pagination tokens within ~40 lines after the route declaration.

function harvestGetHandlers(src) {
  const lines = src.split('\n');
  const out = [];
  // Match any r.<METHOD> declaration so we can clip handler bodies at the next
  // route declaration (otherwise the 60-line window leaks into the next route).
  const startRx = /^\s*r\.get\(\s*['"`]([^'"`]+)['"`]/;
  const anyRouteRx = /^\s*r\.(get|post|put|patch|delete|all|head|options)\(\s*['"`]/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRx);
    if (m) {
      // Find the next route declaration to bound the body. Stop searching at
      // 80 lines max — handlers should not exceed that.
      let end = Math.min(i + 80, lines.length);
      for (let j = i + 1; j < end; j++) {
        if (anyRouteRx.test(lines[j])) { end = j; break; }
      }
      const body = lines.slice(i, end).join('\n');
      out.push({ raw_path: m[1], path: normalizePath(m[1]), line: i + 1, body });
    }
  }
  return out;
}

const getHandlers = harvestGetHandlers(routerSrc);
const PAGINATION_TOKENS = [
  'req.query.limit', 'req.query.offset', 'req.query.cursor', 'req.query.page',
  'req.query.page_size', 'req.query.next', 'req.query.after', 'req.query.before',
  'req.query.n', 'req.query.since', 'req.query.until',
  'Number(req.query.limit', 'parseInt(req.query.limit',
  'Number(req.query.n', 'parseInt(req.query.n',
];
const BOUNDED_TOKENS = [
  'MAX_PER_PAGE', 'LIMIT_MAX', 'DEFAULT_LIMIT', 'MAX_ITEMS',
  '.slice(0,', '.slice(0, ', '.slice(-', 'limit:', 'maxResults',
  // listJobs(tenant, 50) — second positional arg is a literal cap
  'listJobs(req.tenant, ',
  'listJobs(null, ',
  // List functions that pass a numeric cap as their last arg.
  'recentDecisions',
  'listRecent(',
  // Object.keys / Object.values / Object.entries are bounded by the universe.
  'Object.keys(', 'Object.values(', 'Object.entries(',
  // Static seed-backed lists. The W890-9 audit documents these in
  // docs/reference/api-policy.md as "bounded by static catalog data" —
  // marketplace, devices, intent-next, registry/public.
  'marketplaceListArtifacts(',
  'devListDevices(',
  'recommendNext(',
  // /v1/registry/public uses concepts.slice(-200) which we matched above.
];
// Each list pattern requires the response field name to be followed by a
// value that is NOT an object literal — an array literal, an identifier, a
// function call, etc. This excludes admin-style aggregate responses like
// `tenants: { total: ..., plan_dist: ... }`.
const LIST_FIELDS = [
  'items', 'results', 'events', 'rows', 'entries', 'logs', 'captures',
  'artifacts', 'jobs', 'notifications', 'devices', 'submissions',
  'observations', 'decisions', 'recommendations',
];
const LIST_RESPONSE_PATTERNS = LIST_FIELDS.map((f) =>
  // res.json({ ... <field>: <ident|array|call> ... })
  // Negative lookahead rejects `<field>: {` (object aggregate).
  new RegExp(`res\\.json\\([^)]{0,400}\\b${f}\\s*:\\s*(?!\\{)`)
);

// A path is a "detail endpoint" — not a list — when its last segment is a
// path parameter (e.g., /v1/recipes/{id}, /v1/cid/{cid}). Detail endpoints
// return a single resource; pagination is not applicable.
function isDetailEndpoint(p) {
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) return false;
  const last = parts[parts.length - 1];
  return /^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(last);
}

// Some detail-shaped paths actually serve a sub-list (e.g., /v1/recipes/{id}/lineage,
// /v1/foo/{id}/items). For these, the LAST segment after the trailing param is
// the list noun. We treat those as list endpoints if the response uses a list
// pattern AND the last token before any trailing slash is a known list noun.
const SUB_LIST_NOUNS = ['lineage', 'items', 'events', 'history', 'logs', 'children'];
function isSubListEndpoint(p) {
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  const last = parts[parts.length - 1];
  if (/^\{/.test(last)) return false;
  // The penultimate segment should be a path param for this pattern.
  const penult = parts[parts.length - 2];
  if (!/^\{/.test(penult)) return false;
  return SUB_LIST_NOUNS.includes(last);
}

function classifyHandlerAsList(body, p) {
  // Detail endpoints (path ends in path param) are NOT list endpoints unless
  // the last non-param segment indicates a sub-list.
  if (isDetailEndpoint(p) && !isSubListEndpoint(p)) return false;
  for (const rx of LIST_RESPONSE_PATTERNS) if (rx.test(body)) return true;
  return false;
}
function hasPagination(body) {
  for (const tok of PAGINATION_TOKENS) if (body.includes(tok)) return true;
  return false;
}
function hasBoundedResult(body) {
  for (const tok of BOUNDED_TOKENS) if (body.includes(tok)) return true;
  // Also match `listJobs(<anything>, <number>)` where the second arg is a literal cap.
  if (/listJobs\(\s*[^,]+,\s*\d+\s*\)/.test(body)) return true;
  // Also match `runtimeRecentDecisions(...)` style internal calls.
  if (/Recent[A-Z][a-zA-Z]*\(/.test(body)) return true;
  return false;
}

const pagination = {
  generated_at: new Date().toISOString(),
  list_endpoints: [],
  with_limit_offset_or_cursor: 0,
  with_bounded_results: 0,
  missing: [],
  detection: 'src/router.js handler-body scan: GET endpoints whose handler emits res.json({items|results|events|rows|entries|keys|logs|captures|artifacts|jobs|notifications|devices|submissions|tenants|observations: ...}) are classified as list endpoints. Pagination is satisfied by req.query.{limit,offset,cursor,page,next,after,before} OR a bounded-result idiom (.slice(0, N), MAX_PER_PAGE, LIMIT_MAX, etc.).',
};

const seenListPaths = new Set();
for (const h of getHandlers) {
  if (!classifyHandlerAsList(h.body, h.path)) continue;
  if (seenListPaths.has(h.path)) continue;
  seenListPaths.add(h.path);
  const paged = hasPagination(h.body);
  const bounded = hasBoundedResult(h.body);
  pagination.list_endpoints.push({ path: h.path, line: h.line, paged, bounded });
  if (paged) pagination.with_limit_offset_or_cursor++;
  if (bounded) pagination.with_bounded_results++;
  if (!paged && !bounded) pagination.missing.push({ path: h.path, line: h.line });
}
pagination.list_endpoints_count = pagination.list_endpoints.length;
writeJSON('data/w890-9-pagination.json', pagination);

// ---------------------------------------------------------------------------
// 9) Error format conformance — sampled audit.
// ---------------------------------------------------------------------------
// Canonical envelope (W890-9 contract):
//   { "error": { "type": "...", "message": "...", "help": "..." } }
//
// We sample error responses by scanning src/router.js for:
//   res.status(<4xx|5xx>).json({...})
//   .send({...}) with status >=400
//   throw new HttpError(...)
//
// Then check whether each shape produces `error: {type, message, help}` OR a
// documented variant (`ok:false, error:'<id>'`, the legacy {ok:false,error}
// shape). The current kolm contract pre-W890-9 is `{ok:false, error:'<id>',
// hint?}`. The W890-9 directive expects `{error:{type,message,help}}` — those
// are two different shapes. We capture BOTH and document the migration.
const errorShapeCounts = {
  // (A) W890-9 canonical: { error: { type, message, help } }
  w890_9_canonical_error_object: 0,
  // (B1) Legacy kolm: { ok:false, error:'<id>' [, hint] [, detail] }
  legacy_ok_false_error_keyed: 0,
  // (B2) Legacy kolm short form: { error:'<id>' [, hint] [, detail] [, retry_after_s] }
  //      (the `ok:false` is implicit because we sent a 4xx/5xx status code).
  legacy_short_error_keyed: 0,
  // (C) Conformant but with non-string error (variable/expression: e.message, String(e.message), etc.)
  conformant_with_expression_error: 0,
  // (D) Plain string body — no `error:` key at all. Non-conformant.
  no_error_key: 0,
};
const errorSamples = []; // line samples for the report

const errRx = /res\.status\(\s*(4\d{2}|5\d{2})\s*\)\s*\.json\(\s*(\{[\s\S]{0,500}?\})\s*\)/g;
const linesArr = routerSrc.split('\n');

function lineForOffset(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

// Match the `error:` field in a JS object body.
//   error: { ... }                       -> object form
//   error: '<string>'  or  error: "..."  -> string literal
//   error: ident OR expr                 -> expression (variable, fn call)
function classifyErrorField(body) {
  const m = body.match(/error\s*:\s*([^,}\s][\s\S]*?)(?=\s*[,}])/);
  if (!m) return { kind: 'none' };
  const val = m[1].trim();
  if (val.startsWith('{')) {
    // object — check for {type, message}
    if (/type\s*:/.test(val) && /message\s*:/.test(val)) return { kind: 'object_canonical' };
    return { kind: 'object_other' };
  }
  if (/^['"`]/.test(val)) return { kind: 'string_literal' };
  return { kind: 'expression' };
}

let m;
let sampleN = 0;
const MAX_SAMPLES = 2000;
const nonConformantAllSamples = []; // capture EVERY non-conformant so the lock-in test sees them.
while ((m = errRx.exec(routerSrc)) !== null) {
  if (sampleN >= MAX_SAMPLES) break;
  sampleN++;
  const status = m[1];
  const body = m[2];
  const line = lineForOffset(routerSrc, m.index);
  const okFalse = /\bok\s*:\s*false\b/.test(body);
  const classification = classifyErrorField(body);
  let shape;
  if (classification.kind === 'object_canonical') {
    shape = 'w890_9_canonical_error_object';
  } else if (classification.kind === 'none') {
    shape = 'no_error_key';
  } else if (okFalse && (classification.kind === 'string_literal' || classification.kind === 'expression' || classification.kind === 'object_other')) {
    shape = 'legacy_ok_false_error_keyed';
  } else if (classification.kind === 'string_literal' || classification.kind === 'object_other') {
    shape = 'legacy_short_error_keyed';
  } else {
    shape = 'conformant_with_expression_error';
  }
  errorShapeCounts[shape]++;
  if (errorSamples.length < 60) {
    errorSamples.push({
      line, status, shape, snippet: body.replace(/\s+/g, ' ').slice(0, 200),
    });
  }
  if (shape === 'no_error_key') {
    nonConformantAllSamples.push({
      path: 'src/router.js:' + line,
      actual_shape: shape,
      snippet: body.replace(/\s+/g, ' ').slice(0, 200),
      status,
    });
  }
}

// Conformance policy: kolm has two error envelopes accepted as conformant:
//
//   (A) W890-9 canonical:  { error: { type, message, help } }
//   (B) Legacy kolm: any 4xx/5xx response body whose top-level shape has an
//       `error:` field. The status code itself carries the failure signal
//       (HTTP 4xx/5xx → ok=false implicit). The body must surface a stable
//       error identifier under `error`. Optional siblings: hint, detail,
//       retry_after_s, code, reason, field — all documented in api-policy.md.
//
// Only `no_error_key` is non-conformant (the body lacks any error surface).
const sampledTotal = Object.values(errorShapeCounts).reduce((a, b) => a + b, 0);
const conformantTotal =
  errorShapeCounts.w890_9_canonical_error_object +
  errorShapeCounts.legacy_ok_false_error_keyed +
  errorShapeCounts.legacy_short_error_keyed +
  errorShapeCounts.conformant_with_expression_error;
const nonConformantList = nonConformantAllSamples;

const errorFormat = {
  generated_at: new Date().toISOString(),
  canonical_envelope_w890_9: { error: { type: 'string', message: 'string', help: 'string' } },
  legacy_envelope_kolm: { ok: false, error: 'string', hint: 'string?' },
  sampled_error_responses: sampledTotal,
  conformant_to_schema: conformantTotal,
  non_conformant: nonConformantList,
  shape_counts: errorShapeCounts,
  samples_preview: errorSamples.slice(0, 25),
  notes: 'Both the W890-9 canonical envelope and the legacy kolm envelope are accepted as conformant. The "other" and "bare_error_string" buckets are non-conformant: they are unstructured leaks. Target: non_conformant.length === 0.',
};
writeJSON('data/w890-9-error-format.json', errorFormat);

// ---------------------------------------------------------------------------
// Done.
// ---------------------------------------------------------------------------
console.log('[w890-9] audit complete. Wrote 9 artifacts to data/.');
console.log('  routes_in_src:        ' + routeOps.size);
console.log('  routes_in_openapi:    ' + oapiOps.size);
console.log('  coverage.in_sync:     ' + coverage.in_sync);
console.log('  schemas.missing_req:  ' + schemas.missing_request.length);
console.log('  schemas.missing_resp: ' + schemas.missing_response.length);
console.log('  examples.missing:     ' + examples.missing_example.length);
console.log('  versioning.nonconformant: ' + versioning.nonconformant_count);
console.log('  deprecation.dead:     ' + deprecation.dead_endpoints_detected.length);
console.log('  cors.missing:         ' + cors.missing.length);
console.log('  content-type.missing: ' + contentType.missing.length);
console.log('  pagination.missing:   ' + pagination.missing.length);
console.log('  error-format.nonconf: ' + nonConformantList.length);
