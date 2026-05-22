#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildProductGraph, stableStringify } = require('./product-graph-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const GRAPH_PATH = path.join(ROOT, 'public', 'product-graph.json');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');

function fail(out, code, detail, extra = {}) {
  out.ok = false;
  out.failures.push({ code, detail, ...extra });
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) out[row[field] || 'unknown'] = (out[row[field] || 'unknown'] || 0) + 1;
  return out;
}

async function main() {
  const graph = await buildProductGraph(ROOT);
  const generated = stableStringify(graph);
  const existing = fs.existsSync(GRAPH_PATH) ? fs.readFileSync(GRAPH_PATH, 'utf8') : '';
  const out = {
    ok: true,
    failures: [],
    warnings: [],
    counts: graph.counts,
    readiness_counts: graph.readiness_counts,
    journey_stages: countBy(graph.journeys, 'stage'),
  };

  if (existing !== generated) {
    fail(out, 'stale_product_graph', 'public/product-graph.json does not match the current source docs and product experience');
  }

  const routeSurfaceIds = new Set(graph.route_surfaces.map((row) => row.id));
  const journeyIds = new Set(graph.journeys.map((row) => row.id));
  const dimensionIds = new Set(graph.dimensions.map((row) => row.id));
  const readinessIds = new Set();
  for (const group of graph.readiness_groups) {
    for (const req of group.requirements || []) readinessIds.add(req.id);
  }

  for (const required of [
    'identity-access-billing',
    'public-docs-sdk',
    'compile-artifact-verification',
    'runtime-inference-connectors',
    'capture-data-eval-training',
    'governance-compliance-security',
    'deployment-edge-federated',
  ]) {
    if (!routeSurfaceIds.has(required)) fail(out, 'missing_route_surface', `route surface missing: ${required}`);
  }

  for (const required of [
    'gateway-capture',
    'privacy-lake',
    'datasets-labeling',
    'train-distill',
    'models-backbones',
    'multimodal-tokenization',
    'compile-verify',
    'runtime-inference',
    'compute-cloud',
    'devices-fleet',
    'enterprise-governance',
    'agents-registry',
  ]) {
    if (!journeyIds.has(required)) fail(out, 'missing_journey', `journey missing: ${required}`);
  }

  for (const required of [
    'model-provider',
    'compute-target',
    'artifact-runtime',
    'storage-plane',
    'privacy-mode',
    'deployment-mode',
    'governance-mode',
    'proof-mode',
  ]) {
    if (!dimensionIds.has(required)) fail(out, 'missing_dimension', `customization dimension missing: ${required}`);
  }

  for (const required of [
    'kolm-format-spec',
    'standalone-verify',
    'holdout-independence',
    'openai-anthropic-gateway',
    'runtime-local-artifact',
    'artifact-signing-pipeline',
    'cli-world-class',
    'local-account-ui',
  ]) {
    if (!readinessIds.has(required)) fail(out, 'missing_readiness_requirement', `readiness requirement missing: ${required}`);
  }

  for (const journey of graph.journeys) {
    for (const field of ['account', 'cli', 'tui', 'api', 'customization_dimensions', 'next_actions']) {
      if (!Array.isArray(journey[field]) || journey[field].length === 0) {
        fail(out, 'journey_missing_contract', `${journey.id} missing ${field}`);
      }
    }
    if (!journey.stage) fail(out, 'journey_missing_stage', `${journey.id} missing stage`);
    if (!journey.user_story || journey.user_story.length < 40) fail(out, 'journey_weak_user_story', `${journey.id} user story too thin`);
  }

  const openReadiness = Object.entries(graph.readiness_counts)
    .filter(([status]) => !['shipped', 'implemented', 'certified'].includes(status))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [status, count] of openReadiness) {
    out.warnings.push({
      code: 'open_readiness_status',
      detail: `${count} requirement(s) are ${status}; product copy must keep that scope explicit`,
      status,
      count,
    });
  }

  if (wantJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`product-kernel: ok=${out.ok} journeys=${graph.counts.journeys} route_surfaces=${graph.counts.route_surfaces} requirements=${graph.counts.readiness_requirements} warnings=${out.warnings.length}`);
    for (const failure of out.failures) console.error(` - ${failure.code}: ${failure.detail}`);
    for (const warning of out.warnings) console.error(` ! ${warning.code}: ${warning.detail}`);
  }

  if (!out.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
