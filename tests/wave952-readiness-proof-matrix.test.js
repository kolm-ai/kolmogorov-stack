import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'readiness-proof-matrix.json');
const MASTER_SPEC = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.json');
const MASTER_MD = path.join(ROOT, 'docs', 'master-component-spec-sheet-2026-06-17.md');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'readiness-proof-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W952 package wiring makes readiness proof a control and depth gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:readiness-proof-matrix'], 'node scripts/build-readiness-proof-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:readiness-proof-matrix'],
    'node scripts/build-readiness-proof-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave952-readiness-proof-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:otel-matrix && npm run build:readiness-proof-matrix && npm run build:frontier-delta-freshness && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:frontier-delta-freshness && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:meta-routes/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/readiness-proof-matrix\.json/);
  assert.match(releaseVerify, /kolm\.readiness_proof_matrix\.v1/);

  const fileLedger = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(fileLedger, /build-readiness-proof-matrix\.cjs/);
  assert.match(fileLedger, /docs\/internal\/readiness-proof-matrix\.json/);

  const masterBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-master-component-spec-sheet.mjs'), 'utf8');
  assert.match(masterBuilder, /READINESS_PROOF/);
  assert.match(masterBuilder, /local_readiness_proof_pct/);
  assert.match(masterBuilder, /readiness_proof_surplus_score/);
});

test('W952 generated matrix is current and separates claimable from locally proved readiness', () => {
  execFileSync(process.execPath, ['scripts/build-readiness-proof-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.readiness_proof_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.equal(m.summary.requirement_count, 57);
  assert.equal(m.summary.claimable_requirement_count, 49);
  assert.equal(m.summary.claimable_readiness_pct, 86);
  assert.equal(m.summary.local_proof_requirement_count, 57);
  assert.equal(m.summary.local_proof_coverage_pct, 100);
  assert.equal(m.summary.open_external_requirement_count, 8);
  assert.equal(m.summary.workorder_count, 8);
  assert.deepEqual(m.summary.open_external_by_status, {
    needs_external_partner: 2,
    needs_live_certification: 1,
    needs_package_release: 4,
    needs_public_benchmark_data: 1,
  });
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.workorder_surplus_points >= 30);
  assert.ok(m.gates.warnings.some((w) => w.code === 'external_readiness_still_unclaimable'));
});

test('W952 above-100 score is local proof surplus only, not a shipped-claim upgrade', () => {
  const m = matrix();
  assert.equal(m.over_100_hill_climb.metric, 'local_readiness_proof_surplus_score');
  assert.ok(m.over_100_hill_climb.score > 100);
  assert.ok(m.over_100_hill_climb.score <= m.over_100_hill_climb.ceiling);
  assert.match(m.over_100_hill_climb.surplus_meaning, /do not convert external gates into shipped claims/i);

  const openRows = m.readiness_rows.filter((row) => !row.claimable);
  assert.equal(openRows.length, 8);
  for (const row of openRows) {
    assert.equal(row.proof_complete, true, `${row.id} should have local proof complete`);
    assert.equal(row.claimable, false, `${row.id} must remain unclaimable until external evidence exists`);
    assert.ok(row.workorder_id, `${row.id} must have a workorder`);
    assert.equal(row.public_copy_scoped, true, `${row.id} public copy must stay scoped`);
    assert.equal(row.missing_local_files.length, 0, `${row.id} local workorder files must exist`);
  }
});

test('W952 language-fit matrix explains why JS is control-plane, not the only substrate', () => {
  const m = matrix();
  assert.equal(m.language_fit.architecture, 'js_control_plane_with_python_rust_native_escape_hatches');
  assert.ok(m.language_fit.tracked_file_counts.js_family > m.language_fit.tracked_file_counts.python);
  assert.ok(m.language_fit.tracked_file_counts.python >= 20);
  assert.ok(m.language_fit.tracked_file_counts.rust >= 10);
  assert.equal(m.language_fit.missing_escape_hatches.length, 0);
  assert.equal(Object.values(m.language_fit.safety_guards).every(Boolean), true);

  const hatches = new Set(m.language_fit.escape_hatches.filter((row) => row.present).map((row) => row.path));
  for (const rel of [
    'workers/quantize/scripts/quantize.py',
    'workers/distill/scripts/train_preference.py',
    'workers/distill/scripts/dedup_pairs.py',
    'packages/runtime-rs/src/lib.rs',
    'packages/runtime-rs/src/wasm.rs',
    'packages/sdk-swift/Sources/Kolm/Kolm.swift',
    'packages/sdk-kotlin/src/main/kotlin/ai/kolm/Kolm.kt',
  ]) {
    assert.ok(hatches.has(rel), `missing escape hatch ${rel}`);
  }
});

test('W952 master spec reports local readiness proof at 100 without inflating frontier claims', () => {
  execFileSync(process.execPath, ['scripts/build-master-component-spec-sheet.mjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const sheet = readJson(MASTER_SPEC);
  assert.equal(sheet.sources.readiness_proof_matrix, 'docs/internal/readiness-proof-matrix.json');
  assert.equal(sheet.summary.readiness_proof.local_proof_coverage_pct, 100);
  assert.equal(sheet.summary.readiness_proof.claimable_readiness_pct, 86);
  assert.ok(sheet.perfection_model.local_engineering_score >= 99.9);
  assert.ok(sheet.perfection_model.readiness_proof_surplus_score > 100);
  assert.ok(sheet.perfection_model.frontier_product_score < 100);

  const md = fs.readFileSync(MASTER_MD, 'utf8');
  assert.match(md, /Local readiness proof coverage/);
  assert.match(md, /Claimable readiness closed locally/);
  assert.match(md, /Readiness proof surplus hill-climb/);
  assert.match(md, /Language fit/);
});
