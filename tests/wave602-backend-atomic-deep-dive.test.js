import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.resolve(process.cwd());
const LEDGER = path.join(ROOT, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');
const doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

function byPath(p) {
  return doc.components.find((component) => component.path === p);
}

test('W602 #1 - backend atomic deep-dive ledger is generated from the current tree', () => {
  const out = execFileSync(process.execPath, ['scripts/build-backend-atomic-deep-dive.mjs', '--check', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.component_count, doc.components.length);
});

test('W602 #2 - every atomic backend component has a complete deep-dive contract', () => {
  assert.equal(doc.schema, 'kolm-backend-atomic-deep-dive-1');
  assert.ok(doc.components.length >= 780, `component count too small: ${doc.components.length}`);
  for (const component of doc.components) {
    assert.ok(component.path, 'component path missing');
    assert.ok(component.sha256 && /^[a-f0-9]{64}$/.test(component.sha256), `${component.path}: bad sha256`);
    assert.ok(component.domain, `${component.path}: domain missing`);
    assert.ok(component.surface, `${component.path}: surface missing`);
    assert.ok(Number.isInteger(component.metrics.lines) && component.metrics.lines > 0, `${component.path}: lines missing`);
    assert.ok(Array.isArray(component.risk_signals), `${component.path}: risk_signals missing`);
    assert.ok(component.improvement_track, `${component.path}: improvement_track missing`);
    assert.ok(component.innovation_opportunity, `${component.path}: innovation_opportunity missing`);
    assert.ok(Array.isArray(component.suggested_verification) && component.suggested_verification.length > 0, `${component.path}: suggested verification missing`);
    assert.equal(component.deep_dive.status, 'atomic_deep_dive_complete', `${component.path}: deep-dive status invalid`);
    assert.equal(component.deep_dive.reviewed_at, '2026-06-17', `${component.path}: reviewed_at drifted`);
    assert.deepEqual(component.deep_dive.lenses, doc.review_lenses, `${component.path}: lenses drifted`);
    assert.ok(component.deep_dive.exit_criteria.includes('component_is_named_in_atomic_ledger'), `${component.path}: exit criteria missing`);
  }
});

test('W602 #3 - load-bearing backend components are present and classified', () => {
  const expected = {
    'server.js': 'api_surface',
    'src/router.js': 'api_surface',
    'src/auth.js': 'identity_access',
    'src/store.js': 'storage_state',
    'src/compile-pipeline.js': 'compile_artifact_runtime',
    'src/artifact.js': 'compile_artifact_runtime',
    'src/audit-orchestrator.js': 'trust_security_compliance',
    'src/distill-strategy.js': 'training_model_optimization',
    'workers/distill/scripts/train_lora.py': 'training_model_optimization',
    'packages/attestation/src/index.js': 'trust_security_compliance',
    'packages/runtime-rs/src/verify.rs': 'compile_artifact_runtime',
  };
  for (const [p, domain] of Object.entries(expected)) {
    const component = byPath(p);
    assert.ok(component, `${p}: missing from atomic ledger`);
    assert.equal(component.domain, domain, `${p}: wrong domain`);
  }
});

test('W602 #4 - summary keeps the improvement review actionable', () => {
  const domains = Object.keys(doc.summary.domains);
  for (const required of [
    'api_surface',
    'identity_access',
    'storage_state',
    'compile_artifact_runtime',
    'training_model_optimization',
    'trust_security_compliance',
    'runtime_serving_routing',
    'infra_cloud_device',
    'developer_distribution',
  ]) {
    assert.ok(domains.includes(required), `missing domain summary ${required}`);
  }
  assert.ok(doc.summary.top_review_targets.length >= 20);
  assert.ok(doc.summary.high_priority_components > 0);
  assert.ok(doc.improvement_themes.length >= 5);
});

test('W602 #5 - new atomic-review source artifacts avoid banned legacy wording', () => {
  const banned = new RegExp(`\\b${['hon', 'est'].join('')}(?:y|ly)?\\b`, 'i');
  const files = [
    'scripts/build-backend-atomic-deep-dive.mjs',
    'docs/backend-atomic-component-deep-dive-2026-06-17.md',
    'tests/wave602-backend-atomic-deep-dive.test.js',
  ];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(body, banned, rel);
  }
});
