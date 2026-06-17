import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BUILDBOOK = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'product-invention-buildbook.json'), 'utf8'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-product-invention-buildbook.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('W598 #1 - invention buildbook simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.inventions, 14);
  assert.equal(out.coverage.covered_categories, out.counts.categories);
  assert.equal(out.coverage.covered_open_requirements, out.counts.open_requirements);
});

test('W598 #2 - buildbook supports category, invention, and metric filters', () => {
  assert.equal(run(['--invention=w598-codegraph-product-indexer', '--summary']).counts.selected_inventions, 1);
  assert.ok(run(['--category=device-runtime', '--summary']).counts.selected_inventions >= 1);
  assert.ok(run(['--metric=proof', '--summary']).counts.selected_inventions >= 1);
});

test('W598 #3 - buildbook references current registry, benchmark, and compliance evidence', () => {
  const body = JSON.stringify(BUILDBOOK);
  assert.doesNotMatch(body, /public\/registry\.html/);
  assert.doesNotMatch(body, /public\/marketplace\.html/);
  assert.doesNotMatch(body, /public\/benchmarks\/quality-judge-calibration\.json/);
  assert.doesNotMatch(body, /public\/soc2\.html/);
  assert.doesNotMatch(body, /public\/hipaa-mapping\.html/);
  assert.match(body, /docs\/byo-registry\.md/);
  assert.match(body, /public\/benchmarks\/trinity-500-benchmark\.json/);
  assert.match(body, /docs\/compliance\/SOC2-EVIDENCE\.md/);
});

test('W598 #4 - buildbook implementation file arrays are de-duplicated', () => {
  for (const invention of BUILDBOOK.inventions) {
    assert.equal(
      new Set(invention.implementation_files).size,
      invention.implementation_files.length,
      `${invention.id}: duplicate implementation_files`
    );
  }
});
