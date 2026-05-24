import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPEC = path.join(ROOT, 'docs', 'product-invention-implementation-spec.json');
const DOC = path.join(ROOT, 'docs', 'research', 'product-invention-implementation-spec-2026-05-23.md');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('W593 #1 - invention implementation spec is buildable, research-backed, and metric-linked', () => {
  const spec = readJson(SPEC);
  assert.equal(spec.schema_version, 'kolm-invention-implementation-spec-1');
  assert.ok(spec.research_sources.length >= 20);
  assert.ok(spec.inventions.length >= 12);
  for (const invention of spec.inventions) {
    assert.ok(invention.thesis.length >= 80, `${invention.id}: thesis too thin`);
    assert.ok(invention.math_core.length >= 3, `${invention.id}: math_core too thin`);
    assert.ok(invention.build_phases.length >= 5, `${invention.id}: build_phases too thin`);
    assert.ok(invention.implementation_files.length >= 5, `${invention.id}: implementation_files too thin`);
    assert.ok(invention.acceptance_tests.length >= 3, `${invention.id}: acceptance_tests too thin`);
    assert.ok(invention.failure_modes.length >= 3, `${invention.id}: failure_modes too thin`);
    assert.ok(invention.smoke_simulation.command, `${invention.id}: missing smoke command`);
  }
});

test('W593 #2 - implementation simulator covers every journey, dimension, metric, open gate, and portfolio item', () => {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-invention-implementation-spec.cjs', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.ok(result.simulation.composite_delta >= 0.25);
});

test('W593 #3 - each major category has a focused smoke path', () => {
  const categories = [
    'quantization',
    'compilation',
    'distillation',
    'runtime-serving',
    'privacy-security',
    'cloud-compute',
    'agents',
    'proof-governance',
    'developer-experience'
  ];
  for (const category of categories) {
    const stdout = execFileSync(process.execPath, ['scripts/simulate-invention-implementation-spec.cjs', `--category=${category}`, '--summary'], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, `${category}: ${result.failures.join('\n')}`);
    assert.ok(result.counts.selected_inventions >= 1, `${category}: no selected inventions`);
  }
});

test('W593 #4 - markdown handoff exists and package gates include the simulator', () => {
  const md = fs.readFileSync(DOC, 'utf8');
  assert.match(md, /Kolm-Q Max/);
  assert.match(md, /Acceptance bar/);
  assert.match(md, /npm run verify:invention-spec/);
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:invention-spec'], /simulate-invention-implementation-spec\.cjs --summary/);
  assert.match(pkg.scripts['verify:inventions'], /verify:invention-spec/);
  assert.match(pkg.scripts['verify:depth'], /verify:invention-spec/);
});
