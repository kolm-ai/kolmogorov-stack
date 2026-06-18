#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API_ROUTES_PATH = path.join(ROOT, 'public', 'docs', 'api-routes.json');
const OPENAPI_PATH = path.join(ROOT, 'public', 'openapi.json');
const PRODUCT_GRAPH_PATH = path.join(ROOT, 'public', 'product-graph.json');
const PRODUCT_SURFACES_PATH = path.join(ROOT, 'docs', 'product-surfaces.json');
const PRODUCT_JOURNEYS_PATH = path.join(ROOT, 'docs', 'product-journeys.json');
const ROUTER_PATH = path.join(ROOT, 'src', 'router.js');

const SCHEMA = 'kolm.api_contract_matrix.v1';
const UPDATED_AT = '2026-06-18';
const OPENAPI_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const BODY_VERBS = new Set(['post', 'put', 'patch']);
const MUTATING_VERBS = new Set(['post', 'put', 'patch', 'delete']);

const sourceCache = new Map();
let routerGlobalAuthLineCache = null;
let moduleMountLinesCache = null;

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function sourceText(source) {
  const rel = String(source || '').replace(/\\/g, '/');
  if (!sourceCache.has(rel)) {
    const abs = path.join(ROOT, rel);
    sourceCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
  }
  return sourceCache.get(rel);
}

function sourceLines(source) {
  return sourceText(source).split(/\r?\n/);
}

function sourceLine(route) {
  const lines = sourceLines(route.source);
  const idx = Number(route.line) - 1;
  return idx >= 0 && idx < lines.length ? lines[idx] : '';
}

function lineNumberFromIndex(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicRoutePath(p) {
  return String(p || '').replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(\*\)/g, ':$1');
}

function openapiPath(p) {
  let s = publicRoutePath(p).replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function expressPathFromOpenapi(p) {
  let s = String(p || '').replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function routeKey(method, routePath) {
  return `${String(method || '').toUpperCase()} ${String(routePath || '')}`;
}

function operationKey(method, expressPath) {
  return routeKey(method, expressPath);
}

function canonicalOperationPath(routePath) {
  return expressPathFromOpenapi(openapiPath(routePath));
}

function routeOperationKey(route) {
  return operationKey(route.method, canonicalOperationPath(route.path));
}

function flattenApiRoutes(apiRoutes) {
  const rows = [];
  for (const group of apiRoutes.groups || []) {
    const groupKey = String(group.key || group.label || 'misc').toLowerCase();
    const groupLabel = group.label || group.key || groupKey;
    for (const route of group.routes || []) {
      const method = String(route.method || '').toUpperCase();
      const routePath = String(route.path || '');
      rows.push({
        ...route,
        method,
        path: routePath,
        route_key: routeKey(method, routePath),
        operation_key: operationKey(method, canonicalOperationPath(routePath)),
        group_key: groupKey,
        group_label: groupLabel,
      });
    }
  }
  return rows;
}

function extractOpenapiOperations(openapi) {
  const map = new Map();
  const rows = [];
  for (const [oapiPath, methods] of Object.entries(openapi.paths || {})) {
    for (const [method, op] of Object.entries(methods || {})) {
      const m = String(method || '').toLowerCase();
      if (!OPENAPI_VERBS.has(m)) continue;
      const expressPath = expressPathFromOpenapi(oapiPath);
      const key = operationKey(m, expressPath);
      const row = {
        key,
        method: m.toUpperCase(),
        path: expressPath,
        openapi_path: oapiPath,
        operation: op,
      };
      rows.push(row);
      map.set(key, row);
    }
  }
  return { map, rows };
}

function routerGlobalAuthLine() {
  if (routerGlobalAuthLineCache != null) return routerGlobalAuthLineCache;
  const lines = sourceLines('src/router.js');
  const idx = lines.findIndex((line) => /r\.use\(\s*authMiddleware\s*\)/.test(line));
  routerGlobalAuthLineCache = idx >= 0 ? idx + 1 : 0;
  return routerGlobalAuthLineCache;
}

function parseModuleMountLines() {
  if (moduleMountLinesCache) return moduleMountLinesCache;
  const routerSrc = sourceText('src/router.js');
  const imports = [];
  const importRx = /^\s*import\s+\{\s*([^}]+?)\s*\}\s+from\s+['"]\.\/([^'"]+\.js)['"];?/gm;
  let m;
  while ((m = importRx.exec(routerSrc))) {
    const source = `src/${m[2]}`;
    const names = [];
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      const mm = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) names.push(mm[2] || mm[1]);
    }
    imports.push({ source, names });
  }

  const out = new Map();
  for (const row of imports) {
    const callLines = [];
    for (const name of row.names) {
      const rx = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
      let cm;
      while ((cm = rx.exec(routerSrc))) {
        const before = routerSrc.slice(Math.max(0, cm.index - 20), cm.index);
        if (/import\s+\{/.test(before)) continue;
        callLines.push(lineNumberFromIndex(routerSrc, cm.index));
      }
    }
    if (callLines.length) out.set(row.source, Math.min(...callLines));
  }
  moduleMountLinesCache = out;
  return out;
}

function moduleMountLine(source) {
  return parseModuleMountLines().get(String(source || '').replace(/\\/g, '/')) || 0;
}

function findRouteBlock(route) {
  const text = sourceText(route.source);
  if (!text) return '';
  const method = String(route.method || '').toLowerCase();
  const routePath = String(route.path || '');
  const needles = [`'${routePath}'`, `"${routePath}"`, `\`${routePath}\``];
  let start = -1;
  for (const needle of needles) {
    let idx = text.indexOf(needle);
    while (idx >= 0) {
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const prefix = text.slice(lineStart, idx);
      const prefixWindow = text.slice(Math.max(0, idx - 160), idx);
      const routeCall = new RegExp(`\\.(?:${escapeRegExp(method)}|all)\\s*\\(`);
      if (routeCall.test(prefix) || routeCall.test(prefixWindow)) {
        start = lineStart;
        break;
      }
      idx = text.indexOf(needle, idx + needle.length);
    }
    if (start >= 0) break;
  }

  if (start < 0 && Number(route.line) > 0) {
    const lines = text.split(/\r?\n/);
    const from = Math.max(0, Number(route.line) - 25);
    const to = Math.min(lines.length, Number(route.line) + 80);
    return lines.slice(from, to).join('\n');
  }

  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n\s*(?:r|router|app)\.(?:get|post|put|patch|delete|all)\s*\(/);
  const end = next >= 0 ? start + 1 + next : text.length;
  return text.slice(start, end);
}

function hasExplicitRouteAuth(block) {
  return /(^|[,\s(])(?:auth|authMiddleware|requireAuth)(?=[,\s)])/m.test(block)
    || /\bdeps\.authMiddleware\b/.test(block)
    || /\bauth_required\b/.test(block)
    || /\breq\.tenant_record\b/.test(block);
}

function securityRequirementFor(level) {
  if (level === 'public') return [];
  return [{ bearerAuth: [] }, { apiKeyAuth: [] }];
}

function classifyRouteSecurity(route) {
  const source = String(route.source || '').replace(/\\/g, '/');
  const line = Number(route.line) || 0;
  const block = findRouteBlock(route);
  const globalAuthLine = routerGlobalAuthLine();
  const lineText = sourceLine(route);

  let level = 'public';
  let proof = 'public route surface';

  if (source === 'src/router.js') {
    if (hasExplicitRouteAuth(lineText) || hasExplicitRouteAuth(block.split(/\r?\n/).slice(0, 3).join('\n'))) {
      level = 'authenticated';
      proof = `${source}:${line} carries route-local auth middleware`;
    } else if (globalAuthLine > 0 && line > globalAuthLine) {
      level = 'authenticated';
      proof = `${source}:${line} is mounted after r.use(authMiddleware) at line ${globalAuthLine}`;
    } else {
      level = 'public';
      proof = `${source}:${line} is mounted before r.use(authMiddleware) at line ${globalAuthLine}`;
    }
  } else {
    const mountLine = moduleMountLine(source);
    if (mountLine > 0 && globalAuthLine > 0 && mountLine > globalAuthLine) {
      level = 'authenticated';
      proof = `${source} is registered from src/router.js:${mountLine} after r.use(authMiddleware) at line ${globalAuthLine}`;
    } else if (hasExplicitRouteAuth(block) || hasExplicitRouteAuth(lineText)) {
      level = 'authenticated';
      proof = `${source}:${line} carries route-local auth or tenant guard`;
    } else if (mountLine > 0) {
      level = 'public';
      proof = `${source} is registered from src/router.js:${mountLine} before r.use(authMiddleware) at line ${globalAuthLine}`;
    } else {
      level = 'public';
      proof = `${source}:${line} has no detected parent or route-local auth gate`;
    }
  }

  return {
    level,
    openapi_security: securityRequirementFor(level),
    proof,
  };
}

function buildProductMaps() {
  const surfacesDoc = readJson(PRODUCT_SURFACES_PATH);
  const productGraph = readJson(PRODUCT_GRAPH_PATH);
  const journeysDoc = fs.existsSync(PRODUCT_JOURNEYS_PATH) ? readJson(PRODUCT_JOURNEYS_PATH) : { journeys: [] };
  const surfaceByGroup = new Map();
  const surfaceByPrimaryPath = new Map();
  const surfaceRows = [];

  const surfaces = Array.isArray(surfacesDoc.surfaces) ? surfacesDoc.surfaces : [];
  for (const surface of surfaces) {
    const row = {
      id: surface.id,
      name: surface.name,
      status: surface.status || 'unknown',
      claim_scope: 'surface-certified',
    };
    surfaceRows.push(row);
    for (const group of surface.route_groups || []) {
      const key = String(group).toLowerCase();
      if (!surfaceByGroup.has(key)) surfaceByGroup.set(key, []);
      surfaceByGroup.get(key).push(row);
    }
    for (const primaryPath of surface.primary_paths || []) {
      const key = String(primaryPath).replace(/\?.*$/, '');
      if (!surfaceByPrimaryPath.has(key)) surfaceByPrimaryPath.set(key, []);
      surfaceByPrimaryPath.get(key).push(row);
    }
  }

  const journeyByRoute = new Map();
  const journeyRows = [];
  const journeys = Array.isArray(productGraph.journeys) ? productGraph.journeys
    : Array.isArray(journeysDoc.journeys) ? journeysDoc.journeys : [];
  for (const journey of journeys) {
    const row = {
      id: journey.id,
      name: journey.name || journey.id,
      surface: journey.surface || null,
      stage: journey.stage || null,
    };
    journeyRows.push(row);
    for (const api of journey.api || []) {
      const key = String(api).replace(/\?.*$/, '');
      if (!journeyByRoute.has(key)) journeyByRoute.set(key, []);
      journeyByRoute.get(key).push(row);
    }
  }

  return {
    surfaces: surfaceRows,
    surfaceByGroup,
    surfaceByPrimaryPath,
    journeys: journeyRows,
    journeyByRoute,
  };
}

function uniqueRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = row && row.id ? row.id : JSON.stringify(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

function hasRequestSchema(op) {
  if (!op || !op.requestBody || !op.requestBody.content) return false;
  return Object.values(op.requestBody.content).some((content) => content && content.schema);
}

function hasResponseSchema(op) {
  if (!op || !op.responses) return false;
  for (const response of Object.values(op.responses)) {
    if (!response) continue;
    if (response.$ref) return true;
    if (response.content && Object.values(response.content).some((content) => content && content.schema)) return true;
  }
  return false;
}

function hasOperationSecurity(op) {
  return !!op && Object.prototype.hasOwnProperty.call(op, 'security');
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function inferIdempotency(route, block) {
  const method = String(route.method || '').toLowerCase();
  if (['get', 'head', 'options'].includes(method)) return 'not_required_read_only';
  const text = `${(route.comments || []).join(' ')} ${block || ''}`.toLowerCase();
  if (/idempotenc|x-idempotency-key|idempotent/.test(text)) return 'supported_or_explicit';
  return 'unspecified_mutation';
}

function inferStateModel(route, block) {
  const method = String(route.method || '').toLowerCase();
  if (['get', 'head', 'options'].includes(method)) return 'read_only';
  const text = `${(route.comments || []).join(' ')} ${block || ''}`.toLowerCase();
  if (/append|write|persist|store|insert|update|delete|purge|enqueue|queue|charge|billing|payout|promote|create|save/.test(text)) {
    return 'stateful_mutation';
  }
  return 'compute_or_validate';
}

function buildApiContractMatrix() {
  const apiRoutes = readJson(API_ROUTES_PATH);
  const openapi = readJson(OPENAPI_PATH);
  const routes = flattenApiRoutes(apiRoutes);
  const { map: openapiOps, rows: openapiRows } = extractOpenapiOperations(openapi);
  const productMaps = buildProductMaps();

  const routeOperationMap = new Map();
  const duplicateRouteKeys = [];
  const routeKeyCounts = new Map();
  for (const route of routes) {
    routeKeyCounts.set(route.route_key, (routeKeyCounts.get(route.route_key) || 0) + 1);
    if (route.method.toLowerCase() === 'all') continue;
    if (!routeOperationMap.has(route.operation_key)) routeOperationMap.set(route.operation_key, route);
  }
  for (const [key, count] of routeKeyCounts.entries()) {
    if (count > 1) duplicateRouteKeys.push({ route_key: key, rows: count });
  }

  const productJourneyRouteMisses = [];
  for (const [key, journeys] of productMaps.journeyByRoute.entries()) {
    if (!routeKeyCounts.has(key)) {
      productJourneyRouteMisses.push({ route_key: key, journeys: journeys.map((j) => j.id).sort() });
    }
  }

  const missingOpenapiOps = [];
  for (const key of [...routeOperationMap.keys()].sort()) {
    if (!openapiOps.has(key)) missingOpenapiOps.push(key);
  }
  const orphanOpenapiOps = [];
  for (const key of [...openapiOps.keys()].sort()) {
    if (!routeOperationMap.has(key)) orphanOpenapiOps.push(key);
  }

  const groupRows = new Map();
  const routeRows = [];
  let publicRoutes = 0;
  let authenticatedRoutes = 0;
  let unknownSecurityRoutes = 0;
  let mutatingRoutes = 0;
  let mutatingWithoutRequestBody = 0;
  let responseContractGaps = 0;
  let openapiSecurityMissing = 0;
  let openapiSecurityMismatches = 0;
  let unownedRoutes = 0;
  let skippedOpenapiRoutes = 0;

  for (const route of routes) {
    const methodLower = route.method.toLowerCase();
    const openapiApplicable = methodLower !== 'all';
    const opRow = openapiApplicable ? openapiOps.get(route.operation_key) : null;
    const op = opRow && opRow.operation;
    const block = findRouteBlock(route);
    const security = classifyRouteSecurity(route);
    const groupSurfaces = productMaps.surfaceByGroup.get(route.group_key) || [];
    const pathSurfaces = productMaps.surfaceByPrimaryPath.get(route.path) || [];
    const productSurfaces = uniqueRows([...groupSurfaces, ...pathSurfaces]);
    const productJourneys = uniqueRows(productMaps.journeyByRoute.get(route.route_key) || []);
    const requestRequired = BODY_VERBS.has(methodLower);
    const requestSchemaPresent = !requestRequired || hasRequestSchema(op);
    const responseSchemaPresent = !openapiApplicable || hasResponseSchema(op);
    const securityPresent = !openapiApplicable || hasOperationSecurity(op);
    const securityMatches = !openapiApplicable || (op && jsonEqual(op.security, security.openapi_security));

    if (security.level === 'public') publicRoutes++;
    else if (security.level === 'authenticated') authenticatedRoutes++;
    else unknownSecurityRoutes++;

    if (MUTATING_VERBS.has(methodLower)) mutatingRoutes++;
    if (openapiApplicable && requestRequired && !requestSchemaPresent) mutatingWithoutRequestBody++;
    if (openapiApplicable && !responseSchemaPresent) responseContractGaps++;
    if (openapiApplicable && !securityPresent) openapiSecurityMissing++;
    if (openapiApplicable && !securityMatches) openapiSecurityMismatches++;
    if (!productSurfaces.length) unownedRoutes++;
    if (!openapiApplicable) skippedOpenapiRoutes++;

    const routeRow = {
      method: route.method,
      path: route.path,
      route_key: route.route_key,
      operation_key: route.operation_key,
      source: route.source || null,
      line: Number(route.line) || null,
      group_key: route.group_key,
      group_label: route.group_label,
      openapi_applicable: openapiApplicable,
      openapi_path: openapiApplicable ? openapiPath(route.path) : null,
      openapi_present: !!op,
      operation_id: op && op.operationId ? op.operationId : null,
      security: {
        level: security.level,
        openapi_security: security.openapi_security,
        openapi_security_present: securityPresent,
        openapi_security_matches_source: securityMatches,
        proof: security.proof,
      },
      request_contract: {
        required: requestRequired,
        schema_present: requestSchemaPresent,
        idempotency: inferIdempotency(route, block),
      },
      response_contract: {
        schema_present: responseSchemaPresent,
      },
      product_surfaces: productSurfaces,
      product_journeys: productJourneys,
      state_model: inferStateModel(route, block),
      claim_scope: productSurfaces.some((surface) => surface.claim_scope === 'surface-certified')
        ? 'surface-certified'
        : 'source-indexed',
    };
    routeRows.push(routeRow);

    if (!groupRows.has(route.group_key)) {
      groupRows.set(route.group_key, {
        group_key: route.group_key,
        group_label: route.group_label,
        routes: 0,
        openapi_operations: 0,
        public_routes: 0,
        authenticated_routes: 0,
        product_surfaces: productSurfaces,
      });
    }
    const group = groupRows.get(route.group_key);
    group.routes += 1;
    if (op) group.openapi_operations += 1;
    if (security.level === 'public') group.public_routes += 1;
    if (security.level === 'authenticated') group.authenticated_routes += 1;
    group.product_surfaces = uniqueRows([...(group.product_surfaces || []), ...productSurfaces]);
  }

  const groupSurfaceMisses = [...groupRows.values()]
    .filter((group) => !group.product_surfaces.length)
    .map((group) => group.group_key)
    .sort();

  const summary = {
    manifest_route_rows: routes.length,
    unique_route_keys: routeKeyCounts.size,
    operation_route_count: routeOperationMap.size,
    openapi_operation_count: openapiRows.length,
    route_groups: groupRows.size,
    product_surfaces: productMaps.surfaces.length,
    product_journeys: productMaps.journeys.length,
    public_routes: publicRoutes,
    authenticated_routes: authenticatedRoutes,
    unknown_security_routes: unknownSecurityRoutes,
    skipped_openapi_routes: skippedOpenapiRoutes,
    duplicate_route_keys: duplicateRouteKeys.length,
    mutating_routes: mutatingRoutes,
    mutating_without_request_body: mutatingWithoutRequestBody,
    response_contract_gaps: responseContractGaps,
    openapi_security_missing: openapiSecurityMissing,
    openapi_security_mismatches: openapiSecurityMismatches,
    unowned_routes: unownedRoutes,
    product_journey_route_misses: productJourneyRouteMisses.length,
    missing_openapi_ops: missingOpenapiOps.length,
    orphan_openapi_ops: orphanOpenapiOps.length,
  };

  const failures = [];
  const warnings = [];
  if (summary.missing_openapi_ops) failures.push({ gate: 'openapi_coverage', count: summary.missing_openapi_ops, sample: missingOpenapiOps.slice(0, 10) });
  if (summary.orphan_openapi_ops) failures.push({ gate: 'openapi_orphans', count: summary.orphan_openapi_ops, sample: orphanOpenapiOps.slice(0, 10) });
  if (summary.unknown_security_routes) failures.push({ gate: 'route_security_unknown', count: summary.unknown_security_routes });
  if (summary.openapi_security_missing) failures.push({ gate: 'openapi_security_missing', count: summary.openapi_security_missing });
  if (summary.openapi_security_mismatches) failures.push({ gate: 'openapi_security_mismatch', count: summary.openapi_security_mismatches });
  if (summary.mutating_without_request_body) failures.push({ gate: 'mutating_request_contract', count: summary.mutating_without_request_body });
  if (summary.response_contract_gaps) failures.push({ gate: 'response_contract', count: summary.response_contract_gaps });
  if (summary.unowned_routes) failures.push({ gate: 'product_surface_ownership', count: summary.unowned_routes });
  if (summary.product_journey_route_misses) failures.push({ gate: 'product_journey_route_refs', count: summary.product_journey_route_misses, sample: productJourneyRouteMisses.slice(0, 10) });
  if (groupSurfaceMisses.length) failures.push({ gate: 'route_group_surface_ownership', count: groupSurfaceMisses.length, sample: groupSurfaceMisses.slice(0, 10) });
  if (duplicateRouteKeys.length) warnings.push({ gate: 'duplicate_manifest_route_rows', count: duplicateRouteKeys.length, sample: duplicateRouteKeys.slice(0, 10) });
  if (summary.skipped_openapi_routes) warnings.push({ gate: 'non_openapi_router_all_rows', count: summary.skipped_openapi_routes });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    sources: [
      'public/docs/api-routes.json',
      'public/openapi.json',
      'public/product-graph.json',
      'docs/product-surfaces.json',
      'docs/product-journeys.json',
      'src/router.js',
    ],
    summary,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings,
    },
    openapi_security_schemes_required: ['bearerAuth', 'apiKeyAuth'],
    duplicate_route_keys: duplicateRouteKeys.sort((a, b) => a.route_key.localeCompare(b.route_key)),
    skipped_openapi_routes: routeRows
      .filter((route) => !route.openapi_applicable)
      .map((route) => ({ route_key: route.route_key, source: route.source, line: route.line })),
    missing_openapi_ops: missingOpenapiOps,
    orphan_openapi_ops: orphanOpenapiOps,
    product_journey_route_misses: productJourneyRouteMisses.sort((a, b) => a.route_key.localeCompare(b.route_key)),
    route_groups: [...groupRows.values()].sort((a, b) => a.group_key.localeCompare(b.group_key)),
    routes: routeRows.sort((a, b) => a.route_key.localeCompare(b.route_key) || String(a.source).localeCompare(String(b.source))),
  };
}

module.exports = {
  API_ROUTES_PATH,
  OPENAPI_PATH,
  PRODUCT_GRAPH_PATH,
  PRODUCT_JOURNEYS_PATH,
  PRODUCT_SURFACES_PATH,
  ROOT,
  ROUTER_PATH,
  SCHEMA,
  UPDATED_AT,
  buildApiContractMatrix,
  canonicalOperationPath,
  classifyRouteSecurity,
  expressPathFromOpenapi,
  extractOpenapiOperations,
  flattenApiRoutes,
  openapiPath,
  routeKey,
  routeOperationKey,
  stableStringify,
};
