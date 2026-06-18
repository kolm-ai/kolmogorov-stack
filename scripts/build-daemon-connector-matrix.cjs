#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'daemon-connector-matrix.json');
const SCHEMA = 'kolm.daemon_connector_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

function lineNumber(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function extractExports(src) {
  const functions = [...src.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({ name: m[1], kind: 'function', line: lineNumber(src, m.index) }));
  const constants = [...src.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({ name: m[1], kind: 'const', line: lineNumber(src, m.index) }));
  return [...functions, ...constants].sort((a, b) => a.name.localeCompare(b.name));
}

function requiredExports() {
  return [
    'resolveUpstreamKey',
    'buildDaemonApp',
    'startDaemon',
    'stopDaemon',
    'daemonStatus',
    '_internals',
  ];
}

function extractProviderRegistryIds(src) {
  const blockMatch = src.match(/export const PROVIDERS = \{([\s\S]*?)\n\};/);
  if (!blockMatch) return [];
  const ids = [];
  const block = blockMatch[1];
  for (const m of block.matchAll(/^  (?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*)):\s*\{/gm)) {
    ids.push(m[1] || m[2] || m[3]);
  }
  return [...new Set(ids)].sort();
}

function extractSupportedProviderIds(src) {
  const blockMatch = src.match(/export const SUPPORTED_PROVIDER_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!blockMatch) return [];
  return [...blockMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
}

function routeKind(pathValue) {
  if (pathValue === '/v1/health' || pathValue === '/health') return 'health_probe';
  if (pathValue === '/v1/models') return 'model_catalog';
  if (pathValue.includes('openrouter')) return 'openrouter_alias';
  if (pathValue.includes('anthropic') || pathValue === '/v1/messages') return 'anthropic_compat';
  if (pathValue.includes('v1beta')) return 'gemini_compat';
  return 'openai_compat';
}

function extractRoutes(src) {
  const routes = [];
  const openAiLoop = /for \(const p of \[([\s\S]*?)\]\) \{\s*app\.post\(p, \(req, res\) => handlePassthrough\('openai', p, req, res\)\);/m.exec(src);
  if (openAiLoop) {
    for (const m of openAiLoop[1].matchAll(/['"]([^'"]+)['"]/g)) {
      routes.push({
        method: 'POST',
        path: m[1],
        provider: 'openai',
        upstream_path: m[1],
        kind: routeKind(m[1]),
        line: lineNumber(src, openAiLoop.index + m.index),
      });
    }
  }

  for (const m of src.matchAll(/app\.post\('([^']+)', \(req, res\) => handlePassthrough\('([^']+)', '([^']+)', req, res\)\)/g)) {
    routes.push({
      method: 'POST',
      path: m[1],
      provider: m[2],
      upstream_path: m[3],
      kind: routeKind(m[1]),
      line: lineNumber(src, m.index),
    });
  }

  for (const line of src.split(/\r?\n/)) {
    if (!line.includes('app.post(/^')) continue;
    const idx = src.indexOf(line);
    const routeExpr = line.slice(line.indexOf('app.post(') + 'app.post('.length, line.indexOf(', (req'));
    routes.push({
      method: 'POST',
      path: routeExpr,
      provider: 'gemini',
      upstream_path: 'req.path + query',
      kind: 'gemini_compat',
      line: lineNumber(src, idx),
    });
  }

  for (const m of src.matchAll(/(?:^|\s)app\.get\('([^']+)',/g)) {
    routes.push({
      method: 'GET',
      path: m[1],
      provider: 'daemon',
      upstream_path: null,
      kind: routeKind(m[1]),
      line: lineNumber(src, m.index),
    });
  }

  const seen = new Set();
  return routes
    .filter((row) => {
      const key = `${row.method} ${row.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path));
}

function groupRoutes(routes) {
  const groups = {};
  for (const route of routes) {
    const key = route.provider;
    groups[key] ||= { provider: key, route_count: 0, paths: [] };
    groups[key].route_count += 1;
    groups[key].paths.push(route.path);
  }
  return Object.values(groups)
    .map((row) => ({ ...row, paths: row.paths.sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function extractFixtureShapes(src) {
  const rows = [];
  const fixtureIdx = src.indexOf('function fixtureBody');
  if (fixtureIdx < 0) return rows;
  const blockEnd = src.indexOf('// The HEAVY lifting', fixtureIdx);
  const block = blockEnd > fixtureIdx ? src.slice(fixtureIdx, blockEnd) : src.slice(fixtureIdx);
  if (block.includes("provider === 'anthropic'")) {
    rows.push({ provider: 'anthropic', upstream_path: '/v1/messages', shape: 'message' });
  }
  for (const m of block.matchAll(/upstreamPath === '([^']+)'/g)) {
    rows.push({ provider: 'openai', upstream_path: m[1], shape: shapeForPath(m[1]) });
  }
  rows.push({ provider: 'openai', upstream_path: '/v1/chat/completions', shape: 'chat.completion' });
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.provider}:${row.upstream_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.upstream_path.localeCompare(b.upstream_path));
}

function shapeForPath(pathValue) {
  if (pathValue.includes('embedding')) return 'embedding.list';
  if (pathValue.includes('transcription') || pathValue.includes('translation')) return 'transcription';
  if (pathValue.includes('speech')) return 'audio.speech';
  if (pathValue.includes('moderation')) return 'moderation';
  if (pathValue.includes('responses')) return 'response';
  return 'chat.completion';
}

function safetyGuards(src) {
  const catchIdx = src.indexOf('} catch (e) {');
  const zeroRetentionIdx = src.indexOf('if (zeroRetention) {');
  const modelsIdx = src.indexOf("app.get('/v1/models'");
  const modelsBlock = modelsIdx >= 0 ? src.slice(modelsIdx, src.indexOf('return { app, getTotal', modelsIdx)) : '';
  const errorBlock = catchIdx >= 0 ? src.slice(catchIdx, src.indexOf('let respText = extractCompletionText', catchIdx)) : '';
  const zeroRetentionBlock = zeroRetentionIdx >= 0 ? src.slice(zeroRetentionIdx, zeroRetentionIdx + 400) : '';
  return {
    x_powered_by_disabled: src.includes("app.disable('x-powered-by')"),
    body_limit_8mb: src.includes("express.json({ limit: '8mb' })"),
    cors_preflight_204: src.includes("if (req.method === 'OPTIONS') return res.status(204).end()"),
    missing_credentials_401: src.includes('missing_upstream_credentials') && src.includes('status: 401'),
    privacy_block_451: src.includes("policy === 'block'") && src.includes('status: 451'),
    fail_closed_error_path_redacts: errorBlock.includes('deriveLakePrompt()') && errorBlock.includes('promptRedactedField'),
    zero_retention_no_store: zeroRetentionBlock.includes("event: null") && zeroRetentionBlock.includes("retention: 'none'"),
    raw_sidecar_opt_in_only: src.includes('KOLM_ALLOW_RAW') && src.includes('rawAllowed && promptText') && src.includes('rawAllowed && respText'),
    sidecar_private_permissions: src.includes('chmodSync(fp, 0o600)'),
    canonical_event_store_append: src.includes('eventStoreAppend(ev)') && src.includes('appendEvent is'),
    durable_response_header: src.includes("'x-kolm-event-durable'") && src.includes('String(out.durable !== false)'),
    local_sentinel_tenant: src.includes('LOCAL_SENTINEL_TENANT') && src.includes("'local:'"),
    bounded_provider_reachability: src.includes('const REACH_TIMEOUT_MS = 1500') && src.includes('probeProviderReach'),
    fixture_mode_offline: src.includes('KOLM_CONNECTOR_FIXTURE') && src.includes('fixtureBody('),
    model_catalog_no_upstream_call: modelsBlock.includes('Object.entries(PROVIDERS)') && modelsBlock.includes('FRONTIER_MODELS') && !modelsBlock.includes('forwardRaw'),
  };
}

function testEvidence() {
  const required = [
    'tests/wave368-connector.test.js',
    'tests/wave407b-connector-fixes.test.js',
    'tests/wave409a-canonical-event-store.test.js',
    'tests/wave409b-privacy-failclosed.test.js',
    'tests/wave409k-openai-compat-surface.test.js',
    'tests/wave411-redaction-leak.test.js',
    'tests/wave470-suite-order-determinism.test.js',
    'tests/wave549-hosted-connector-upstream-key.test.js',
    'tests/wave550-cors-contract.test.js',
  ];
  return required.map((rel) => ({ path: rel, present: fs.existsSync(path.join(ROOT, rel)) }));
}

function buildMatrix() {
  const daemonSrc = read('src/daemon-connector.js');
  const providerSrc = read('src/provider-registry.js');
  const exports = extractExports(daemonSrc);
  const exportNames = new Set(exports.map((row) => row.name));
  const required = requiredExports();
  const missingRequiredExports = required.filter((name) => !exportNames.has(name));
  const providerRegistryIds = extractProviderRegistryIds(providerSrc);
  const supportedProviderIds = extractSupportedProviderIds(providerSrc);
  const routes = extractRoutes(daemonSrc);
  const routeGroups = groupRoutes(routes);
  const directProviderIds = routeGroups.map((row) => row.provider).filter((id) => id !== 'daemon').sort();
  const fixtureShapes = extractFixtureShapes(daemonSrc);
  const guards = safetyGuards(daemonSrc);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const tests = testEvidence();
  const missingTests = tests.filter((row) => !row.present).map((row) => row.path);
  const passThroughRoutes = routes.filter((row) => row.method === 'POST');
  const statusRoutes = routes.filter((row) => row.method === 'GET');
  const requiredDirectProviders = ['anthropic', 'gemini', 'openai', 'openrouter'];
  const missingDirectProviders = requiredDirectProviders.filter((id) => !directProviderIds.includes(id));

  const summary = {
    daemon_bytes: Buffer.byteLength(daemonSrc),
    daemon_lines: daemonSrc.split(/\r?\n/).length,
    export_count: exports.length,
    missing_required_exports: missingRequiredExports.length,
    route_count: routes.length,
    passthrough_route_count: passThroughRoutes.length,
    status_route_count: statusRoutes.length,
    direct_provider_count: directProviderIds.length,
    provider_registry_count: providerRegistryIds.length,
    supported_provider_id_count: supportedProviderIds.length,
    fixture_shape_count: fixtureShapes.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.passthrough_route_count < 14) failures.push({ gate: 'passthrough_routes', count: summary.passthrough_route_count });
  if (summary.status_route_count < 3) failures.push({ gate: 'status_routes', count: summary.status_route_count });
  if (missingDirectProviders.length) failures.push({ gate: 'direct_providers', missing: missingDirectProviders });
  if (summary.provider_registry_count < 10) failures.push({ gate: 'provider_registry', count: summary.provider_registry_count });
  if (summary.supported_provider_id_count < 10) failures.push({ gate: 'supported_provider_ids', count: summary.supported_provider_id_count });
  if (summary.fixture_shape_count < 7) failures.push({ gate: 'fixture_shapes', count: summary.fixture_shape_count });
  if (failedGuards.length) failures.push({ gate: 'daemon_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for the local daemon connector proxy boundary: lifecycle exports, passthrough routes, provider coverage, privacy/storage guards, and direct tests.',
    sources: [
      'src/daemon-connector.js',
      'src/provider-registry.js',
      'tests/wave368-connector.test.js',
      'tests/wave407b-connector-fixes.test.js',
      'tests/wave409a-canonical-event-store.test.js',
      'tests/wave409b-privacy-failclosed.test.js',
      'tests/wave409k-openai-compat-surface.test.js',
      'tests/wave411-redaction-leak.test.js',
      'tests/wave470-suite-order-determinism.test.js',
      'tests/wave549-hosted-connector-upstream-key.test.js',
      'tests/wave550-cors-contract.test.js',
    ],
    summary,
    exports,
    required_exports: required,
    missing_required_exports: missingRequiredExports,
    provider_registry_ids: providerRegistryIds,
    supported_provider_ids: supportedProviderIds,
    direct_provider_ids: directProviderIds,
    routes,
    route_groups: routeGroups,
    fixture_shapes: fixtureShapes,
    safety_guards: guards,
    failed_safety_guards: failedGuards,
    test_evidence: tests,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
  };
}

function main() {
  const matrix = buildMatrix();
  const body = stableStringify(matrix);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('daemon-connector-matrix: docs/internal/daemon-connector-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
  }

  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
      warnings: matrix.gates.warnings,
    }, null, 2));
  } else {
    const action = CHECK ? 'ok' : 'wrote';
    console.log(`daemon-connector-matrix: ${action} docs/internal/daemon-connector-matrix.json routes=${matrix.summary.route_count} providers=${matrix.summary.direct_provider_count} failures=${matrix.gates.failures.length}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
