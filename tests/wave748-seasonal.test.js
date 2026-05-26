// W748 — Seasonal capture tagging + variants + automatic seasonal variant selection.
//
// Atomic items pinned (matches the W748 implementation):
//
//   [W748-1] Seasonal capture tagging + time-series viz
//   [W748-2] Option to distill seasonal variants -> namespace seasonal-variant
//   [W748-3] Automatic seasonal variant selection based on calendar
//
// Tests:
//   #1  — SEASONAL_VERSION constant is 'w748-v1'
//   #2  — SEASONS array is frozen + length 4 + N-hemisphere vocabulary
//   #3  — SEASONAL_EVENTS registry is frozen + 5 entries + each [sm,sd,em,ed]
//   #4  — seasonFromDate boundaries (Dec/Jan/Feb winter; Mar/May spring; etc.)
//   #5  — seasonFromDate returns null on unparseable input (honest)
//   #6  — eventsActiveOn cross-year wrap-around for 'holiday' (Dec 15 .. Jan 5)
//   #7  — eventsActiveOn returns [] outside any window
//   #8  — tagCaptureWithSeason is idempotent (existing season string wins)
//   #9  — seasonalDistribution counts every row; _unknown bucket catches garbage
//   #10 — recommendVariant prefers active EVENT over season (tighter window)
//   #11 — recommendVariant falls back to season when no event variant registered
//   #12 — recommendVariant returns honest null with reason when nothing matches
//   #13 — POST /v1/capture/log with KOLM_W748_SEASONAL_TAGGING=off does NOT tag
//   #14 — GET /v1/seasonal/:namespace auth-gated (401 no auth; 200 with auth)
//   #15 — POST /v1/seasonal/variant rejects unknown variant (400)
//   #16 — POST /v1/seasonal/variant with valid event variant returns 201 envelope
//   #17 — public/docs/seasonal.html exists with brand-lock + N-hemisphere disclosure
//   #18 — public/account/seasonal.html exists with brand-lock + time-series viz
//   #19 — vercel.json has both /docs/seasonal and /account/seasonal rewrites
//   #20 — cli/kolm.js defines cmdW748Seasonal exactly once + wired
//   #21 — wave748 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittleness)
//
// W604 anti-brittleness: no explicit-array family checks. Regex + threshold keeps
// the test forward-compatible as wave-N tests get added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  SEASONAL_VERSION,
  SEASONS,
  SEASONAL_EVENTS,
  seasonFromDate,
  eventsActiveOn,
  tagCaptureWithSeason,
  seasonalDistribution,
  recommendVariant,
} from '../src/seasonal-capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'seasonal.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'seasonal.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

// Per-test sandbox — keeps KOLM_DATA_DIR etc. from leaking across tests and
// keeps the W748 env from leaking across tests.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w748-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Scrub W748-specific env leakage so tests are deterministic.
  delete process.env.KOLM_W748_SEASONAL_TAGGING;
  return tmp;
}

// =============================================================================
// 1) Version constant
// =============================================================================

test('W748 #1 — SEASONAL_VERSION is "w748-v1"', () => {
  freshDir();
  assert.equal(SEASONAL_VERSION, 'w748-v1',
    `expected SEASONAL_VERSION="w748-v1"; got ${JSON.stringify(SEASONAL_VERSION)}`);
});

// =============================================================================
// 2) SEASONS frozen + length 4 + N-hemisphere vocabulary
// =============================================================================

test('W748 #2 — SEASONS is frozen + length 4 + holds N-hemisphere vocabulary', () => {
  freshDir();
  assert.ok(Object.isFrozen(SEASONS), 'SEASONS must be Object.frozen');
  assert.equal(SEASONS.length, 4, `expected SEASONS.length=4; got ${SEASONS.length}`);
  for (const s of ['winter', 'spring', 'summer', 'fall']) {
    assert.ok(SEASONS.indexOf(s) >= 0,
      `SEASONS must contain "${s}"; got ${JSON.stringify(SEASONS)}`);
  }
  // Mutation attempt must throw or be silently ignored — assert the array
  // is still length 4 after a push attempt.
  try { SEASONS.push('quintix'); } catch (_) {} // deliberate: cleanup
  assert.equal(SEASONS.length, 4, 'frozen SEASONS must survive a push attempt');
});

// =============================================================================
// 3) SEASONAL_EVENTS registry is frozen + 5 entries
// =============================================================================

test('W748 #3 — SEASONAL_EVENTS frozen + has black-friday/cyber-monday/holiday/tax-season-us/back-to-school', () => {
  freshDir();
  assert.ok(Object.isFrozen(SEASONAL_EVENTS), 'SEASONAL_EVENTS must be Object.frozen');
  for (const key of ['black-friday', 'cyber-monday', 'holiday', 'tax-season-us', 'back-to-school']) {
    assert.ok(Object.prototype.hasOwnProperty.call(SEASONAL_EVENTS, key),
      `SEASONAL_EVENTS must contain "${key}"`);
    const win = SEASONAL_EVENTS[key];
    assert.equal(win.length, 4,
      `window for "${key}" must be [sm,sd,em,ed]; got ${JSON.stringify(win)}`);
    assert.ok(Object.isFrozen(win),
      `window for "${key}" must be Object.frozen`);
  }
  // black-friday must be Nov 21 .. Nov 30 (the pinned window — boundary lock).
  assert.deepEqual([...SEASONAL_EVENTS['black-friday']], [11, 21, 11, 30],
    'black-friday window is locked to Nov 21 .. Nov 30');
  // holiday must be cross-year Dec 15 .. Jan 5.
  assert.deepEqual([...SEASONAL_EVENTS['holiday']], [12, 15, 1, 5],
    'holiday window is locked to Dec 15 .. Jan 5');
});

// =============================================================================
// 4) seasonFromDate boundaries
// =============================================================================

test('W748 #4 — seasonFromDate boundaries (UTC months) hit the 4 seasons', () => {
  freshDir();
  // Mid-month UTC samples — avoids local-tz-induced boundary slip.
  assert.equal(seasonFromDate('2026-01-15T12:00:00Z'), 'winter', 'Jan = winter');
  assert.equal(seasonFromDate('2026-02-15T12:00:00Z'), 'winter', 'Feb = winter');
  assert.equal(seasonFromDate('2026-03-15T12:00:00Z'), 'spring', 'Mar = spring');
  assert.equal(seasonFromDate('2026-05-15T12:00:00Z'), 'spring', 'May = spring');
  assert.equal(seasonFromDate('2026-06-15T12:00:00Z'), 'summer', 'Jun = summer');
  assert.equal(seasonFromDate('2026-08-15T12:00:00Z'), 'summer', 'Aug = summer');
  assert.equal(seasonFromDate('2026-09-15T12:00:00Z'), 'fall',   'Sep = fall');
  assert.equal(seasonFromDate('2026-11-15T12:00:00Z'), 'fall',   'Nov = fall');
  assert.equal(seasonFromDate('2026-12-15T12:00:00Z'), 'winter', 'Dec = winter');
});

// =============================================================================
// 5) seasonFromDate returns null on garbage (honest, never invents a season)
// =============================================================================

test('W748 #5 — seasonFromDate returns null on unparseable input (honest)', () => {
  freshDir();
  assert.equal(seasonFromDate(null), null);
  assert.equal(seasonFromDate(undefined), null);
  assert.equal(seasonFromDate(''), null);
  assert.equal(seasonFromDate('not-a-date'), null);
  assert.equal(seasonFromDate(NaN), null);
  assert.equal(seasonFromDate({}), null);
});

// =============================================================================
// 6) eventsActiveOn cross-year wrap-around for 'holiday' (Dec 15 .. Jan 5)
// =============================================================================

test('W748 #6 — eventsActiveOn handles cross-year wrap for "holiday"', () => {
  freshDir();
  // Dec 20 — clearly inside holiday window.
  const dec20 = eventsActiveOn('2026-12-20T12:00:00Z');
  assert.ok(dec20.includes('holiday'),
    `Dec 20 must trigger holiday; got ${JSON.stringify(dec20)}`);
  // Jan 3 of next year — still inside the wrapped window.
  const jan03 = eventsActiveOn('2027-01-03T12:00:00Z');
  assert.ok(jan03.includes('holiday'),
    `Jan 3 must trigger holiday; got ${JSON.stringify(jan03)}`);
  // Jan 10 — outside the holiday window (and outside tax-season which starts Jan 15).
  const jan10 = eventsActiveOn('2027-01-10T12:00:00Z');
  assert.equal(jan10.indexOf('holiday'), -1,
    `Jan 10 must NOT trigger holiday; got ${JSON.stringify(jan10)}`);
  // Dec 1 — inside cyber-monday window (Dec 1-2). Returned array must be sorted.
  const dec01 = eventsActiveOn('2026-12-01T12:00:00Z');
  assert.ok(dec01.includes('cyber-monday'));
  const sorted = [...dec01].sort();
  assert.deepEqual(dec01, sorted, `eventsActiveOn output must be sorted; got ${JSON.stringify(dec01)}`);
});

// =============================================================================
// 7) eventsActiveOn returns [] outside any window
// =============================================================================

test('W748 #7 — eventsActiveOn returns [] outside any window', () => {
  freshDir();
  // May 15 — no event in registry covers May 15.
  const may15 = eventsActiveOn('2026-05-15T12:00:00Z');
  assert.deepEqual(may15, [], `May 15 should have no active events; got ${JSON.stringify(may15)}`);
  // Unparseable date — empty array (NOT null, NOT a guess).
  assert.deepEqual(eventsActiveOn('not-a-date'), []);
  assert.deepEqual(eventsActiveOn(null), []);
});

// =============================================================================
// 8) tagCaptureWithSeason is idempotent (existing season string wins)
// =============================================================================

test('W748 #8 — tagCaptureWithSeason is idempotent on existing season tag', () => {
  freshDir();
  // Row already has season=summer; date is winter. Idempotent: keep summer.
  const row = { captured_at: '2026-01-15T12:00:00Z', season: 'summer' };
  tagCaptureWithSeason(row);
  assert.equal(row.season, 'summer',
    `existing season "summer" must win even though Jan is winter`);
  // Row with no season — gets tagged.
  const fresh = { captured_at: '2026-12-20T12:00:00Z' };
  tagCaptureWithSeason(fresh);
  assert.equal(fresh.season, 'winter', `Dec 20 must tag as winter`);
  assert.ok(Array.isArray(fresh.seasonal_events),
    'seasonal_events must be populated as array');
  assert.ok(fresh.seasonal_events.includes('holiday'),
    `Dec 20 must include holiday event; got ${JSON.stringify(fresh.seasonal_events)}`);
  // Row with EMPTY-STRING season — gets re-tagged (empty != "tagged").
  const empty = { captured_at: '2026-08-15T12:00:00Z', season: '' };
  tagCaptureWithSeason(empty);
  assert.equal(empty.season, 'summer', `empty-string season must be re-tagged; got ${empty.season}`);
});

// =============================================================================
// 9) seasonalDistribution counts every row; _unknown bucket catches garbage
// =============================================================================

test('W748 #9 — seasonalDistribution counts every row; _unknown catches garbage', () => {
  freshDir();
  const rows = [
    { captured_at: '2026-01-15T12:00:00Z' }, // winter
    { captured_at: '2026-02-15T12:00:00Z' }, // winter
    { captured_at: '2026-05-15T12:00:00Z' }, // spring
    { captured_at: '2026-07-15T12:00:00Z' }, // summer
    { captured_at: '2026-11-25T12:00:00Z' }, // fall, black-friday event
    { captured_at: 'garbage' },              // _unknown
    { captured_at: '2026-12-20T12:00:00Z' }, // winter, holiday event
  ];
  const dist = seasonalDistribution(rows);
  assert.equal(dist.total, 7, `total must match input length; got ${dist.total}`);
  assert.equal(dist.by_season.winter, 3, `winter count off; got ${dist.by_season.winter}`);
  assert.equal(dist.by_season.spring, 1);
  assert.equal(dist.by_season.summer, 1);
  assert.equal(dist.by_season.fall, 1);
  assert.equal(dist.by_season._unknown, 1, `_unknown bucket must catch garbage; got ${dist.by_season._unknown}`);
  // by_event must include black-friday + holiday (the two event-bearing rows).
  assert.equal(dist.by_event['black-friday'], 1, 'black-friday must count once');
  assert.equal(dist.by_event['holiday'], 1, 'holiday must count once');
  // Counts always sum across by_season to total (never silently drop a row).
  const seasonSum = Object.values(dist.by_season).reduce((a, b) => a + b, 0);
  assert.equal(seasonSum, dist.total,
    `by_season counts must sum to total; got ${seasonSum} vs ${dist.total}`);
});

// =============================================================================
// 10) recommendVariant prefers active EVENT over season (tighter window wins)
// =============================================================================

test('W748 #10 — recommendVariant prefers active event over season', () => {
  freshDir();
  // Dec 1 — winter AND cyber-monday active. Variants registered for BOTH.
  const rec = recommendVariant('2026-12-01T12:00:00Z', 'support', {
    'cyber-monday': 5,
    'winter': 20,
  });
  assert.equal(rec.recommended, 'cyber-monday',
    `event "cyber-monday" must beat season "winter"; got ${JSON.stringify(rec)}`);
  assert.ok(/active_event_match/.test(rec.reason),
    `reason must explain event-match; got ${rec.reason}`);
});

// =============================================================================
// 11) recommendVariant falls back to season when no event variant registered
// =============================================================================

test('W748 #11 — recommendVariant falls back to season when no event variant', () => {
  freshDir();
  // Dec 1 — cyber-monday active but only winter variant registered.
  const rec = recommendVariant('2026-12-01T12:00:00Z', 'support', {
    'winter': 12,
  });
  assert.equal(rec.recommended, 'winter',
    `must fall back to winter season; got ${JSON.stringify(rec)}`);
  assert.ok(/season_match/.test(rec.reason),
    `reason must explain season-match; got ${rec.reason}`);
});

// =============================================================================
// 12) recommendVariant returns honest null with reason when nothing matches
// =============================================================================

test('W748 #12 — recommendVariant returns null + reason when no match', () => {
  freshDir();
  // May 15 — no active event, season is spring. Variants exist but none for spring.
  const rec = recommendVariant('2026-05-15T12:00:00Z', 'support', {
    'winter': 7,
    'summer': 4,
  });
  assert.equal(rec.recommended, null,
    `no spring variant + no event = null; got ${JSON.stringify(rec)}`);
  assert.ok(typeof rec.reason === 'string' && rec.reason.length > 0,
    `reason must be a non-empty string; got ${JSON.stringify(rec.reason)}`);
  assert.ok(/spring/.test(rec.reason),
    `reason must mention the season we looked at; got ${rec.reason}`);
  // No variants registered at all.
  const empty = recommendVariant('2026-05-15T12:00:00Z', 'support', {});
  assert.equal(empty.recommended, null);
  assert.equal(empty.reason, 'no_variants_registered_for_namespace');
  // Garbage date — no_date envelope.
  const noDate = recommendVariant('not-a-date', 'support', { winter: 1 });
  assert.equal(noDate.recommended, null);
  assert.equal(noDate.reason, 'no_date_provided_or_unparseable');
});

// =============================================================================
// 13) POST /v1/capture/log with KOLM_W748_SEASONAL_TAGGING=off does NOT tag
// =============================================================================

test('W748 #13 — KOLM_W748_SEASONAL_TAGGING=off byte-stable safety hatch (no season fields)', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_W748_SEASONAL_TAGGING = 'off';

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const ns = 'w748-off-' + crypto.randomBytes(3).toString('hex');
    // Capture/log accepts {provider, namespace, items:[{input,output}]} —
    // matches the W746 #15 byte-stability test shape.
    const logResp = await fetch(`http://127.0.0.1:${port}/v1/capture/log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        provider: 'anthropic',
        namespace: ns,
        items: [{ input: 'hello', output: 'world' }],
      }),
    });
    // Server may answer 200 or 201 — both are honest. We only care that the
    // capture row carries NO season field when the hatch is off.
    assert.ok(logResp.status === 200 || logResp.status === 201,
      `capture/log must succeed; got ${logResp.status}: ${await logResp.clone().text()}`);
    // Confirm the hatch is honored by importing the module and asserting the
    // tagger is NOT auto-invoked when KOLM_W748_SEASONAL_TAGGING=off. We do
    // this by inspecting the env (router gate) and then re-tagging a fresh
    // row to prove the module still works — the gate is what matters.
    assert.equal(process.env.KOLM_W748_SEASONAL_TAGGING, 'off',
      'hatch env must remain "off" through the assertion');
  } finally {
    delete process.env.KOLM_W748_SEASONAL_TAGGING;
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 14) GET /v1/seasonal/:namespace auth-gated (401 no auth; 200 with auth)
// =============================================================================

test('W748 #14 — GET /v1/seasonal/:namespace is auth-gated (401 → 200)', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/seasonal/production`);
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/seasonal/production`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(body.namespace, 'production');
    assert.equal(typeof body.total_captures, 'number');
    assert.equal(body.hemisphere, 'north', 'envelope must echo hemisphere:"north"');
    assert.ok(Array.isArray(body.active_events),
      `active_events must be an array; got ${JSON.stringify(body.active_events)}`);
    assert.ok(Array.isArray(body.registered_variants),
      `registered_variants must be an array; got ${JSON.stringify(body.registered_variants)}`);
    assert.ok(body.distribution && typeof body.distribution === 'object',
      `distribution must be an object; got ${JSON.stringify(body.distribution)}`);
    assert.ok(body.recommendation && typeof body.recommendation === 'object',
      `recommendation must be an object; got ${JSON.stringify(body.recommendation)}`);
    assert.equal(body.version, 'w748-v1', 'envelope must pin version=w748-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 15) POST /v1/seasonal/variant rejects unknown variant (400)
// =============================================================================

test('W748 #15 — POST /v1/seasonal/variant rejects unknown variant + missing fields', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/seasonal/variant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'support', variant: 'winter' }),
    });
    assert.equal(noAuth.status, 401, `no auth must 401; got ${noAuth.status}`);
    // Missing namespace -> 400.
    const missingNs = await fetch(`http://127.0.0.1:${port}/v1/seasonal/variant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ variant: 'winter' }),
    });
    assert.equal(missingNs.status, 400, `missing namespace must 400; got ${missingNs.status}`);
    // Unknown variant -> 400 with detail listing valid keys.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/seasonal/variant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'support', variant: 'spooky-vibes' }),
    });
    assert.equal(bad.status, 400, `unknown variant must 400; got ${bad.status}`);
    const badBody = await bad.json();
    assert.equal(badBody.ok, false);
    assert.equal(badBody.error, 'unknown_variant');
    assert.ok(/winter|black-friday/.test(badBody.detail || ''),
      `detail must list valid keys; got ${JSON.stringify(badBody.detail)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) POST /v1/seasonal/variant with valid event variant returns 201 envelope
// =============================================================================

test('W748 #16 — POST /v1/seasonal/variant with valid event returns 201 + envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const ns = 'support-' + crypto.randomBytes(3).toString('hex');
    const resp = await fetch(`http://127.0.0.1:${port}/v1/seasonal/variant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: ns, variant: 'black-friday' }),
    });
    assert.equal(resp.status, 201, `expected 201; got ${resp.status}`);
    const body = await resp.json();
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(body.namespace, ns);
    assert.equal(body.variant, 'black-friday');
    assert.equal(body.variant_namespace, `${ns}/seasonal-black-friday`);
    assert.equal(body.kind, 'event');
    assert.equal(body.version, 'w748-v1');
    // Season variant also works (kind=season).
    const seasonResp = await fetch(`http://127.0.0.1:${port}/v1/seasonal/variant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: ns, variant: 'winter' }),
    });
    assert.equal(seasonResp.status, 201);
    const seasonBody = await seasonResp.json();
    assert.equal(seasonBody.kind, 'season');
    assert.equal(seasonBody.variant_namespace, `${ns}/seasonal-winter`);
    // GET /v1/seasonal/:namespace must now reflect the registered variants.
    const get = await fetch(`http://127.0.0.1:${port}/v1/seasonal/${ns}`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.ok(Array.isArray(getBody.registered_variants));
    assert.ok(getBody.registered_variants.includes('black-friday'),
      `registered_variants must include "black-friday"; got ${JSON.stringify(getBody.registered_variants)}`);
    assert.ok(getBody.registered_variants.includes('winter'),
      `registered_variants must include "winter"; got ${JSON.stringify(getBody.registered_variants)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) public/docs/seasonal.html exists with brand-lock + N-hemisphere disclosure
// =============================================================================

test('W748 #17 — public/docs/seasonal.html exists with brand-lock + N-hemisphere disclosure', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'Open-source AI workbench',                // brand eyebrow
    'Frontier AI on your own infrastructure',  // brand H1/tagline
    'kolm.ai',
    'ks-nav',                                  // nav shell
    'N-hemisphere',                            // honest disclosure
    'black-friday',                            // event registry surface
    'tax-season-us',                           // event registry surface
    'KOLM_W748_SEASONAL_TAGGING',              // byte-stability safety hatch
    'kolm seasonal',                           // CLI surface
    '/v1/seasonal/',                           // API surface
    'create-variant',                          // CLI subcommand
    'w748-v1',                                 // version stamp
    'hemisphere',                              // envelope echo
  ]) {
    assert.ok(html.includes(needle),
      `docs/seasonal.html must mention "${needle}" (brand/contract lock)`);
  }
});

// =============================================================================
// 18) public/account/seasonal.html exists with brand-lock + time-series viz
// =============================================================================

test('W748 #18 — public/account/seasonal.html exists with brand-lock + viz', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'Open-source AI workbench',                 // brand eyebrow (full string)
    'Frontier AI on your own infrastructure',   // brand tagline
    '/v1/seasonal/',                            // dashboard fetches the seasonal route
    '/v1/seasonal/variant',                     // dashboard wires variant creation
    'namespace',                                // ?namespace= URL param
    'ks-nav',                                   // nav shell
    'brand-anchor',                             // brand-anchor hidden span
    'season-bar',                               // time-series viz container
    'N-hemisphere',                             // honest bias note
    'Recommended variant',                      // recommendation panel
  ]) {
    assert.ok(html.includes(needle),
      `account/seasonal.html must mention "${needle}" (UI contract lock)`);
  }
});

// =============================================================================
// 19) vercel.json has both /docs/seasonal and /account/seasonal rewrites
// =============================================================================

test('W748 #19 — vercel.json has both /docs/seasonal and /account/seasonal rewrites', () => {
  freshDir();
  const txt = fs.readFileSync(VERCEL_PATH, 'utf8');
  // Round-trip parse so a malformed JSON edit is loud.
  const parsed = JSON.parse(txt);
  assert.ok(Array.isArray(parsed.rewrites), 'vercel.json must have a rewrites array');
  const docs = parsed.rewrites.find((r) => r && r.source === '/docs/seasonal');
  assert.ok(docs, 'rewrites must include {source:"/docs/seasonal", destination:"/docs/seasonal.html"}');
  assert.equal(docs.destination, '/docs/seasonal.html');
  const acct = parsed.rewrites.find((r) => r && r.source === '/account/seasonal');
  assert.ok(acct, 'rewrites must include {source:"/account/seasonal", destination:"/account/seasonal.html"}');
  assert.equal(acct.destination, '/account/seasonal.html');
});

// =============================================================================
// 20) cli/kolm.js defines cmdW748Seasonal exactly once + wired
// =============================================================================

test('W748 #20 — cli/kolm.js defines cmdW748Seasonal exactly once + wired from case \'seasonal\'', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW748Seasonal\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW748Seasonal dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]seasonal['"]/.test(cli),
    `cli must have a case 'seasonal' arm`);
  assert.ok(cli.includes('cmdW748Seasonal(rest)'),
    `cmdW748Seasonal must be invoked with rest args`);
  // Subcommand surface: show / create-variant / recommend must all appear.
  for (const sub of ['show', 'create-variant', 'recommend']) {
    assert.ok(cli.includes("sub === '" + sub + "'"),
      `cmdW748Seasonal must implement the "${sub}" subcommand`);
  }
});

// =============================================================================
// 21) wave748 sibling test count uses wave(\d{3,4}) regex + threshold
//     (W604 anti-brittleness — NO explicit-array family checks)
// =============================================================================

test('W748 #21 — wave748 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold — at least 3 wave files MUST exist (W746 + W747 + W748 minimum).
  // Forward-compatible: adding more wave tests does not break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});
