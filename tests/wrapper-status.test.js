// LM-4 /status surface lock-in (V1 launch 2026-05-26)
//
// Pins the 4 contracts that ship the public /v1/status route + the
// /status page so a stray rename, deletion, or schema drift trips here.
//
//   #1 GET /v1/status handler is registered in src/router.js (grep)
//   #2 public/status/index.html exists, carries "All systems operational",
//      and labels all 4 component pills (gateway, auth, storage, captures)
//   #3 public/status/feed.json exists, parses as valid JSON, and matches
//      the JSON Feed v1.1 envelope (version + title + home_page_url +
//      feed_url + items array)
//   #4 the /v1/status handler reads the CACHE slug from public/sw.js
//      (grep for the cache-read pattern so a refactor that hardcodes a
//      stale version field fails this test)
//
// No router boot, no network — these are pure source/file pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ROUTER_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'router.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// #1 GET /v1/status route registered
// ---------------------------------------------------------------------------
test('LM-4 #1: GET /v1/status is registered in src/router.js', () => {
  // Match either single or double quotes around the path. The route
  // must be registered with r.get (not r.post — that is the existing
  // /v1/status/subscribe). Allow optional whitespace inside the call.
  const re = /r\.get\(\s*['"]\/v1\/status['"]/;
  assert.match(
    ROUTER_SRC,
    re,
    'expected r.get(\'/v1/status\', ...) handler in src/router.js',
  );
});

// ---------------------------------------------------------------------------
// #2 /status page exists with the required headline + 4 pill labels
// ---------------------------------------------------------------------------
test('LM-4 #2: public/status/index.html exists with All systems operational + 4 component pills', () => {
  const pagePath = path.join(REPO_ROOT, 'public', 'status', 'index.html');
  assert.ok(fs.existsSync(pagePath), 'public/status/index.html must exist');
  const html = fs.readFileSync(pagePath, 'utf8');
  assert.ok(
    html.includes('All systems operational'),
    'page must contain "All systems operational" headline',
  );
  // Component pills carry both a data-component attribute (script hook)
  // and a visible label. Pin BOTH the data hook and the visible name so
  // a refactor that drops either tripwires.
  const components = ['gateway', 'auth', 'storage', 'captures'];
  for (const c of components) {
    assert.ok(
      html.includes(`data-component="${c}"`),
      `pill data-component="${c}" must be present`,
    );
    // Capitalized visible label, e.g. "Gateway", "Auth", "Storage", "Captures"
    const label = c.charAt(0).toUpperCase() + c.slice(1);
    assert.ok(
      html.includes(`>${label}</span>`),
      `visible component label "${label}" must be rendered on the page`,
    );
  }
});

// ---------------------------------------------------------------------------
// #3 /status/feed.json is a valid JSON Feed v1.1 document
// ---------------------------------------------------------------------------
test('LM-4 #3: public/status/feed.json is valid JSON Feed v1.1 with items[]', () => {
  const feedPath = path.join(REPO_ROOT, 'public', 'status', 'feed.json');
  assert.ok(fs.existsSync(feedPath), 'public/status/feed.json must exist');
  const raw = fs.readFileSync(feedPath, 'utf8');
  let feed;
  assert.doesNotThrow(() => { feed = JSON.parse(raw); }, 'feed.json must parse as JSON');
  assert.equal(
    feed.version,
    'https://jsonfeed.org/version/1.1',
    'feed.version must be the JSON Feed v1.1 marker',
  );
  assert.equal(typeof feed.title, 'string', 'feed.title must be a string');
  assert.ok(feed.title.length > 0, 'feed.title must be non-empty');
  assert.equal(
    feed.home_page_url,
    'https://kolm.ai/status',
    'feed.home_page_url must point at https://kolm.ai/status',
  );
  assert.equal(
    feed.feed_url,
    'https://kolm.ai/status/feed.json',
    'feed.feed_url must self-reference https://kolm.ai/status/feed.json',
  );
  assert.ok(Array.isArray(feed.items), 'feed.items must be an array');
});

// ---------------------------------------------------------------------------
// #4 /v1/status handler reads the CACHE slug from public/sw.js
// ---------------------------------------------------------------------------
test('LM-4 #4: /v1/status handler reads CACHE slug from public/sw.js', () => {
  // The handler must read public/sw.js and extract the cache slug via a
  // regex literal that matches `const CACHE = '...'`. Pin both anchors so
  // a refactor that drops the dynamic read (e.g. hardcodes a version
  // string) fails this test.
  assert.ok(
    /public['"]\s*,\s*['"]sw\.js/.test(ROUTER_SRC),
    'handler must build path to public/sw.js',
  );
  // The regex literal in the source contains the bytes `const\s+CACHE`.
  // The test asserts the literal substring is present — proves the
  // handler is doing a regex parse of the CACHE assignment in sw.js.
  assert.ok(
    ROUTER_SRC.includes('const\\s+CACHE\\s*='),
    'handler must include a regex literal that matches `const CACHE = ...` in sw.js',
  );
});
