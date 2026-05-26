// wave4-r-enrich tests — pin every R-series enrichment delta.
//
// Each test asserts ONE of the v2 contracts the Part-B spec calls out so a
// future edit that removes (or quietly downgrades) an enrichment is caught
// here. No edits to anything under src/ inside this file.
//
// Test count target: 12. All must pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Hermetic temp dir — set BEFORE importing artifact-lifecycle (which reads
// KOLM_DATA_DIR at module-eval time).
// ---------------------------------------------------------------------------
const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r-enrich-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const runtimePassport = await import('../src/runtime-passport.js');
const artifactLifecycle = await import('../src/artifact-lifecycle.js');
const serveAutodetect = await import('../src/serve-autodetect.js');
const deployConfig = await import('../src/deploy-config.js');
const driftDetector = await import('../src/drift-detector.js');
const costDisplacement = await import('../src/cost-displacement.js');
const assuranceCase = await import('../src/assurance-case.js');
const kvCacheShard = await import('../src/kv-cache-shard.js');

// =============================================================================
// R-1 — runtime-passport.js
// =============================================================================

test('R-enrich #1 — R-1 exports v2 schema constant + RUNTIME_PASSPORT_FIELDS_V2', () => {
  assert.equal(runtimePassport.RUNTIME_PASSPORT_SCHEMA_V2, 'kolm-runtime-passport-2',
    'RUNTIME_PASSPORT_SCHEMA_V2 must be the literal "kolm-runtime-passport-2"');
  assert.ok(Array.isArray(runtimePassport.RUNTIME_PASSPORT_FIELDS_V2),
    'RUNTIME_PASSPORT_FIELDS_V2 must be an array');
  for (const f of ['file_size_bytes', 'file_hash', 'latency_p50_ms', 'latency_p95_ms',
                   'time_to_first_token_ms', 'max_context_tested', 'quality_delta',
                   'perplexity_delta', 'kv_cache', 'fallback', 'unsupported_features', 'notes']) {
    assert.ok(runtimePassport.RUNTIME_PASSPORT_FIELDS_V2.includes(f),
      `RUNTIME_PASSPORT_FIELDS_V2 must include ${f}`);
  }
});

test('R-enrich #2 — R-1 generateRuntimePassport computes sha256 + size from disk', async () => {
  // Drop a tiny artifact in our tmp so the sha256 is real.
  const artifactPath = path.join(TEST_DATA_DIR, 'tiny-q4_k_m.gguf');
  const body = Buffer.from('not-a-real-gguf-but-deterministic-bytes');
  fs.writeFileSync(artifactPath, body);
  const passport = await runtimePassport.generateRuntimePassport(artifactPath, 'gguf', 'cuda');
  assert.equal(passport.schema_version, runtimePassport.RUNTIME_PASSPORT_SCHEMA_V2);
  assert.equal(passport.file_size_bytes, body.length,
    'file_size_bytes must equal the on-disk byte count');
  const expectedHash = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(passport.file_hash, expectedHash,
    'file_hash must be sha256:<hex> matching the on-disk bytes');
  assert.equal(passport.runtime, 'llama.cpp', 'gguf -> llama.cpp');
  assert.equal(passport.precision, 'q4_k_m', 'q4_k_m precision parsed from filename');
  assert.equal(passport.status, 'estimated');
});

test('R-enrich #3 — R-1 addShardKvCacheToPassport merges shardPassportEntry', async () => {
  const artifactPath = path.join(TEST_DATA_DIR, 'shardtarget-fp16.safetensors');
  fs.writeFileSync(artifactPath, Buffer.from('xx'));
  const passport = await runtimePassport.generateRuntimePassport(artifactPath, 'safetensors', 'cuda');
  const kvEntry = kvCacheShard.shardPassportEntry({
    measured: {
      compression_ratio: 10.2,
      quality_delta: 0.0,
      max_context_at_vram: { 16: 8192, 24: 16384, 32: 32768 },
    },
  });
  const enriched = runtimePassport.addShardKvCacheToPassport(passport, kvEntry);
  assert.equal(enriched.schema_version, runtimePassport.RUNTIME_PASSPORT_SCHEMA_V2);
  assert.ok(enriched.kv_cache, 'kv_cache must be populated');
  assert.equal(enriched.kv_cache.method, 'shard');
  assert.equal(enriched.kv_cache.compression_ratio, 10.2);
  // Original passport must NOT be mutated.
  assert.equal(passport.kv_cache, null, 'addShardKvCacheToPassport must return a fresh object, not mutate input');
});

// =============================================================================
// R-2 — artifact-lifecycle.js
// =============================================================================

test('R-enrich #4 — R-2 TRANSITIONS includes the full ladder + rejects invalid edges', () => {
  assert.ok(artifactLifecycle.TRANSITIONS, 'TRANSITIONS must be exported');
  // Every documented state must be a key.
  for (const s of ['created', 'signed', 'deployed', 'monitored', 'drift_detected',
                   're_evaluated', 'superseded', 'archived', 'revoked']) {
    assert.ok(Array.isArray(artifactLifecycle.TRANSITIONS[s]),
      `TRANSITIONS.${s} must be an array`);
  }
  // archived is terminal — no successor allowed.
  assert.equal(artifactLifecycle.TRANSITIONS.archived.length, 0,
    'archived must be terminal (no allowed transitions)');
  // monitored -> drift_detected is the new edge.
  assert.ok(artifactLifecycle.TRANSITIONS.monitored.includes('drift_detected'),
    'monitored must transition to drift_detected');
  // drift_detected -> re_evaluated is the new edge.
  assert.ok(artifactLifecycle.TRANSITIONS.drift_detected.includes('re_evaluated'),
    'drift_detected must transition to re_evaluated');

  // ArtifactLifecycle class must REJECT an invalid edge (archived -> deployed).
  const id = 'art-r-enrich-4-' + crypto.randomBytes(2).toString('hex');
  const lc = new artifactLifecycle.ArtifactLifecycle(id);
  // Walk through to archived
  lc.transition('signed', 'system');
  lc.transition('deployed', 'system');
  lc.transition('monitored', 'system');
  lc.transition('superseded', 'system', null, { successor_id: 'art-next' });
  lc.transition('archived', 'system');
  assert.equal(lc.currentState(), 'archived');
  assert.throws(
    () => lc.transition('deployed', 'system'),
    /invalid transition/,
    'archived -> deployed must throw',
  );
});

test('R-enrich #5 — R-2 revoke fires blockPulls + alertDeployments side effects', () => {
  artifactLifecycle._resetSideEffectLogForTests();
  const id = 'art-r-enrich-5-' + crypto.randomBytes(2).toString('hex');
  const lc = new artifactLifecycle.ArtifactLifecycle(id);
  lc.transition('signed', 'system');
  lc.transition('deployed', 'system');
  lc.transition('revoked', 'system', 'license-violation');
  const log = artifactLifecycle.getSideEffectLog();
  const blocked = log.find((e) => e.kind === 'block_pulls' && e.artifact_id === id);
  const alerted = log.find((e) => e.kind === 'alert_deployments' && e.artifact_id === id);
  assert.ok(blocked, 'revoke must fire blockPulls');
  assert.ok(alerted, 'revoke must fire alertDeployments');
});

// =============================================================================
// R-3 — serve-autodetect.js (the serve-runtime module)
// =============================================================================

test('R-enrich #6 — R-3 RUNTIME_SELECTION table + selectRuntime returns expected pairs', async () => {
  assert.ok(serveAutodetect.RUNTIME_SELECTION, 'RUNTIME_SELECTION must be exported');
  assert.equal(serveAutodetect.RUNTIME_SELECTION.gguf.cuda.runtime, 'llama.cpp');
  assert.match(String(serveAutodetect.RUNTIME_SELECTION.gguf.cuda.flags || ''), /--n-gpu-layers/);
  assert.equal(serveAutodetect.RUNTIME_SELECTION.safetensors.cuda.runtime, 'vllm');
  assert.equal(serveAutodetect.RUNTIME_SELECTION.safetensors.metal.runtime, 'mlx');
  assert.equal(serveAutodetect.RUNTIME_SELECTION.safetensors.cpu.runtime, 'transformers');
  assert.equal(serveAutodetect.RUNTIME_SELECTION.mlx.metal.runtime, 'mlx');
  assert.equal(serveAutodetect.RUNTIME_SELECTION.exl2.cuda.runtime, 'exllamav2');

  // selectRuntime exercises the table directly.
  const pick = await serveAutodetect.selectRuntime('/models/foo.gguf', { class: 'cuda', gpu_name: 'RTX 5090', vram_gb: 32 });
  assert.equal(pick.ok, true);
  assert.equal(pick.runtime, 'llama.cpp');
  assert.equal(pick.format, 'gguf');
  assert.equal(pick.gpu_name, 'RTX 5090');
  assert.equal(pick.vram_gb, 32);

  // Bad pairing returns ok:false envelope, never throws.
  const bad = await serveAutodetect.selectRuntime('/models/foo.exl2', 'cpu');
  assert.equal(bad.ok, false, 'exl2 on cpu must return error envelope');
  assert.equal(bad.error, 'unsupported_pairing');
});

test('R-enrich #7 — R-3 HEALTH_SCHEMA + METRICS_SCHEMA are exported with required fields', () => {
  assert.ok(serveAutodetect.HEALTH_SCHEMA, 'HEALTH_SCHEMA must be exported');
  assert.ok(serveAutodetect.HEALTH_SCHEMA.required.includes('ok'));
  assert.ok(serveAutodetect.HEALTH_SCHEMA.required.includes('runtime'));
  assert.ok(serveAutodetect.HEALTH_SCHEMA.required.includes('uptime_s'));
  assert.ok(serveAutodetect.METRICS_SCHEMA, 'METRICS_SCHEMA must be exported');
  for (const k of ['runtime', 'request_count', 'latency_p50_ms', 'tok_s_p50', 'memory_mb', 'uptime_s']) {
    assert.ok(serveAutodetect.METRICS_SCHEMA.required.includes(k),
      `METRICS_SCHEMA.required must include ${k}`);
  }
});

// =============================================================================
// R-4 — deploy-config.js
// =============================================================================

test('R-enrich #8 — R-4 generateKubernetesManifests emits HPA targeting kolm_requests_active', () => {
  const yaml = deployConfig.generateKubernetesManifests({ artifact: 'art-r-enrich-8', runtime: 'vllm' });
  const yamlStr = String(yaml);
  assert.match(yamlStr, /kind: HorizontalPodAutoscaler/,
    'HPA document must be present');
  assert.match(yamlStr, new RegExp(deployConfig.HPA_CUSTOM_METRIC_NAME),
    `HPA must reference custom metric ${deployConfig.HPA_CUSTOM_METRIC_NAME}`);
  assert.match(yamlStr, /averageValue:/,
    'HPA must use averageValue target type');
  // Healthcheck contract for docker-compose
  const compose = deployConfig.generateDockerCompose({ artifact: 'art-r-enrich-8' });
  const composeStr = String(compose);
  assert.match(composeStr, /healthcheck:/, 'compose must include healthcheck stanza');
  assert.match(composeStr, /interval: 30s/, 'healthcheck interval must be 30s');
  assert.match(composeStr, /retries: \d+/, 'healthcheck retries must be present');
});

test('R-enrich #9 — R-4 generateAirgapBundle reserves kolm-verify slot in manifest_entries', () => {
  // Write a tiny .kolm so the air-gap generator has something to bundle.
  const artifactPath = path.join(TEST_DATA_DIR, 'enrich9.kolm');
  fs.writeFileSync(artifactPath, Buffer.from('x'.repeat(64)));
  const outDir = path.join(TEST_DATA_DIR, 'airgap-out');
  const result = deployConfig.generateAirgapBundle({
    artifact_path: artifactPath,
    output_dir: outDir,
    runtime: 'vllm',
  });
  assert.equal(result.ok, true, 'air-gap bundle must succeed');
  assert.ok(Array.isArray(result.manifest_entries), 'manifest_entries must be present');
  const verifyEntry = result.manifest_entries.find((e) => e.path === deployConfig.KOLM_VERIFY_BINARY_NAME);
  assert.ok(verifyEntry, 'manifest_entries must include the kolm-verify binary slot');
  assert.equal(verifyEntry.sha256, deployConfig.KOLM_VERIFY_PLACEHOLDER_SHA256,
    'placeholder sha256 must be exposed as a const');
  // Standard files must also be present
  const expected = ['artifact.kolm', 'verify.cjs', 'MANIFEST.sha256', 'README.md'];
  for (const p of expected) {
    assert.ok(result.manifest_entries.some((e) => e.path === p),
      `manifest_entries must include ${p}`);
  }
});

// =============================================================================
// R-5 — drift-detector.js
// =============================================================================

test('R-enrich #10 — R-5 klDivergence on identical distributions returns ~0', () => {
  const a = { topic_a: 50, topic_b: 30, topic_c: 20 };
  const kl = driftDetector.klDivergence(a, a);
  assert.ok(kl < 1e-6, `KL(a||a) must be ~0, got ${kl}`);
  // KL of disjoint supports is finite (not NaN) thanks to smoothing.
  const b = { topic_x: 100 };
  const kl2 = driftDetector.klDivergence(a, b);
  assert.ok(Number.isFinite(kl2), 'KL on disjoint support must be finite');
  assert.ok(kl2 > 0, 'KL on disjoint distributions must be > 0');
  // Severity ladder rules
  assert.equal(driftDetector.scoreSeverity({ fallback_rate_delta: 0.10 }), 'high',
    'fallback_rate_delta > 0.05 must score high');
  assert.equal(driftDetector.scoreSeverity({ topic_kl_divergence: 0.35 }), 'high',
    'topic_kl > 0.3 must score high');
  assert.equal(driftDetector.scoreSeverity({ fallback_rate_delta: 0.03 }), 'medium',
    'fallback_rate_delta > 0.025 must score medium');
  assert.equal(driftDetector.scoreSeverity({ topic_kl_divergence: 0.18 }), 'medium',
    'topic_kl > 0.15 must score medium');
  assert.equal(driftDetector.scoreSeverity({}), 'none');
});

// =============================================================================
// R-6 — cost-displacement.js
// =============================================================================

test('R-enrich #11 — R-6 calculateSavings returns full envelope shape (by_provider + payback_days)', async () => {
  const tenant_id = 'tenant_r_enrich_11';
  const now = Date.now();
  // Synthetic receipts: 3 local + 2 frontier in the past 7 days.
  const receipts = [
    { tenant: tenant_id, namespace: 'prod', route_decision: 'local',    cost_usd: 0,
      input_tokens: 1000, output_tokens: 500, model: 'claude-sonnet-4-6', provider: 'anthropic', ts: now - 1 * 24 * 3600 * 1000 },
    { tenant: tenant_id, namespace: 'prod', route_decision: 'local',    cost_usd: 0,
      input_tokens: 1000, output_tokens: 500, model: 'claude-sonnet-4-6', provider: 'anthropic', ts: now - 2 * 24 * 3600 * 1000 },
    { tenant: tenant_id, namespace: 'prod', route_decision: 'local',    cost_usd: 0,
      input_tokens: 1000, output_tokens: 500, model: 'claude-sonnet-4-6', provider: 'anthropic', ts: now - 3 * 24 * 3600 * 1000 },
    { tenant: tenant_id, namespace: 'prod', route_decision: 'frontier', cost_usd: 0.018,
      input_tokens: 1000, output_tokens: 500, model: 'claude-sonnet-4-6', provider: 'anthropic', ts: now - 4 * 24 * 3600 * 1000 },
    { tenant: tenant_id, namespace: 'prod', route_decision: 'frontier', cost_usd: 0.018,
      input_tokens: 1000, output_tokens: 500, model: 'claude-sonnet-4-6', provider: 'anthropic', ts: now - 5 * 24 * 3600 * 1000 },
  ];
  const result = await costDisplacement.calculateSavings('prod', {
    tenant_id,
    period_days: 7,
    now,
    readReceipts: () => receipts,
    frontier_model: 'claude-sonnet-4-6',
    compile_cost_usd: 0.50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.total_calls, 5);
  assert.equal(result.local_calls, 3);
  assert.equal(result.frontier_calls, 2);
  assert.ok(Math.abs(result.local_ratio - 0.6) < 1e-9, 'local_ratio must be 0.6');
  assert.ok(result.baseline_cost_usd > result.actual_cost_usd, 'baseline > actual when local saved cost');
  assert.equal(result.compile_cost_usd, 0.50);
  assert.ok(typeof result.payback_days === 'number' && result.payback_days > 0,
    `payback_days must be a positive number, got ${result.payback_days}`);
  assert.ok(result.by_provider && result.by_provider.anthropic, 'by_provider.anthropic must be populated');
  assert.equal(result.by_provider.anthropic.calls, 5);
  assert.equal(typeof result.net_savings_usd, 'number');
  // estimateFrontierCost helper
  const fc = costDisplacement.estimateFrontierCost(1000, 500, 'claude-sonnet-4-6');
  // 1000 in * 3.00/1M + 500 out * 15.00/1M = 0.003 + 0.0075 = 0.0105
  assert.ok(Math.abs(fc - 0.0105) < 1e-9, `estimateFrontierCost must price claude-sonnet-4-6 at 0.0105, got ${fc}`);
});

// =============================================================================
// R-7 — assurance-case.js
// =============================================================================

test('R-enrich #12 — R-7 generateAssuranceCase emits CLAIM_STATUSES_V2-valid claims + CONTROL_FRAMEWORKS', async () => {
  assert.ok(assuranceCase.CLAIM_STATUSES_V2, 'CLAIM_STATUSES_V2 must be exported');
  for (const s of ['supported', 'unsupported', 'partial', 'unknown']) {
    assert.ok(assuranceCase.CLAIM_STATUSES_V2.includes(s),
      `CLAIM_STATUSES_V2 must include ${s}`);
  }
  assert.ok(assuranceCase.CONTROL_FRAMEWORKS, 'CONTROL_FRAMEWORKS must be exported');
  for (const f of ['soc2', 'iso27001', 'hipaa', 'sox', 'nist-csf']) {
    assert.ok(assuranceCase.CONTROL_FRAMEWORKS.includes(f),
      `CONTROL_FRAMEWORKS must include ${f}`);
  }
  // Empty context — every claim is 'unknown'/'unsupported' but always v2-valid.
  const envelope = await assuranceCase.generateAssuranceCase('art_r_enrich_12');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.artifact_id, 'art_r_enrich_12');
  assert.ok(Array.isArray(envelope.claims), 'claims must be an array');
  assert.equal(envelope.claims.length, 4, 'must emit 4 default claims (reproducibility/provenance/signatures/PII)');
  for (const c of envelope.claims) {
    assert.ok(assuranceCase.CLAIM_STATUSES_V2.includes(c.status),
      `claim status '${c.status}' must be in CLAIM_STATUSES_V2`);
    assert.ok(Array.isArray(c.evidence), 'claim.evidence must be an array');
    assert.ok(Array.isArray(c.limitations), 'claim.limitations must be an array');
  }
  for (const ctrl of envelope.controls) {
    assert.ok(assuranceCase.CONTROL_FRAMEWORKS.includes(ctrl.framework),
      `control framework '${ctrl.framework}' must be in CONTROL_FRAMEWORKS`);
  }
  // With a richly-attested artifact context, at least one claim flips to 'supported'.
  const richEnvelope = await assuranceCase.generateAssuranceCase('art_r_enrich_12b', {
    id: 'art_r_enrich_12b',
    manifest: { seed: 42, reproducibility: 'hash:abc' },
    receipt: { signature_ed25519: 'sig:abc', signature_fingerprint: 'fp123' },
    evidence_dag: {
      nodes: [
        { id: 'cap_1', kind: 'capture' },
        { id: 'rg_1',  kind: 'rights', covers: ['cap_1'] },
      ],
    },
    pii_redaction: { enabled: true, report: { redacted: 0 } },
  });
  const supportedCount = richEnvelope.claims.filter((c) => c.status === 'supported').length;
  assert.ok(supportedCount >= 3,
    `rich context must surface >= 3 'supported' claims, got ${supportedCount}`);
});
