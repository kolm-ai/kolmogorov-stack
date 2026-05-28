// W746 — Capture staleness: recency weighting, freshness distribution, TTL eviction,
// teacher-version tagging.
//
// Atomic items pinned (matches the W746 implementation):
//
//   [W746-1] Capture expiry / decay weighting → recency weight in training sampler
//   [W746-2] Configurable retention policy (auto-expire >N days) → per-namespace TTL
//   [W746-3] Visual timeline showing capture freshness distribution
//   [W746-4] Teacher version tagging on every capture → extend event-store row
//
// Tests:
//   #1  — STALENESS_VERSION constant is 'w746-v1'
//   #2  — recencyWeight today == 1.0
//   #3  — recencyWeight 30d ago with half_life=30 ~= 0.5
//   #4  — recencyWeight 60d ago with half_life=30 ~= 0.25
//   #5  — recencyWeight future-dated clamps to 1.0 (no clock-skew inflation)
//   #6  — weightCapturesByRecency annotates each row with recency_weight in (0, 1]
//   #7  — freshnessDistribution buckets are correct + overflow catches >max
//   #8  — evictExpired with ttl_days=null returns ALL kept, evicted empty
//   #9  — evictExpired with ttl_days=30 evicts rows >30 days old
//   #10 — applyNamespaceTtl respects per-namespace TTL config
//   #11 — TEACHER_VERSION_TAG_VERSION constant is 'w746-v1'
//   #12 — currentTeacherVersion env override + default for anthropic
//   #13 — tagCaptureWithTeacherVersion is idempotent (existing tag wins)
//   #14 — groupByTeacherVersion counts rows per teacher_version
//   #15 — POST /v1/capture/log with KOLM_W746_TEACHER_TAGGING=off does NOT tag
//   #16 — GET /v1/staleness/:namespace auth-gated (401 no auth; 200 with auth)
//   #17 — POST /v1/staleness/apply-ttl requires owner role (anon → 403)
//   #18 — POST /v1/staleness/apply-ttl owner (kind:human) returns 200 envelope
//   #19 — public/docs/staleness.html exists with brand-lock + formula
//   #20 — public/account/staleness.html exists with brand-lock + timeline viz
//   #21 — vercel.json has both /docs/staleness and /account/staleness rewrites
//   #22 — cli/kolm.js defines cmdW746Staleness exactly once + wired
//   #23 — wave746 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittleness)
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
  STALENESS_VERSION,
  recencyWeight,
  weightCapturesByRecency,
  freshnessDistribution,
  evictExpired,
  applyNamespaceTtl,
} from '../src/capture-staleness.js';

import {
  TEACHER_VERSION_TAG_VERSION,
  currentTeacherVersion,
  tagCaptureWithTeacherVersion,
  groupByTeacherVersion,
} from '../src/teacher-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'staleness.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'staleness.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

const MS_PER_DAY = 86400000;

// Per-test sandbox — keeps KOLM_DATA_DIR etc. from leaking across tests and
// keeps the teacher-version env from leaking into the env-resolution tests.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w746-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Scrub W746-specific env leakage so tests are deterministic.
  delete process.env.KOLM_W746_TEACHER_TAGGING;
  delete process.env.KOLM_TEACHER_VERSION_ANTHROPIC;
  delete process.env.KOLM_TEACHER_VERSION_OPENAI;
  delete process.env.KOLM_DISTILL_TEACHER;
  return tmp;
}

// =============================================================================
// 1) Version constant
// =============================================================================

test('W746 #1 — STALENESS_VERSION is "w746-v1"', () => {
  freshDir();
  assert.equal(STALENESS_VERSION, 'w746-v1',
    `expected STALENESS_VERSION="w746-v1"; got ${JSON.stringify(STALENESS_VERSION)}`);
});

// =============================================================================
// 2) recencyWeight today == 1.0
// =============================================================================

test('W746 #2 — recencyWeight on a same-instant capture returns 1.0', () => {
  freshDir();
  const now = Date.now();
  const w = recencyWeight(new Date(now).toISOString(), { now, half_life_days: 30 });
  assert.equal(w, 1.0,
    `same-instant capture must have weight=1.0; got ${w}`);
});

// =============================================================================
// 3) recencyWeight 30d ago with half_life=30 ~= 0.5
// =============================================================================

test('W746 #3 — recencyWeight 30d ago with half_life=30 returns ~0.5', () => {
  freshDir();
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * MS_PER_DAY).toISOString();
  const w = recencyWeight(thirtyDaysAgo, { now, half_life_days: 30 });
  // Allow tiny floating-point delta but lock the value tightly.
  assert.ok(Math.abs(w - 0.5) < 1e-9,
    `30d-old capture at 30d half-life must be ~0.5; got ${w}`);
});

// =============================================================================
// 4) recencyWeight 60d ago with half_life=30 ~= 0.25
// =============================================================================

test('W746 #4 — recencyWeight 60d ago with half_life=30 returns ~0.25', () => {
  freshDir();
  const now = Date.now();
  const sixtyDaysAgo = new Date(now - 60 * MS_PER_DAY).toISOString();
  const w = recencyWeight(sixtyDaysAgo, { now, half_life_days: 30 });
  assert.ok(Math.abs(w - 0.25) < 1e-9,
    `60d-old capture at 30d half-life must be ~0.25; got ${w}`);
  // Sanity: 90d -> 0.125
  const ninetyDaysAgo = new Date(now - 90 * MS_PER_DAY).toISOString();
  const w90 = recencyWeight(ninetyDaysAgo, { now, half_life_days: 30 });
  assert.ok(Math.abs(w90 - 0.125) < 1e-9,
    `90d-old capture at 30d half-life must be ~0.125; got ${w90}`);
});

// =============================================================================
// 5) recencyWeight future-dated clamps to 1.0 (no clock-skew inflation)
// =============================================================================

test('W746 #5 — recencyWeight future-dated capture clamps to 1.0', () => {
  freshDir();
  const now = Date.now();
  const futureIso = new Date(now + 5 * MS_PER_DAY).toISOString();
  const w = recencyWeight(futureIso, { now, half_life_days: 30 });
  assert.equal(w, 1.0,
    `future-dated capture must clamp to 1.0 (no inflation); got ${w}`);
});

// =============================================================================
// 6) weightCapturesByRecency annotates each row with recency_weight in (0, 1]
// =============================================================================

test('W746 #6 — weightCapturesByRecency annotates every row with recency_weight in (0, 1]', () => {
  freshDir();
  const now = Date.now();
  const caps = [
    { cid: 'a', captured_at: new Date(now).toISOString() },                     // 1.0
    { cid: 'b', captured_at: new Date(now - 30 * MS_PER_DAY).toISOString() },   // 0.5
    { cid: 'c', captured_at: new Date(now - 60 * MS_PER_DAY).toISOString() },   // 0.25
    { cid: 'd', captured_at: new Date(now - 365 * MS_PER_DAY).toISOString() },  // tiny but >0
  ];
  const weighted = weightCapturesByRecency(caps, { now, half_life_days: 30 });
  assert.equal(weighted.length, 4);
  for (const row of weighted) {
    assert.ok(typeof row.recency_weight === 'number',
      `row ${row.cid} must have a numeric recency_weight; got ${row.recency_weight}`);
    assert.ok(row.recency_weight > 0 && row.recency_weight <= 1.0,
      `recency_weight for ${row.cid} must be in (0, 1]; got ${row.recency_weight}`);
    // Confirm original fields survived.
    assert.equal(typeof row.cid, 'string');
  }
  // Confirm input array was NOT mutated (pure transform contract).
  assert.equal(caps[0].recency_weight, undefined,
    'input array MUST NOT be mutated — caller must reuse safely');
});

// =============================================================================
// 7) freshnessDistribution buckets + overflow
// =============================================================================

test('W746 #7 — freshnessDistribution buckets are correct + overflow catches >max', () => {
  freshDir();
  const now = Date.now();
  const caps = [
    { captured_at: new Date(now - 0.5 * MS_PER_DAY).toISOString() }, // <=1d
    { captured_at: new Date(now - 0.5 * MS_PER_DAY).toISOString() }, // <=1d
    { captured_at: new Date(now - 5 * MS_PER_DAY).toISOString() },   // <=7d
    { captured_at: new Date(now - 20 * MS_PER_DAY).toISOString() },  // <=30d
    { captured_at: new Date(now - 60 * MS_PER_DAY).toISOString() },  // <=90d
    { captured_at: new Date(now - 200 * MS_PER_DAY).toISOString() }, // <=365d
    { captured_at: new Date(now - 500 * MS_PER_DAY).toISOString() }, // >365d
  ];
  const dist = freshnessDistribution(caps, { now });
  // 5 buckets + 1 overflow = 6 entries.
  assert.equal(dist.length, 6,
    `expected 6 entries (5 buckets + overflow); got ${dist.length}: ${JSON.stringify(dist)}`);
  const byLabel = new Map(dist.map((d) => [d.bucket_label, d]));
  assert.equal(byLabel.get('<=1d').count, 2);
  assert.equal(byLabel.get('<=7d').count, 1);
  assert.equal(byLabel.get('<=30d').count, 1);
  assert.equal(byLabel.get('<=90d').count, 1);
  assert.equal(byLabel.get('<=365d').count, 1);
  assert.equal(byLabel.get('>365d').count, 1);
  // Counts sum to input length (no silent drops).
  const sum = dist.reduce((a, b) => a + b.count, 0);
  assert.equal(sum, caps.length,
    `bucket counts must sum to input length; got ${sum} vs ${caps.length}`);
  // pct fields are numeric.
  for (const d of dist) {
    assert.equal(typeof d.pct, 'number', `pct must be numeric; got ${d.pct} in ${d.bucket_label}`);
  }
});

// =============================================================================
// 8) evictExpired with ttl_days=null returns ALL kept, evicted empty
// =============================================================================

test('W746 #8 — evictExpired with ttl_days=null keeps everything (W746-2 honesty)', () => {
  freshDir();
  const now = Date.now();
  const caps = [
    { cid: 'a', captured_at: new Date(now).toISOString() },
    { cid: 'b', captured_at: new Date(now - 365 * MS_PER_DAY).toISOString() },
    { cid: 'c', captured_at: new Date(now - 9999 * MS_PER_DAY).toISOString() },
  ];
  const r = evictExpired(caps, { ttl_days: null, now });
  assert.equal(r.kept.length, 3, 'null TTL must keep all rows');
  assert.equal(r.evicted.length, 0, 'null TTL must evict nothing');
  // Also: ttl_days=0 / '' should be treated as "no TTL", not "evict everything".
  const r0 = evictExpired(caps, { ttl_days: 0, now });
  assert.equal(r0.kept.length, 3, 'ttl_days=0 must NOT silently wipe a corpus');
  assert.equal(r0.evicted.length, 0);
});

// =============================================================================
// 9) evictExpired with ttl_days=30 evicts rows >30 days old
// =============================================================================

test('W746 #9 — evictExpired with ttl_days=30 evicts rows older than 30 days', () => {
  freshDir();
  const now = Date.now();
  const caps = [
    { cid: 'fresh-1', captured_at: new Date(now - 5 * MS_PER_DAY).toISOString() },
    { cid: 'fresh-2', captured_at: new Date(now - 29 * MS_PER_DAY).toISOString() },
    { cid: 'old-1', captured_at: new Date(now - 31 * MS_PER_DAY).toISOString() },
    { cid: 'old-2', captured_at: new Date(now - 365 * MS_PER_DAY).toISOString() },
    { cid: 'garbage', captured_at: 'not-a-date' }, // evicted (cannot prove age)
  ];
  const r = evictExpired(caps, { ttl_days: 30, now });
  assert.equal(r.kept.length, 2, `expected 2 kept; got ${r.kept.length}`);
  assert.equal(r.evicted.length, 3, `expected 3 evicted; got ${r.evicted.length}`);
  const keptIds = r.kept.map((c) => c.cid).sort();
  assert.deepEqual(keptIds, ['fresh-1', 'fresh-2']);
  const evictedIds = r.evicted.map((c) => c.cid).sort();
  assert.deepEqual(evictedIds, ['garbage', 'old-1', 'old-2']);
});

// =============================================================================
// 10) applyNamespaceTtl respects per-namespace TTL config
// =============================================================================

test('W746 #10 — applyNamespaceTtl applies per-namespace TTL config', () => {
  freshDir();
  const now = Date.now();
  const caps = [
    // production: 30d TTL → keep fresh, evict old
    { cid: 'p1', namespace: 'production', captured_at: new Date(now - 5 * MS_PER_DAY).toISOString() },
    { cid: 'p2', namespace: 'production', captured_at: new Date(now - 60 * MS_PER_DAY).toISOString() },
    // staging: no TTL → keep everything
    { cid: 's1', namespace: 'staging', captured_at: new Date(now - 10 * MS_PER_DAY).toISOString() },
    { cid: 's2', namespace: 'staging', captured_at: new Date(now - 999 * MS_PER_DAY).toISOString() },
    // default: 7d TTL
    { cid: 'd1', namespace: 'default', captured_at: new Date(now - 3 * MS_PER_DAY).toISOString() },
    { cid: 'd2', namespace: 'default', captured_at: new Date(now - 10 * MS_PER_DAY).toISOString() },
  ];
  const settings = {
    production: { capture_ttl_days: 30 },
    staging: { capture_ttl_days: null },
    default: { capture_ttl_days: 7 },
  };
  const out = applyNamespaceTtl(caps, settings, { now });
  // production: 1 kept (p1=5d), 1 evicted (p2=60d > 30d TTL)
  // staging:    2 kept (both, no TTL), 0 evicted
  // default:    1 kept (d1=3d), 1 evicted (d2=10d > 7d TTL)
  // Totals:     4 kept, 2 evicted
  assert.equal(out.kept_total, 4, `expected 4 kept_total; got ${out.kept_total}`);
  assert.equal(out.evicted_total, 2, `expected 2 evicted_total; got ${out.evicted_total}`);
  assert.equal(out.by_namespace.production.kept, 1);
  assert.equal(out.by_namespace.production.evicted, 1);
  assert.equal(out.by_namespace.production.ttl_days, 30);
  assert.equal(out.by_namespace.staging.kept, 2);
  assert.equal(out.by_namespace.staging.evicted, 0);
  assert.equal(out.by_namespace.staging.ttl_days, null);
  assert.equal(out.by_namespace.default.kept, 1);
  assert.equal(out.by_namespace.default.evicted, 1);
  assert.equal(out.by_namespace.default.ttl_days, 7);
});

// =============================================================================
// 11) TEACHER_VERSION_TAG_VERSION constant
// =============================================================================

test('W746 #11 — TEACHER_VERSION_TAG_VERSION is "w746-v1"', () => {
  freshDir();
  assert.equal(TEACHER_VERSION_TAG_VERSION, 'w746-v1',
    `expected TEACHER_VERSION_TAG_VERSION="w746-v1"; got ${JSON.stringify(TEACHER_VERSION_TAG_VERSION)}`);
});

// =============================================================================
// 12) currentTeacherVersion env override + default for anthropic
// =============================================================================

test('W746 #12 — currentTeacherVersion resolves env override then per-provider default', () => {
  freshDir();
  // No env set → anthropic default is claude-opus-4-7 (per MEMORY.md W604+).
  assert.equal(currentTeacherVersion('anthropic'), 'claude-opus-4-7',
    'anthropic default must be claude-opus-4-7');
  // Provider-specific env wins over default.
  process.env.KOLM_TEACHER_VERSION_ANTHROPIC = 'claude-opus-4-7-20251007';
  assert.equal(currentTeacherVersion('anthropic'), 'claude-opus-4-7-20251007',
    'provider-specific env must win over default');
  delete process.env.KOLM_TEACHER_VERSION_ANTHROPIC;
  // Generic env wins over per-provider default when set.
  process.env.KOLM_DISTILL_TEACHER = 'generic-teacher-v9';
  assert.equal(currentTeacherVersion('anthropic'), 'generic-teacher-v9',
    'generic KOLM_DISTILL_TEACHER must win over default when set');
  delete process.env.KOLM_DISTILL_TEACHER;
  // Unknown provider with no env falls through to honest fallback.
  assert.equal(currentTeacherVersion('weirdvendor'), 'unknown_teacher_v0',
    'unknown provider must fall to unknown_teacher_v0');
  // Empty/null provider with no env also falls through to fallback.
  assert.equal(currentTeacherVersion(''), 'unknown_teacher_v0');
  assert.equal(currentTeacherVersion(null), 'unknown_teacher_v0');
  // OpenAI default present.
  assert.equal(currentTeacherVersion('openai'), 'gpt-4o',
    'openai default must be gpt-4o');
  // Case-insensitive provider matching.
  assert.equal(currentTeacherVersion('ANTHROPIC'), 'claude-opus-4-7');
});

// =============================================================================
// 13) tagCaptureWithTeacherVersion is idempotent (existing tag wins)
// =============================================================================

test('W746 #13 — tagCaptureWithTeacherVersion is idempotent — existing tag wins', () => {
  freshDir();
  const row = { cid: 'a', provider: 'anthropic' };
  tagCaptureWithTeacherVersion(row);
  assert.equal(row.teacher_version, 'claude-opus-4-7');
  assert.equal(row.teacher_provider, 'anthropic');
  // Now flip the env and re-tag — existing tag MUST win (closer-to-source).
  process.env.KOLM_TEACHER_VERSION_ANTHROPIC = 'something-else-v2';
  tagCaptureWithTeacherVersion(row);
  assert.equal(row.teacher_version, 'claude-opus-4-7',
    'existing tag must NOT be overwritten by re-tagging');
  delete process.env.KOLM_TEACHER_VERSION_ANTHROPIC;
  // A row that explicitly has a teacher_version set already is also preserved.
  const preTagged = { cid: 'b', provider: 'anthropic', teacher_version: 'claude-opus-4-7-20251007' };
  tagCaptureWithTeacherVersion(preTagged);
  assert.equal(preTagged.teacher_version, 'claude-opus-4-7-20251007',
    'pre-tagged row must be left alone');
  // Empty-string teacher_version IS overwritten (treat as missing).
  const emptyTagged = { cid: 'c', provider: 'openai', teacher_version: '' };
  tagCaptureWithTeacherVersion(emptyTagged);
  assert.equal(emptyTagged.teacher_version, 'gpt-4o',
    'empty-string teacher_version must be re-tagged');
});

// =============================================================================
// 14) groupByTeacherVersion counts rows per teacher_version
// =============================================================================

test('W746 #14 — groupByTeacherVersion counts rows by teacher_version (untagged → unknown_teacher_v0)', () => {
  freshDir();
  const caps = [
    { teacher_version: 'claude-opus-4-7' },
    { teacher_version: 'claude-opus-4-7' },
    { teacher_version: 'claude-opus-4-7' },
    { teacher_version: 'gpt-4o' },
    { teacher_version: 'gpt-4o' },
    {}, // untagged → unknown_teacher_v0
    { teacher_version: '' }, // empty → unknown_teacher_v0
  ];
  const out = groupByTeacherVersion(caps);
  assert.equal(out['claude-opus-4-7'], 3);
  assert.equal(out['gpt-4o'], 2);
  assert.equal(out['unknown_teacher_v0'], 2,
    `untagged rows must roll up under unknown_teacher_v0; got ${out['unknown_teacher_v0']}`);
});

// =============================================================================
// 15) POST /v1/capture/log with KOLM_W746_TEACHER_TAGGING=off does NOT tag
// =============================================================================

test('W746 #15 — POST /v1/capture/log with KOLM_W746_TEACHER_TAGGING=off does NOT tag the row', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  // Byte-stability safety hatch: explicitly disable tagging.
  process.env.KOLM_W746_TEACHER_TAGGING = 'off';

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
    const ns = 'w746-tag-off-' + crypto.randomBytes(3).toString('hex');
    const resp = await fetch(`http://127.0.0.1:${port}/v1/capture/log`, {
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
    assert.equal(resp.status, 201, `expected 201; got ${resp.status}: ${await resp.clone().text()}`);
    const body = await resp.json();
    assert.ok(body && (body.ok || Array.isArray(body.ids)),
      `expected ok envelope; got ${JSON.stringify(body)}`);
    // With KOLM_W746_TEACHER_TAGGING=off, the row must NOT carry teacher_version.
    // Read it back via /v1/teacher-versions/:namespace and confirm every count
    // rolls up under unknown_teacher_v0.
    const tvResp = await fetch(`http://127.0.0.1:${port}/v1/teacher-versions/${encodeURIComponent(ns)}`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(tvResp.status, 200);
    const tvBody = await tvResp.json();
    assert.ok(tvBody && tvBody.ok, `expected ok envelope; got ${JSON.stringify(tvBody)}`);
    if (tvBody.total_captures > 0) {
      // Every version present should be the fallback (no real tag was written).
      for (const v of tvBody.versions) {
        assert.equal(v.teacher_version, 'unknown_teacher_v0',
          `with tagging OFF, every version row must be unknown_teacher_v0; got ${JSON.stringify(v)}`);
      }
    }
  } finally {
    delete process.env.KOLM_W746_TEACHER_TAGGING;
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) GET /v1/staleness/:namespace auth-gated (401 no auth; 200 with auth)
// =============================================================================

test('W746 #16 — GET /v1/staleness/:namespace is auth-gated (401 → 200)', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/staleness/production`);
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/staleness/production`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.namespace, 'production');
    assert.equal(typeof body.total_captures, 'number');
    assert.ok(Array.isArray(body.freshness),
      `freshness must be an array; got ${JSON.stringify(body.freshness)}`);
    assert.equal(body.version, 'w746-v1');
    assert.equal(typeof body.evicted_if_ttl_30d, 'number');
    assert.equal(typeof body.evicted_if_ttl_90d, 'number');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) POST /v1/staleness/apply-ttl requires owner role (anon → 403)
// =============================================================================

test('W746 #17 — POST /v1/staleness/apply-ttl rejects non-owner (anon) with 403', async () => {
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
    // No auth → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/staleness/apply-ttl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'production', ttl_days: 30 }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    // Anon (non-owner) → 403
    const forbidden = await fetch(`http://127.0.0.1:${port}/v1/staleness/apply-ttl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'production', ttl_days: 30 }),
    });
    assert.equal(forbidden.status, 403,
      `expected 403 for non-owner (anon kind); got ${forbidden.status}`);
    const body = await forbidden.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'forbidden');
    assert.ok(typeof body.hint === 'string' && body.hint.length > 0,
      'forbidden envelope must carry a hint');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) POST /v1/staleness/apply-ttl owner (kind:human) returns 200 envelope
// =============================================================================

test('W746 #18 — POST /v1/staleness/apply-ttl with owner role (kind:human) returns 200 envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  // Provision an owner-equivalent tenant: kind:'human' satisfies the W746
  // owner check in src/router.js:5617.
  const t = provisionTenant('w746-owner-' + crypto.randomBytes(3).toString('hex'),
    { kind: 'human', plan: 'enterprise', quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // 18a — owner with null TTL → 200 (no eviction).
    const ok = await fetch(`http://127.0.0.1:${port}/v1/staleness/apply-ttl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'production', ttl_days: null }),
    });
    const okText = await ok.text();
    assert.equal(ok.status, 200,
      `owner must get 200 for null-TTL no-op; got ${ok.status} body=${okText}`);
    const body = JSON.parse(okText);
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(body.namespace, 'production');
    assert.equal(body.ttl_days, null);
    assert.equal(body.evicted_projected, 0, 'null TTL must project 0 evictions');
    assert.equal(body.deleted_actual, 0, 'null TTL must NEVER delete anything');
    assert.equal(body.version, 'w746-v1');
    // 18b — invalid ttl_days → 400.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/staleness/apply-ttl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'production', ttl_days: -5 }),
    });
    assert.equal(bad.status, 400, `negative ttl_days must 400; got ${bad.status}`);
    const badBody = await bad.json();
    assert.equal(badBody.error, 'invalid_ttl_days');
    // 18c — missing namespace → 400.
    const missing = await fetch(`http://127.0.0.1:${port}/v1/staleness/apply-ttl`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ ttl_days: 30 }),
    });
    assert.equal(missing.status, 400, `missing namespace must 400; got ${missing.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) public/docs/staleness.html exists with brand-lock + formula
// =============================================================================

test('W746 #19 — public/docs/staleness.html exists with brand-lock + formula', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'Open-source AI workbench',          // brand eyebrow
    'Frontier AI on your own infrastructure.', // brand H1/tagline
    'kolm.ai',
    'ks-nav',                            // nav shell
    'ks-foot',                           // footer shell (W902 unified ks-footer -> ks-foot across 642 pages via scripts/w902-unify-footer.cjs)
    'recency',                           // W746-1
    'half_life_days',                    // formula parameter
    '0.5 ** (',                          // exponential decay formula
    'teacher_version',                   // W746-4
    'KOLM_W746_TEACHER_TAGGING',         // byte-stability safety hatch
    'kolm staleness',                    // CLI surface
    '/v1/staleness',                     // API surface
    'apply-ttl',                         // destructive route
    'w746-v1',                           // version stamp
  ]) {
    assert.ok(html.includes(needle),
      `staleness.html must mention "${needle}" (brand/contract lock)`);
  }
});

// =============================================================================
// 20) public/account/staleness.html exists with brand-lock + timeline viz
// =============================================================================

test('W746 #20 — public/account/staleness.html exists with brand-lock + timeline viz', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'Open-source AI workbench',          // brand eyebrow (full string)
    'Frontier AI on your own infrastructure',  // brand tagline
    '/v1/staleness/',                    // dashboard fetches the freshness route
    '/v1/teacher-versions/',             // dashboard fetches per-teacher breakdown
    '/v1/staleness/apply-ttl',           // dashboard wires the destructive button
    'namespace',                         // ?namespace= URL param
    'ks-nav',                            // nav shell
    'ks-nav__brand',                     // brand mark (W903 deliberately stripped the hidden brand-anchor disambiguation span across 90 pages via scripts/w903-strip-brand-anchor.cjs; brand identity now lives in the nav brand mark)
  ]) {
    assert.ok(html.includes(needle),
      `account/staleness.html must mention "${needle}" (UI contract lock)`);
  }
});

// =============================================================================
// 21) vercel.json has both /docs/staleness and /account/staleness rewrites
// =============================================================================

test('W746 #21 — vercel.json has both /docs/staleness and /account/staleness rewrites', () => {
  freshDir();
  const txt = fs.readFileSync(VERCEL_PATH, 'utf8');
  // Round-trip parse so a malformed JSON edit is loud.
  const parsed = JSON.parse(txt);
  assert.ok(Array.isArray(parsed.rewrites), 'vercel.json must have a rewrites array');
  const docs = parsed.rewrites.find((r) => r && r.source === '/docs/staleness');
  assert.ok(docs, 'rewrites must include {source:"/docs/staleness", destination:"/docs/staleness.html"}');
  assert.equal(docs.destination, '/docs/staleness.html');
  const acct = parsed.rewrites.find((r) => r && r.source === '/account/staleness');
  assert.ok(acct, 'rewrites must include {source:"/account/staleness", destination:"/account/staleness.html"}');
  assert.equal(acct.destination, '/account/staleness.html');
});

// =============================================================================
// 22) cli/kolm.js defines cmdW746Staleness exactly once + wired
// =============================================================================

test('W746 #22 — cli/kolm.js defines cmdW746Staleness exactly once + wired from case \'staleness\'', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW746Staleness\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW746Staleness dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]staleness['"]/.test(cli),
    `cli must have a case 'staleness' arm`);
  assert.ok(cli.includes('cmdW746Staleness(rest)'),
    `cmdW746Staleness must be invoked with rest args`);
  // Subcommand surface: show / apply-ttl / sampler-weights must all appear.
  for (const sub of ['show', 'apply-ttl', 'sampler-weights']) {
    assert.ok(cli.includes("sub === '" + sub + "'") || cli.includes("'" + sub + "'"),
      `cmdW746Staleness must implement the "${sub}" subcommand`);
  }
});

// =============================================================================
// 23) wave746 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittleness)
// =============================================================================

test('W746 #23 — wave746 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold — at least 3 wave files MUST exist (W746 + W741 + W742 minimum).
  // Forward-compatible: adding more wave tests does not break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});
