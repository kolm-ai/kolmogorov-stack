import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const KERNELS_PATH = path.join(ROOT, 'docs', 'product-frontier-operator-kernels.json');
const MARKDOWN_PATH = path.join(ROOT, 'docs', 'research', 'product-frontier-operator-kernels-2026-05-23.md');

function run(args = []) {
  const out = spawnSync(process.execPath, ['scripts/simulate-product-frontier-operator-kernels.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  return JSON.parse(out.stdout);
}

test('W605 #1 - operator kernels include serious research-backed build plans', () => {
  const spec = JSON.parse(fs.readFileSync(KERNELS_PATH, 'utf8'));
  assert.equal(spec.schema_version, 'kolm-product-frontier-operator-kernels-1');
  assert.ok(spec.sources.length >= 20);
  assert.ok(spec.operator_kernels.length >= 10);
  for (const kernel of spec.operator_kernels) {
    assert.match(kernel.id, /^w605-[a-z0-9-]+-kernel$/);
    assert.ok(kernel.source_refs.length >= 3, `${kernel.id}: sources`);
    assert.ok(kernel.mathematical_primitives.length >= 5, `${kernel.id}: primitives`);
    assert.ok(kernel.build_steps.length >= 6, `${kernel.id}: build steps`);
    assert.ok(kernel.smoke_tests.length >= 2, `${kernel.id}: smoke tests`);
    assert.ok(kernel.failure_modes.length >= 4, `${kernel.id}: failure modes`);
    assert.ok(kernel.data_contracts.length >= 2, `${kernel.id}: data contracts`);
  }
});

test('W605 #2 - simulator covers all product journeys, metrics, readiness gates, and sources', () => {
  const result = run(['--summary']);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_journeys.length, 0);
  assert.equal(result.coverage.missing_dimensions.length, 0);
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.missing_metrics.length, 0);
  assert.equal(result.coverage.missing_categories.length, 0);
  assert.equal(result.coverage.missing_portfolio_inventions.length, 0);
  assert.equal(result.coverage.unused_sources.length, 0);
  assert.ok(result.simulation.build_depth >= 0.68);
  assert.ok(result.simulation.composite_delta >= 0.2);
});

test('W605 #3 - filters remain actionable for implementation agents', () => {
  const quant = run(['--category=quantization-memory', '--summary']);
  assert.equal(quant.counts.selected_kernels, 1);
  assert.equal(quant.coverage.missing_categories.length >= 0, true);

  const security = run(['--metric=security', '--summary']);
  assert.ok(security.counts.selected_kernels >= 4);

  const compile = run(['--journey=compile-verify', '--summary']);
  assert.ok(compile.counts.selected_kernels >= 8);

  const source = run(['--source=tensorrt-llm', '--summary']);
  assert.ok(source.counts.selected_kernels >= 3);

  const kernel = run(['--kernel=w605-experiential-distill-kernel', '--summary']);
  assert.equal(kernel.counts.selected_kernels, 1);
});

test('W605 #4 - markdown handoff and package scripts wire operator kernels into depth gates', () => {
  const md = fs.readFileSync(MARKDOWN_PATH, 'utf8');
  assert.match(md, /HoloQuant Joint Weight, Activation, And KV Planner/);
  assert.match(md, /Experiential On-Policy Distillation Kernel/);
  assert.match(md, /Judge Interval Proof Kernel/);
  assert.match(md, /OWASP Red-Team Compiler Kernel/);
  assert.match(md, /Agent Implementation Router Kernel/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:operator-kernels'], /simulate-product-frontier-operator-kernels/);
  assert.match(pkg.scripts['verify:operator-kernels'], /wave605-product-frontier-operator-kernels/);
  assert.match(pkg.scripts['verify:inventions'], /verify:operator-kernels/);
  assert.match(pkg.scripts['verify:depth'], /verify:operator-kernels/);
});
