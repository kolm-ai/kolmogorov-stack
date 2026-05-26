// @public-routes-only
// Wave 552 - lock the broad product-surface scope the launch audit asked for:
// real Gemma rows, non-placeholder multimodal tokenization, and post-auth
// account coverage for the whole API -> train/distill -> compile -> deploy loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as eventStore from '../src/event-store.js';
import * as captureStore from '../src/capture-store.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W552 #1 - Gemma catalog uses real Gemma 3 / Gemma 3n rows, not stale Gemma 4 claims', async () => {
  const R = await import('../src/model-registry.js');
  const M = await import('../src/models.js');
  const allFrontierIds = [...R.FRONTIER_MODELS, ...R.CANDIDATE_MODELS].map((m) => m.id);
  const allBackboneIds = R.BACKBONES.map((m) => m.id);
  const allModelIds = M.MODELS.map((m) => m.id);

  assert.ok(allFrontierIds.includes('google/gemma-3-27b-it'), 'frontier/candidate catalog must expose Gemma 3 27B');
  assert.ok(allBackboneIds.includes('google/gemma-3n-E2B-it'), 'backbone catalog must expose Gemma 3n E2B');
  assert.ok(allBackboneIds.includes('google/gemma-3n-E4B-it'), 'backbone catalog must expose Gemma 3n E4B');
  assert.ok(allModelIds.includes('google/embeddinggemma-300m'), 'task model registry must expose EmbeddingGemma');
  assert.ok(allModelIds.includes('google/medgemma-4b-it'), 'task model registry must expose MedGemma');

  const publicAndCode = [
    read('src/model-registry.js'),
    read('src/benchmarks.js'),
    read('src/model-weights-manifest.js'),
    read('public/models.html'),
  ].join('\n');
  assert.doesNotMatch(publicAndCode, /gemma-4-26b-a4b-it|Gemma 4 sparse|Gemma 4,|Gemma 4 \//);
});

test('W552 #2 - multimodal tokenizer emits local feature tokens instead of placeholder sidecars', async () => {
  const { tokenize, detectModality } = await import('../services/embed/multimodal.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-mm-'));
  const png = path.join(dir, 'patient-scan.png');
  const oneByOnePng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
  fs.writeFileSync(png, oneByOnePng);

  assert.equal(detectModality(png), 'image');
  const out = await tokenize(png, { force: true });
  assert.equal(out.skipped, false);
  assert.equal(out.modality, 'image');
  assert.ok(out.sidecarPath && fs.existsSync(out.sidecarPath), 'sidecar must be written');

  const sidecar = fs.readFileSync(out.sidecarPath, 'utf8');
  assert.match(sidecar, /feature_tokenizer: "kolm-local-multimodal-features-v1"/);
  assert.match(sidecar, /Local feature tokens/);
  assert.match(sidecar, /"image_format": "png"/);
  assert.match(sidecar, /"width": 1/);
  assert.match(sidecar, /"height": 1/);
  assert.match(sidecar, /byte_histogram_16/);
  assert.doesNotMatch(sidecar, /placeholder|transcript pending|Sprint 1|Sprint 2|not yet/i);
});

test('W552 #3 - account overview covers every major shipped product surface', () => {
  const html = read('public/account/overview.html');
  for (const surface of [
    'api-wrapper',
    'training-distill',
    'compiler',
    'gemma',
    'multimodal-tokenization',
    'compute',
    'devices',
    'enterprise',
  ]) {
    assert.match(html, new RegExp(`data-surface="${surface}"`), `missing account surface ${surface}`);
  }
  for (const text of [
    'OpenAI, Claude, OpenRouter',
    'Gemma 3, Gemma 3n, MedGemma, EmbeddingGemma',
    'Image, audio, video, and PDF sidecars',
    'Local CPU/CUDA/MPS/ROCm/DirectML/OpenVINO/QNN',
    'Registered device fleet, local/SSH/HTTP installs',
    'Teams, approvals, audit log, privacy membrane',
  ]) {
    assert.ok(html.includes(text), `account overview missing copy: ${text}`);
  }
});

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w552-'));
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  delete process.env.KOLM_CAPTURE_DRIVER;
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
}

function cleanupHome(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
  delete process.env.KOLM_DATA_DIR;
  delete process.env.KOLM_STORE_DRIVER;
  delete process.env.KOLM_LOCAL_DAEMON;
  delete process.env.KOLM_CONNECTOR_FIXTURE;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {} // deliberate: cleanup
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const out = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

test('W552 #4 - zero-retention connector calls forward without persisting capture rows', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    process.env.KOLM_LOCAL_DAEMON = '1';
    process.env.KOLM_CONNECTOR_FIXTURE = '1';
    const express = (await import('express')).default;
    const { buildRouter } = await import('../src/router.js');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(buildRouter());
    await withServer(app, async (base) => {
      const r = await fetch(base + '/v1/capture/openrouter', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolm-retention': 'none',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3-8b-instruct',
          messages: [{ role: 'user', content: 'do not retain this' }],
        }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-kolm-retention'), 'none');
      assert.equal(r.headers.get('x-kolm-no-store'), 'true');
      assert.equal(r.headers.get('x-kolm-event-id'), null, 'no event id should be minted for zero-retention calls');
      const rows = await eventStore.listEvents({ namespace: 'default', limit: 50 });
      assert.equal(rows.length, 0, 'zero-retention call must not append canonical event rows');
    });
  } finally {
    cleanupHome(home);
  }
});

test('W552 #5 - differential privacy stats add deterministic noisy counts and metadata', async () => {
  const { differentialPrivacyStats } = await import('../src/privacy-membrane.js');
  const stats = {
    total_calls: 100,
    sensitive_events: 7,
    providers: { openai: { calls: 80, spend: 1.2 }, anthropic: { calls: 20, spend: 0.8 } },
    models: { 'gpt-4o-mini': { calls: 80, spend: 1.2 } },
    redactions_by_class: { email: 5, ssn: 2 },
    repeated_clusters: [{ pattern: 'support', count: 12 }],
    top_workflows: [{ workflow_id: 'wf_1', calls: 9 }],
    window: { tenant_id: 'tenant_test', namespace: 'support', since: '2026-05-20T00:00:00Z' },
  };
  const a = differentialPrivacyStats(stats, { epsilon: 8, delta: 1e-6, seed: 'fixed-w552' });
  const b = differentialPrivacyStats(stats, { epsilon: 8, delta: 1e-6, seed: 'fixed-w552' });
  assert.deepEqual(a, b, 'fixed seed keeps DP aggregate tests reproducible');
  assert.equal(a.privacy.mode, 'differential_privacy');
  assert.equal(a.privacy.mechanism, 'laplace');
  assert.equal(a.privacy.epsilon, 8);
  assert.match(a.privacy.seed_hash, /^[0-9a-f]{64}$/);
  assert.equal(typeof a.providers.openai.calls, 'number');
  assert.equal(stats.providers.openai.calls, 80, 'input object must not be mutated');
});

test('W552 #5b - lake analytics filters by provider, model, status, and latency without mutating rows', async () => {
  const { filterLakeEvents } = await import('../src/lake.js');
  const rows = [
    { event_id: 'a', provider: 'openai', model: 'gpt-4o-mini', status: 'ok', latency_ms: 120 },
    { event_id: 'b', provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'ok', latency_ms: 640 },
    { event_id: 'c', provider: 'openai', model: 'gpt-4o-mini', error: '429', latency_ms: 30 },
  ];
  const filtered = filterLakeEvents(rows, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 'ok',
    min_latency_ms: 100,
    exclude_errors: true,
  });
  assert.deepEqual(filtered.map((r) => r.event_id), ['a']);
  assert.equal(rows.length, 3, 'filter must not mutate source rows');
});

test('W552 #5c - OpenAI-compatible runtime supports explicit fallback model chains', async () => {
  const { resolveModelChain, handleChatCompletion } = await import('../src/completions-api.js');
  assert.deepEqual(resolveModelChain({
    model: 'openai:gpt-primary, openai:gpt-backup',
    fallback_models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-backup'],
  }), ['openai:gpt-primary', 'openai:gpt-backup', 'anthropic:claude-sonnet-4-6']);

  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY;
  const oldBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_BASE_URL = 'https://openai.test';
  const seen = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (body.model === 'gpt-primary') {
      return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 'cmpl_fallback',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await handleChatCompletion({
      model: ['openai:gpt-primary', 'openai:gpt-backup'],
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.deepEqual(seen, ['gpt-primary', 'gpt-backup']);
    assert.equal(out.choices[0].message.content, 'fallback ok');
    assert.equal(out.kolm_fallback.selected_model, 'openai:gpt-backup');
    assert.equal(out.kolm_fallback.attempted[0].status, 503);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldBase == null) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldBase;
  }
});

test('W552 #6 - compute registry includes OpenVINO and QNN edge inference adapters', async () => {
  const registry = JSON.parse(read('src/compute/registry.json'));
  const names = registry.backends.map((b) => b.name);
  assert.ok(names.includes('local-openvino'), 'Intel OpenVINO backend missing');
  assert.ok(names.includes('local-qnn'), 'Qualcomm QNN/Hexagon backend missing');
  for (const backend of ['local-openvino', 'local-qnn']) {
    const mod = await import(`../src/compute/backends/${backend}.js?wave552=${Date.now()}`);
    assert.equal(typeof mod.detect, 'function');
    assert.equal(typeof mod.test, 'function');
    assert.equal(typeof mod.run, 'function');
  }
});

test('W552 #7 - compile --as-mcp creates a project-scoped agent surface with correct tool names', () => {
  const home = mkHome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w552-mcp-'));
  try {
    const specPath = path.join(work, 'agent-artifact.spec.json');
    const outPath = path.join(work, 'agent-artifact.kolm');
    fs.writeFileSync(specPath, JSON.stringify({
      job_id: 'job_w552_mcp',
      task: 'uppercase support labels for an agent',
      recipes: [{
        id: 'rcp_upper',
        name: 'uppercase',
        source: 'function generate(input, lib) { return String(input).toUpperCase(); }',
      }],
      evals: {
        spec: 'rs-1-evals',
        n: 2,
        cases: [
          { id: 'c1', input: 'refund', expected: 'REFUND' },
          { id: 'c2', input: 'billing', expected: 'BILLING' },
        ],
      },
    }, null, 2));

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KOLM_DATA_DIR: path.join(home, '.kolm'),
      KOLM_STORE_DRIVER: 'jsonl',
      RECIPE_RECEIPT_SECRET: 'wave552-mcp-secret',
      KOLM_NO_UPDATE: '1',
      NO_COLOR: '1',
    };
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'cli', 'kolm.js'),
      'compile',
      '--spec', specPath,
      '--out', outPath,
      '--as-mcp',
      '--json',
      '--gate', '0',
    ], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `compile --as-mcp failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(fs.existsSync(outPath), 'artifact should be written');
    const yamlPath = path.join(work, 'kolm.yaml');
    const skillPath = path.join(work, '.kolm', 'skills', 'agent-artifact.md');
    assert.ok(fs.existsSync(yamlPath), 'kolm.yaml should be written');
    assert.ok(fs.existsSync(skillPath), 'project-local skill sidecar should be written');
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(yaml, /artifacts:\s*\n\s+- path: "\.\/agent-artifact\.kolm"/);
    assert.match(yaml, /mcp:\s*\n\s+transport: stdio/);
    assert.match(skill, /Tool name: `mcp__[^`]+__agent-artifact`/);
    assert.doesNotMatch(skill, /mcp__kolm__agent-artifact/);
    assert.doesNotMatch(skill, /Runtime egress is patched/);
    assert.match(skill, /signed and verified before each call/);
    assert.match(r.stdout, /"mcp_project"/);
  } finally {
    cleanupHome(home);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

test('W552 #8 - SOTA readiness matrix covers the 10B backend checklist with real evidence paths', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-sota-readiness.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, `sota audit failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(out.requirements >= 55, 'matrix should be exhaustive enough to cover format, compile, gateway, runtime, registry, enterprise, AI infra, DX');
  const matrix = JSON.parse(read('docs/product-sota-readiness.json'));
  const ids = new Set(matrix.surfaces.flatMap((s) => s.requirements.map((x) => x.id)));
  for (const id of [
    'kolm-format-spec',
    'standalone-verify',
    'openai-anthropic-gateway',
    'zero-retention-mode',
    'differential-privacy',
    'runtime-wasm',
    'ios-android-sdk',
    'compute-openvino-qnn',
    'artifact-signing-pipeline',
    'model-routing',
    'prompt-compression',
    'semantic-cache',
    'compile-as-mcp',
  ]) {
    assert.ok(ids.has(id), `matrix missing ${id}`);
  }
});
