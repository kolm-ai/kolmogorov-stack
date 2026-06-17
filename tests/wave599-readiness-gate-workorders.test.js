import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WORKORDERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'readiness-gate-workorders.json'), 'utf8'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-readiness-gate-workorders.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('W599 #1 - readiness workorder simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.open_requirements, 8);
  assert.equal(out.counts.workorders, 8);
  assert.equal(out.coverage.missing_open_requirements.length, 0);
});

test('W599 #2 - every workorder local file exists', () => {
  for (const workorder of WORKORDERS.workorders) {
    for (const rel of workorder.local_files) {
      assert.equal(fs.existsSync(path.join(ROOT, rel)), true, `${workorder.id}: missing ${rel}`);
    }
  }
});

test('W599 #3 - workorders use current local evidence paths', () => {
  const body = JSON.stringify(WORKORDERS);
  assert.doesNotMatch(body, /public\/spec-grammar\.html/);
  assert.doesNotMatch(body, /public\/benchmarks\/quality-judge-calibration\.json/);
  assert.doesNotMatch(body, /public\/benchmarks\/redaction-public-benchmark\.json/);
  assert.doesNotMatch(body, /public\/soc2\.html/);
  assert.doesNotMatch(body, /public\/hipaa-mapping\.html/);
  assert.doesNotMatch(body, /public\/slsa\.html/);
  assert.match(body, /public\/benchmarks\/trinity-500-benchmark\.json/);
  assert.match(body, /docs\/compliance\/SOC2-EVIDENCE\.md/);
});

test('W599 #4 - workorder filters isolate external gate classes', () => {
  assert.equal(run(['--kind=package_release', '--summary']).counts.selected_workorders, 4);
  assert.equal(run(['--requirement=benchmarking-infra', '--summary']).counts.selected_workorders, 1);
});
