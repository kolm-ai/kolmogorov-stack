import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-product-math-frontier.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('W596 #1 - math frontier simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.inventions, 14);
  assert.equal(out.coverage.used_primitives, out.counts.primitives);
  assert.equal(out.coverage.covered_open_requirements, out.counts.open_requirements);
  assert.ok(out.simulation.composite_delta >= 0.22);
});

test('W596 #2 - math frontier filters preserve valid backend slices', () => {
  assert.equal(run(['--invention=w596-kolm-q-lagrangian', '--summary']).counts.selected_inventions, 1);
  assert.ok(run(['--category=quantization', '--summary']).counts.selected_inventions >= 1);
  assert.ok(run(['--primitive=conformal-risk-calibration', '--summary']).counts.selected_inventions >= 1);
});
