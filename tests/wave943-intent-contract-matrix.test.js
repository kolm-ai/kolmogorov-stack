import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  VERB_DESCRIPTIONS,
  classifyIntent,
  expandToWorkflow,
  listVerbs,
} from '../src/intent.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'intent-contract-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'intent-contract-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W943 package wiring makes the intent contract matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:intent-contract-matrix'], 'node scripts/build-intent-contract-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:intent-contract-matrix'],
    'node scripts/build-intent-contract-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave943-intent-contract-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:binder-contract-matrix && npm run build:intent-contract-matrix && npm run build:wrapper-cli-matrix && npm run build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-intent-contract-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/intent-contract-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/intent-contract-matrix\.json/);
  assert.match(releaseVerify, /kolm\.intent_contract_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /INTENT_CONTRACT_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_intent_contract_matrix_and_routing_workflow_taxonomy/);
  assert.match(backendAtomic, /npm run verify:intent-contract-matrix/);
});

test('W943 generated matrix is current and all hard intent gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-intent-contract-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.intent_contract_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 7);
  assert.ok(m.summary.function_count >= 21);
  assert.equal(m.summary.verb_count, 94);
  assert.equal(m.summary.unique_verb_count, 94);
  assert.equal(m.summary.duplicate_verb_count, 0);
  assert.equal(m.summary.phrasing_count, 823);
  assert.equal(m.summary.unique_phrasing_count, 823);
  assert.equal(m.summary.phrase_collision_count, 0);
  assert.equal(m.summary.example_count, 124);
  assert.equal(m.summary.regex_rule_count, 18);
  assert.equal(m.summary.confidence_floor_count, 36);
  assert.equal(m.summary.workflow_count, 16);
  assert.equal(m.summary.subcommand_workflow_count, 2);
  assert.equal(m.summary.required_verb_gaps, 0);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 10);
});

test('W943 matrix captures catalog, regex, workflow, and safety contracts', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true);

  const exports = new Set(m.exports.map((row) => row.name));
  for (const name of ['VERB_DESCRIPTIONS', 'listVerbs', 'classifyIntent', 'snapshotContext', 'recommendNext', 'expandToWorkflow']) {
    assert.ok(exports.has(name), `missing export ${name}`);
  }

  const verbs = new Set(m.verb_catalog.map((row) => row.verb));
  for (const verb of ['compile', 'distill', 'cloud', 'quickstart', 'route', 'pipeline', 'lineage', 'regulatory']) {
    assert.ok(verbs.has(verb), `missing verb ${verb}`);
  }
  assert.deepEqual(m.duplicate_verbs, []);
  assert.deepEqual(m.phrase_collisions, []);

  const regexVerbs = new Set(m.regex_rules.map((row) => row.verb));
  for (const verb of ['tail', 'capture', 'distill', 'compile', 'run', 'export', 'login', 'federated', 'route']) {
    assert.ok(regexVerbs.has(verb), `missing regex route ${verb}`);
  }

  const workflows = new Map(m.workflows.map((row) => [row.workflow, row]));
  assert.ok(workflows.get('multi_teacher_distill').step_count >= 6);
  assert.ok(workflows.get('quickstart').step_count >= 3);
  assert.ok(workflows.get('quantize').step_count >= 3);

  const subworkflows = new Set(m.subcommand_workflows.map((row) => `${row.verb}:${row.subcommand}`));
  assert.ok(subworkflows.has('quickstart:wrapper'));
  assert.ok(subworkflows.has('quickstart:studio'));

  const evidence = new Map(m.test_evidence.map((row) => [row.path, row]));
  for (const rel of m.required_test_evidence) {
    assert.ok(evidence.has(rel), `${rel} must be direct intent evidence`);
  }
});

test('W943 intent catalog owns every verb and phrase exactly once', () => {
  const verbs = listVerbs();
  assert.deepEqual(verbs, VERB_DESCRIPTIONS.map((row) => row.verb));
  assert.equal(new Set(verbs).size, verbs.length, 'listVerbs must be duplicate-free');

  const owners = new Map();
  for (const entry of VERB_DESCRIPTIONS) {
    assert.ok(entry.phrasings.length > 0, `${entry.verb} must have phrasings`);
    assert.ok(entry.examples.length > 0, `${entry.verb} must have examples`);
    for (const phrase of entry.phrasings) {
      const key = phrase.toLowerCase();
      assert.equal(owners.has(key), false, `phrase ${phrase} is already owned by ${owners.get(key)}`);
      owners.set(key, entry.verb);
    }
  }
});

test('W943 intent workflows cover subcommands, teacher council, followups, and low-confidence fallback', async () => {
  const quick = await classifyIntent('$ kolm quickstart wrapper');
  assert.equal(quick.verb, 'quickstart');
  assert.equal(quick.subcommand, 'wrapper');
  const quickWorkflow = expandToWorkflow(quick, '$ kolm quickstart wrapper');
  assert.equal(quickWorkflow.summary, 'Stand up the wrapper (gateway + capture) end to end.');
  assert.equal(quickWorkflow.steps[0].cmd, 'kolm quickstart wrapper');

  const council = await classifyIntent('teacher council with claude, gpt, gemini for support');
  assert.equal(council.verb, 'distill');
  assert.equal(council.source, 'regex');
  assert.ok(council.args.includes('--teachers'));
  const councilWorkflow = expandToWorkflow(council, 'teacher council with claude, gpt, gemini for support');
  assert.equal(councilWorkflow.namespace_hint, 'support');
  assert.ok(councilWorkflow.steps.some((step) => step.cmd.includes('kolm distill --teachers claude-opus-4-7,gpt-4o,gemini-2.5-pro --weights auto --namespace support')));
  assert.ok(councilWorkflow.steps.some((step) => step.cmd.includes('kolm verify <artifact>.kolm --binder council.html')));

  const followup = await classifyIntent('ok do it', {
    previous_workflow: {
      steps: [{ cmd: 'kolm capture --provider openai --as ks_proxy', why: 'capture first' }],
    },
  });
  assert.equal(followup.verb, 'capture');
  assert.equal(followup.source, 'followup');
  assert.deepEqual(followup.args, ['--provider', 'openai', '--as', 'ks_proxy']);

  const low = await classifyIntent('can you do the risky paid operation maybe with no details');
  assert.equal(low.verb, 'ask');
  assert.equal(low.source, 'low_confidence');
  assert.ok(low.alternatives.length >= 1);
});

test('W943 collision fixes route provenance and diagnosis phrases deterministically', async () => {
  const diagnosis = await classifyIntent('diagnose');
  assert.equal(diagnosis.verb, 'diagnose');

  const setup = await classifyIntent('diagnose setup');
  assert.equal(setup.verb, 'doctor');

  const showProvenance = await classifyIntent('show provenance');
  assert.equal(showProvenance.verb, 'lineage');

  const verifyProvenance = await classifyIntent('verify provenance');
  assert.equal(verifyProvenance.verb, 'verify');
});
