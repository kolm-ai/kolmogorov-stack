import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKORDERS = path.join(ROOT, 'docs', 'readiness-gate-workorders.json');
const READINESS = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runSimulator(...args) {
  const stdout = execFileSync(process.execPath, ['scripts/simulate-readiness-gate-workorders.cjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(stdout);
}

function openRequirements() {
  const readiness = readJson(READINESS);
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) {
      if (!['shipped', 'implemented'].includes(requirement.status)) out.push({ surface: surface.id, ...requirement });
    }
  }
  return out;
}

test('W599 #1 - every open readiness gate has one executable workorder', () => {
  const spec = readJson(WORKORDERS);
  const open = openRequirements();
  assert.equal(spec.schema_version, 'kolm-readiness-gate-workorders-1');
  assert.equal(spec.workorders.length, open.length);
  const ids = new Set(spec.workorders.map((workorder) => workorder.requirement_id));
  for (const requirement of open) assert.ok(ids.has(requirement.id), `missing workorder for ${requirement.id}`);
});

test('W599 #2 - workorders keep local proof separate from external evidence', () => {
  const spec = readJson(WORKORDERS);
  for (const workorder of spec.workorders) {
    assert.ok(workorder.local_files.length >= 4, `${workorder.id}: local_files too thin`);
    assert.ok(workorder.local_commands.length >= 4, `${workorder.id}: local_commands too thin`);
    assert.ok(workorder.external_actions.length >= 3, `${workorder.id}: external_actions too thin`);
    assert.ok(workorder.evidence_required.length >= 3, `${workorder.id}: evidence_required too thin`);
    assert.ok(workorder.failure_modes.length >= 3, `${workorder.id}: failure_modes too thin`);
    assert.match(workorder.public_copy_rule, /do not (claim|advertise|publish)/i, `${workorder.id}: weak public_copy_rule`);
  }
});

test('W599 #3 - simulator validates coverage and focused gates', () => {
  const result = runSimulator('--summary');
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.equal(result.coverage.missing_open_requirements.length, 0);
  assert.equal(result.coverage.extra_workorders.length, 0);
  assert.equal(result.counts.open_requirements, 8);
  assert.equal(result.counts.workorders, 8);
  assert.equal(result.counts.kinds, 4);

  const spec = readJson(WORKORDERS);
  for (const workorder of spec.workorders) {
    const focused = runSimulator(`--requirement=${workorder.requirement_id}`, '--summary');
    assert.equal(focused.ok, true, `${workorder.requirement_id}: ${focused.failures.join('\n')}`);
    assert.equal(focused.counts.selected_workorders, 1);
  }
  for (const kind of ['external_partner', 'package_release', 'public_benchmark_data', 'live_certification']) {
    const focused = runSimulator(`--kind=${kind}`, '--summary');
    assert.equal(focused.ok, true, `${kind}: ${focused.failures.join('\n')}`);
    assert.ok(focused.counts.selected_workorders >= 1);
  }
});

test('W599 #4 - package scripts wire readiness workorders into depth verification', () => {
  const pkg = readJson(PACKAGE);
  assert.match(pkg.scripts['verify:readiness-workorders'], /simulate-readiness-gate-workorders\.cjs --summary/);
  assert.match(pkg.scripts['verify:depth'], /verify:readiness-workorders/);
});
