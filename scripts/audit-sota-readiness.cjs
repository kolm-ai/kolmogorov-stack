#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const VALID_STATUSES = new Set([
  'shipped',
  'implemented',
  'partial',
  'needs_public_benchmark_data',
  'needs_package_release',
  'needs_external_partner',
  'needs_live_certification',
]);
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2']);

function fail(msg) {
  console.error('sota-readiness FAIL: ' + msg);
  process.exitCode = 1;
}

function relExists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
} catch (e) {
  fail(`cannot parse ${path.relative(ROOT, MATRIX)}: ${e.message}`);
  process.exit();
}

if (!doc || typeof doc !== 'object') fail('matrix must be an object');
if (!doc.schema_version) fail('schema_version missing');
if (!Array.isArray(doc.surfaces) || doc.surfaces.length === 0) fail('surfaces[] missing');

const ids = new Set();
const counts = {};
let requirements = 0;

for (const surface of doc.surfaces || []) {
  if (!surface || typeof surface !== 'object') { fail('surface entry must be object'); continue; }
  if (!surface.id || !/^[a-z0-9-]+$/.test(surface.id)) fail(`bad surface id: ${surface.id}`);
  if (!Array.isArray(surface.requirements) || surface.requirements.length === 0) fail(`surface ${surface.id} has no requirements`);
  for (const req of surface.requirements || []) {
    requirements += 1;
    const prefix = `${surface.id}/${req && req.id}`;
    if (!req || typeof req !== 'object') { fail(`${surface.id} requirement must be object`); continue; }
    if (!req.id || !/^[a-z0-9-]+$/.test(req.id)) fail(`${prefix}: bad id`);
    if (ids.has(req.id)) fail(`${prefix}: duplicate requirement id`);
    ids.add(req.id);
    if (!req.title || String(req.title).length < 12) fail(`${prefix}: title missing/too short`);
    if (!VALID_PRIORITIES.has(req.priority)) fail(`${prefix}: invalid priority ${req.priority}`);
    if (!VALID_STATUSES.has(req.status)) fail(`${prefix}: invalid status ${req.status}`);
    counts[req.status] = (counts[req.status] || 0) + 1;
    if (!Array.isArray(req.evidence_paths) || req.evidence_paths.length === 0) {
      fail(`${prefix}: evidence_paths[] missing`);
      continue;
    }
    for (const p of req.evidence_paths) {
      if (typeof p !== 'string' || p.trim() === '') fail(`${prefix}: blank evidence path`);
      else if (!relExists(p)) fail(`${prefix}: missing evidence path ${p}`);
    }
  }
}

const requiredIds = [
  'kolm-format-spec',
  'standalone-verify',
  'k-score-calibration',
  'incremental-compile',
  'compile-failure-diagnostics',
  'async-compile-webhooks',
  'compile-cache',
  'openai-anthropic-gateway',
  'zero-retention-mode',
  'capture-filtering',
  'event-lake-schema',
  'opentelemetry',
  'team-capture-rbac',
  'runtime-wasm',
  'runtime-edge',
  'ios-android-sdk',
  'registry-search',
  'version-diff',
  'deploy-buttons',
  'artifact-signing-pipeline',
  'model-routing',
  'shadow-mode',
  'cost-attribution',
  'rate-limits-quotas',
  'webhooks-events',
  'sdk-depth',
  'secrets-management',
  'prompt-compression',
  'semantic-cache',
  'fallback-chains',
  'quality-scoring',
  'rag-artifact',
  'streaming',
  'token-budget',
  'evals-ab',
  'compile-as-mcp',
];
for (const id of requiredIds) {
  if (!ids.has(id)) fail(`required checklist id missing: ${id}`);
}

const openStatuses = Object.entries(counts)
  .filter(([k]) => k !== 'shipped' && k !== 'implemented')
  .sort(([a], [b]) => a.localeCompare(b));

const verdict = process.exitCode ? 'fail' : (openStatuses.length ? 'warn' : 'pass');
console.log(JSON.stringify({
  ok: !process.exitCode,
  verdict,
  surfaces: (doc.surfaces || []).length,
  requirements,
  counts,
  note: openStatuses.length
    ? 'Some requirements are intentionally marked partial/external/package/benchmark/certification; do not market them as fully shipped.'
    : 'All requirements are marked shipped or implemented.',
}, null, 2));
