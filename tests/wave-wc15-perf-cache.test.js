// @public-routes-only — exercises /v1/product/graph (public, mounted before authMiddleware).
// WC15 — perf cache lock-in for src/privacy-membrane.js + src/router.js
//
// Pins three caches the prod hot path depends on:
//   1. _loadProprietaryTerms() — mtime-keyed cache for the terms file.
//      recordCapture() scans up to 200 items per /v1/capture/log request;
//      the per-call statSync + readFileSync + JSON.parse was a measurable tax.
//   2. _getProprietaryRegexes() — cache of compiled `new RegExp(term, 'gi')`
//      per term, refreshed only when the terms cache invalidates.
//   3. _customerIdRe() — cache the compiled regex keyed off the
//      KOLM_CUSTOMER_ID_PATTERN env-value source string.
//   4. router.readProductGraph() — 30s TTL cache for the 141KB
//      public/product-graph.json file served from /v1/product/graph.
//
// These tests own the caching contract: change the caches → re-run me.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pm; // privacy-membrane module
let router; // router module (lazy — heavy to load)
let TMP;
let TERMS_PATH;

before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc15-perf-'));
  process.env.KOLM_DATA_DIR = path.join(TMP, '.kolm');
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  fs.mkdirSync(path.join(TMP, '.kolm', 'runtime'), { recursive: true });
  // Cache-bust import so KOLM_DATA_DIR is honoured at module-load time.
  pm = await import('../src/privacy-membrane.js?wc15=' + Date.now());
  TERMS_PATH = pm.statePaths().proprietary_terms;
});

beforeEach(() => {
  pm._resetCacheForTests();
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} // deliberate: cleanup
});

// ------------------------------------------------------------------ terms
test('WC15 #1 detectProprietary still functionally matches terms (sanity)', () => {
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['Acme Falcon', 'Project Athena'] }));
  pm._resetCacheForTests();
  const r = pm.scan('We use Acme Falcon for our Project Athena rollout.');
  const props = r.matches.filter((m) => m.class === 'proprietary_term').map((m) => m.value);
  assert.ok(props.includes('Acme Falcon'), 'Acme Falcon must be detected');
  assert.ok(props.includes('Project Athena'), 'Project Athena must be detected');
});

test('WC15 #2 _loadProprietaryTerms returns the cached array on second call (reference equality)', () => {
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['Foo', 'Bar'] }));
  pm._resetCacheForTests();
  pm.scan('warm cache'); // forces a load
  const peek1 = pm._peekCachesForTests();
  pm.scan('hit cache');
  const peek2 = pm._peekCachesForTests();
  assert.ok(peek1.proprietary_terms !== null, 'cache must be populated after first scan');
  assert.strictEqual(peek2.proprietary_terms, peek1.proprietary_terms,
    'second call must return same cached array reference');
});

test('WC15 #3 touching the terms file (mtime advance) invalidates the cache', () => {
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['One'] }));
  pm._resetCacheForTests();
  pm.scan('first scan');
  const peek1 = pm._peekCachesForTests();
  const cached1 = peek1.proprietary_terms;

  // Advance mtime by 5s (well past any FS timestamp resolution quirk) and
  // change file content so JSON.parse yields a different array.
  const future = (Date.now() / 1000) + 5;
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['One', 'Two'] }));
  fs.utimesSync(TERMS_PATH, future, future);

  pm.scan('second scan');
  const peek2 = pm._peekCachesForTests();
  assert.notStrictEqual(peek2.proprietary_terms, cached1,
    'mtime change must invalidate the cache (new array reference)');
  assert.equal(peek2.proprietary_terms.length, 2, 'new contents must be loaded');
});

test('WC15 #4 _resetCacheForTests clears the terms cache (next call re-reads)', () => {
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['Alpha'] }));
  pm._resetCacheForTests();
  pm.scan('warm cache');
  const peek1 = pm._peekCachesForTests();
  assert.ok(peek1.proprietary_terms !== null);

  pm._resetCacheForTests();
  const peek2 = pm._peekCachesForTests();
  assert.equal(peek2.proprietary_terms, null, 'reset must null the terms cache');

  // Next scan repopulates with a fresh reference.
  pm.scan('rewarm');
  const peek3 = pm._peekCachesForTests();
  assert.ok(peek3.proprietary_terms !== null);
  assert.notStrictEqual(peek3.proprietary_terms, peek1.proprietary_terms,
    'post-reset re-read must yield a fresh array reference');
});

test('WC15 #5 _getProprietaryRegexes caches compiled RegExps alongside terms', () => {
  fs.writeFileSync(TERMS_PATH, JSON.stringify({ terms: ['Falcon', 'Athena'] }));
  pm._resetCacheForTests();
  pm.scan('warm cache');
  const peek1 = pm._peekCachesForTests();
  pm.scan('hit cache');
  const peek2 = pm._peekCachesForTests();
  assert.ok(Array.isArray(peek1.proprietary_regex));
  assert.equal(peek1.proprietary_regex.length, 2);
  assert.strictEqual(peek2.proprietary_regex, peek1.proprietary_regex,
    'second scan must reuse the cached compiled-regex array');
  // And the individual RegExp objects must also be reused.
  assert.strictEqual(peek2.proprietary_regex[0].re, peek1.proprietary_regex[0].re);
});

// ------------------------------------------------------------------ customer ID re
test('WC15 #6 _customerIdRe caches the compiled regex (reference equality across scans)', () => {
  delete process.env.KOLM_CUSTOMER_ID_PATTERN;
  pm._resetCacheForTests();
  pm.scan('CUST-ABC123 is a customer');
  const peek1 = pm._peekCachesForTests();
  pm.scan('CID-XYZ999 is another');
  const peek2 = pm._peekCachesForTests();
  assert.ok(peek1.customer_id_re !== null);
  assert.strictEqual(peek2.customer_id_re, peek1.customer_id_re,
    'same env -> same RegExp instance');
});

test('WC15 #7 changing KOLM_CUSTOMER_ID_PATTERN invalidates the cache', () => {
  delete process.env.KOLM_CUSTOMER_ID_PATTERN;
  pm._resetCacheForTests();
  pm.scan('CUST-ABC123 default');
  const peek1 = pm._peekCachesForTests();
  const defaultRe = peek1.customer_id_re;

  process.env.KOLM_CUSTOMER_ID_PATTERN = '\\bACCOUNT-[0-9]{4,}\\b';
  pm.scan('ACCOUNT-9876 custom');
  const peek2 = pm._peekCachesForTests();
  assert.notStrictEqual(peek2.customer_id_re, defaultRe,
    'env change must produce a new RegExp instance');
  assert.equal(peek2.customer_id_src, '\\bACCOUNT-[0-9]{4,}\\b');

  // Cleanup so we don't leak across the suite.
  delete process.env.KOLM_CUSTOMER_ID_PATTERN;
});

// ------------------------------------------------------------------ product graph
test('WC15 #8 readProductGraph caches the file (no re-read within TTL) + re-reads after TTL', async () => {
  router = await import('../src/router.js?wc15=' + Date.now());
  router._resetProductGraphCacheForTests();

  // Spy on fs.readFileSync via a counter on PRODUCT_GRAPH_PATH reads.
  const origRead = fs.readFileSync;
  let reads = 0;
  const PRODUCT_GRAPH_PATH = path.resolve(
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public', 'product-graph.json')
  );
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('public/product-graph.json')) {
      reads++;
    }
    return origRead.call(this, p, ...rest);
  };

  // Save real Date.now so we can advance it.
  const origNow = Date.now;
  let now = 1_000_000_000_000;
  Date.now = () => now;

  try {
    // We need access to readProductGraph; it's not exported, so call via the
    // /v1/product/graph route OR exercise the cache through the exported reset
    // + a thin wrapper. Easier: import a fresh module and trigger via the
    // server graph endpoint. Instead we directly call the closure by exporting
    // it for tests. Fallback: hit the cache state by importing again — but
    // that creates a separate module instance. So we use the public route via
    // buildRouter() to exercise the real cached fn.

    // Simpler approach: use the exported _resetProductGraphCacheForTests and
    // hit the function indirectly by spying on reads through buildRouter +
    // a synthetic express invocation. To keep this test surgical, we test the
    // cache mechanics through repeated calls to the cached path via an
    // assertion helper imported alongside the reset.

    // The cleanest available signal: call the route handler via supertest-lite.
    // To avoid that heavy import here, we instead trust the read-count: every
    // call to readProductGraph routes through fs.readFileSync of that exact
    // path, so reads === number of cache misses.

    // First call should miss; subsequent calls within TTL should hit.
    // We need to actually invoke readProductGraph. We do that by hitting
    // the /v1/product/graph handler. Import express + build the app.
    const expressMod = await import('express');
    const app = expressMod.default();
    const built = await router.buildRouter();
    app.use(built);

    // Use Node's http.createServer + fetch to drive the route.
    const httpMod = await import('node:http');
    const server = httpMod.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      router._resetProductGraphCacheForTests();
      reads = 0;

      await fetch(`${base}/v1/product/graph`);
      assert.equal(reads, 1, 'first call must read from disk');

      await fetch(`${base}/v1/product/graph`);
      await fetch(`${base}/v1/product/graph`);
      assert.equal(reads, 1, 'subsequent calls within TTL must hit cache (still 1 disk read)');

      // Advance past 30s TTL.
      now += 30_001;
      await fetch(`${base}/v1/product/graph`);
      assert.equal(reads, 2, 'call past TTL must re-read disk (2 total reads)');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.readFileSync = origRead;
    Date.now = origNow;
  }
});
