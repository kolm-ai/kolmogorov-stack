import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  kernelCatalog,
  makeNextAction,
  makeProofRef,
  normalizeReadiness,
  readinessClaimScope,
  validateKernelNode,
} from '../src/product-kernel.js';
import {
  errorEnvelope,
  jobEnvelope,
  okEnvelope,
  readinessEnvelope,
} from '../src/envelope.js';

test('product kernel exposes the structural vocabulary required by all product surfaces', () => {
  const catalog = kernelCatalog();
  assert.equal(catalog.version, '2026-05-22');
  assert.ok(catalog.readiness_statuses.includes('needs_public_benchmark_data'));
  assert.ok(catalog.readiness_statuses.includes('needs_live_certification'));
  assert.ok(catalog.route_classes.some((row) => row.id === 'build-launch'));
  assert.ok(catalog.deployment_modes.some((row) => row.id === 'airgap'));
  assert.ok(catalog.failure_codes.some((row) => row.code === 'compute_missing'));
  assert.ok(catalog.proof_kinds.includes('artifact_hash'));
});

test('readiness normalization preserves honest claim scope', () => {
  assert.equal(readinessClaimScope('needs_public_benchmark_data'), 'benchmark-gated');
  assert.deepEqual(normalizeReadiness({
    status: 'needs_package_release',
    requirement_ids: ['runtime-wasm'],
  }), {
    status: 'needs_package_release',
    claim_scope: 'package-release-gated',
    external_requirements: [],
    requirement_ids: ['runtime-wasm'],
  });
});

test('proof refs and next actions are typed and stable', () => {
  assert.deepEqual(makeProofRef('artifact_hash', 'sha256:abc'), {
    kind: 'artifact_hash',
    id: 'sha256:abc',
  });
  assert.deepEqual(makeNextAction({
    label: 'Run cloud readiness',
    value: 'kolm cloud readiness --json',
    surface: 'compute-cloud',
  }), {
    kind: 'command',
    label: 'Run cloud readiness',
    value: 'kolm cloud readiness --json',
    href: null,
    surface: 'compute-cloud',
    journey: null,
    priority: 'P1',
  });
  assert.throws(() => makeProofRef('unknown', 'x'), /unknown proof kind/);
});

test('kernel node validation catches bad IDs, stages, and readiness', () => {
  assert.equal(validateKernelNode({
    id: 'compile-verify',
    stage: 'compile',
    readiness: { status: 'implemented' },
  }).ok, true);
  const bad = validateKernelNode({
    id: 'Compile Verify',
    stage: 'nonsense',
    readiness: { status: 'magic' },
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures.sort(), ['bad_id', 'bad_readiness', 'bad_stage']);
});

test('ok envelope uses surface, journey, readiness, tenant, evidence, and actions consistently', () => {
  const env = okEnvelope({
    surface: 'compile-verify',
    readiness: { status: 'implemented', requirement_ids: ['standalone-verify'] },
    tenant: { tenant_id: 'tenant_1', workspace_id: 'ws_1' },
    data: { artifact_id: 'art_1' },
    evidence: { artifact_ids: ['art_1'], receipt_ids: ['rcp_1'] },
    next_actions: [{ label: 'Verify artifact', value: 'kolm verify task.kolm' }],
  });
  assert.equal(env.ok, true);
  assert.equal(env.surface, 'compile-verify');
  assert.equal(env.journey, 'compile-verify');
  assert.equal(env.readiness.claim_scope, 'local-implementation');
  assert.equal(env.tenant.id, 'tenant_1');
  assert.deepEqual(env.evidence.artifact_ids, ['art_1']);
  assert.equal(env.next_actions[0].value, 'kolm verify task.kolm');
});

test('error envelope maps known failure codes to severity, retryability, and next action', () => {
  const env = errorEnvelope({
    code: 'compute_missing',
    surface: 'train-distill',
    message: 'No GPU or hosted compute provider is configured.',
  });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'compute_missing');
  assert.equal(env.error.severity, 'blocker');
  assert.equal(env.error.retryable, true);
  assert.equal(env.next_actions.length, 1);
});

test('readiness and job envelopes produce product-surface proof shapes', () => {
  const readiness = readinessEnvelope({
    surface: 'compute-cloud',
    status: 'needs_package_release',
    external_requirements: ['publish edge package'],
    blockers: ['package release'],
  });
  assert.equal(readiness.readiness.claim_scope, 'package-release-gated');
  assert.deepEqual(readiness.data.blockers, ['package release']);

  const job = jobEnvelope({
    surface: 'train-distill',
    job: { id: 'job_1', status: 'queued' },
  });
  assert.equal(job.data.job.id, 'job_1');
  assert.deepEqual(job.evidence.proof_refs, [{ kind: 'job_id', id: 'job_1' }]);
});

test('CLI and TUI expose the generated product graph and readiness closeout ledger', () => {
  const cli = fileURLToPath(new URL('../cli/kolm.js', import.meta.url));
  const surfaces = spawnSync(process.execPath, [cli, 'surfaces', '--json'], { encoding: 'utf8' });
  assert.equal(surfaces.status, 0, surfaces.stderr);
  const surfaceJson = JSON.parse(surfaces.stdout);
  assert.equal(surfaceJson.graph_available, true);
  assert.equal(surfaceJson.closeout_available, true);
  assert.equal(surfaceJson.contract.counts.surfaces, 12);
  assert.ok(surfaceJson.readiness_counts.shipped >= 1);
  assert.ok(surfaceJson.closeout_counts.open_requirements >= 0);

  const tui = spawnSync(process.execPath, [cli, 'tui', '--views', '--json'], { encoding: 'utf8' });
  assert.equal(tui.status, 0, tui.stderr);
  const tuiJson = JSON.parse(tui.stdout);
  assert.equal(tuiJson.product_graph_counts.tui_views, tuiJson.views.length);
  assert.deepEqual(tuiJson.readiness_counts, surfaceJson.readiness_counts);
});
