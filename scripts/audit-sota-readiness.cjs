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
const OPEN_STATUSES = new Set([
  'partial',
  'needs_public_benchmark_data',
  'needs_package_release',
  'needs_external_partner',
  'needs_live_certification',
]);
const CLOSEOUT_FIELDS = [
  'current_scope',
  'blocking_condition',
  'next_wave',
  'build_or_proof_required',
  'done_when',
  'verification',
];

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
const openRequirements = [];
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
    if (OPEN_STATUSES.has(req.status)) {
      openRequirements.push({ surface: surface.id, id: req.id, status: req.status, priority: req.priority });
      if (!req.closeout || typeof req.closeout !== 'object' || Array.isArray(req.closeout)) {
        fail(`${prefix}: open status ${req.status} requires closeout object`);
      } else {
        for (const field of CLOSEOUT_FIELDS) {
          const value = req.closeout[field];
          if (Array.isArray(value)) {
            if (!value.length || value.some((entry) => typeof entry !== 'string' || entry.trim().length < 8)) {
              fail(`${prefix}: closeout.${field} must contain actionable strings`);
            }
          } else if (typeof value !== 'string' || value.trim().length < 8) {
            fail(`${prefix}: closeout.${field} missing/too short`);
          }
        }
        if (!/^W[0-9]+-[a-z0-9-]+$/.test(req.closeout.next_wave || '')) {
          fail(`${prefix}: closeout.next_wave must be a stable wave id like W565-format-governance`);
        }
      }
    }
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
  open_requirements: openRequirements,
  note: openStatuses.length
    ? 'Some requirements are intentionally marked partial/external/package/benchmark/certification; every one must carry a closeout contract and must not be marketed as fully shipped.'
    : 'All requirements are marked shipped or implemented.',
}, null, 2));
