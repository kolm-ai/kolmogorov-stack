import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FRONTIER_PATH = path.join(ROOT, 'docs', 'product-frontier-map.json');
const FRONTIER = JSON.parse(fs.readFileSync(FRONTIER_PATH, 'utf8'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-product-frontier-map.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('W595 #1 - frontier map simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.programs, 16);
  assert.equal(out.coverage.covered_open_requirements, out.counts.open_requirements);
  assert.equal(out.coverage.unaddressed_competitors.length, 0);
});

test('W595 #2 - frontier map supports program, axis, and competitor filters', () => {
  assert.equal(run(['--program=w595-benchmark-evidence-network', '--summary']).counts.selected_programs, 1);
  assert.ok(run(['--axis=eval-observability', '--summary']).counts.selected_programs >= 1);
  assert.ok(run(['--competitor=langsmith-braintrust-phoenix-weave', '--summary']).counts.selected_programs >= 1);
});

test('W595 #3 - frontier implementation references current local evidence paths', () => {
  const body = JSON.stringify(FRONTIER);
  assert.doesNotMatch(body, /public\/benchmarks\.html/);
  assert.doesNotMatch(body, /public\/registry\.html/);
  assert.doesNotMatch(body, /public\/marketplace\.html/);
  assert.doesNotMatch(body, /public\/benchmarks\/quality-judge-calibration\.json/);
  assert.match(body, /docs\/benchmark-evidence\.md/);
  assert.match(body, /docs\/byo-registry\.md/);
  assert.match(body, /public\/benchmarks\/trinity-500-benchmark\.json/);
});

test('W595 #4 - frontier implementation file arrays are de-duplicated', () => {
  for (const program of FRONTIER.programs) {
    assert.equal(
      new Set(program.implementation_files).size,
      program.implementation_files.length,
      `${program.id}: duplicate implementation_files`
    );
  }
});
