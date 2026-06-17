import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SPEC_PATH = path.join(ROOT, 'docs', 'product-invention-implementation-spec.json');
const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/simulate-invention-implementation-spec.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function stringifySpec() {
  return JSON.stringify(SPEC);
}

test('W593 #1 - implementation spec simulator passes globally', () => {
  const out = run(['--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.inventions, 14);
  assert.equal(out.coverage.covered_open_requirements, out.counts.open_requirements);
  assert.equal(out.coverage.missing_journeys.length, 0);
  assert.ok(out.simulation.composite_delta >= 0.25);
});

test('W593 #2 - every invention has a completed spec deep-dive contract', () => {
  for (const invention of SPEC.inventions) {
    const dive = invention.deep_dive;
    assert.ok(dive, `${invention.id}: missing deep_dive`);
    assert.equal(dive.status, 'spec_deep_dive_complete_build_deep_dive_required');
    assert.match(dive.reviewed_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(dive.reviewer_count >= 4, `${invention.id}: reviewer_count below 4`);
    assert.deepEqual(
      [...dive.lenses].sort(),
      [
        'math_and_proof_validity',
        'operability_release_and_claim_scope',
        'privacy_security_and_failure_abuse',
        'source_to_route_wiring_trace',
      ].sort()
    );
    assert.ok(dive.required_outputs.length >= 4, `${invention.id}: required_outputs too thin`);
    assert.ok(dive.exit_criteria.length >= 4, `${invention.id}: exit_criteria too thin`);
  }
});

test('W593 #3 - category filter still validates a single backend category', () => {
  const out = run(['--category=quantization', '--summary']);
  assert.equal(out.ok, true, out.failures.join('\n'));
  assert.equal(out.counts.selected_inventions, 1);
});

test('W593 #4 - implementation spec uses current benchmark local evidence', () => {
  const body = stringifySpec();
  assert.match(body, /public\/benchmarks\/trinity-500-benchmark\.json/);
  assert.doesNotMatch(body, /public\/benchmarks\/quality-judge-calibration\.json/);
  assert.doesNotMatch(body, /public\/benchmarks\.html/);
  assert.doesNotMatch(body, /public\/registry\.html/);
});
