// W921 — Gateway semantic (embedding-similarity) prompt cache.
//
// Unit coverage for src/semantic-cache.js per the spec test_plan (1)-(7):
//   #1  namespaceCacheConfig defaults + clamp + unknown-mode degrade + safety fence
//   #2  canonicalizeCacheInput strips volatile fields + temperature bucketing
//   #3  nearestNeighbour threshold gate (null below, entry at/above, identity=1)
//   #4  semanticCacheLookup exact_hit / semantic_hit / miss
//   #5  tenant/namespace/model isolation — no cross-fenced hit
//   #6  evictExpired TTL prune + max_entries LRU
//   #7  verified (VSC) mode — no hit until promoteCacheEntryToVerified
//   #8  exact mode never serves a paraphrase; off/disabled never serves
//   #9  invalidateNamespaceCache purges a (tenant,namespace) cache

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEMANTIC_CACHE_VERSION,
  CACHE_MODES,
  namespaceCacheConfig,
  canonicalizeCacheInput,
  embedForCache,
  nearestNeighbour,
  semanticCacheLookup,
  semanticCacheWrite,
  evictExpired,
  promoteCacheEntryToVerified,
  invalidateNamespaceCache,
  cacheStoreStats,
  _resetStore,
  DIMENSIONS,
} from '../src/semantic-cache.js';

beforeEach(() => _resetStore());

const body = (text, extra = {}) => ({
  model: 'kolm-trinity',
  messages: [{ role: 'user', content: text }],
  ...extra,
});

test('#0 module surface + version constants', () => {
  assert.equal(SEMANTIC_CACHE_VERSION, 'w921-semcache-v1');
  assert.deepEqual(CACHE_MODES, ['off', 'exact', 'semantic', 'verified']);
  assert.equal(DIMENSIONS, 256);
});

test('#1 namespaceCacheConfig: defaults, clamp, unknown-mode degrade, safety fence', () => {
  const def = namespaceCacheConfig({});
  assert.equal(def.mode, 'off');
  assert.equal(def.similarity_threshold, 0.92);
  assert.equal(def.ttl_s, 3600);
  assert.equal(def.max_entries, 5000);
  assert.equal(def.embedder, 'hashed-ngram');

  // unknown mode degrades to off
  assert.equal(namespaceCacheConfig({ cache: { mode: 'banana' } }).mode, 'off');

  // threshold clamps into [0.5, 0.999]
  assert.equal(namespaceCacheConfig({ cache: { mode: 'semantic', similarity_threshold: 5 } }).similarity_threshold, 0.999);
  assert.equal(namespaceCacheConfig({ cache: { mode: 'semantic', similarity_threshold: -1 } }).similarity_threshold, 0.5);

  // verified mode implies verified_only
  assert.equal(namespaceCacheConfig({ cache: { mode: 'verified' } }).verified_only, true);

  // safety fence: a block/zero-retention/suspended namespace is forced off
  assert.equal(namespaceCacheConfig({ redact_mode: 'block', cache: { mode: 'semantic' } }).mode, 'off');
  assert.equal(namespaceCacheConfig({ capture_mode: 'block', cache: { mode: 'exact' } }).mode, 'off');
  assert.equal(namespaceCacheConfig({ status: 'suspended', cache: { mode: 'semantic' } }).mode, 'off');
  assert.equal(namespaceCacheConfig({ zero_retention: true, cache: { mode: 'semantic' } }).mode, 'off');

  // accepts bare-cache-object form too
  assert.equal(namespaceCacheConfig({ mode: 'exact' }).mode, 'exact');
});

test('#2 canonicalizeCacheInput: strips volatile fields, buckets temperature', () => {
  const a = canonicalizeCacheInput(body('Hello there', { stream: true, user: 'u1', request_id: 'r1', temperature: 0.0 }));
  const b = canonicalizeCacheInput(body('Hello there', { stream: false, user: 'u2', request_id: 'r2', temperature: 0.05 }));
  // volatile-only differences collide; temp 0.0 and 0.05 share the 0.0 bucket
  assert.deepEqual(a.canonicalInput, b.canonicalInput);
  assert.equal(a.temperature_bucket, '0.0');
  assert.equal(b.temperature_bucket, '0.0');

  // temp 0.0 and 0.9 do NOT collide
  const c = canonicalizeCacheInput(body('Hello there', { temperature: 0.9 }));
  assert.notEqual(a.temperature_bucket, c.temperature_bucket);
  assert.notDeepEqual(a.canonicalInput, c.canonicalInput);

  assert.equal(a.userText, 'Hello there');
  assert.equal(a.tool_schema_hash, 'none');

  // distinct tool schema changes the hash
  const withTools = canonicalizeCacheInput(body('q', { tools: [{ type: 'function', function: { name: 'f' } }] }));
  assert.notEqual(withTools.tool_schema_hash, 'none');
});

test('#3 nearestNeighbour: threshold gate + identity', () => {
  const q = embedForCache('how do I reset my password');
  const same = { vector: embedForCache('how do I reset my password'), entry: { id: 'same' } };
  const close = { vector: embedForCache('how can I reset my password please'), entry: { id: 'close' } };
  const far = { vector: embedForCache('what is the airspeed velocity of an unladen swallow'), entry: { id: 'far' } };

  // identity -> ~1.0
  const idHit = nearestNeighbour(q, [same], 0.999);
  assert.ok(idHit);
  assert.ok(idHit.similarity > 0.999);
  assert.equal(idHit.entry.id, 'same');

  // unrelated text sits below 0.85
  const farSim = nearestNeighbour(q, [far], -1).similarity;
  assert.ok(farSim < 0.85, `expected far sim < 0.85, got ${farSim}`);

  // high threshold rejects the far candidate -> null
  assert.equal(nearestNeighbour(q, [far], 0.92), null);

  // argmax picks the closest among several
  const winner = nearestNeighbour(q, [far, close, same], 0.5);
  assert.equal(winner.entry.id, 'same');

  // empty / malformed inputs -> null
  assert.equal(nearestNeighbour(q, [], 0.5), null);
  assert.equal(nearestNeighbour(null, [same], 0.5), null);
});

test('#4 semanticCacheLookup: exact_hit, semantic_hit, miss', async () => {
  // Default-strength threshold (0.92). The in-repo hashed-ngram embedder is a
  // surface bag-of-ngrams: it catches near-duplicate phrasings (punctuation /
  // whitespace variants), not deep paraphrase — matching the spec caveat that a
  // real transformer embedder is the opt-in recall upgrade.
  const cfg = namespaceCacheConfig({ cache: { mode: 'semantic', similarity_threshold: 0.92 } });
  const ctx = { tenant: 't1', namespace: 'ns1', model: 'm1', config: cfg };

  const ci = canonicalizeCacheInput(body('How do I reset my password?'));
  // miss on empty store
  const m0 = await semanticCacheLookup({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText });
  assert.equal(m0.status, 'miss');

  await semanticCacheWrite({
    ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText,
    value: { answer: 'Use the reset link.' }, source_receipt_id: 'rcpt_1',
  });

  // byte-identical -> exact_hit, similarity 1, source receipt threaded
  const exact = await semanticCacheLookup({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText });
  assert.equal(exact.status, 'exact_hit');
  assert.equal(exact.similarity, 1);
  assert.equal(exact.source_receipt_id, 'rcpt_1');
  assert.deepEqual(exact.value, { answer: 'Use the reset link.' });

  // near-duplicate above threshold (different canonical key -> not exact) -> semantic_hit
  const near = canonicalizeCacheInput(body('How do I reset my password'));
  assert.notDeepEqual(near.canonicalInput, ci.canonicalInput);
  const sem = await semanticCacheLookup({ ...ctx, canonicalInput: near.canonicalInput, userText: near.userText });
  assert.equal(sem.status, 'semantic_hit');
  assert.ok(sem.similarity >= 0.92 && sem.similarity < 1, `similarity ${sem.similarity}`);
  assert.equal(sem.source_receipt_id, 'rcpt_1');

  // unrelated prompt -> miss (far below threshold)
  const unrel = canonicalizeCacheInput(body('What is the capital of France?'));
  const miss = await semanticCacheLookup({ ...ctx, canonicalInput: unrel.canonicalInput, userText: unrel.userText });
  assert.equal(miss.status, 'miss');
});

test('#5 isolation: never returns across tenant / namespace / model', async () => {
  const cfg = namespaceCacheConfig({ cache: { mode: 'semantic', similarity_threshold: 0.5 } });
  const ci = canonicalizeCacheInput(body('shared exact prompt'));
  await semanticCacheWrite({
    tenant: 'A', namespace: 'X', model: 'M', config: cfg,
    canonicalInput: ci.canonicalInput, userText: ci.userText,
    value: { a: 1 }, source_receipt_id: 'r',
  });

  const base = { canonicalInput: ci.canonicalInput, userText: ci.userText, config: cfg };
  assert.equal((await semanticCacheLookup({ ...base, tenant: 'B', namespace: 'X', model: 'M' })).status, 'miss');
  assert.equal((await semanticCacheLookup({ ...base, tenant: 'A', namespace: 'Y', model: 'M' })).status, 'miss');
  assert.equal((await semanticCacheLookup({ ...base, tenant: 'A', namespace: 'X', model: 'N' })).status, 'miss');
  // same fence -> hit
  assert.equal((await semanticCacheLookup({ ...base, tenant: 'A', namespace: 'X', model: 'M' })).status, 'exact_hit');
});

test('#6 evictExpired: TTL prune + max_entries LRU', async () => {
  const cfg = namespaceCacheConfig({ cache: { mode: 'semantic', ttl_s: 3600, max_entries: 2 } });
  const ctx = { tenant: 't', namespace: 'ns', model: 'm', config: cfg };

  for (const q of ['alpha one', 'beta two', 'gamma three']) {
    const ci = canonicalizeCacheInput(body(q));
    await semanticCacheWrite({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { q }, source_receipt_id: q });
  }
  // max_entries=2 enforced on write -> oldest ('alpha one') evicted
  assert.equal(cacheStoreStats().entries, 2);

  // TTL prune: future "now" past ttl wipes everything
  const future = Date.now() + 3601 * 1000;
  const { pruned } = evictExpired({ tenant: 't', namespace: 'ns', model: 'm', now: future, max_entries: 2, ttl_s: 3600 });
  assert.ok(pruned >= 1);
  assert.equal(cacheStoreStats().entries, 0);
});

test('#7 verified mode: no semantic hit until promoted', async () => {
  const cfg = namespaceCacheConfig({ cache: { mode: 'verified', similarity_threshold: 0.92 } });
  assert.equal(cfg.verified_only, true);
  const ctx = { tenant: 't', namespace: 'ns', model: 'm', config: cfg };

  const ci = canonicalizeCacheInput(body('How do I reset my password?'));
  await semanticCacheWrite({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { a: 'x' }, source_receipt_id: 'r1' });

  const near = canonicalizeCacheInput(body('How do I reset my password'));
  // unpromoted -> miss (and even exact unpromoted is gated in verified mode)
  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: near.canonicalInput, userText: near.userText })).status, 'miss');
  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText })).status, 'miss');

  // promote the stored exact_key, then it serves
  const exact_key = await firstEntryKey('t', 'ns', 'm');
  const prom = await promoteCacheEntryToVerified({ tenant: 't', namespace: 'ns', model: 'm', entry_key: exact_key });
  assert.equal(prom.ok, true);

  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText })).status, 'exact_hit');
  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: near.canonicalInput, userText: near.userText })).status, 'semantic_hit');
});

test('#8 exact mode never serves a paraphrase; off/disabled never serves', async () => {
  const exactCfg = namespaceCacheConfig({ cache: { mode: 'exact' } });
  const ctx = { tenant: 't', namespace: 'ns', model: 'm', config: exactCfg };
  const ci = canonicalizeCacheInput(body('how do I reset my password'));
  await semanticCacheWrite({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { a: 1 }, source_receipt_id: 'r' });

  const para = canonicalizeCacheInput(body('how can I reset my password please'));
  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: para.canonicalInput, userText: para.userText })).status, 'miss');
  assert.equal((await semanticCacheLookup({ ...ctx, canonicalInput: ci.canonicalInput, userText: ci.userText })).status, 'exact_hit');

  // off -> disabled, never writes
  const offCfg = namespaceCacheConfig({ cache: { mode: 'off' } });
  const offCtx = { tenant: 't2', namespace: 'ns', model: 'm', config: offCfg };
  const w = await semanticCacheWrite({ ...offCtx, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { a: 1 } });
  assert.equal(w.written, false);
  assert.equal((await semanticCacheLookup({ ...offCtx, canonicalInput: ci.canonicalInput, userText: ci.userText })).status, 'disabled');
});

test('#9 invalidateNamespaceCache purges a (tenant,namespace)', async () => {
  const cfg = namespaceCacheConfig({ cache: { mode: 'exact' } });
  const ci = canonicalizeCacheInput(body('q'));
  await semanticCacheWrite({ tenant: 't', namespace: 'ns', model: 'm1', config: cfg, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { a: 1 } });
  await semanticCacheWrite({ tenant: 't', namespace: 'ns', model: 'm2', config: cfg, canonicalInput: ci.canonicalInput, userText: ci.userText, value: { a: 2 } });
  assert.equal(cacheStoreStats().entries, 2);

  const { removed } = invalidateNamespaceCache('t', 'ns');
  assert.equal(removed, 2);
  assert.equal(cacheStoreStats().entries, 0);
});

// helper: re-derive the canonical exact_key the module stores an entry under,
// so a test can target it for operator promotion.
async function firstEntryKey(_tenant, _namespace, model, prompt = 'How do I reset my password?') {
  const { cacheKey } = await import('../src/cache.js');
  const ci = canonicalizeCacheInput(body(prompt));
  return cacheKey(model, ci.canonicalInput);
}
