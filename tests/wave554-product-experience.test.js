// Wave 554 - product-depth lock-ins.
// @public-routes-only
//
// The user-facing promise is broader than "routes exist": each major surface
// must be usable through account UI, CLI, TUI, API, cloud/self-host controls,
// privacy controls, and proof paths. These tests pin that product contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  USER_CONTROL_DIMENSIONS,
  accountSectionsBySurface,
  apiRoutesBySurface,
  listProductExperience,
  tuiViews,
  validateProductExperience,
} from '../src/product-experience.js';
import { provisionAnonTenant } from '../src/auth.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function tmpMediaDir() {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || ROOT, 'kolm-w554-'));
  const file = path.join(dir, 'retina-scan.png');
  fs.writeFileSync(file, PNG_1X1);
  return { dir, file };
}

test('W554 #1 - product experience contract covers every user-control dimension and product surface', () => {
  const result = validateProductExperience();
  assert.equal(result.ok, true, result.missing.join(', '));
  assert.equal(result.counts.surfaces, 12);
  assert.ok(result.counts.account_links >= 20);
  assert.ok(result.counts.cli_commands >= 50);
  assert.ok(result.counts.tui_views >= 16);
  assert.ok(result.counts.api_routes >= 55);
  assert.equal(result.counts.customization_dimensions, 8);

  const dimensions = new Set(USER_CONTROL_DIMENSIONS.map((d) => d.id));
  for (const id of ['model-provider', 'compute-target', 'artifact-runtime', 'storage-plane', 'privacy-mode', 'deployment-mode', 'governance-mode', 'proof-mode']) {
    assert.ok(dimensions.has(id), `missing customization dimension ${id}`);
  }

  const surfaces = new Set(listProductExperience().map((s) => s.id));
  for (const id of ['gateway-capture', 'privacy-lake', 'datasets-labeling', 'train-distill', 'models-backbones', 'multimodal-tokenization', 'compile-verify', 'runtime-inference', 'compute-cloud', 'devices-fleet', 'enterprise-governance', 'agents-registry']) {
    assert.ok(surfaces.has(id), `missing product surface ${id}`);
  }
});

test('W554 #2 - every product surface has account pages, API routes, and evidence paths that resolve locally', () => {
  const router = read('src/router.js');
  for (const surface of listProductExperience()) {
    for (const accountPath of surface.account) {
      const clean = accountPath.replace(/^\/+/, '');
      const htmlPath = path.join(ROOT, 'public', `${clean}.html`);
      assert.equal(fs.existsSync(htmlPath), true, `${surface.id} missing account page ${accountPath}`);
    }
    for (const evidencePath of surface.evidence_paths) {
      assert.equal(fs.existsSync(path.join(ROOT, evidencePath)), true, `${surface.id} missing evidence ${evidencePath}`);
    }
    for (const route of surface.api) {
      const routePath = route.trim().split(/\s+/).pop();
      const loose = routePath.replace(/:[A-Za-z0-9_]+/g, '');
      assert.ok(router.includes(routePath) || router.includes(loose), `${surface.id} missing route ${route}`);
    }
  }

  const account = accountSectionsBySurface();
  assert.ok(account['compute-cloud'].includes('/account/storage'));
  assert.ok(account['enterprise-governance'].includes('/account/audit-log'));
  const api = apiRoutesBySurface();
  assert.ok(api['gateway-capture'].includes('POST /v1/capture/anthropic'));
  assert.ok(api['compute-cloud'].includes('GET /v1/cloud/readiness'));
  assert.ok(api['compute-cloud'].includes('POST /v1/byoc/deploy'));
});

test('W554 #3 - CLI exposes a machine-readable product surface map', () => {
  const r = spawnSync(process.execPath, ['cli/kolm.js', 'surfaces', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.surfaces.length, 12);
  assert.ok(parsed.surfaces.some((s) => s.id === 'compute-cloud' && s.customization.includes('storage-plane')));
  assert.ok(parsed.surfaces.some((s) => s.id === 'train-distill' && s.customization.includes('compute-target')));
  assert.ok(parsed.surfaces.some((s) => s.id === 'compute-cloud' && s.cli.some((cmd) => cmd.includes('--remote'))));
  assert.ok(parsed.surfaces.some((s) => s.id === 'devices-fleet' && s.api.includes('POST /v1/tunnel/register')));
  assert.ok(parsed.surfaces.some((s) => s.id === 'models-backbones' && /Gemma 3n/.test(s.user_goal)));
  assert.ok(parsed.surfaces.some((s) => s.id === 'multimodal-tokenization' && s.cli.some((cmd) => cmd.includes('media tokenize'))));
  assert.ok(parsed.customization_dimensions.some((d) => d.id === 'model-provider' && d.options.includes('Anthropic Claude')));
  assert.doesNotMatch(r.stdout, /ks_[a-z0-9]+|secret-token|sk-[A-Za-z0-9_-]+/i);
});

test('W554 #4 - TUI view contract is testable without launching an interactive terminal', () => {
  const r = spawnSync(process.execPath, ['cli/kolm.js', 'tui', '--views', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  const viewIds = new Set(parsed.views.map((v) => v.id));
  for (const id of ['live-calls', 'connectors', 'privacy-events', 'opportunities', 'labeling-queue', 'datasets', 'builds', 'artifacts', 'compile', 'models', 'devices', 'audit-log', 'billing', 'settings', 'multimodal-tokenize', 'multimodal-bakeoff']) {
    assert.ok(viewIds.has(id), `missing TUI view ${id}`);
  }
});

test('W554 #5 - post-auth overview has the product command center, not only metrics', () => {
  const html = read('public/account/overview.html');
  const storage = read('public/account/storage.html');
  assert.match(html, /data-postauth-product-command-center/);
  for (const id of ['gateway-capture', 'privacy-lake', 'datasets-labeling', 'train-distill', 'models-backbones', 'multimodal-tokenization', 'compile-verify', 'runtime-inference', 'compute-cloud', 'devices-fleet', 'enterprise-governance', 'agents-registry']) {
    assert.match(html, new RegExp(`data-journey-id="${id}"`), `missing account journey card ${id}`);
  }
  assert.match(html, /R2-compatible object storage, S3-compatible storage, AWS, Supabase, Modal, RunPod, Lambda, Together, or remote SSH/);
  assert.match(html, /OpenAI, Claude, OpenRouter, Gemini-compatible, or self-hosted/);
  assert.match(storage, /data-panel="cloud-readiness"/);
  assert.match(storage, /id="cloud-deployment-profiles"/);
  assert.match(storage, /\/v1\/cloud\/readiness/);
  assert.match(storage, /kolm cloud readiness --json/);
  assert.match(storage, /kolm cloud readiness --remote --json/);
  assert.match(storage, /hosted GPU, storage, and enterprise controls/i);
  const devices = read('public/account/devices.html');
  assert.match(devices, /data-panel="team-remote-ops"/);
  assert.match(devices, /kolm tunnel new --team/);
  assert.match(devices, /kolm install-device artifact\.kolm --device/);
  assert.doesNotMatch(storage, /secret-token|sk-[A-Za-z0-9_-]{16,}|ks_[a-f0-9]{16,}/i);
});

test('W554 #6 - product journey audit validates end-to-end user perspective coverage', () => {
  const r = spawnSync(process.execPath, ['scripts/audit-product-journeys.mjs', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, `journey audit failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true, parsed.failures.join(', '));
  assert.equal(parsed.counts.product_surfaces, 12);
  assert.equal(parsed.counts.journeys, 12);
  assert.ok(parsed.counts.research_references >= 8);
});

test('W554 #7 - hosted API exposes the same product experience contract without secrets', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/v1/product/experience`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.contract.ok, true);
  assert.equal(body.secret_values_included, false);
  assert.equal(body.surfaces.length, 12);
  assert.ok(body.platform_capabilities.model_framework_targets.length >= 16);
  assert.ok(body.platform_capabilities.deployment_profiles.some((p) => p.id === 's3-self-hosted-ssh'));
  assert.ok(body.cloud_readiness.blockers.includes('no_artifact_storage_configured'));
  assert.ok(body.cloud_readiness.deployment_profiles.some((p) => p.id === 'local-private' && p.configured));
  assert.doesNotMatch(JSON.stringify(body), /ks_[a-z0-9]+|secret-token|sk-[A-Za-z0-9_-]+/i);

  const cloud = await fetch(`http://127.0.0.1:${port}/v1/cloud/readiness`);
  assert.equal(cloud.status, 200);
  const cloudBody = await cloud.json();
  assert.equal(cloudBody.ok, true);
  assert.equal(cloudBody.secret_values_included, false);
  assert.equal(cloudBody.platform_matrix.ok, true);
  assert.ok(Array.isArray(cloudBody.blockers));
  assert.ok(cloudBody.readiness.deployment_profiles.some((p) => p.id === 'hosted-gpu-train'));
  assert.ok(cloudBody.cloud.providers.some((p) => p.id === 'remote-ssh-gpu'));
  assert.doesNotMatch(JSON.stringify(cloudBody), /ks_[a-z0-9]+|secret-token|sk-[A-Za-z0-9_-]+/i);
});

test('W554 #8 - local CLI multimodal tokenization writes compile-ready sidecars', () => {
  const { dir, file } = tmpMediaDir();
  try {
    const r = spawnSync(process.execPath, ['cli/kolm.js', 'media', 'tokenize', '--path', file, '--force', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.modality, 'image');
    assert.equal(parsed.skipped, false);
    assert.ok(parsed.sidecarPath.endsWith('.png.md'));
    const sidecar = fs.readFileSync(parsed.sidecarPath, 'utf8');
    assert.match(sidecar, /kolm-local-multimodal-features-v1/);
    assert.match(sidecar, /feature_tokenizer/);
    assert.match(sidecar, /retina-scan\.png/);
    assert.doesNotMatch(sidecar, /TODO|placeholder|coming soon/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W554 #9 - hosted tokenization route is disabled by default and works on trusted local daemons', async (t) => {
  const { dir, file } = tmpMediaDir();
  const priorDaemon = process.env.KOLM_LOCAL_DAEMON;
  const priorAllow = process.env.KOLM_ALLOW_SERVER_FILE_TOKENIZE;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 100 });
  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${tenant.api_key}` };
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.close();
    if (priorDaemon == null) delete process.env.KOLM_LOCAL_DAEMON;
    else process.env.KOLM_LOCAL_DAEMON = priorDaemon;
    if (priorAllow == null) delete process.env.KOLM_ALLOW_SERVER_FILE_TOKENIZE;
    else process.env.KOLM_ALLOW_SERVER_FILE_TOKENIZE = priorAllow;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { port } = server.address();
  delete process.env.KOLM_LOCAL_DAEMON;
  delete process.env.KOLM_ALLOW_SERVER_FILE_TOKENIZE;

  const denied = await fetch(`http://127.0.0.1:${port}/v1/multimodal/tokenize`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: file, force: true }),
  });
  assert.equal(denied.status, 403);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error, 'server_file_tokenize_disabled');

  process.env.KOLM_LOCAL_DAEMON = '1';
  const allowed = await fetch(`http://127.0.0.1:${port}/v1/multimodal/tokenize`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: file, force: true }),
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'file');
  assert.equal(body.modality, 'image');
  assert.equal(body.tokenizer, 'kolm-local-multimodal-features-v1');
  assert.ok(fs.existsSync(body.sidecar_path));

  const doctor = await fetch(`http://127.0.0.1:${port}/v1/multimodal/tokenize/doctor`, { headers: authHeaders });
  assert.equal(doctor.status, 200);
  const doctorBody = await doctor.json();
  assert.equal(doctorBody.ok, true);
  assert.equal(doctorBody.local_daemon, true);
  assert.equal(doctorBody.secret_values_included, false);
});
