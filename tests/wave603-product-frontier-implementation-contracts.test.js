import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPEC = path.join(ROOT, 'docs', 'product-frontier-implementation-contracts.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-frontier-implementation-contracts-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runSimulator(...args) {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-product-frontier-implementation-contracts.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

test('W603 #1 - every W601 frontier experiment has an implementation contract', () => {
  const spec = readJson(SPEC);
  assert.equal(spec.schema_version, 'kolm-product-frontier-implementation-contracts-1');
  assert.ok(spec.implementation_research.length >= 12);
  assert.ok(spec.contracts.length >= 15);
  for (const id of [
    'w603-kv-memory-controller-contract',
    'w603-structured-decode-contracts-contract',
    'w603-cloud-train-autopilot-contract',
    'w603-package-adoption-rail-contract',
    'w603-codegraph-test-miner-contract'
  ]) {
    assert.ok(spec.contracts.some((contract) => contract.id === id), `missing ${id}`);
  }
  for (const source of ['mlir-dialect-conversion', 'tvm-relax', 'iree-compiler', 'onnxruntime-genai', 'nvidia-dynamo-kv-routing', 'kserve-genai', 'ray-serve-llm', 'openai-evals', 'inspect-ai']) {
    assert.ok(spec.implementation_research.some((row) => row.id === source), `missing research ${source}`);
  }
});

test('W603 #2 - simulator proves full handoff coverage across product graph and readiness gates', () => {
  const result = runSimulator('--summary');
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_experiment_contracts.length, 0);
  assert.equal(result.coverage.duplicate_experiment_contracts.length, 0);
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.equal(result.coverage.unused_research.length, 0);
  assert.ok(result.simulation.implementation_readiness >= 0.78);
});

test('W603 #3 - filters by contract, category, source, experiment, and metric remain actionable', () => {
  for (const arg of [
    '--contract=w603-kv-memory-controller-contract',
    '--category=structured-decoding',
    '--source=mlir-dialect-conversion',
    '--experiment=w601-cloud-train-autopilot',
    '--metric=security'
  ]) {
    const result = runSimulator(arg, '--summary');
    assert.equal(result.ok, true, `${arg}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_contracts >= 1, `${arg}: selected no contracts`);
  }
});

test('W603 #4 - markdown handoff and package scripts keep contracts in depth gates', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  assert.match(md, /KV Memory Controller/);
  assert.match(md, /Structured Decode Contracts/);
  assert.match(md, /Cloud Train Autopilot/);
  assert.match(md, /Package Adoption Rail/);
  assert.match(md, /Implementation Rule/);
  assert.match(md, /npm run verify:frontier-contracts/);
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:frontier-contracts'], /simulate-product-frontier-implementation-contracts\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:frontier-contracts/);
  assert.match(pkg.scripts['verify:depth'], /verify:frontier-contracts/);
});
