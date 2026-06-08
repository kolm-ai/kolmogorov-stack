// Wave 553 - backend readiness: cloud GPU/storage detection + production
// observability wiring.
//
// NOTE: this wave originally had five checks. The 2026 site teardown retired the
// multi-surface compiler product that two of them described:
//   - "#1 platform matrix ... evidence" asserted every capability row pointed at
//     a live page (public/sdk.js, compute.html, account/*.html, ...) — all
//     deleted with that surface.
//   - "#3 repo codegraph" asserted page-routes (/account/overview, /compute,
//     /models, /captures, /distill, /train, /spec) + a >=300 route / 50-evidence
//     count that only held for the old surface.
// Both were removed. The live-backend checks that survive the teardown intact —
// cloud-provider env detection (#2), the OTEL module (#4), and the machine-
// readable `kolm cloud readiness` CLI surface (#5) — are kept below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  cloudReadinessSummary,
  deploymentProfiles,
  detectCloudReadiness,
} from '../src/platform-capabilities.js';
import * as otel from '../src/otel.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W553 #2 - cloud readiness detects storage, hosted GPU, teacher, and observability wiring without printing secrets', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'secret-token',
    R2_BUCKET: 'kolm-artifacts',
    KOLM_RUNPOD_TOKEN: 'runpod-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    KOLM_OTEL: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.local:4318',
  };
  const ready = detectCloudReadiness(env);
  assert.equal(ready.ok, true);
  assert.ok(ready.providers.find((p) => p.id === 'cloudflare-r2' && p.configured));
  assert.ok(ready.providers.find((p) => p.id === 'runpod-gpu' && p.configured));
  assert.ok(ready.providers.find((p) => p.id === 'anthropic-teacher' && p.configured));
  assert.ok(ready.providers.find((p) => p.id === 'otel-collector' && p.configured));
  assert.ok(ready.providers.find((p) => p.id === 'cloudflare-r2' && /R2/.test(p.label)));
  assert.ok(ready.providers.find((p) => p.id === 'supabase-storage' && Array.isArray(p.caveats)));
  assert.doesNotMatch(JSON.stringify(ready), /secret-token|runpod-secret|anthropic-secret/);

  const profiles = deploymentProfiles(env);
  assert.ok(profiles.some((p) => p.id === 'local-private' && p.configured));
  assert.ok(profiles.some((p) => p.id === 'hosted-gpu-train' && p.configured));
  assert.ok(profiles.some((p) => p.id === 'r2-managed-edge' && p.configured));
  assert.ok(profiles.some((p) => p.id === 's3-self-hosted-ssh' && !p.configured));

  const empty = cloudReadinessSummary({});
  assert.equal(empty.ok, false);
  assert.ok(empty.blockers.includes('no_artifact_storage_configured'));
  assert.ok(empty.blockers.includes('no_hosted_gpu_or_managed_train_configured'));
  assert.ok(empty.blockers.includes('no_cloud_or_remote_compute_configured'));
});

test('W553 #4 - OTEL module is importable ESM and server can mount middleware only when enabled', async () => {
  assert.equal(typeof otel.init, 'function');
  assert.equal(typeof otel.expressMiddleware, 'function');
  assert.equal(otel.init({ enabled: false }), false);
  const span = otel.startSpan('kolm.test', { 'kolm.surface': 'test' });
  assert.equal(typeof span.traceId, 'string');
  assert.equal(span.traceId.length, 32);
  await otel.shutdown();
});

test('W553 #5 - CLI cloud readiness is wired and machine-readable', () => {
  const env = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'secret-token',
    R2_BUCKET: 'kolm-artifacts',
    KOLM_RUNPOD_TOKEN: 'runpod-secret',
  };
  const r = spawnSync(process.execPath, ['cli/kolm.js', 'cloud', 'readiness', '--json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.platform_matrix.ok, true);
  assert.ok(parsed.cloud.providers.some((p) => p.id === 'cloudflare-r2' && p.configured));
  assert.ok(parsed.deployment_profiles.some((p) => p.id === 'hosted-gpu-train' && p.configured));
  assert.doesNotMatch(r.stdout, /secret-token|runpod-secret/);
});
