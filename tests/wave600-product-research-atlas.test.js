import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATLAS = path.join(ROOT, 'docs', 'product-research-atlas.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-research-atlas-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runSimulator(...args) {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-product-research-atlas.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

test('W600 #1 - research atlas includes current frontier sources and implementable deltas', () => {
  const atlas = readJson(ATLAS);
  assert.equal(atlas.schema_version, 'kolm-product-research-atlas-1');
  assert.ok(atlas.sources.length >= 28);
  assert.ok(atlas.categories.length >= 14);
  assert.ok(atlas.invention_deltas.length >= 14);
  for (const id of [
    'bitnet-era',
    'bitnet-cpp',
    'tensorrt-llm-quant',
    'nvfp4-qad',
    'torchao-inference',
    'vllm-speculative',
    'ray-serve-llm',
    'skypilot-managed-jobs',
    'graphrag',
    'raptor',
    'colbertv2',
    'dspy-miprov2',
    'peft-lora',
    'owasp-llm',
    'garak'
  ]) {
    assert.ok(atlas.sources.some((source) => source.id === id), `missing source ${id}`);
  }
  for (const delta of atlas.invention_deltas) {
    assert.match(delta.id, /^w600-/);
    assert.ok(delta.product_change.length >= 120, `${delta.id}: product_change too thin`);
    assert.ok(delta.build_steps.length >= 5, `${delta.id}: build_steps too thin`);
    assert.ok(delta.acceptance_tests.length >= 3, `${delta.id}: acceptance_tests too thin`);
    assert.ok(delta.failure_modes.length >= 3, `${delta.id}: failure_modes too thin`);
  }
});

test('W600 #2 - simulator covers product graph, readiness, metrics, portfolio, categories, and sources', () => {
  const result = runSimulator('--summary');
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.equal(result.coverage.unused_sources.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.26);
});

test('W600 #3 - every category, source, metric, and representative delta has focused smoke coverage', () => {
  const atlas = readJson(ATLAS);
  for (const category of atlas.categories) {
    const result = runSimulator(`--category=${category}`, '--summary');
    assert.equal(result.ok, true, `${category}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_deltas >= 1, `${category}: no selected deltas`);
  }
  for (const metric of atlas.tracked_metrics) {
    const result = runSimulator(`--metric=${metric}`, '--summary');
    assert.equal(result.ok, true, `${metric}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_deltas >= 1, `${metric}: no selected deltas`);
  }
  for (const source of ['bitnet-era', 'nvfp4-qad', 'graphrag', 'owasp-llm', 'skypilot-managed-jobs']) {
    const result = runSimulator(`--source=${source}`, '--summary');
    assert.equal(result.ok, true, `${source}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_deltas >= 1, `${source}: no selected deltas`);
  }
  for (const delta of ['w600-native-ternary-student-target', 'w600-rag-artifact-compiler', 'w600-security-redteam-compiler']) {
    const result = runSimulator(`--delta=${delta}`, '--summary');
    assert.equal(result.ok, true, `${delta}: ${result.failures.join('\n')}`);
    assert.equal(result.counts.selected_deltas, 1);
  }
});

test('W600 #4 - markdown handoff and package scripts keep the research atlas in depth gates', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  assert.match(md, /Native Ternary Student Target/);
  assert.match(md, /FP4 Distillation Recovery Loop/);
  assert.match(md, /RAG Artifact Compiler/);
  assert.match(md, /Security Red-Team Compiler/);
  assert.match(md, /Implementation Rule/);
  assert.match(md, /npm run verify:research-atlas/);
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:research-atlas'], /simulate-product-research-atlas\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:research-atlas/);
  assert.match(pkg.scripts['verify:depth'], /verify:research-atlas/);
});
