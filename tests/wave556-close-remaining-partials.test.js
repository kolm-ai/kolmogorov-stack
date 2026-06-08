// Wave 556 - closes the remaining local partials in the SOTA ledger:
// @public-routes-only
// team capture RBAC, verified publishers, dependency graphs, and streaming
// connector parity.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { dependencyBlastRadius, dependencyGraphFromManifest } from '../src/artifact-dependency-graph.js';
import { authorizeCaptureAction, captureRbacPolicy } from '../src/team-capture-rbac.js';
import { evaluatePublisherVerification, verifiedPublisherPolicy } from '../src/publisher-verification.js';
import { normalizeStreamChunk, streamingCapabilities, streamingReadiness } from '../src/streaming-contract.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W556 #1 - team capture RBAC fences tenants, scopes, roles, teams, and namespaces', () => {
  const policy = captureRbacPolicy();
  assert.equal(policy.ok, true);
  assert.ok(policy.actions['lake:export']);

  const deniedTenant = authorizeCaptureAction({
    action: 'capture:read',
    tenantId: 'tenant_a',
    rowTenantId: 'tenant_b',
    memberRole: 'owner',
    keyScopes: ['*'],
  });
  assert.equal(deniedTenant.ok, false);
  assert.equal(deniedTenant.reason, 'tenant_mismatch');

  const deniedRole = authorizeCaptureAction({
    action: 'lake:export',
    tenantId: 'tenant_a',
    rowTenantId: 'tenant_a',
    memberRole: 'member',
    keyScopes: ['lake:export'],
  });
  assert.equal(deniedRole.ok, false);
  assert.equal(deniedRole.reason, 'insufficient_role');

  const allowed = authorizeCaptureAction({
    action: 'capture:stream',
    tenantId: 'tenant_a',
    rowTenantId: 'tenant_a',
    teamId: 'team_1',
    memberTeamIds: ['team_1'],
    memberRole: 'viewer',
    keyScopes: ['capture:stream'],
    namespace: 'claims',
    allowedNamespaces: ['claims'],
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.tenant_fenced, true);
});

test('W556 #2 - verified publisher policy produces badges only from concrete checks', () => {
  const policy = verifiedPublisherPolicy();
  assert.equal(policy.ok, true);
  assert.ok(policy.rules.enterprise_verified.includes('security-review'));

  const result = evaluatePublisherVerification({
    publisher: {
      id: 'acme',
      domain_verified: true,
      security_contact: 'security@example.com',
      security_reviewed: true,
    },
    artifacts: [
      { signature_valid: true, production_ready: true, k_score: 0.92 },
      { verified_receipt_hash: 'abc', production_readiness_state: 'production_ready_verified', k_score: 0.89 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.badge, 'enterprise_verified');
  assert.equal(result.secret_values_included, false);

  const bad = evaluatePublisherVerification({
    publisher: { id: 'unsigned', domain_verified: true },
    artifacts: [{ production_ready: true, k_score: 0.95 }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('artifact-signature'));
});

test('W556 #3 - artifact dependency graph reports model/runtime/expert dependencies and blast radius', () => {
  const graph = dependencyGraphFromManifest({
    id: 'claims-router',
    base_model: 'google/gemma-3n-E2B-it',
    runtime_target: 'gguf',
    model_weights: { student: { sha256: 'abc123' } },
    compiled_targets: ['gguf', 'onnx'],
    lineage: {
      upstream_artifacts: ['phi-redactor@1'],
      dependencies: ['tokenizer:v1'],
    },
    moe: { experts: ['claims-redactor', 'appeals-classifier'] },
    workflow_ir: { steps: [{ id: 'redact', type: 'tool' }, { id: 'classify', type: 'model' }] },
  });
  assert.equal(graph.ok, true);
  assert.ok(graph.nodes.some((n) => n.id === 'model:google/gemma-3n-E2B-it'));
  assert.ok(graph.edges.some((e) => e.type === 'routes_to_expert'));
  assert.ok(graph.edges.some((e) => e.type === 'workflow_step'));
  const blast = dependencyBlastRadius(graph, ['model:google/gemma-3n-E2B-it']);
  assert.ok(blast.affected_artifacts.includes('claims-router'));
});

test('W556 #4 - streaming contract normalizes OpenAI, Anthropic, OpenRouter, local, and capture SSE events', () => {
  const caps = streamingCapabilities();
  const ready = streamingReadiness();
  assert.equal(caps.ok, true);
  assert.equal(ready.ok, true);
  assert.ok(ready.model_stream_provider_count >= 4);
  const providerIds = new Set(caps.providers.map((p) => p.id));
  for (const id of ['openai', 'anthropic', 'openrouter', 'kolm-capture-sse', 'local-artifact']) {
    assert.ok(providerIds.has(id), `missing ${id}`);
  }

  assert.deepEqual(normalizeStreamChunk('openai', { choices: [{ delta: { content: 'hi' } }] }).text, 'hi');
  assert.deepEqual(normalizeStreamChunk('openrouter', { choices: [{ delta: { content: 'or' } }] }).text, 'or');
  assert.deepEqual(normalizeStreamChunk('anthropic', { type: 'content_block_delta', delta: { text: 'claude' } }).text, 'claude');
  assert.deepEqual(normalizeStreamChunk('kolm-capture-sse', { prompt_head: 'capture prompt' }).type, 'capture');
  assert.deepEqual(normalizeStreamChunk('local-artifact', { output: 'local' }).text, 'local');
});

test('W556 #5 - hosted API exposes the remaining completion contracts without secrets', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const urls = [
    '/v1/capture/rbac/policy',
    '/v1/registry/verified-publishers/policy',
    '/v1/streaming/capabilities',
  ];
  for (const url of urls) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, url);
    const body = await res.json();
    assert.equal(body.secret_values_included, false, url);
    assert.doesNotMatch(JSON.stringify(body), /secret-token|sk-[A-Za-z0-9_-]{16,}|ks_[a-f0-9]{16,}/i);
  }

  const graph = await fetch(base + '/v1/artifacts/dependency-graph', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifact_id: 'router', manifest: { base_model: 'gpt-4o', runtime_target: 'onnx' }, changed: ['model:gpt-4o'] }),
  });
  assert.equal(graph.status, 200);
  const graphBody = await graph.json();
  assert.equal(graphBody.secret_values_included, false);
  assert.ok(graphBody.blast_radius.affected_artifacts.includes('router'));
});
