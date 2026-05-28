// W751-W755 — Vertical foundation students.
//
// Ships items 3 + 4 (marketplace listing stub + landing pages) for all 5
// verticals (legal, medical, code, finance, support). Items 1 + 2 (per-
// vertical fingerprint + per-vertical pre-train) are W757-blocked and surface
// an honest "w757_not_shipped" envelope.
//
// Atomic items pinned (matches the W751-W755 implementation):
//
//   1) VERTICALS_VERSION present + stamped 'w751-v1'
//   2) VERTICALS array frozen + len=5 + canonical id order
//   3) every vertical row carries the full schema (id, name, tagline,
//      target_kscore, common_tasks, model_slug, marketplace_status)
//   4) getVertical() returns the row case-insensitively + null for unknown
//   5) registerVerticalArtifact() registers an HONEST stub:
//      pending_distill:true, not_kolm_compiled:true, k_score:null, kscore null
//   6) registerAllVerticalStubs() is idempotent (second call SKIPS dup slugs)
//   7) verticalFingerprintStub returns honest w757_not_shipped envelope
//   8) GET  /v1/verticals is public + returns ok:true + total:5
//   9) GET  /v1/verticals/:id is public + returns one vertical
//  10) GET  /v1/verticals/nonexistent returns 404 with known[] list
//  11) POST /v1/verticals/register-stubs is auth-required (401 without)
//  12) POST /v1/verticals/register-stubs is owner-gated (403 for anon)
//  13) POST /v1/verticals/register-stubs returns ok:true for kind:'human' owner
//      AND every registered listing has pending_distill:true + kscore:null
//  14) GET  /v1/verticals/legal/fingerprint requires auth + returns honest
//      w757_not_shipped envelope with blocked_by:'W757'
//  15) All 5 public/verticals/<id>.html files exist with brand-lock eyebrow +
//      model_slug + case-study skeleton
//  16) public/docs/verticals.html exists with brand-lock H1 + sortable table +
//      all 5 vertical rows + version stamp
//  17) vercel.json has 6 rewrites: /verticals/<id> for all 5 + /docs/verticals
//  18) cli/kolm.js defines cmdW751Verticals exactly once + wired from case
//      'vertical'
//  19) src/auth.js makes /v1/verticals + /v1/verticals/:id public (PUBLIC_API)
//      but keeps /v1/verticals/:id/fingerprint AND register-stubs auth-gated
//  20) wave751 sibling test count uses regex wave(\d{3,4}) + threshold pattern
//      (W604 anti-brittleness: NEVER an explicit hard-coded sibling list)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  VERTICALS_VERSION,
  VERTICALS,
  getVertical,
  listVerticals,
  registerVerticalArtifact,
  registerAllVerticalStubs,
  verticalFingerprintStub,
} from '../src/verticals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const VERTICALS_DIR = path.join(REPO_ROOT, 'public', 'verticals');
const DOCS_VERTICALS = path.join(REPO_ROOT, 'public', 'docs', 'verticals.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const AUTH_PATH = path.join(REPO_ROOT, 'src', 'auth.js');
const TESTS_DIR = __dirname;

const VERTICAL_IDS = ['legal', 'medical', 'code', 'finance', 'support'];

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w751-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

async function freshEventStore() {
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const market = await import('../src/marketplace-store.js');
  if (market._resetForTests) market._resetForTests();
  return { eventStore, market };
}

// =============================================================================
// 1) VERTICALS_VERSION present + stamped 'w751-v1'
// =============================================================================

test('W751 #1 — VERTICALS_VERSION present + stamped w751-v1', () => {
  freshDir();
  assert.equal(VERTICALS_VERSION, 'w751-v1',
    `expected VERTICALS_VERSION='w751-v1'; got ${JSON.stringify(VERTICALS_VERSION)}`);
});

// =============================================================================
// 2) VERTICALS array frozen + len=5 + canonical id order
// =============================================================================

test('W751 #2 — VERTICALS frozen + len=5 + canonical id order', () => {
  freshDir();
  assert.ok(Array.isArray(VERTICALS), 'VERTICALS must be an array');
  assert.equal(VERTICALS.length, 5,
    `expected exactly 5 verticals; got ${VERTICALS.length}`);
  // Object.freeze on the outer array.
  assert.ok(Object.isFrozen(VERTICALS),
    'VERTICALS array must be Object.freeze()d (deliberate breaking-change gate)');
  // Each entry frozen too.
  for (const v of VERTICALS) {
    assert.ok(Object.isFrozen(v),
      `vertical row ${v && v.id} must be Object.freeze()d`);
  }
  // Canonical id order pinned — any re-order is a deliberate breaking change.
  const ids = VERTICALS.map((v) => v.id);
  assert.deepEqual(ids, VERTICAL_IDS,
    `vertical id order pinned to ${JSON.stringify(VERTICAL_IDS)}; got ${JSON.stringify(ids)}`);
  // listVerticals() returns the same frozen catalog (not a copy).
  assert.equal(listVerticals(), VERTICALS,
    'listVerticals() must return the frozen catalog reference');
});

// =============================================================================
// 3) every vertical row carries the full schema
// =============================================================================

test('W751 #3 — every vertical row has the full schema (id/name/tagline/target_kscore/common_tasks/model_slug/marketplace_status)', () => {
  freshDir();
  for (const v of VERTICALS) {
    assert.ok(typeof v.id === 'string' && v.id.length > 0,
      `vertical missing id: ${JSON.stringify(v)}`);
    assert.ok(typeof v.name === 'string' && v.name.length > 0,
      `vertical ${v.id} missing name`);
    assert.ok(typeof v.tagline === 'string' && v.tagline.length > 0,
      `vertical ${v.id} missing tagline`);
    assert.ok(typeof v.target_kscore === 'number'
      && v.target_kscore > 0 && v.target_kscore <= 1,
      `vertical ${v.id} target_kscore must be in (0,1]; got ${v.target_kscore}`);
    assert.ok(Array.isArray(v.common_tasks) && v.common_tasks.length >= 3,
      `vertical ${v.id} must have >=3 common_tasks; got ${JSON.stringify(v.common_tasks)}`);
    assert.ok(Object.isFrozen(v.common_tasks),
      `vertical ${v.id} common_tasks must be frozen`);
    assert.equal(v.model_slug, 'kolm-' + v.id + '-7b',
      `vertical ${v.id} model_slug must be 'kolm-${v.id}-7b'; got ${v.model_slug}`);
    assert.equal(v.marketplace_status, 'pending_distill',
      `vertical ${v.id} marketplace_status must be 'pending_distill' at W751-v1; got ${v.marketplace_status}`);
    // No emoji icon field — standing brand-lock rule.
    assert.equal(v.icon, undefined,
      `vertical ${v.id} MUST NOT carry an icon/emoji field (brand-lock); got ${v.icon}`);
  }
});

// =============================================================================
// 4) getVertical() returns the row case-insensitively + null for unknown
// =============================================================================

test('W751 #4 — getVertical() case-insensitive + null for unknown', () => {
  freshDir();
  const a = getVertical('legal');
  const b = getVertical('LEGAL');
  const c = getVertical('  Legal ');
  assert.ok(a && a.id === 'legal', 'getVertical(legal) must return the legal row');
  assert.equal(a, b, 'getVertical must be case-insensitive (LEGAL == legal)');
  assert.equal(a, c, 'getVertical must trim + lowercase whitespace input');
  // Unknown returns null, never throws.
  assert.equal(getVertical('marketing'), null);
  assert.equal(getVertical(''), null);
  assert.equal(getVertical(null), null);
  assert.equal(getVertical(undefined), null);
  assert.equal(getVertical(42), null);
});

// =============================================================================
// 5) registerVerticalArtifact() registers an HONEST stub
// =============================================================================

test('W751 #5 — registerVerticalArtifact() registers HONEST pending_distill stub', async () => {
  freshDir();
  await freshEventStore();
  const listing = await registerVerticalArtifact('legal');
  // The marketplace-store-side fields.
  assert.equal(listing.cid, 'pending_legal',
    `cid must be 'pending_legal' for the W751 stub; got ${listing.cid}`);
  assert.equal(listing.vertical, 'legal');
  assert.equal(listing.k_score, null,
    `kscore MUST be null on stub (NEVER fake); got ${listing.k_score}`);
  assert.equal(listing.hardware_target, 'rtx');
  // The manifest carries the honesty contract.
  assert.ok(listing.manifest, 'listing.manifest required');
  assert.equal(listing.manifest.pending_distill, true,
    `manifest.pending_distill must be true; got ${listing.manifest.pending_distill}`);
  assert.equal(listing.manifest.not_kolm_compiled, true,
    `manifest.not_kolm_compiled must be true; got ${listing.manifest.not_kolm_compiled}`);
  assert.equal(listing.manifest.k_score, null,
    `manifest.k_score must be null (NEVER fake); got ${listing.manifest.k_score}`);
  assert.deepEqual(listing.manifest.blocked_by, ['W757', 'W715'],
    `blocked_by must be ['W757','W715']; got ${JSON.stringify(listing.manifest.blocked_by)}`);
  // Unknown vertical throws with UNKNOWN_VERTICAL code.
  await assert.rejects(
    () => registerVerticalArtifact('marketing'),
    (e) => e && e.code === 'UNKNOWN_VERTICAL',
    'registerVerticalArtifact(marketing) must throw UNKNOWN_VERTICAL',
  );
});

// =============================================================================
// 6) registerAllVerticalStubs() is idempotent
// =============================================================================

test('W751 #6 — registerAllVerticalStubs() is idempotent (second call skips dup slugs)', async () => {
  freshDir();
  await freshEventStore();
  const first = await registerAllVerticalStubs();
  assert.equal(first.ok, true);
  assert.equal(first.version, 'w751-v1');
  assert.equal(first.total, 5);
  assert.equal(first.registered.length, 5,
    `first call must register all 5; got ${JSON.stringify(first.registered)}`);
  assert.equal(first.skipped.length, 0,
    `first call must skip nothing; got ${JSON.stringify(first.skipped)}`);
  // Every model_slug in canonical kolm-<id>-7b shape.
  for (const slug of first.registered) {
    assert.ok(/^kolm-[a-z]+-7b$/.test(slug),
      `registered slug must match kolm-<id>-7b; got ${slug}`);
  }
  const second = await registerAllVerticalStubs();
  assert.equal(second.ok, true);
  assert.equal(second.registered.length, 0,
    `second call must register nothing (idempotent); got ${JSON.stringify(second.registered)}`);
  assert.equal(second.skipped.length, 5,
    `second call must skip all 5; got ${JSON.stringify(second.skipped)}`);
});

// =============================================================================
// 7) verticalFingerprintStub honest envelope
// =============================================================================

test('W751 #7 — verticalFingerprintStub returns honest w757_not_shipped envelope', () => {
  freshDir();
  const env = verticalFingerprintStub('legal');
  assert.equal(env.ok, false,
    `fingerprint stub MUST have ok:false (feature not shipped); got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'w757_not_shipped',
    `error code MUST be 'w757_not_shipped'; got ${env.error}`);
  assert.equal(env.blocked_by, 'W757',
    `blocked_by MUST be 'W757'; got ${env.blocked_by}`);
  assert.equal(env.vertical, 'legal');
  assert.ok(typeof env.hint === 'string' && env.hint.includes('W757'),
    `hint must mention W757; got ${JSON.stringify(env.hint)}`);
  assert.equal(env.version, 'w751-v1');
});

// =============================================================================
// 8) GET /v1/verticals is public + returns ok:true + total:5
// =============================================================================

test('W751 #8 — GET /v1/verticals is PUBLIC + returns ok:true + total:5', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No auth header — should still succeed (public route).
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals`, { method: 'GET' });
    assert.equal(res.status, 200, `expected 200 (public); got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'w751-v1');
    assert.equal(body.total, 5);
    assert.ok(Array.isArray(body.verticals) && body.verticals.length === 5);
    const ids = body.verticals.map((v) => v.id);
    assert.deepEqual(ids, VERTICAL_IDS, 'API id order must match canonical');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 9) GET /v1/verticals/:id is public + returns one vertical
// =============================================================================

test('W751 #9 — GET /v1/verticals/legal is PUBLIC + returns one vertical', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals/legal`, { method: 'GET' });
    assert.equal(res.status, 200, `expected 200 public; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'w751-v1');
    assert.ok(body.vertical && body.vertical.id === 'legal');
    assert.equal(body.vertical.model_slug, 'kolm-legal-7b');
    assert.equal(body.vertical.marketplace_status, 'pending_distill');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 10) GET /v1/verticals/<unknown> returns 404 with known[] list
// =============================================================================

test('W751 #10 — GET /v1/verticals/<unknown> returns 404 with known list', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals/marketing`, { method: 'GET' });
    assert.equal(res.status, 404, `expected 404 for unknown vertical; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unknown_vertical');
    assert.equal(body.id, 'marketing');
    assert.deepEqual(body.known, VERTICAL_IDS,
      `404 envelope must echo known ids; got ${JSON.stringify(body.known)}`);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 11) POST /v1/verticals/register-stubs is auth-required (401)
// =============================================================================

test('W751 #11 — POST /v1/verticals/register-stubs returns 401 without auth', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals/register-stubs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401, `expected 401 with no auth; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'auth_required');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 12) POST /v1/verticals/register-stubs is owner-gated (403 for anon)
// =============================================================================

test('W751 #12 — POST /v1/verticals/register-stubs returns 403 for anon (non-owner)', async () => {
  freshDir();
  await freshEventStore();
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
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals/register-stubs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403,
      `anon kind must be 403 (owner-gated); got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'forbidden');
    assert.ok(typeof body.hint === 'string' && body.hint.includes('owner-only'),
      `hint must mention owner-only; got ${JSON.stringify(body.hint)}`);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 13) POST /v1/verticals/register-stubs returns ok:true for kind:'human' owner
// =============================================================================

test('W751 #13 — POST /v1/verticals/register-stubs returns ok:true for kind:human (owner)', async () => {
  freshDir();
  await freshEventStore();
  const { buildRouter } = await import('../src/router.js');
  const { provisionTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  // kind:'human' satisfies the W751 owner check.
  const t = provisionTenant('w751-owner-' + crypto.randomBytes(3).toString('hex'),
    { kind: 'human', plan: 'enterprise', quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/verticals/register-stubs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, `expected 200 for human owner; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, 'w751-v1');
    assert.equal(body.total, 5);
    // First call registers 5, none skipped (fresh store).
    assert.equal(body.registered.length, 5,
      `expected 5 registrations on fresh store; got ${JSON.stringify(body.registered)}`);
    assert.equal(body.skipped.length, 0);
    // Every registered slug matches kolm-<id>-7b shape.
    for (const slug of body.registered) {
      assert.ok(/^kolm-[a-z]+-7b$/.test(slug),
        `slug shape must be kolm-<id>-7b; got ${slug}`);
    }
    // Idempotency: a second call returns the same envelope shape with
    // skipped[].length === 5 + registered[].length === 0.
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/verticals/register-stubs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.registered.length, 0,
      `idempotent second call must register 0; got ${JSON.stringify(body2.registered)}`);
    assert.equal(body2.skipped.length, 5,
      `idempotent second call must skip 5; got ${JSON.stringify(body2.skipped)}`);

    // Verify every registered listing carries HONEST pending fields (read from
    // the marketplace store directly so the test pins the contract, not a
    // synthetic mirror).
    const market = await import('../src/marketplace-store.js');
    for (const id of VERTICAL_IDS) {
      const row = await market.getListingByCid('pending_' + id);
      assert.ok(row, `expected listing for pending_${id}`);
      assert.equal(row.k_score, null,
        `${id} k_score must be null on stub (NEVER fake); got ${row.k_score}`);
      assert.equal(row.manifest.pending_distill, true,
        `${id} manifest.pending_distill must be true; got ${row.manifest.pending_distill}`);
      assert.equal(row.manifest.not_kolm_compiled, true,
        `${id} manifest.not_kolm_compiled must be true; got ${row.manifest.not_kolm_compiled}`);
    }
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 14) GET /v1/verticals/<id>/fingerprint requires auth + returns honest envelope
// =============================================================================

test('W751 #14 — GET /v1/verticals/<id>/fingerprint requires auth + returns honest w757 envelope', async () => {
  freshDir();
  await freshEventStore();
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
    // 14a — no auth → 401 (the fingerprint surface is NOT public).
    // The auth middleware may short-circuit with its own 'missing api key'
    // error before reaching the route's 'auth_required' check. Both are
    // honest 401 envelopes; either one proves auth is enforced.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/verticals/legal/fingerprint`, {
      method: 'GET',
    });
    assert.equal(noAuth.status, 401,
      `fingerprint must require auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(noAuthBody.error || '')),
      `expected an auth-required-shape error; got ${JSON.stringify(noAuthBody)}`,
    );
    // 14b — unknown vertical → 404 + known[] list.
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/verticals/marketing/fingerprint`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(unknown.status, 404,
      `unknown vertical fingerprint must 404; got ${unknown.status}`);
    const unkBody = await unknown.json();
    assert.equal(unkBody.error, 'unknown_vertical');
    assert.deepEqual(unkBody.known, VERTICAL_IDS);
    // 14c — known vertical with auth → 200 envelope with honest ok:false + w757_not_shipped.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/verticals/legal/fingerprint`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200,
      `the route succeeded; the FEATURE is what's blocked; expected 200, got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, false,
      `feature blocked → ok:false envelope; got ${JSON.stringify(body)}`);
    assert.equal(body.error, 'w757_not_shipped');
    assert.equal(body.blocked_by, 'W757');
    assert.equal(body.vertical, 'legal');
    assert.equal(body.version, 'w751-v1');
    assert.ok(typeof body.hint === 'string' && body.hint.includes('W757'));
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 15) All 5 public/verticals/<id>.html files exist with brand-lock + slug
// =============================================================================

test('W751 #15 — all 5 public/verticals/<id>.html exist with brand-lock + model_slug + case-study skeleton', () => {
  freshDir();
  for (const v of VERTICALS) {
    const p = path.join(VERTICALS_DIR, v.id + '.html');
    assert.ok(fs.existsSync(p), `expected landing page at ${p}`);
    const html = fs.readFileSync(p, 'utf8');
    for (const needle of [
      'kolm.ai',
      'Open-source AI workbench',          // brand eyebrow
      'Frontier AI',                       // brand H1 family (per-vertical OR brand)
      v.model_slug,                        // kolm-<id>-7b
      'w751-v1',                           // version stamp
      'pending_distill',                   // honest pending status
      'Case study',                        // case-study skeleton heading
      '/marketplace/' + v.model_slug,      // CTA into marketplace listing
      'cross-namespace transfer math',     // blocker reference (W917/3a57dd4f
                                           // public-surface polish scrubbed the
                                           // internal W757/W715 wave tags from
                                           // shipped HTML — the blocker is now
                                           // described in plain words)
    ]) {
      assert.ok(html.includes(needle),
        `verticals/${v.id}.html must mention "${needle}"`);
    }
    // Per-vertical landing page MUST NOT carry emoji glyphs in body (brand-lock).
    // Restrict to a defense-in-depth common emoji set — full regex would be
    // brittle. The standing rule is no emojis anywhere in shipped HTML.
    const commonEmoji = /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
    assert.ok(!commonEmoji.test(html),
      `verticals/${v.id}.html MUST NOT carry emoji glyphs (brand-lock)`);
  }
});

// =============================================================================
// 16) public/docs/verticals.html overview page
// =============================================================================

test('W751 #16 — public/docs/verticals.html exists with brand-lock H1 + sortable table + all 5 rows', () => {
  freshDir();
  assert.ok(fs.existsSync(DOCS_VERTICALS), `expected ${DOCS_VERTICALS}`);
  const html = fs.readFileSync(DOCS_VERTICALS, 'utf8');
  for (const needle of [
    'kolm.ai',
    'Open-source AI workbench',                  // brand eyebrow
    'Frontier AI on your own infrastructure',    // brand H1 (the docs page uses the brand H1)
    'w751-v1',                                   // version stamp
    'pending_distill',                           // honest status
    // The internal W757/W715 wave tags were deliberately scrubbed from shipped
    // HTML by 3a57dd4f ("Public-surface polish ... drops internal version
    // tags"). The blocker is now described in plain product language; pin the
    // surviving phrases instead of the internal wave-tag noise.
    'fingerprinting',                            // blocker (vertical fingerprint pipeline)
    'cross-namespace transfer math',             // other blocker
    'target_kscore',                             // sortable column key
    'sort',                                      // sort JS
  ]) {
    assert.ok(html.includes(needle),
      `docs/verticals.html must mention "${needle}"`);
  }
  // Every vertical id appears at least once (5 rows in the table).
  for (const v of VERTICALS) {
    assert.ok(html.includes(v.model_slug),
      `docs/verticals.html must reference model_slug ${v.model_slug}`);
    assert.ok(html.includes('/verticals/' + v.id),
      `docs/verticals.html must link to /verticals/${v.id}`);
  }
  // No emoji glyphs in body (brand-lock).
  const commonEmoji = /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
  assert.ok(!commonEmoji.test(html),
    'docs/verticals.html MUST NOT carry emoji glyphs (brand-lock)');
});

// =============================================================================
// 17) vercel.json has 6 rewrites (/verticals/<id> for all 5 + /docs/verticals)
// =============================================================================

test('W751 #17 — vercel.json has 6 rewrites for verticals (5 landing + 1 docs)', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = v.rewrites || [];
  for (const id of VERTICAL_IDS) {
    const rw = rewrites.find((r) => r.source === '/verticals/' + id);
    assert.ok(rw, `vercel.json must have rewrite for /verticals/${id}`);
    assert.equal(rw.destination, '/verticals/' + id + '.html',
      `rewrite destination must be /verticals/${id}.html; got ${rw.destination}`);
  }
  const docs = rewrites.find((r) => r.source === '/docs/verticals');
  assert.ok(docs, 'vercel.json must have rewrite for /docs/verticals');
  assert.equal(docs.destination, '/docs/verticals.html');
});

// =============================================================================
// 18) cli/kolm.js dispatcher
// =============================================================================

test('W751 #18 — cli/kolm.js defines cmdW751Verticals exactly once + wired from case "vertical"', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW751Verticals\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW751Verticals definition; got ${defs.length}`);
  assert.ok(/case\s+['"]vertical['"]/.test(cli),
    `cli must have case 'vertical' arm`);
  assert.ok(cli.includes('cmdW751Verticals(rest)'),
    `case 'vertical' must invoke cmdW751Verticals(rest)`);
});

// =============================================================================
// 19) src/auth.js PUBLIC_API gate — list + show public; register + fingerprint
//     stay auth-gated
// =============================================================================

test('W751 #19 — src/auth.js makes /v1/verticals + /v1/verticals/:id public but NOT register-stubs/fingerprint', () => {
  freshDir();
  const auth = fs.readFileSync(AUTH_PATH, 'utf8');
  // Listing path is literal.
  assert.ok(auth.includes("p === '/v1/verticals'"),
    `auth.js PUBLIC_API must include literal '/v1/verticals' check`);
  // Per-id path uses a single-segment regex so /v1/verticals/<id>/<fingerprint>
  // does NOT match (the fingerprint route must stay auth-gated).
  assert.ok(/\/\^\\\/v1\\\/verticals\\\/\[A-Za-z0-9_-\]\+\$\//.test(auth),
    `auth.js PUBLIC_API must include the single-segment /v1/verticals/<id> regex (so fingerprint stays auth-gated)`);
  // register-stubs is auth-gated by absence from PUBLIC_API + the route's own
  // 401 check; confirm the literal string register-stubs is NOT in PUBLIC_API.
  // (The literal absent-check is best-effort; the route 401 test above is the
  // real contract.)
  assert.ok(!auth.includes("p === '/v1/verticals/register-stubs'"),
    `register-stubs MUST NOT appear as a public-API literal in auth.js`);
});

// =============================================================================
// 20) wave751 sibling test count uses regex wave(\d{3,4}) + threshold pattern
// =============================================================================

test('W751 #20 — wave751 sibling test count uses regex wave(\\d{3,4}) + threshold (W604 anti-brittleness)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
