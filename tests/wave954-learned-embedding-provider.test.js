// W954 - learned/provider embedding boundary for semantic curation.
//
// The default hash-bag embedder stays synchronous and dependency-free. When a
// learned/provider backend is explicitly configured, CURATE must precompute
// vectors once and feed them into the semantic stages that were previously
// capped by lexical hash-bag similarity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearEmbeddingProviders,
  embedBatchAsync,
  embeddingProviderProfile,
  registerEmbeddingProvider,
} from '../src/embedding.js';
import { curatePairs } from '../src/data-curate.js';

function unit(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function semanticVector(text) {
  const s = String(text || '').toLowerCase();
  if (/(refund|reimbursement|money back|cancel|yearly|annual|billing|charge|returned)/.test(s)) return [1, 0, 0, 0];
  if (/(password|login|credential|reset|account access)/.test(s)) return [0, 1, 0, 0];
  if (/(shipping|delivery|package|courier)/.test(s)) return [0, 0, 1, 0];
  return unit([0.2, 0.1, 0.1, 0.7]);
}

function installSemanticProvider() {
  clearEmbeddingProviders();
  registerEmbeddingProvider('semantic-test', async (texts) => ({
    vectors: texts.map(semanticVector),
    backend_used: 'semantic-test',
  }), { learned_semantic: true, kind: 'learned_semantic' });
}

async function withTempEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w954-embed-'));
  const saved = {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_PYTHON: process.env.KOLM_PYTHON,
    KOLM_EMBED_BACKEND: process.env.KOLM_EMBED_BACKEND,
    KOLM_EMBED_URL: process.env.KOLM_EMBED_URL,
    KOLM_EMBED_ALLOW_REMOTE: process.env.KOLM_EMBED_ALLOW_REMOTE,
  };
  process.env.KOLM_DATA_DIR = tmp;
  process.env.KOLM_PYTHON = 'kolm-python-not-installed-for-w954';
  delete process.env.KOLM_EMBED_BACKEND;
  delete process.env.KOLM_EMBED_URL;
  delete process.env.KOLM_EMBED_ALLOW_REMOTE;
  try {
    return await fn();
  } finally {
    clearEmbeddingProviders();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const paraphrasePairs = [
  {
    input: 'How do I get my money back after canceling the annual plan?',
    output: 'Submit a billing case and support will reverse eligible charges.',
  },
  {
    input: 'Explain the reimbursement process for ending a yearly subscription.',
    output: 'Open a support ticket; eligible yearly subscription fees can be returned.',
  },
  {
    input: 'How can an employee reset login credentials?',
    output: 'Use the account access page to rotate the password and confirm the login.',
  },
];

test('embedding provider registry exposes learned semantic batch vectors', async () => {
  await withTempEnv(async () => {
    installSemanticProvider();
    const profile = embeddingProviderProfile({ backend: 'semantic-test' });
    assert.equal(profile.provider, 'semantic-test');
    assert.equal(profile.learned_semantic, true);

    const res = await embedBatchAsync(['refund request', 'password reset'], { backend: 'semantic-test' });
    assert.equal(res.ok, true);
    assert.equal(res.backend_used, 'semantic-test');
    assert.equal(res.backend_kind, 'learned_semantic');
    assert.equal(res.learned_semantic, true);
    assert.equal(res.dim, 4);
    assert.deepEqual(res.vectors[0], [1, 0, 0, 0]);
    assert.deepEqual(res.vectors[1], [0, 1, 0, 0]);
  });
});

test('CURATE near-dup fallback uses provider vectors for low-lexical-overlap paraphrases', async () => {
  await withTempEnv(async () => {
    const hash = await curatePairs({
      tenant: 'tenant_w954',
      namespace: 'hash-near-dup',
      pairs: paraphrasePairs.map((p) => ({ ...p })),
      opts: {
        quality: false,
        minhash: false,
        semdedup: false,
        dedup: true,
        cluster: false,
        cot: false,
        pii: false,
        embeddingNearDup: true,
        embeddingNearDupThreshold: 0.999,
      },
    });
    assert.equal(hash.ok, true);
    assert.equal(hash.report.embedding_near_dup.backend_used, 'embedding-near-dup-js');
    assert.equal(hash.report.embedding_near_dup.n_removed, 0);
    assert.equal(hash.n_kept, 3);

    installSemanticProvider();
    const learned = await curatePairs({
      tenant: 'tenant_w954',
      namespace: 'learned-near-dup',
      pairs: paraphrasePairs.map((p) => ({ ...p })),
      opts: {
        quality: false,
        minhash: false,
        semdedup: false,
        dedup: true,
        cluster: false,
        cot: false,
        pii: false,
        embeddingNearDup: true,
        embeddingNearDupThreshold: 0.999,
        embeddingBackend: 'semantic-test',
      },
    });

    assert.equal(learned.ok, true);
    assert.equal(learned.report.embedding_provider.backend_used, 'semantic-test');
    assert.equal(learned.report.embedding_provider.learned_semantic, true);
    assert.equal(learned.report.embedding_near_dup.backend_used, 'embedding-near-dup-js:semantic-test');
    assert.equal(learned.report.embedding_near_dup.embedding_backend, 'semantic-test');
    assert.equal(learned.report.embedding_near_dup.n_removed, 1);
    assert.equal(learned.n_kept, 2);
    assert.match(learned.report.backend_used, /semantic-test/);
  });
});

test('CURATE reuses provider vectors for semantic clustering and label-error detection', async () => {
  await withTempEnv(async () => {
    installSemanticProvider();
    const res = await curatePairs({
      tenant: 'tenant_w954',
      namespace: 'cluster-provider',
      pairs: [
        { input: 'refund a charge', output: 'billing can return eligible charges' },
        { input: 'cancel annual plan', output: 'yearly subscription fees may be returned' },
        { input: 'reset account password', output: 'login credentials rotate from the account page' },
        { input: 'recover login access', output: 'password reset confirms account access' },
      ],
      opts: {
        quality: false,
        minhash: false,
        semdedup: false,
        dedup: false,
        cluster: true,
        semanticCluster: true,
        n_clusters: 2,
        detectErrors: true,
        routeErrors: false,
        cot: false,
        pii: false,
        embeddingBackend: 'semantic-test',
      },
    });

    assert.equal(res.ok, true);
    assert.match(res.report.cluster_method, /^kmeans:semantic-test:/);
    assert.equal(res.report.cluster_embedding_backend, 'semantic-test');
    assert.equal(res.report.label_errors.backend, 'cl-dense');
    assert.equal(res.report.label_errors.embedding_backend, 'semantic-test');
    assert.ok(res.report.embedding_provider.reused_by.includes('semantic_cluster_labels'));
    assert.ok(res.report.embedding_provider.reused_by.includes('label_error_detection'));
  });
});

test('remote embedding endpoints are refused unless explicitly allowed', async () => {
  await withTempEnv(async () => {
    const res = await embedBatchAsync(['do not egress'], {
      backend: 'openai-compatible',
      url: 'https://example.com/v1/embeddings',
    });
    assert.equal(res.backend_requested, 'openai-compatible');
    assert.equal(res.ok, true);
    assert.equal(res.backend_used, 'hashbag');
    assert.equal(res.fallback, 'hashbag');
    assert.match(res.error, /remote_embedding_url_refused/);
  });
});
