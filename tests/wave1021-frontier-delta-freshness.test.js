import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.resolve(process.cwd());
const REPORT = path.join(ROOT, 'docs', 'internal', 'frontier-delta-freshness.json');
const STACK_SPEC = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('W1021 #1 - frontier delta freshness report is generated from current authority sources', () => {
  const out = execFileSync(process.execPath, ['scripts/audit-frontier-delta-freshness.cjs', '--check', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true, parsed.failures.join('\n'));
  assert.equal(parsed.summary.category_count, 16);
});

test('W1021 #2 - old raw frontier deltas are classified as historical, not current readiness', () => {
  const report = readJson(REPORT);
  assert.equal(report.schema, 'kolm-frontier-delta-freshness-1');
  assert.equal(report.authority.status, 'current_spec_verified');
  assert.match(report.authority.rule, /Raw frontier deltas can preserve the original research audit/);
  assert.ok(report.summary.historical_raw_severe_gap_count >= 50);
  assert.ok(report.summary.categories_with_historical_raw_severe_gaps >= 12);
  assert.equal(report.summary.current_severe_category_count, 0);
  assert.equal(report.summary.superseded_severe_categories, report.summary.categories_with_historical_raw_severe_gaps);
});

test('W1021 #3 - every superseded severe category has closure markers in the current stack spec', () => {
  const report = readJson(REPORT);
  for (const row of report.rows) {
    if (row.raw_severe_gap_count === 0) continue;
    assert.equal(row.current_severe_gap_count, 0, row.id);
    assert.equal(row.resolution, 'historical_raw_deltas_superseded_by_current_stack_spec', row.id);
    assert.ok(row.closure_marker_count >= 1, `${row.id}: missing closure marker`);
  }
});

test('W1021 #4 - stack spec names the current source of truth without the stale raw-delta authority phrase', () => {
  const spec = fs.readFileSync(STACK_SPEC, 'utf8');
  assert.match(spec, /Current source of truth for readiness/);
  assert.doesNotMatch(spec, /Source of truth:\s*16 per-category frontier-delta analyses/i);
});

test('W1021 #5 - external gates remain explicit after severe local SOTA gaps are closed', () => {
  const report = readJson(REPORT);
  assert.equal(report.summary.open_external_or_release_requirements, 8);
  assert.deepEqual(report.summary.open_external_or_release_status_counts, {
    needs_external_partner: 2,
    needs_live_certification: 1,
    needs_package_release: 4,
    needs_public_benchmark_data: 1,
  });
});
