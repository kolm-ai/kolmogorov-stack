import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.json');
const SHEET_MD = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.md');
const ATOMIC = path.join(ROOT, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('W616 master component spec sheet is generated and current', () => {
  const out = execFileSync(process.execPath, ['scripts/build-master-component-spec-sheet.mjs', '--check', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /master-component-spec-sheet-2026-06-17\.json/);
});

test('W616 master component spec sheet covers every atomic component', () => {
  const sheet = readJson(SHEET);
  const atomic = readJson(ATOMIC);
  assert.equal(sheet.schema, 'kolm-master-component-spec-sheet-1');
  assert.equal(sheet.components.length, atomic.components.length);
  assert.equal(sheet.summary.component_count, atomic.summary.component_count);
  assert.ok(sheet.components.length > 800);
  for (const row of sheet.components) {
    assert.equal(typeof row.path, 'string');
    assert.ok(row.target_state?.perfection_definition);
    assert.ok(row.current_state?.improvement_track);
    assert.ok(Array.isArray(row.perfection_gaps));
    assert.equal(typeof row.next_best_action, 'string');
  }
});

test('W616 master component spec sheet keeps perfection distance explicit', () => {
  const sheet = readJson(SHEET);
  assert.equal(typeof sheet.perfection_model.local_engineering_score, 'number');
  assert.equal(typeof sheet.perfection_model.frontier_product_score, 'number');
  assert.ok(sheet.perfection_model.local_engineering_score >= 80);
  assert.ok(sheet.perfection_model.frontier_product_score >= 60);
  assert.ok(sheet.perfection_model.frontier_product_score < 100);
  assert.equal(sheet.summary.readiness_proof.local_proof_coverage_pct, 100);
  assert.equal(sheet.summary.readiness_proof.claimable_readiness_pct, 86);
  assert.ok(sheet.perfection_model.readiness_proof_surplus_score > 100);
  assert.equal(sheet.summary.categories_with_critical_frontier_work_open, 0);
  assert.ok(sheet.summary.categories_with_major_frontier_work_open > 0);
  assert.equal(sheet.summary.components_without_direct_test_reference, 0);
  assert.equal(sheet.summary.direct_test_reference_pct, 100);
  assert.ok(sheet.top_component_gaps.length > 0);

  const md = fs.readFileSync(SHEET_MD, 'utf8');
  assert.match(md, /How Close To Perfect/);
  assert.match(md, /Local engineering perfection/);
  assert.match(md, /Frontier\/product perfection/);
  assert.match(md, /Local readiness proof coverage/);
  assert.match(md, /Claimable readiness closed locally/);
});
