import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MATH = path.join(ROOT, 'docs', 'product-math-frontier.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-math-frontier-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(args = []) {
  return JSON.parse(execFileSync(process.execPath, ['scripts/simulate-product-math-frontier.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  }));
}

test('W596 #1 - math frontier is research-backed and implementation-grade', () => {
  const doc = readJson(MATH);
  assert.equal(doc.schema_version, 'kolm-product-math-frontier-1');
  assert.ok(doc.sources.length >= 30);
  assert.ok(doc.math_primitives.length >= 16);
  assert.ok(doc.categories.length >= 10);
  assert.ok(doc.inventions.length >= 12);

  const sourceIds = new Set(doc.sources.map((row) => row.id));
  for (const required of [
    'gptq',
    'awq',
    'smoothquant',
    'quarot',
    'quip-sharp',
    'aqlm',
    'kivi',
    'kvquant',
    'flashattention',
    'pagedattention',
    'sglang',
    'medusa',
    'eagle',
    'mlir',
    'tvm',
    'iree',
    'onnx-runtime-eps',
    'minillm',
    'dpo',
    'dp-sgd',
    'fedavg',
    'krum',
    'sigstore'
  ]) {
    assert.ok(sourceIds.has(required), `missing source ${required}`);
  }

  for (const invention of doc.inventions) {
    assert.ok(invention.objective.length >= 85, `${invention.id}: objective too thin`);
    assert.ok(invention.invariant.length >= 85, `${invention.id}: invariant too thin`);
    assert.ok(invention.primitive_refs.length >= 2, `${invention.id}: primitive_refs too thin`);
    assert.ok(invention.source_refs.length >= 3, `${invention.id}: source_refs too thin`);
    assert.ok(invention.build_steps.length >= 5, `${invention.id}: build_steps too thin`);
    assert.ok(invention.implementation_files.length >= 5, `${invention.id}: implementation_files too thin`);
    assert.ok(invention.acceptance_tests.length >= 4, `${invention.id}: acceptance_tests too thin`);
    assert.ok(invention.smoke_simulation.command.includes('simulate-product-math-frontier.cjs'), `${invention.id}: missing smoke command`);
  }
});

test('W596 #2 - simulator covers all product graph, readiness, portfolio, category, primitive, and metric surfaces', () => {
  const result = run(['--summary']);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.unused_primitives.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.22);
});

test('W596 #3 - every category, primitive, and invention has a focused smoke path', () => {
  const doc = readJson(MATH);
  for (const category of doc.categories) {
    const result = run([`--category=${category}`, '--summary']);
    assert.equal(result.ok, true, `${category}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_inventions >= 1, `${category}: no selected inventions`);
  }

  for (const primitive of doc.math_primitives) {
    const result = run([`--primitive=${primitive.id}`, '--summary']);
    assert.equal(result.ok, true, `${primitive.id}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_inventions >= 1, `${primitive.id}: no selected inventions`);
  }

  for (const invention of doc.inventions) {
    const result = run([`--invention=${invention.id}`, '--summary']);
    assert.equal(result.ok, true, `${invention.id}: ${result.failures.join('\n')}`);
    assert.equal(result.counts.selected_inventions, 1, `${invention.id}: focused smoke selected wrong count`);
  }
});

test('W596 #4 - markdown handoff contains the important research vocabulary and product insight sections', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  for (const term of [
    'GPTQ',
    'AWQ',
    'SmoothQuant',
    'QuaRot',
    'QuIP',
    'AQLM',
    'KIVI',
    'KVQuant',
    'FlashAttention',
    'PagedAttention',
    'SGLang',
    'Medusa',
    'EAGLE',
    'MLIR',
    'TVM',
    'IREE',
    'ONNX Runtime',
    'MiniLLM',
    'DPO',
    'conformal',
    'DP-SGD',
    'FedAvg',
    'Krum',
    'Insights',
    'Build Strategy Brain',
    'Cloud Cost-Latency Solver'
  ]) {
    assert.match(md, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${term}`);
  }
  assert.match(md, /npm run verify:math-frontier/);
});

test('W596 #5 - package scripts wire math-frontier into invention and depth gates', () => {
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:math-frontier'], /simulate-product-math-frontier\.cjs --summary/);
  assert.match(pkg.scripts['verify:math-frontier'], /wave596-product-math-frontier\.test\.js/);
  assert.match(pkg.scripts['verify:inventions'], /verify:math-frontier/);
  assert.match(pkg.scripts['verify:depth'], /verify:math-frontier/);
});
