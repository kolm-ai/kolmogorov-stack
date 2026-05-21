// Wave 553 - close the "7.5 -> 10/10" backend readiness gap:
// broader model/framework coverage, enterprise controls, production
// observability/debugging, cloud GPU/storage readiness, and local codegraph
// indexing for future surgical audits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  cloudReadinessSummary,
  deploymentProfiles,
  detectCloudReadiness,
  listPlatformCapabilities,
  validatePlatformCapabilities,
} from '../src/platform-capabilities.js';
import { auditCodeGraph, buildCodeGraph } from '../src/repo-codegraph.js';
import * as otel from '../src/otel.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W553 #1 - platform matrix covers major model frameworks, enterprise, observability, and scale controls', () => {
  const matrix = validatePlatformCapabilities();
  assert.equal(matrix.ok, true, matrix.missing.join(', '));
  assert.ok(matrix.counts.frameworks >= 16, 'runtime/model target coverage should include edge, browser, local, and serving engines');
  assert.ok(matrix.counts.model_families >= 18, 'model family coverage should include teachers, students, media, RAG, agents, and structured models');
  assert.ok(matrix.counts.device_targets >= 16, 'device target coverage should include local, mobile, browser, cloud, edge, and airgap targets');
  assert.ok(matrix.counts.methods >= 22, 'method coverage should include capture, privacy, train/distill, eval, runtime, compression, and observability');
  assert.ok(matrix.counts.enterprise_controls >= 8, 'enterprise security/privacy controls must be explicit');
  assert.ok(matrix.counts.observability_controls >= 5, 'production monitoring/debugging controls must be explicit');
  assert.ok(matrix.counts.scale_controls >= 7, 'scale/perf controls must be explicit');

  const caps = listPlatformCapabilities();
  const frameworkIds = new Set(caps.model_framework_targets.map((r) => r.id));
  for (const id of ['openai-compatible', 'anthropic-messages', 'gguf-llama-cpp', 'onnx-runtime', 'coreml-ane', 'mlx-apple-silicon', 'tensorrt-llm', 'openvino', 'qnn-hexagon']) {
    assert.ok(frameworkIds.has(id), `missing ${id}`);
  }
  const modelIds = new Set(caps.model_family_targets.map((r) => r.id));
  for (const id of ['frontier-teacher-gpt', 'frontier-teacher-claude', 'frontier-teacher-gemini', 'open-weight-moe-llm', 'vision-language-model', 'speech-asr-model', 'rag-pipeline-artifact', 'agent-tool-policy-model']) {
    assert.ok(modelIds.has(id), `missing model family ${id}`);
  }
  const deviceIds = new Set(caps.device_targets.map((r) => r.id));
  for (const id of ['nvidia-cuda-workstation', 'amd-rocm-workstation', 'apple-silicon-mac', 'intel-npu-openvino', 'qualcomm-hexagon-qnn', 'ios-coreml-ane', 'android-litert-qnn', 'browser-webgpu', 'cloudflare-workers', 'airgapped-server']) {
    assert.ok(deviceIds.has(id), `missing device ${id}`);
  }
  const methodIds = new Set(caps.method_targets.map((r) => r.id));
  for (const id of ['capture-proxy', 'zero-retention-capture', 'teacher-student-distill', 'preference-optimization', 'lora-qlora-train', 'multimodal-tokenization', 'quantize-awq-gptq-gguf-mlx', 'otel-export']) {
    assert.ok(methodIds.has(id), `missing method ${id}`);
  }
  const allRows = [
    ...caps.model_framework_targets,
    ...caps.model_family_targets,
    ...caps.device_targets,
    ...caps.method_targets,
    ...caps.enterprise_controls,
    ...caps.observability_controls,
    ...caps.scale_controls,
  ];
  for (const row of allRows) {
    for (const evidencePath of row.evidence || []) {
      assert.equal(fs.existsSync(path.join(ROOT, evidencePath)), true, `${row.id} references missing evidence path ${evidencePath}`);
    }
  }
});

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

test('W553 #3 - repo codegraph indexes routes, symbols, scripts, and readiness evidence', () => {
  const graph = buildCodeGraph({ root: ROOT });
  const audit = auditCodeGraph(graph);
  assert.equal(audit.ok, true, audit.missing.join(', '));
  assert.ok(graph.counts.routes >= 300, 'route graph should include hosted API + public surfaces');
  assert.ok(graph.counts.symbols >= 500, 'symbol graph should be useful for impact analysis');
  assert.ok(graph.counts.readiness_requirements >= 50, 'SOTA readiness requirements should be indexed');
  assert.equal(graph.counts.readiness_missing_evidence, 0);
  assert.ok(graph.routes.some((r) => r.path === '/v1/chat/completions'));
  assert.ok(graph.routes.some((r) => r.path === '/account/overview'));
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
