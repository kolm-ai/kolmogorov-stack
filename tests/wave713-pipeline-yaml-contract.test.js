// W713 - direct contract test for src/pipeline-yaml.js.
//
// The W738 pipeline YAML schema is a provenance boundary: it controls which
// classifier artifact, route artifacts, and hosted-teacher IDs a composed
// pipeline can invoke. These tests pin bounded parsing, safe route labels,
// CID canonicalization, unknown-key rejection, and prototype-pollution guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PIPELINE_YAML_CONTRACT_VERSION,
  PIPELINE_YAML_LIMITS,
  PIPELINE_YAML_VERSION,
  collectReferencedCids,
  parsePipelineYaml,
  starterPipelineYaml,
  validatePipelineYaml,
} from '../src/pipeline-yaml.js';

function shaCid(ch) {
  return `sha256-${ch.repeat(64)}`;
}

function validYaml() {
  return [
    'version: w738-v1',
    'name: support-triage',
    'classifier:',
    `  artifact_cid: ${shaCid('A')}`,
    '  version: v1',
    'routes:',
    '  billing:',
    `    artifact_cid: ${shaCid('B')}`,
    '  escalation:',
    '    teacher: claude-sonnet-4-6',
    '',
  ].join('\n');
}

function errorsByPath(validation) {
  const out = new Map();
  for (const entry of validation.errors || []) {
    if (!out.has(entry.path)) out.set(entry.path, new Set());
    out.get(entry.path).add(entry.error);
  }
  return out;
}

test('W713 pipeline-yaml is wired into the direct depth verifier', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../src/pipeline-yaml.js', import.meta.url), 'utf8');

  assert.equal(PIPELINE_YAML_VERSION, 'w738-v1');
  assert.equal(PIPELINE_YAML_CONTRACT_VERSION, 'w713-v1');
  assert.equal(
    pkg.scripts['verify:pipeline-yaml'],
    'node --test --test-concurrency=1 tests/wave713-pipeline-yaml-contract.test.js',
  );
  assert.ok(
    pkg.scripts['verify:depth'].includes('verify:pipeline-runner && npm run verify:pipeline-yaml && npm run verify:device-daemon'),
    'verify:depth must run pipeline-yaml immediately after pipeline-runner',
  );
  assert.ok(PIPELINE_YAML_LIMITS.max_yaml_chars <= 64_000);
  assert.ok(PIPELINE_YAML_LIMITS.max_routes <= 128);
  assert.match(source, /SAFE_ROUTE_LABEL_RE/);
  assert.match(source, /unsafe_mapping_prototype/);
});

test('W713 valid pipeline yaml parses to canonical cids and stable references', () => {
  const parsed = parsePipelineYaml(validYaml());
  const validation = validatePipelineYaml(parsed);

  assert.deepEqual(validation, { ok: true });
  assert.equal(parsed.version, PIPELINE_YAML_VERSION);
  assert.equal(parsed.name, 'support-triage');
  assert.equal(parsed.classifier.artifact_cid, shaCid('a'));
  assert.equal(parsed.routes.billing.artifact_cid, shaCid('b'));
  assert.equal(parsed.routes.escalation.teacher, 'claude-sonnet-4-6');
  assert.deepEqual(collectReferencedCids(parsed), [shaCid('a'), shaCid('b')]);
});

test('W713 starter pipeline remains a self-validating schema example', () => {
  const parsed = parsePipelineYaml(starterPipelineYaml());
  const validation = validatePipelineYaml(parsed);

  assert.deepEqual(validation, { ok: true }, JSON.stringify(validation));
  assert.equal(collectReferencedCids(parsed).length, 3);
});

test('W713 parser rejects non-string roots and oversized YAML before schema work', () => {
  assert.throws(
    () => parsePipelineYaml(123),
    (err) => err && err.code === 'pipeline_yaml_input_not_string',
  );
  assert.throws(
    () => parsePipelineYaml('x'.repeat(PIPELINE_YAML_LIMITS.max_yaml_chars + 1)),
    (err) => err && err.code === 'pipeline_yaml_too_large' && err.max_chars === PIPELINE_YAML_LIMITS.max_yaml_chars,
  );
});

test('W713 validator rejects unknown keys, unsafe labels, paths, and ambiguous targets', () => {
  const parsed = parsePipelineYaml([
    'version: w738-v1',
    'name: support-triage',
    'unexpected: true',
    'classifier:',
    `  artifact_cid: ${shaCid('a')}`,
    '  local_path: ./classifier.kolm',
    'routes:',
    '  billing:',
    '    artifact_cid: ../billing.kolm',
    '    teacher: anthropic/claude',
    '    extra: true',
    '  bad/label:',
    `    artifact_cid: ${shaCid('b')}`,
    '  escalation:',
    '    teacher: anthropic/claude',
    '',
  ].join('\n'));
  const validation = validatePipelineYaml(parsed);
  const byPath = errorsByPath(validation);

  assert.equal(validation.ok, false);
  assert.ok(byPath.get('unexpected').has('unknown_key'));
  assert.ok(byPath.get('classifier.local_path').has('unknown_key'));
  assert.ok(byPath.get('routes.billing').has('must_not_have_both_artifact_cid_and_teacher'));
  assert.ok(byPath.get('routes.billing.extra').has('unknown_key'));
  assert.ok(byPath.get('routes.bad/label').has('label_must_match_safe_pattern'));
  assert.ok(byPath.get('routes.escalation.teacher').has('must_match_safe_teacher_id'));
});

test('W713 validator caps route count and rejects unsafe mapping prototypes', () => {
  const routeLines = [];
  for (let i = 0; i < PIPELINE_YAML_LIMITS.max_routes + 1; i++) {
    routeLines.push(`  r${i}:`);
    routeLines.push(`    artifact_cid: ${shaCid('b')}`);
  }
  const tooMany = parsePipelineYaml([
    'version: w738-v1',
    'name: support-triage',
    'classifier:',
    `  artifact_cid: ${shaCid('a')}`,
    'routes:',
    ...routeLines,
    '',
  ].join('\n'));
  const countValidation = validatePipelineYaml(tooMany);
  assert.ok(errorsByPath(countValidation).get('routes').has('too_many'));

  const polluted = parsePipelineYaml([
    'version: w738-v1',
    'name: support-triage',
    'classifier:',
    `  artifact_cid: ${shaCid('a')}`,
    'routes:',
    '  __proto__:',
    `    artifact_cid: ${shaCid('b')}`,
    '  billing:',
    `    artifact_cid: ${shaCid('b')}`,
    '',
  ].join('\n'));
  const pollutedValidation = validatePipelineYaml(polluted);

  assert.equal(Object.prototype.artifact_cid, undefined);
  assert.equal(pollutedValidation.ok, false);
  assert.ok(errorsByPath(pollutedValidation).get('routes').has('unsafe_mapping_prototype'));
});

test('W713 collectReferencedCids ignores inherited, invalid, and over-limit routes', () => {
  const routes = Object.create({
    inherited: { artifact_cid: shaCid('f') },
  });
  routes.safe = { artifact_cid: shaCid('c').toUpperCase() };
  routes['bad/label'] = { artifact_cid: shaCid('d') };
  routes.empty = { artifact_cid: '../not-a-cid.kolm' };

  const out = collectReferencedCids({
    classifier: { artifact_cid: shaCid('a').toUpperCase() },
    routes,
  });

  assert.deepEqual(out, [shaCid('a'), shaCid('c')]);
});
