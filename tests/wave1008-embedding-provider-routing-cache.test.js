// W1008 - learned/provider vector reuse across routing + semantic cache.
//
// W954 added the provider embedding boundary for CURATE. This locks the two
// gateway reuse seams without changing defaults:
//   - semantic-cache uses embedBatchAsync when cache.embedder === 'provider'
//   - semantic-router can score non-default/provider centroids only when the
//     caller supplies a same-dimension prompt_vector.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  namespaceCacheConfig,
  canonicalizeCacheInput,
  semanticCacheWrite,
  semanticCacheLookup,
  _resetStore,
} from '../src/semantic-cache.js';
import {
  scoreRoute,
  ClusterRouterStats,
} from '../src/semantic-router.js';
import {
  registerEmbeddingProvider,
  clearEmbeddingProviders,
} from '../src/embedding.js';

const body = (text) => ({
  model: 'kolm-trinity',
  messages: [{ role: 'user', content: text }],
});

function semanticVector(text) {
  const s = String(text || '').toLowerCase();
  if (/password|credential|login|recovery/.test(s)) return [1, 0];
  if (/invoice|billing|payment/.test(s)) return [0, 1];
  return [0.70710678, 0.70710678];
}

beforeEach(() => {
  _resetStore();
  clearEmbeddingProviders();
  registerEmbeddingProvider('w1007-semantic', async (texts) => ({
    backend_used: 'w1007-semantic',
    vectors: texts.map(semanticVector),
  }), { learned_semantic: true });
});

test('semantic cache uses the W954 provider path when cache.embedder is provider', async () => {
  const cfg = namespaceCacheConfig({
    cache: {
      mode: 'semantic',
      embedder: 'provider',
      embeddingBackend: 'w1007-semantic',
      similarity_threshold: 0.99,
    },
  });
  assert.equal(cfg.embedder, 'provider');
  assert.equal(cfg.embedding_backend, 'w1007-semantic');

  const stored = canonicalizeCacheInput(body('How do I reset my password?'));
  await semanticCacheWrite({
    tenant: 't',
    namespace: 'ns',
    model: 'm',
    config: cfg,
    canonicalInput: stored.canonicalInput,
    userText: stored.userText,
    value: { answer: 'Use account security.' },
    source_receipt_id: 'receipt_provider_cache',
  });

  const paraphrase = canonicalizeCacheInput(body('Can I change my login credentials?'));
  assert.notDeepEqual(paraphrase.canonicalInput, stored.canonicalInput);
  const hit = await semanticCacheLookup({
    tenant: 't',
    namespace: 'ns',
    model: 'm',
    config: cfg,
    canonicalInput: paraphrase.canonicalInput,
    userText: paraphrase.userText,
  });

  assert.equal(hit.status, 'semantic_hit');
  assert.ok(hit.similarity >= 0.99, `similarity ${hit.similarity}`);
  assert.equal(hit.source_receipt_id, 'receipt_provider_cache');
});

test('semantic router scores provider-trained centroids only with a matching prompt_vector', () => {
  const stats = new ClusterRouterStats({ k: 2, dim: 2, centroids: [[1, 0], [0, 1]] });
  for (let i = 0; i < 25; i += 1) {
    stats.update({ clusterId: 0, model: 'gpt-4o-mini', won: true, cost_usd: 0.01, latency_ms: 40 });
    stats.update({ clusterId: 1, model: 'claude-opus-4-7', won: true, cost_usd: 0.01, latency_ms: 40 });
  }
  const namespaceConfig = {
    primary: 'anthropic:claude-opus-4-7',
    fallback: ['openai:gpt-4o-mini'],
    route_mode: 'cost_quality',
  };

  const withoutVector = scoreRoute({
    namespaceConfig,
    prompt: 'Can I change my login credentials?',
    stats,
    opts: { min_samples: 20, route_weights: { similarity: 1 } },
  });
  assert.equal(withoutVector.reason, 'prompt_vector_required_for_nondefault_embedder');
  assert.equal(withoutVector.cold_start, true);

  const withVector = scoreRoute({
    namespaceConfig,
    prompt: 'Can I change my login credentials?',
    stats,
    opts: {
      min_samples: 20,
      route_weights: { similarity: 1 },
      prompt_vector: semanticVector('Can I change my login credentials?'),
      embedder_id: 'provider:w1007-semantic',
    },
  });
  assert.equal(withVector.reason, 'multi_signal_reorder');
  assert.equal(withVector.embedder, 'provider:w1007-semantic');
  assert.equal(withVector.chosen.provider, 'openai');
  assert.equal(withVector.chosen.model, 'gpt-4o-mini');
});
