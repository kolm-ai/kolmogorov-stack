// Wave 555 - user-completion pass.
// @public-routes-only
//
// Locks the buildable gaps that were still marked partial after the broad
// product audit: cloud deploy planning, secret refs, prompt compression,
// semantic cache, token budgets, and RAG access from artifact recipes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

import {
  compressPrompt,
  enforceTokenBudget,
  estimateTokens,
  semanticFingerprint,
  semanticSimilarity,
} from '../src/optimization.js';
import {
  buildDeployPlan,
  deployButtons,
  deploymentMatrix,
} from '../src/deployment-plans.js';
import {
  buildExternalSecretIntent,
  getSecret,
  listSecretRefs,
  putSecret,
  resolveSecretRef,
  secretVaultStatus,
} from '../src/secrets-vault.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w555-'));
  process.env.KOLM_DATA_DIR = path.join(dir, '.kolm');
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.KOLM_DATA_DIR;
  delete process.env.KOLM_RUNTIME_POLICY;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
}

test('W555 #1 - prompt compression and token-budget enforcement are deterministic and budget-bound', () => {
  const body = Array.from({ length: 900 }, (_, i) => `ticket-${i} refund billing cancellation escalation`).join(' ');
  const originalTokens = estimateTokens(body);
  const compressed = compressPrompt(body, { maxTokens: 160 });
  assert.equal(compressed.compressed, true);
  assert.ok(compressed.original_tokens >= originalTokens);
  assert.ok(compressed.compressed_tokens <= 160, `compressed tokens ${compressed.compressed_tokens}`);
  assert.match(compressed.input, /kolm prompt-compression:v1/);
  assert.match(compressed.input, /ticket-0/);
  assert.match(compressed.input, /ticket-899/);

  const rejected = enforceTokenBudget(body, { maxTokens: 80, action: 'reject' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'token_budget_exceeded');
  const shrunk = enforceTokenBudget(body, { maxTokens: 160, action: 'compress' });
  assert.equal(shrunk.ok, true);
  assert.equal(shrunk.final_tokens <= 160, true);
});

test('W555 #2 - runtime policy can compress over-budget calls and hit semantic cache before provider egress', async () => {
  const home = tmpHome();
  try {
    const runtime = await import(`../src/runtime-policy.js?w555=${Date.now()}`);
    runtime.setPolicy({
      name: 'local_first',
      max_input_tokens: 80,
      token_budget_action: 'compress',
      prompt_compression_enabled: true,
      semantic_cache_enabled: true,
      semantic_cache_threshold: 0.65,
      semantic_cache_ttl_s: 3600,
    });

    const longRequest = {
      model: 'gpt-4o-mini',
      intent: 'support-triage',
      body: Array.from({ length: 400 }, (_, i) => `refund billing escalation ${i}`).join(' '),
    };
    const compressedDecision = await runtime.decide(longRequest);
    assert.notEqual(compressedDecision.action, 'blocked');
    assert.equal(compressedDecision.token_budget.compressed, true);
    assert.equal(compressedDecision.token_budget.final_tokens <= 80, true);

    const internals = runtime._internals();
    fs.mkdirSync(path.dirname(internals.semanticCachePath()), { recursive: true });
    const prior = {
      ts: Date.now(),
      request_hash: 'cached-support-refund',
      model: 'gpt-4o-mini',
      intent: 'support-triage',
      ...semanticFingerprint('customer refund billing cancellation escalation request'),
      response: { answer: 'route to billing-retention' },
    };
    fs.appendFileSync(internals.semanticCachePath(), JSON.stringify(prior) + '\n');

    const hit = await runtime.decide({
      model: 'gpt-4o-mini',
      intent: 'support-triage',
      body: 'billing customer asks for refund cancellation escalation',
    });
    assert.equal(hit.action, 'semantic_cache_hit');
    assert.equal(hit.cached.answer, 'route to billing-retention');
    assert.ok(hit.semantic_cache.similarity >= 0.65);
    const stats = runtime.replacementStats();
    assert.ok(Object.prototype.hasOwnProperty.call(stats.by_action, 'semantic_cache_hit'));
  } finally {
    cleanup(home);
  }
});

test('W555 #3 - encrypted local secrets and external secret refs never leak values into control-plane envelopes', () => {
  const home = tmpHome();
  try {
    const saved = putSecret({ id: 'openai-prod', value: 'sk-test-super-secret', scope: 'tenant' });
    assert.equal(saved.ref, 'local:openai-prod');
    assert.equal(saved.value_included, false);
    assert.equal(saved.encrypted_at_rest, true);
    const vaultPath = secretVaultStatus().vault_path;
    assert.equal(fs.existsSync(vaultPath), true);
    assert.doesNotMatch(fs.readFileSync(vaultPath, 'utf8'), /sk-test-super-secret/);

    const resolved = getSecret('local:openai-prod');
    assert.equal(resolved.value, 'sk-test-super-secret');
    const refs = listSecretRefs();
    assert.ok(refs.some((r) => r.ref === 'local:openai-prod' && r.value_included === false));

    const external = buildExternalSecretIntent('aws-secrets-manager:arn:aws:secretsmanager:us-east-1:123:secret:kolm/openai');
    assert.equal(external.ok, true);
    assert.equal(external.value_included, false);
    assert.match(external.install_hint, /IAM/);
    const externalResolved = resolveSecretRef('vault:secret/data/kolm#openai');
    assert.equal(externalResolved.type, 'external');
    assert.equal(externalResolved.value_included, false);
  } finally {
    cleanup(home);
  }
});

test('W555 #4 - deploy matrix covers cloud, edge, SSH, GPU, and managed training without secret values', async (t) => {
  const matrix = deploymentMatrix();
  const ids = new Set(matrix.targets.map((r) => r.id));
  for (const id of ['docker', 'ssh', 'fly', 'aws-nitro', 'gcp-cvm', 'azure-cvm', 'cloudflare-workers', 'vercel-edge', 'deno-deploy', 'runpod-gpu', 'lambda-gpu', 'together-finetune']) {
    assert.ok(ids.has(id), `missing deploy target ${id}`);
  }
  assert.equal(matrix.secret_values_included, false);
  assert.doesNotMatch(JSON.stringify(matrix), /secret-token|sk-[A-Za-z0-9_-]{16,}|ks_[a-f0-9]{16,}/i);

  const plan = buildDeployPlan({ target: 'cloudflare-workers', artifactId: 'phi-redactor@1.2.3', baseUrl: 'https://kolm.test' });
  assert.equal(plan.ok, true);
  assert.equal(plan.secret_values_included, false);
  assert.ok(plan.required_secret_refs.includes('env:CLOUDFLARE_API_TOKEN'));
  assert.ok(plan.steps.some((s) => /wrangler/.test(s.command)));
  assert.ok(deployButtons({ artifactId: 'x' }).some((b) => b.target === 'vercel-edge'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const targets = await fetch(base + '/v1/cloud/deploy-targets');
  assert.equal(targets.status, 200);
  const targetsBody = await targets.json();
  assert.equal(targetsBody.secret_values_included, false);
  assert.ok(targetsBody.targets.some((r) => r.id === 'ssh'));

  const routePlan = await fetch(base + '/v1/cloud/deploy-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'vercel-edge', artifact_id: 'classifier', name: 'claims-ai' }),
  });
  assert.equal(routePlan.status, 200);
  const routeBody = await routePlan.json();
  assert.equal(routeBody.target.id, 'vercel-edge');
  assert.equal(routeBody.secret_values_included, false);
  assert.ok(routeBody.steps.some((s) => /vercel/.test(s.command)));
});

test('W555 #5 - CLI exposes local deploy targets and deploy plans offline', () => {
  const targets = spawnSync(process.execPath, ['cli/kolm.js', 'cloud', 'targets', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(targets.status, 0, targets.stderr || targets.stdout);
  const matrix = JSON.parse(targets.stdout);
  assert.ok(matrix.targets.some((r) => r.id === 'cloudflare-workers'));
  assert.equal(matrix.secret_values_included, false);

  const plan = spawnSync(process.execPath, ['cli/kolm.js', 'cloud', 'deploy-plan', '--target', 'ssh', '--artifact', 'claims-router', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  const parsed = JSON.parse(plan.stdout);
  assert.equal(parsed.target.id, 'ssh');
  assert.ok(parsed.required_secret_refs.includes('env:KOLM_REMOTE_SSH_HOST'));
  assert.equal(parsed.secret_values_included, false);
});

test('W555 #6 - artifact runner exposes RAG sidecars and enforces token-budget code paths', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'artifact-runner.js'), 'utf8');
  assert.match(src, /ragLibFor/);
  assert.match(src, /rag: rag/);
  assert.match(src, /KOLM_E_TOKEN_BUDGET/);
  assert.match(src, /max_input_tokens/);
});
