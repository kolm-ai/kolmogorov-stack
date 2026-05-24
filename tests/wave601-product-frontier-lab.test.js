import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LAB = path.join(ROOT, 'docs', 'product-frontier-lab.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-frontier-lab-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runSimulator(...args) {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-product-frontier-lab.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

test('W601 #1 - frontier lab includes hard backend frontier sources and executable experiments', () => {
  const lab = readJson(LAB);
  assert.equal(lab.schema_version, 'kolm-product-frontier-lab-1');
  assert.ok(lab.sources.length >= 30);
  assert.ok(lab.categories.length >= 14);
  assert.ok(lab.experiments.length >= 14);
  for (const id of [
    'streamingllm',
    'h2o-kv',
    'snapkv',
    'pyramidkv',
    'minference',
    'ring-attention',
    'vllm-structured',
    'xgrammar-docs',
    'datacomp-lm',
    'semdedup',
    'deepspeed-moe-inference',
    'vllm-expert-parallel',
    'executorch',
    'mediapipe-llm',
    'aws-nitro-attestation',
    'nvidia-attestation',
    'amd-sb-3034',
    'codegraph-repo'
  ]) {
    assert.ok(lab.sources.some((source) => source.id === id), `missing source ${id}`);
  }
  for (const experiment of lab.experiments) {
    assert.match(experiment.id, /^w601-/);
    assert.ok(experiment.hypothesis.length >= 140, `${experiment.id}: hypothesis too thin`);
    assert.ok(experiment.procedure.length >= 6, `${experiment.id}: procedure too thin`);
    assert.ok(experiment.acceptance_tests.length >= 3, `${experiment.id}: acceptance_tests too thin`);
    assert.ok(experiment.kill_criteria.length >= 3, `${experiment.id}: kill_criteria too thin`);
  }
});

test('W601 #2 - simulator covers product graph, readiness, metrics, portfolio, categories, and sources', () => {
  const result = runSimulator('--summary');
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.equal(result.coverage.unused_sources.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.28);
});

test('W601 #3 - category, source, metric, and representative experiment filters stay useful', () => {
  const lab = readJson(LAB);
  for (const category of lab.categories) {
    const result = runSimulator(`--category=${category}`, '--summary');
    assert.equal(result.ok, true, `${category}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_experiments >= 1, `${category}: no selected experiments`);
  }
  for (const metric of lab.tracked_metrics) {
    const result = runSimulator(`--metric=${metric}`, '--summary');
    assert.equal(result.ok, true, `${metric}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_experiments >= 1, `${metric}: no selected experiments`);
  }
  for (const source of ['streamingllm', 'xgrammar-docs', 'datacomp-lm', 'executorch', 'amd-sb-3034']) {
    const result = runSimulator(`--source=${source}`, '--summary');
    assert.equal(result.ok, true, `${source}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_experiments >= 1, `${source}: no selected experiments`);
  }
  for (const experiment of ['w601-kv-memory-controller', 'w601-structured-decode-contracts', 'w601-confidential-compute-runbook']) {
    const result = runSimulator(`--experiment=${experiment}`, '--summary');
    assert.equal(result.ok, true, `${experiment}: ${result.failures.join('\n')}`);
    assert.equal(result.counts.selected_experiments, 1);
  }
});

test('W601 #4 - markdown handoff and package scripts keep the frontier lab in depth gates', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  assert.match(md, /KV Memory Controller/);
  assert.match(md, /Structured Decode Contracts/);
  assert.match(md, /Confidential Compute Runbook/);
  assert.match(md, /Package Adoption Rail/);
  assert.match(md, /Implementation Rule/);
  assert.match(md, /npm run verify:frontier-lab/);
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:frontier-lab'], /simulate-product-frontier-lab\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:frontier-lab/);
  assert.match(pkg.scripts['verify:depth'], /verify:frontier-lab/);
});
