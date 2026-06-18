// W690 - direct contract test for src/pipeline-runner.js.
//
// This component is the synchronous artifact-composition execution boundary:
// classifier output selects a route, route execution crosses either artifact
// loading or teacher invocation, and compilePipeline emits the replay sidecar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  compilePipeline,
  PIPELINE_RUNNER_LIMITS,
  PIPELINE_RUNNER_VERSION,
  runPipeline,
} from '../src/pipeline-runner.js';

const HEX_64 = /^[a-f0-9]{64}$/;
const SHA256_URI = /^sha256-[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function shaCid(ch) {
  return `sha256-${ch.repeat(64)}`;
}

function pipelineFixture(overrides = {}) {
  return {
    version: 'w738-v1',
    name: 'support-triage',
    classifier: {
      artifact_cid: shaCid('a'),
      version: 'v1',
    },
    routes: {
      billing: { artifact_cid: shaCid('b') },
      escalation: { teacher: 'teacher-alpha-v1' },
    },
    ...overrides,
  };
}

function yamlFixture(routeCid = shaCid('b')) {
  return [
    'version: w738-v1',
    'name: support-triage',
    'classifier:',
    `  artifact_cid: ${shaCid('a')}`,
    '  version: v1',
    'routes:',
    '  billing:',
    `    artifact_cid: ${routeCid}`,
    '  escalation:',
    '    teacher: teacher-alpha-v1',
    '',
  ].join('\n');
}

test('W690 pipeline-runner is wired into the direct depth verifier', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../src/pipeline-runner.js', import.meta.url), 'utf8');

  assert.equal(PIPELINE_RUNNER_VERSION, 'w738-v2');
  assert.equal(
    pkg.scripts['verify:pipeline-runner'],
    'node --test --test-concurrency=1 tests/wave690-pipeline-runner-contract.test.js',
  );
  const nextDepthVerifier = ['verify', ['device', 'daemon'].join('-')].join(':');
  assert.ok(
    pkg.scripts['verify:depth'].includes(`verify:compile-server && npm run verify:pipeline-runner && npm run verify:pipeline-yaml && npm run ${nextDepthVerifier}`),
    'verify:depth must run pipeline-runner, pipeline-yaml, then the next runtime verifier',
  );
  assert.match(source, /function _stableJson/);
  assert.match(source, /Object\.create\(null\)/);
  assert.match(source, /sidecar_content_sha256/);
  assert.match(source, /pipeline_receipt_sha256/);
  assert.ok(PIPELINE_RUNNER_LIMITS.MAX_INPUT_CHARS <= 32_000, 'input cap must stay bounded');
});

test('W690 runPipeline emits replayable artifact-route receipts', async () => {
  const seen = [];
  const pipeline = pipelineFixture();
  const input = 'where is invoice inv-2026';

  const out = await runPipeline({
    pipeline,
    input,
    tenant_id: 'tenant-acme',
    artifact_loader: async (cid, ctx) => {
      seen.push({ cid, ctx });
      if (cid === shaCid('a')) return { run: () => 'billing' };
      if (cid === shaCid('b')) return { run: (prompt) => `billing answer for ${prompt}` };
      throw new Error('unexpected artifact');
    },
  });

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result, `billing answer for ${input}`);
  assert.equal(out.classifier_label, 'billing');
  assert.deepEqual(out.route_taken, { kind: 'artifact', cid: shaCid('b'), label: 'billing' });
  assert.match(out.input_sha256, HEX_64);
  assert.equal(out.input_sha256, sha256(input));
  assert.match(out.pipeline_spec_sha256, HEX_64);
  assert.match(out.pipeline_receipt_sha256, HEX_64);
  assert.equal(out.pipeline_receipt.receipt_sha256, out.pipeline_receipt_sha256);
  assert.equal(out.pipeline_receipt.result_sha256, sha256(out.result));
  assert.equal(out.pipeline_receipt.tenant_id_sha256, sha256('tenant-acme'));
  assert.deepEqual(seen, [
    { cid: shaCid('a'), ctx: { tenant_id: 'tenant-acme' } },
    { cid: shaCid('b'), ctx: { tenant_id: 'tenant-acme' } },
  ]);
});

test('W690 runPipeline bounds inputs, IDs, labels, and redacts loader failures', async () => {
  const valid = pipelineFixture();
  let calls = 0;
  const tooLarge = await runPipeline({
    pipeline: valid,
    input: 'x'.repeat(PIPELINE_RUNNER_LIMITS.MAX_INPUT_CHARS + 1),
    artifact_loader: async () => {
      calls += 1;
      return { run: () => 'billing' };
    },
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error, 'input_too_large');
  assert.equal(calls, 0, 'oversized input must fail before artifact loading');

  const pathCid = await runPipeline({
    pipeline: pipelineFixture({ classifier: { artifact_cid: '../classifier.kolm' } }),
    input: 'hello',
    artifact_loader: async () => ({ run: () => 'billing' }),
  });
  assert.equal(pathCid.ok, false);
  assert.equal(pathCid.error, 'artifact_cid_must_not_be_path');

  const badLabel = await runPipeline({
    pipeline: valid,
    input: 'hello',
    artifact_loader: async () => ({ run: () => 'bad\u0001label' }),
  });
  assert.equal(badLabel.ok, false);
  assert.equal(badLabel.error, 'classifier_label_control_chars');

  const secretFailure = await runPipeline({
    pipeline: valid,
    input: 'hello',
    artifact_loader: async () => {
      throw new Error('bad alice@example.com 123-45-6789 ghp_abcdefghijklmnopqrst');
    },
  });
  assert.equal(secretFailure.ok, false);
  assert.equal(secretFailure.error, 'classifier_load_failed');
  assert.match(secretFailure.detail_sha256, HEX_64);
  assert.doesNotMatch(secretFailure.detail, /alice@example\.com/);
  assert.doesNotMatch(secretFailure.detail, /123-45-6789/);
  assert.doesNotMatch(secretFailure.detail, /ghp_abcdefghijklmnopqrst/);
  assert.match(secretFailure.detail, /\[redacted_email\]/);
  assert.match(secretFailure.detail, /\[redacted_ssn\]/);
  assert.match(secretFailure.detail, /\[redacted_secret\]/);
});

test('W690 compilePipeline sidecar hashes are replayable and timestamp-independent', async () => {
  const first = await compilePipeline(yamlFixture(), { created_at: '2026-01-01T00:00:00.000Z' });
  const second = await compilePipeline(yamlFixture(), { created_at: '2027-01-01T00:00:00.000Z' });
  const changed = await compilePipeline(yamlFixture(shaCid('c')), { created_at: '2027-01-01T00:00:00.000Z' });

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.notEqual(first.sidecar.created_at, second.sidecar.created_at);
  assert.equal(first.sidecar.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(second.sidecar.created_at, '2027-01-01T00:00:00.000Z');
  assert.match(first.sidecar_hash, SHA256_URI);
  assert.equal(first.sidecar_hash, first.sidecar_content_sha256);
  assert.equal(first.sidecar_hash, second.sidecar_hash, 'created_at must not rotate replay handles');
  assert.notEqual(first.sidecar_hash, changed.sidecar_hash, 'route cid changes must rotate replay handles');
  assert.deepEqual(first.sidecar.parent_cids, [shaCid('a'), shaCid('b')].sort());
  assert.equal(first.sidecar.referenced_cid_count, 2);
});
