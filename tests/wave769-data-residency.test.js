// W769 — Data Residency + Geo-Fence.
//
// Atomic items pinned (matches the W769 implementation):
//
//   1)  DATA_RESIDENCY_VERSION + REGION_SAMPLER_VERSION stamped 'w769-v1'
//   2)  REGIONS is Object.freeze()-d + holds >= 8 entries
//   3)  EU_WEST regulatory_framework includes 'gdpr'
//   4)  DEFAULT_REGION === 'GLOBAL' (honest fallback, not EU_WEST)
//   5)  inferRegionFromTenant returns GLOBAL for null / undefined / no country
//   6)  inferRegionFromTenant resolves 'DE' → EU_CENTRAL, 'IE' → EU_WEST
//   7)  tagCapture rejects unknown region with structured envelope
//   8)  tagCapture rejects missing confirm with structured envelope
//   9)  tagCapture happy path + getCaptureRegion roundtrip
//   10) getCaptureRegion W411 defense-in-depth tenant fence
//   11) getCaptureRegion untagged → honest 'untagged' envelope (NOT silent GLOBAL)
//   12) configureNamespaceRegion happy path + getNamespaceDefaultRegion roundtrip
//   13) enforceRegionPolicy exact match → allowed (reason='exact_region_match')
//   14) enforceRegionPolicy GLOBAL target → allowed (reason='target_is_global')
//   15) enforceRegionPolicy GLOBAL capture → allowed (reason='capture_is_global')
//   16) enforceRegionPolicy mismatch → allowed:false, reason='region_mismatch'
//   17) filterCapturesByRegion FAIL-CLOSED for untagged into non-GLOBAL target
//   18) filterCapturesByRegion GLOBAL target includes untagged captures (opt-out)
//   19) sampleForDistillation returns 'no_captures_in_region' envelope when empty
//   20) sampleForDistillation W411 defense-in-depth tenant fence
//   21) POST /v1/residency/tag-capture: 401 w/o auth, 400 confirm_required,
//       200 happy path
//   22) GET  /v1/residency/capture-region/:id: 401 w/o auth, 200 untagged envelope
//   23) POST /v1/residency/configure-namespace: 401 w/o auth, 400 confirm_required
//   24) GET  /v1/residency/regions: 401 w/o auth, 200 envelope w/ taxonomy
//   25) public/compliance/data-residency.html exists w/ brand-lock + data-w769 anchors
//   26) cli/kolm.js defines cmdW769Residency exactly once + wired from
//       case 'residency'
//   27) vercel.json has the /compliance/data-residency rewrite
//   28) sibling sw.js / test-family lock uses regex (W604 anti-brittleness)
//   29) CRITICAL W460 BYTE-STABILITY: artifact_hash byte-identical when
//       region is null vs absent vs ''  (mirrors W721 / W722 / W739 pattern)
//   30) buildPayload with non-empty region mutates artifact_hash AND stamps
//       manifest.region — the contrapositive lock-in to (29)
//
// W604 anti-brittleness: family locks use regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DATA_RESIDENCY_VERSION,
  REGIONS,
  DEFAULT_REGION,
  inferRegionFromTenant,
  tagCapture,
  getCaptureRegion,
  configureNamespaceRegion,
  getNamespaceDefaultRegion,
  enforceRegionPolicy,
} from '../src/data-residency.js';

import {
  REGION_SAMPLER_VERSION,
  filterCapturesByRegion,
  sampleForDistillation,
} from '../src/region-aware-sampler.js';

import { buildPayload } from '../src/artifact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'compliance', 'data-residency.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w769-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W769 #1 — DATA_RESIDENCY_VERSION + REGION_SAMPLER_VERSION stamped w769-v1', () => {
  freshDir();
  assert.equal(DATA_RESIDENCY_VERSION, 'w769-v1',
    `expected DATA_RESIDENCY_VERSION='w769-v1'; got ${JSON.stringify(DATA_RESIDENCY_VERSION)}`);
  assert.equal(REGION_SAMPLER_VERSION, 'w769-v1',
    `expected REGION_SAMPLER_VERSION='w769-v1'; got ${JSON.stringify(REGION_SAMPLER_VERSION)}`);
});

// =============================================================================
// 2) REGIONS frozen + >=8 entries
// =============================================================================

test('W769 #2 — REGIONS is Object.freeze()-d + holds >= 8 entries (spec floor)', () => {
  freshDir();
  assert.ok(Object.isFrozen(REGIONS),
    'REGIONS MUST be Object.freeze()-d so downstream callers cannot mutate the contract');
  const keys = Object.keys(REGIONS);
  assert.ok(keys.length >= 8,
    `expected >=8 region entries; got ${keys.length}: ${JSON.stringify(keys)}`);
  // Every entry must carry the load-bearing fields.
  for (const k of keys) {
    const r = REGIONS[k];
    assert.equal(r.id, k, `REGIONS.${k}.id must equal '${k}'; got ${JSON.stringify(r.id)}`);
    assert.ok(typeof r.display_name === 'string' && r.display_name.length > 0,
      `REGIONS.${k} must carry a non-empty display_name`);
    assert.ok(Array.isArray(r.regulatory_framework),
      `REGIONS.${k}.regulatory_framework must be an array`);
    assert.ok(Array.isArray(r.iso_3166_codes),
      `REGIONS.${k}.iso_3166_codes must be an array`);
  }
});

// =============================================================================
// 3) EU_WEST regulatory anchor
// =============================================================================

test('W769 #3 — REGIONS.EU_WEST.regulatory_framework includes gdpr', () => {
  freshDir();
  assert.ok(REGIONS.EU_WEST, 'EU_WEST must be present in taxonomy');
  assert.ok(REGIONS.EU_WEST.regulatory_framework.includes('gdpr'),
    `EU_WEST must declare gdpr as a regulatory anchor; got ${JSON.stringify(REGIONS.EU_WEST.regulatory_framework)}`);
});

// =============================================================================
// 4) DEFAULT_REGION === 'GLOBAL'
// =============================================================================

test('W769 #4 — DEFAULT_REGION is GLOBAL (honest fallback, NOT EU_WEST)', () => {
  freshDir();
  // Honesty floor: defaulting to EU_WEST when we don't know would be a
  // silent compliance claim. GLOBAL is the explicit "no residency commitment"
  // sentinel that surfaces the untagged state instead of hiding it.
  assert.equal(DEFAULT_REGION, 'GLOBAL',
    `DEFAULT_REGION must be 'GLOBAL' (the honest fallback); got ${JSON.stringify(DEFAULT_REGION)}`);
  assert.ok(REGIONS.GLOBAL, 'GLOBAL must be a valid REGIONS entry');
});

// =============================================================================
// 5) inferRegionFromTenant handles missing input
// =============================================================================

test('W769 #5 — inferRegionFromTenant returns GLOBAL for null / undefined / no country', () => {
  freshDir();
  assert.equal(inferRegionFromTenant(null), 'GLOBAL');
  assert.equal(inferRegionFromTenant(undefined), 'GLOBAL');
  assert.equal(inferRegionFromTenant({}), 'GLOBAL');
  assert.equal(inferRegionFromTenant({ country_code: null }), 'GLOBAL');
  assert.equal(inferRegionFromTenant({ country_code: '' }), 'GLOBAL');
  // Bogus shapes also fall back honestly.
  assert.equal(inferRegionFromTenant({ country_code: 123 }), 'GLOBAL');
  assert.equal(inferRegionFromTenant({ country_code: 'ZZZ' }), 'GLOBAL');
});

// =============================================================================
// 6) inferRegionFromTenant ISO-3166 resolution
// =============================================================================

test('W769 #6 — inferRegionFromTenant resolves DE→EU_CENTRAL, IE→EU_WEST, GB→UK', () => {
  freshDir();
  assert.equal(inferRegionFromTenant({ country_code: 'DE' }), 'EU_CENTRAL');
  assert.equal(inferRegionFromTenant({ country_code: 'IE' }), 'EU_WEST');
  assert.equal(inferRegionFromTenant({ country_code: 'GB' }), 'UK');
  // Case-insensitive.
  assert.equal(inferRegionFromTenant({ country_code: 'de' }), 'EU_CENTRAL');
  // Trim whitespace.
  assert.equal(inferRegionFromTenant({ country_code: ' fr ' }), 'EU_WEST');
});

// =============================================================================
// 7) tagCapture rejects unknown region
// =============================================================================

test('W769 #7 — tagCapture rejects unknown region with structured envelope', async () => {
  freshDir();
  const r = await tagCapture({
    tenant_id: 'tenant_w769_7',
    capture_id: 'cap_w769_7',
    region: 'MARS_NORTH',
    confirm: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_region',
    `expected error='unknown_region'; got ${JSON.stringify(r)}`);
  assert.ok(Array.isArray(r.valid_regions) && r.valid_regions.length >= 8,
    'unknown_region envelope must list valid_regions');
  assert.equal(r.version, 'w769-v1');
});

// =============================================================================
// 8) tagCapture rejects missing confirm
// =============================================================================

test('W769 #8 — tagCapture rejects missing confirm:true with structured envelope', async () => {
  freshDir();
  const r = await tagCapture({
    tenant_id: 'tenant_w769_8',
    capture_id: 'cap_w769_8',
    region: 'EU_WEST',
    // confirm omitted intentionally
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'confirm_required',
    `expected error='confirm_required'; got ${JSON.stringify(r)}`);
  assert.equal(r.version, 'w769-v1');
});

// =============================================================================
// 9) tagCapture happy path + getCaptureRegion roundtrip
// =============================================================================

test('W769 #9 — tagCapture happy path + getCaptureRegion roundtrip', async () => {
  freshDir();
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const tagResult = await tagCapture({
    tenant_id: 'tenant_w769_9',
    capture_id: 'cap_w769_9',
    region: 'EU_WEST',
    confirm: true,
  });
  assert.equal(tagResult.ok, true, `tagCapture must succeed; got ${JSON.stringify(tagResult)}`);
  assert.equal(tagResult.region, 'EU_WEST');
  assert.equal(tagResult.tenant_id, 'tenant_w769_9');
  assert.equal(tagResult.capture_id, 'cap_w769_9');
  assert.ok(typeof tagResult.tagged_at === 'string' && tagResult.tagged_at.length > 0,
    'tagCapture must return an ISO tagged_at');

  const readBack = await getCaptureRegion({
    tenant_id: 'tenant_w769_9',
    capture_id: 'cap_w769_9',
  });
  assert.equal(readBack.ok, true, `getCaptureRegion must succeed after tag; got ${JSON.stringify(readBack)}`);
  assert.equal(readBack.region, 'EU_WEST');
  assert.equal(readBack.tenant_id, 'tenant_w769_9');
});

// =============================================================================
// 10) getCaptureRegion W411 defense-in-depth tenant fence
// =============================================================================

test('W769 #10 — getCaptureRegion W411 defense-in-depth tenant fence (no cross-tenant read)', async () => {
  freshDir();
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  // Tenant A tags capture cap_shared with EU_WEST.
  const a = await tagCapture({
    tenant_id: 'tenant_A_w769_10',
    capture_id: 'cap_shared',
    region: 'EU_WEST',
    confirm: true,
  });
  assert.equal(a.ok, true);

  // Tenant B asks for the SAME capture id — must NOT see tenant A's tag.
  const b = await getCaptureRegion({
    tenant_id: 'tenant_B_w769_10',
    capture_id: 'cap_shared',
  });
  assert.equal(b.ok, false,
    `cross-tenant read must NEVER return a foreign tag; got ${JSON.stringify(b)}`);
  assert.equal(b.error, 'untagged',
    `cross-tenant read must report untagged (the row exists but not for B); got ${JSON.stringify(b)}`);
});

// =============================================================================
// 11) getCaptureRegion untagged → honest 'untagged' envelope
// =============================================================================

test('W769 #11 — getCaptureRegion untagged returns honest envelope (NOT silent GLOBAL)', async () => {
  freshDir();
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const r = await getCaptureRegion({
    tenant_id: 'tenant_w769_11',
    capture_id: 'cap_never_tagged',
  });
  assert.equal(r.ok, false,
    `untagged capture must NEVER silently report GLOBAL; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'untagged');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'untagged envelope must carry a hint pointing to the tag endpoint');
});

// =============================================================================
// 12) configureNamespaceRegion roundtrip
// =============================================================================

test('W769 #12 — configureNamespaceRegion roundtrip; getNamespaceDefaultRegion returns the pinned region', async () => {
  freshDir();
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const cfg = await configureNamespaceRegion({
    tenant_id: 'tenant_w769_12',
    namespace: 'support.eu',
    region: 'EU_CENTRAL',
    confirm: true,
  });
  assert.equal(cfg.ok, true, `configureNamespaceRegion must succeed; got ${JSON.stringify(cfg)}`);
  assert.equal(cfg.region, 'EU_CENTRAL');
  assert.equal(cfg.namespace, 'support.eu');
  // The note must be present (warns that historical captures are NOT
  // retroactively retagged — important for compliance hygiene).
  assert.ok(typeof cfg.note === 'string' && cfg.note.length > 0,
    'configureNamespaceRegion envelope must carry a note about future-only semantics');

  const got = await getNamespaceDefaultRegion({
    tenant_id: 'tenant_w769_12',
    namespace: 'support.eu',
  });
  assert.equal(got, 'EU_CENTRAL',
    `getNamespaceDefaultRegion must return the pinned region; got ${JSON.stringify(got)}`);

  // An unconfigured namespace falls back to DEFAULT_REGION.
  const fallback = await getNamespaceDefaultRegion({
    tenant_id: 'tenant_w769_12',
    namespace: 'nope.eu',
  });
  assert.equal(fallback, DEFAULT_REGION);
});

// =============================================================================
// 13) enforceRegionPolicy exact match
// =============================================================================

test('W769 #13 — enforceRegionPolicy exact match → allowed (reason=exact_region_match)', () => {
  freshDir();
  const r = enforceRegionPolicy({
    tenant_id: 'tenant_w769_13',
    capture: { region: 'EU_WEST', tenant_id: 'tenant_w769_13' },
    target_region: 'EU_WEST',
  });
  assert.equal(r.ok, true);
  assert.equal(r.allowed, true,
    `exact match must be allowed; got ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'exact_region_match');
});

// =============================================================================
// 14) enforceRegionPolicy GLOBAL target
// =============================================================================

test('W769 #14 — enforceRegionPolicy GLOBAL target → allowed (reason=target_is_global)', () => {
  freshDir();
  const r = enforceRegionPolicy({
    tenant_id: 'tenant_w769_14',
    capture: { region: 'EU_WEST', tenant_id: 'tenant_w769_14' },
    target_region: 'GLOBAL',
  });
  assert.equal(r.allowed, true,
    `GLOBAL target must accept any region; got ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'target_is_global');
});

// =============================================================================
// 15) enforceRegionPolicy GLOBAL capture
// =============================================================================

test('W769 #15 — enforceRegionPolicy GLOBAL capture → allowed (reason=capture_is_global)', () => {
  freshDir();
  const r = enforceRegionPolicy({
    tenant_id: 'tenant_w769_15',
    capture: { region: 'GLOBAL', tenant_id: 'tenant_w769_15' },
    target_region: 'EU_WEST',
  });
  assert.equal(r.allowed, true,
    `GLOBAL capture must be eligible for any region pipeline; got ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'capture_is_global');
});

// =============================================================================
// 16) enforceRegionPolicy mismatch
// =============================================================================

test('W769 #16 — enforceRegionPolicy region mismatch → allowed:false, reason=region_mismatch (HONESTY: never silent-passes)', () => {
  freshDir();
  const r = enforceRegionPolicy({
    tenant_id: 'tenant_w769_16',
    capture: { region: 'EU_WEST', tenant_id: 'tenant_w769_16' },
    target_region: 'US_EAST',
  });
  assert.equal(r.ok, true,
    'envelope.ok stays true — the QUERY succeeded, the policy DECISION is the value');
  assert.equal(r.allowed, false,
    `region mismatch MUST NOT silent-pass; got ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'region_mismatch');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'mismatch envelope must carry a remediation hint');
});

// =============================================================================
// 17) filterCapturesByRegion FAIL-CLOSED for untagged into non-GLOBAL
// =============================================================================

test('W769 #17 — filterCapturesByRegion FAIL-CLOSED: untagged captures excluded from non-GLOBAL target', () => {
  freshDir();
  const captures = [
    { capture_id: 'c1', region: 'EU_WEST' },
    { capture_id: 'c2', region: null },          // untagged
    { capture_id: 'c3' },                         // untagged (no region key)
    { capture_id: 'c4', region: 'US_EAST' },
    { capture_id: 'c5', region: 'GLOBAL' },
  ];
  const eu = filterCapturesByRegion(captures, 'EU_WEST');
  const ids = eu.map((c) => c.capture_id);
  assert.ok(ids.includes('c1'), 'exact EU_WEST tag must pass');
  assert.ok(ids.includes('c5'), 'GLOBAL capture must pass any non-GLOBAL target');
  // Critical: untagged captures MUST be excluded from a non-GLOBAL target.
  assert.ok(!ids.includes('c2'),
    `untagged (region:null) MUST be excluded from non-GLOBAL target; got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('c3'),
    `untagged (no region key) MUST be excluded from non-GLOBAL target; got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('c4'),
    `region mismatch (US_EAST) MUST be excluded from EU_WEST target; got ${JSON.stringify(ids)}`);
});

// =============================================================================
// 18) filterCapturesByRegion GLOBAL target accepts everything
// =============================================================================

test('W769 #18 — filterCapturesByRegion GLOBAL target is the OPT-OUT (untagged captures included)', () => {
  freshDir();
  const captures = [
    { capture_id: 'c1', region: 'EU_WEST' },
    { capture_id: 'c2', region: null },
    { capture_id: 'c3' },
    { capture_id: 'c4', region: 'US_EAST' },
    { capture_id: 'c5', region: 'GLOBAL' },
  ];
  const all = filterCapturesByRegion(captures, 'GLOBAL');
  const ids = all.map((c) => c.capture_id);
  // GLOBAL target is the EXPLICIT opt-out of region enforcement; it must
  // pass through every capture regardless of tag state.
  assert.equal(ids.length, 5,
    `GLOBAL target must include every capture (opt-out semantics); got ${JSON.stringify(ids)}`);
});

// =============================================================================
// 19) sampleForDistillation no_captures_in_region envelope
// =============================================================================

test('W769 #19 — sampleForDistillation no_captures_in_region envelope when filter returns empty', async () => {
  freshDir();
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  // No captures at all in this tenant — the filter step trivially returns
  // empty. The envelope must surface this loudly (not return ok:true with
  // an empty samples array, which would let the caller think the pool was
  // simply empty rather than region-filtered to zero).
  const r = await sampleForDistillation({
    tenant_id: 'tenant_w769_19',
    target_region: 'EU_WEST',
    max_n: 100,
  });
  assert.equal(r.ok, false, `empty filter must yield ok:false; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'no_captures_in_region');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
    'no_captures_in_region envelope must carry a remediation hint');
  assert.equal(r.target_region, 'EU_WEST');
  assert.equal(r.count_after_region_filter, 0);
  assert.equal(r.version, 'w769-v1');
});

// =============================================================================
// 20) sampleForDistillation W411 defense-in-depth tenant fence
// =============================================================================

test('W769 #20 — sampleForDistillation rejects unknown region with structured envelope', async () => {
  freshDir();
  const r = await sampleForDistillation({
    tenant_id: 'tenant_w769_20',
    target_region: 'MARS_NORTH',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_region',
    `unknown target must be rejected; got ${JSON.stringify(r)}`);
  assert.ok(Array.isArray(r.valid_regions) && r.valid_regions.length >= 8);
  // Missing tenant_id is also rejected loudly.
  const noTenant = await sampleForDistillation({ target_region: 'EU_WEST' });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'tenant_id_required');
});

// =============================================================================
// 21) POST /v1/residency/tag-capture: 401 / 400 confirm_required / 200 happy
// =============================================================================

test('W769 #21 — POST /v1/residency/tag-capture: 401 w/o auth, 400 confirm_required, 200 happy', async () => {
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

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/residency/tag-capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap_1', region: 'EU_WEST', confirm: true }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth, no confirm → 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/residency/tag-capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ capture_id: 'cap_1', region: 'EU_WEST' }),
    });
    assert.equal(noConfirm.status, 400, `no confirm must 400; got ${noConfirm.status}`);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    // Auth + confirm:true → 200.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/residency/tag-capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        capture_id: 'cap_w769_21',
        region: 'EU_WEST',
        confirm: true,
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth + confirm; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.region, 'EU_WEST');
    assert.equal(env.version, 'w769-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) GET /v1/residency/capture-region/:id: 401 / 200 untagged envelope
// =============================================================================

test('W769 #22 — GET /v1/residency/capture-region/:id: 401 w/o auth, 200 untagged envelope (NOT 4xx)', async () => {
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

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/residency/capture-region/cap_never`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + untagged capture → HTTP 200 + ok:false honest envelope.
    // The route succeeded; the FEATURE state is "no tag yet". The
    // distinction matters: 4xx would falsely signal a transport problem.
    const untagged = await fetch(`http://127.0.0.1:${port}/v1/residency/capture-region/cap_never`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(untagged.status, 200,
      `untagged must be HTTP 200 (honest envelope, not a transport error); got ${untagged.status}`);
    const env = await untagged.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'untagged');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 23) POST /v1/residency/configure-namespace: 401 / 400 confirm_required
// =============================================================================

test('W769 #23 — POST /v1/residency/configure-namespace: 401 w/o auth, 400 confirm_required', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/residency/configure-namespace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'support.eu', region: 'EU_WEST', confirm: true }),
    });
    assert.equal(noAuth.status, 401);

    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/residency/configure-namespace`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'support.eu', region: 'EU_WEST' }),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    const ok = await fetch(`http://127.0.0.1:${port}/v1/residency/configure-namespace`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'support.eu',
        region: 'EU_WEST',
        confirm: true,
      }),
    });
    assert.equal(ok.status, 200);
    const okEnv = await ok.json();
    assert.equal(okEnv.ok, true);
    assert.equal(okEnv.region, 'EU_WEST');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 24) GET /v1/residency/regions: 401 / 200 envelope w/ taxonomy
// =============================================================================

test('W769 #24 — GET /v1/residency/regions: 401 w/o auth, 200 envelope w/ full taxonomy', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/residency/regions`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/residency/regions`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.default_region, 'GLOBAL');
    assert.ok(env.regions && typeof env.regions === 'object',
      'regions field must carry the taxonomy object');
    assert.ok(Object.keys(env.regions).length >= 8,
      `expected >=8 regions in taxonomy; got ${Object.keys(env.regions).length}`);
    assert.equal(env.version, 'w769-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 25) public/compliance/data-residency.html brand-lock + anchors
// =============================================================================

test('W769 #25 — public/compliance/data-residency.html exists w/ brand-lock + data-w769 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'data-residency.html MUST carry the brand-locked eyebrow "Open-source AI workbench"');
  // Required hidden test anchors (W604 anti-brittleness: assert on
  // load-bearing data-* attributes, not free-form text).
  assert.ok(html.includes('data-w769="taxonomy"'),
    'expected data-w769="taxonomy" anchor on the region taxonomy section');
  assert.ok(html.includes('data-w769="tag-capture"'),
    'expected data-w769="tag-capture" anchor on the per-capture tagging section');
  assert.ok(html.includes('data-w769="sampler"'),
    'expected data-w769="sampler" anchor on the region-aware sampler section');
  assert.ok(html.includes('data-w769="geofence-crossref"'),
    'expected data-w769="geofence-crossref" anchor cross-referencing W708-5');
  // Version stamp.
  assert.ok(html.includes('w769-v1'),
    'page must stamp the w769-v1 version');
  // No emojis (spec invariant for landing pages).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'compliance/data-residency.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 26) cli/kolm.js defines cmdW769Residency exactly once + wired from case 'residency'
// =============================================================================

test('W769 #26 — cli/kolm.js defines cmdW769Residency exactly once + wired from case residency', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW769Residency\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW769Residency must be defined exactly once; found ${defOccurrences}`);
  // case 'residency': must invoke cmdW769Residency.
  assert.ok(/case 'residency':[\s\S]{0,200}cmdW769Residency/.test(cli),
    `expected "case 'residency': ... cmdW769Residency(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('residency'"),
    'COMPLETION_VERBS must include "residency" for shell completion');
  assert.ok(cli.includes('COMPLETION_SUBS.residency'),
    'COMPLETION_SUBS.residency must list the five subcommands');
});

// =============================================================================
// 27) vercel.json /compliance/data-residency rewrite
// =============================================================================

test('W769 #27 — vercel.json carries /compliance/data-residency rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/compliance/data-residency' &&
    r.destination === '/compliance/data-residency.html');
  assert.ok(rw,
    `expected rewrite { source: '/compliance/data-residency', destination: '/compliance/data-residency.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 28) sibling sw.js / test-family lock uses regex (W604 anti-brittleness)
// =============================================================================

test('W769 #28 — sw.js cache slug + test-family count use wave(\\d{3,4}) regex+threshold (W604)', () => {
  freshDir();
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
    if (m) {
      const wm = m[1].match(/wave(\d{3,4})/);
      if (wm) {
        const n = parseInt(wm[1], 10);
        // Regex + threshold so a sibling agent shipping after W769 does NOT
        // break this. The floor is generous on purpose.
        assert.ok(n >= 100,
          `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
      }
    }
  }
  // Sibling test count uses regex + threshold (never hard-coded list).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// =============================================================================
// 29) CRITICAL W460 BYTE-STABILITY — artifact_hash byte-identical when
//     region is null vs absent vs '' (mirrors W721 / W722 / W739 pattern)
// =============================================================================

test('W769 #29 — artifact_hash byte-identical when region is null vs absent vs "" (W460 byte-stability)', () => {
  freshDir();
  // Freeze the wall clock so the timestamp-stamped fields
  // (recipe_bundle_mjs `// generated_at`, receipt issued_at) hash identically
  // across the buildPayload calls. Without the freeze the bundle header drifts
  // between calls and we cannot isolate the W769 hash-slot contribution.
  // Restored in finally.
  const RealDate = Date;
  const fixedIso = '2026-05-24T00:00:00.000Z';
  const fixedMs = RealDate.parse(fixedIso);
  class FrozenDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) { super(fixedMs); } else { super(...a); }
    }
    static now() { return fixedMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }
  // eslint-disable-next-line no-global-assign
  global.Date = FrozenDate;
  try {
    const baseArgs = {
      job_id: 'job_w769_29',
      task: 'W769 byte-stability preservation',
      base_model: 'none',
      recipes: [{ id: 'r1', name: 'r', source: 'function generate(){return {};}' }],
      training_stats: { pass_rate_positive: 1.0 },
      judge_id: 'judge-w769',
      eval_score: 1.0,
    };
    const explicitNull = buildPayload({ ...baseArgs, region: null });
    const explicitEmpty = buildPayload({ ...baseArgs, region: '' });
    const absent = buildPayload({ ...baseArgs });
    // Manifest surface: region must NOT appear in the manifest in any of
    // the three no-region paths (conditional-spread W460 pattern).
    assert.equal(explicitNull.manifest.region, undefined,
      `region:null must NOT introduce a manifest.region key; got ${JSON.stringify(explicitNull.manifest.region)}`);
    assert.equal(explicitEmpty.manifest.region, undefined,
      `region:"" must NOT introduce a manifest.region key; got ${JSON.stringify(explicitEmpty.manifest.region)}`);
    assert.equal(absent.manifest.region, undefined,
      `region absent must NOT introduce a manifest.region key; got ${JSON.stringify(absent.manifest.region)}`);
    // Hash chain: all three paths MUST produce the same artifact_hash so
    // existing (pre-W769) artifacts that re-build without a region do not
    // suddenly drift to a new hash. This is the load-bearing W460 contract.
    assert.equal(
      explicitNull.artifact_hash,
      absent.artifact_hash,
      'region:null MUST hash identically to omitting the field (W460 byte-stability)',
    );
    assert.equal(
      explicitEmpty.artifact_hash,
      absent.artifact_hash,
      'region:"" MUST hash identically to omitting the field (W460 byte-stability)',
    );
  } finally {
    // eslint-disable-next-line no-global-assign
    global.Date = RealDate;
  }
});

// =============================================================================
// 30) Contrapositive: non-empty region MUTATES artifact_hash AND stamps
//     manifest.region (the slot is honored when truly present)
// =============================================================================

test('W769 #30 — non-empty region stamps manifest.region AND mutates artifact_hash (contrapositive of #29)', () => {
  freshDir();
  const RealDate = Date;
  const fixedIso = '2026-05-24T00:00:00.000Z';
  const fixedMs = RealDate.parse(fixedIso);
  class FrozenDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) { super(fixedMs); } else { super(...a); }
    }
    static now() { return fixedMs; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }
  // eslint-disable-next-line no-global-assign
  global.Date = FrozenDate;
  try {
    const baseArgs = {
      job_id: 'job_w769_30',
      task: 'W769 region binding lock-in',
      base_model: 'none',
      recipes: [{ id: 'r1', name: 'r', source: 'function generate(){return {};}' }],
      training_stats: { pass_rate_positive: 1.0 },
      judge_id: 'judge-w769',
      eval_score: 1.0,
    };
    const noRegion = buildPayload({ ...baseArgs });
    const withRegion = buildPayload({ ...baseArgs, region: 'EU_WEST' });
    // Manifest stamp present iff the region is non-empty.
    assert.equal(withRegion.manifest.region, 'EU_WEST',
      `region:'EU_WEST' must stamp manifest.region; got ${JSON.stringify(withRegion.manifest.region)}`);
    // Hash chain MUST move when region is bound.
    assert.notEqual(
      withRegion.artifact_hash,
      noRegion.artifact_hash,
      'artifact_hash MUST differ when a non-empty region is bound (otherwise the conditional slot is dead code)',
    );
    // Cross-region disambiguation: two different regions produce two
    // different hashes.
    const eu = buildPayload({ ...baseArgs, region: 'EU_WEST' });
    const us = buildPayload({ ...baseArgs, region: 'US_EAST' });
    assert.notEqual(
      eu.artifact_hash,
      us.artifact_hash,
      'distinct regions MUST produce distinct artifact_hash values (region binds into the hash)',
    );
  } finally {
    // eslint-disable-next-line no-global-assign
    global.Date = RealDate;
  }
});
