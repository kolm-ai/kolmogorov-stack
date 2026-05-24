import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILDBOOK = path.join(ROOT, 'docs', 'product-invention-buildbook.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-invention-buildbook-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runSimulator(...args) {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-product-invention-buildbook.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

test('W598 #1 - product invention buildbook is source-backed and implementation-grade', () => {
  const buildbook = readJson(BUILDBOOK);
  assert.equal(buildbook.schema_version, 'kolm-product-invention-buildbook-1');
  assert.ok(buildbook.research_sources.length >= 24);
  assert.ok(buildbook.categories.length >= 12);
  assert.ok(buildbook.inventions.length >= 12);
  const requiredSources = [
    'spinquant',
    'qserve',
    'tensorrt-llm',
    'sglang-speculative',
    'iree-deploy',
    'onnx-runtime-eps',
    'opentelemetry-genai',
    'sigstore',
    'cloudflare-r2-presigned',
    'runpod-api',
    'predibase-adapters',
    'braintrust-evals',
    'llm-judge-conformal',
    'model-context-protocol'
  ];
  const sourceIds = new Set(buildbook.research_sources.map((source) => source.id));
  for (const id of requiredSources) assert.ok(sourceIds.has(id), `missing source ${id}`);

  for (const invention of buildbook.inventions) {
    assert.match(invention.id, /^w598-/);
    assert.ok(invention.thesis.length >= 115, `${invention.id}: thesis too thin`);
    assert.ok(invention.build_steps.length >= 7, `${invention.id}: build_steps too thin`);
    assert.ok(invention.acceptance_tests.length >= 4, `${invention.id}: acceptance_tests too thin`);
    assert.ok(invention.failure_modes.length >= 3, `${invention.id}: failure_modes too thin`);
    assert.ok(invention.smoke_simulation.command.includes('simulate-product-invention-buildbook.cjs'), `${invention.id}: missing simulator smoke`);
  }
});

test('W598 #2 - simulator covers every journey, dimension, metric, open gate, category, and portfolio item', () => {
  const result = runSimulator('--summary');
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.weak_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.27);
});

test('W598 #3 - every category and metric has a focused smoke path', () => {
  const buildbook = readJson(BUILDBOOK);
  for (const category of buildbook.categories) {
    const result = runSimulator(`--category=${category}`, '--summary');
    assert.equal(result.ok, true, `${category}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_inventions >= 1, `${category}: no selected inventions`);
  }
  for (const metric of buildbook.tracked_metrics) {
    const result = runSimulator(`--metric=${metric}`, '--summary');
    assert.equal(result.ok, true, `${metric}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_inventions >= 1, `${metric}: no selected inventions`);
  }
});

test('W598 #4 - representative invention smokes and markdown handoff are wired', () => {
  for (const id of [
    'w598-adaptive-lattice-quantization-oracle',
    'w598-teacher-distillation-forge',
    'w598-cloud-compute-control-plane',
    'w598-agent-tool-compiler',
    'w598-serving-runtime-optimizer'
  ]) {
    const result = runSimulator(`--invention=${id}`, '--summary');
    assert.equal(result.ok, true, `${id}: ${result.failures.join('\n')}`);
    assert.equal(result.counts.selected_inventions, 1);
  }

  const md = fs.readFileSync(DOC, 'utf8');
  assert.match(md, /## Insights/);
  assert.match(md, /Competitive Bar/);
  assert.match(md, /Adaptive Lattice Quantization Oracle/);
  assert.match(md, /Cloud Compute Control Plane/);
  assert.match(md, /Implementation Agent Contract/);
  assert.match(md, /npm run verify:invention-buildbook/);

  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:invention-buildbook'], /simulate-product-invention-buildbook\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:invention-buildbook/);
  assert.match(pkg.scripts['verify:depth'], /verify:invention-buildbook/);
});
