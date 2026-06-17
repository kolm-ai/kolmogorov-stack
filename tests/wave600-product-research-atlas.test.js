import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ATLAS = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'product-research-atlas.json'), 'utf8'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-product-research-atlas.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('W600 #1 - research atlas simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.invention_deltas, 14);
  assert.equal(out.coverage.covered_categories, out.counts.categories);
  assert.equal(out.coverage.covered_open_requirements, out.counts.open_requirements);
});

test('W600 #2 - every research atlas implementation file exists', () => {
  for (const delta of ATLAS.invention_deltas) {
    for (const rel of delta.implementation_files) {
      assert.equal(fs.existsSync(path.join(ROOT, rel)), true, `${delta.id}: missing ${rel}`);
    }
  }
});

test('W600 #3 - research atlas filters preserve valid backend slices', () => {
  assert.equal(run(['--delta=w600-native-ternary-student-target', '--summary']).counts.selected_deltas, 1);
  assert.ok(run(['--category=benchmark-reproducer', '--summary']).counts.selected_deltas >= 1);
  assert.ok(run(['--metric=proof', '--summary']).counts.selected_deltas >= 1);
});

test('W600 #4 - research atlas references current registry and benchmark artifacts', () => {
  const body = JSON.stringify(ATLAS);
  assert.doesNotMatch(body, /public\/registry\.html/);
  assert.doesNotMatch(body, /public\/marketplace\.html/);
  assert.doesNotMatch(body, /public\/benchmarks\.html/);
  assert.match(body, /docs\/byo-registry\.md/);
  assert.match(body, /docs\/benchmark-evidence\.md/);
});

test('W600 #5 - research atlas implementation file arrays are de-duplicated', () => {
  for (const delta of ATLAS.invention_deltas) {
    assert.equal(
      new Set(delta.implementation_files).size,
      delta.implementation_files.length,
      `${delta.id}: duplicate implementation_files`
    );
  }
});
