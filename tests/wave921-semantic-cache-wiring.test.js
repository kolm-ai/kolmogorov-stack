// W921 — the semantic/exact prompt cache (src/semantic-cache.js) must be wired
// into /v1/gateway/dispatch: a lookup BEFORE routing (return the cached response
// + skip the upstream call on a hit) and a write AFTER a successful live call.
// Default namespace cache mode is 'off' => disabled (zero behavior change).
// Source-level lock-in (behavior needs a live dispatch + a warmed cache).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-CACHE #1 — dispatch imports the cache and resolves a namespace cache config', () => {
  assert.match(ROUTER, /await import\('\.\/semantic-cache\.js'\)/, 'dispatch must import semantic-cache.js');
  assert.match(ROUTER, /semcache\.namespaceCacheConfig\(nsConfig\)/, 'must resolve the namespace cache config');
  assert.match(ROUTER, /semcache\.deriveCachePolicy\(\{/, 'must derive a category-aware cache policy before lookup/write');
});

test('W921-CACHE #2 — lookup before routing returns a hit and skips the upstream call', () => {
  assert.match(ROUTER, /semcache\.semanticCacheLookup\(\{/, 'must call semanticCacheLookup');
  assert.match(ROUTER, /category:\s*_cachePolicy\.category/, 'lookup must be partitioned by the derived cache category');
  assert.match(ROUTER, /_cachePolicy && _cachePolicy\.cache_allowed[\s\S]*?semcache\.semanticCacheLookup/,
    'lookup must be gated by the cache policy so sensitive/adversarial prompts do not hit the cache');
  assert.match(ROUTER, /_hit\.status\.endsWith\('_hit'\)[\s\S]*?kolm_cache_hit/,
    'a cache hit must return early with a kolm_cache_hit marker (skipping routing + dispatch)');
});

test('W921-CACHE #3 — write after a successful live call, gated off by default', () => {
  assert.match(ROUTER, /if \(_cacheCfg\.mode !== 'off' && _cacheCanon && result\.ok && _cachePolicy && _cachePolicy\.cache_allowed\)[\s\S]*?semcache\.semanticCacheWrite/,
    'must write to the cache only on a successful live call when caching is enabled and policy allows it');
  assert.match(ROUTER, /semcache\.semanticCacheWrite\(\{[\s\S]*?category:\s*_cachePolicy\.category/,
    'writes must use the same category partition as lookup');
});
