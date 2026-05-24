import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FRONTIER = path.join(ROOT, 'docs', 'product-frontier-map.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-frontier-map-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(args = []) {
  return JSON.parse(execFileSync(process.execPath, ['scripts/simulate-product-frontier-map.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  }));
}

test('W595 #1 - frontier map is competitor-backed and implementation-grade', () => {
  const doc = readJson(FRONTIER);
  assert.equal(doc.schema_version, 'kolm-product-frontier-map-1');
  assert.ok(doc.sources.length >= 25);
  assert.ok(doc.competitors.length >= 12);
  assert.ok(doc.capability_axes.length >= 12);
  assert.ok(doc.programs.length >= 12);

  const competitorIds = new Set(doc.competitors.map((row) => row.id));
  for (const required of [
    'fireworks',
    'together',
    'predibase',
    'openpipe',
    'bedrock',
    'vllm',
    'sglang',
    'tensorrt-llm',
    'huggingface-tgi',
    'onnx-runtime',
    'iree',
    'executorch',
    'langsmith-braintrust-phoenix-weave',
    'cloudflare',
    'sigstore-slsa-cyclonedx'
  ]) {
    assert.ok(competitorIds.has(required), `missing competitor ${required}`);
  }

  for (const program of doc.programs) {
    assert.ok(program.product_gap.length >= 80, `${program.id}: product_gap too thin`);
    assert.ok(program.invention.length >= 80, `${program.id}: invention too thin`);
    assert.ok(program.build_steps.length >= 5, `${program.id}: build_steps too thin`);
    assert.ok(program.implementation_files.length >= 5, `${program.id}: implementation_files too thin`);
    assert.ok(program.acceptance_tests.length >= 4, `${program.id}: acceptance_tests too thin`);
    assert.ok(program.smoke_simulation.command.includes('simulate-product-frontier-map.cjs'), `${program.id}: missing smoke command`);
  }
});

test('W595 #2 - simulator covers all journeys, dimensions, metrics, axes, competitors, and open readiness gates', () => {
  const result = run(['--summary']);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_axes.length, 0);
  assert.equal(result.coverage.unaddressed_competitors.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.22);
});

test('W595 #3 - each capability axis and key competitor has a focused smoke path', () => {
  const doc = readJson(FRONTIER);
  for (const axis of doc.capability_axes) {
    const result = run([`--axis=${axis}`, '--summary']);
    assert.equal(result.ok, true, `${axis}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_programs >= 1, `${axis}: no selected programs`);
  }

  for (const competitor of ['together', 'predibase', 'vllm', 'sglang', 'cloudflare', 'langsmith-braintrust-phoenix-weave']) {
    const result = run([`--competitor=${competitor}`, '--summary']);
    assert.equal(result.ok, true, `${competitor}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_programs >= 1, `${competitor}: no selected programs`);
  }
});

test('W595 #4 - markdown handoff and package scripts lock in the frontier map gate', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  for (const term of [
    'Fireworks',
    'Together',
    'Predibase',
    'OpenPipe',
    'Bedrock',
    'vLLM',
    'SGLang',
    'TensorRT-LLM',
    'ONNX Runtime',
    'IREE',
    'ExecuTorch',
    'LangSmith',
    'Braintrust',
    'Phoenix',
    'Weave',
    'Cloudflare',
    'Sigstore'
  ]) {
    assert.match(md, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${term}`);
  }
  assert.match(md, /npm run verify:frontier-map/);

  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:frontier-map'], /simulate-product-frontier-map\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:frontier-map/);
  assert.match(pkg.scripts['verify:depth'], /verify:frontier-map/);
});
