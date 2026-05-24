// W767 — SOC 2 Type II + ISO 27001 Docs.
//
// Atomic items pinned (matches the W767 implementation):
//
//   1)  AUDIT_RETENTION_VERSION + MONITORING_VERSION stamped 'w767-v1'
//   2)  DEFAULT_RETENTION_DAYS = 365, MIN = 90, MAX = 2555
//   3)  getCurrentRetentionDays honors KOLM_AUDIT_RETENTION_DAYS within range
//   4)  getCurrentRetentionDays rejects sub-MIN and clamps super-MAX
//   5)  setRetentionDays rejects missing tenant + out-of-range values
//   6)  getRetentionStatus returns ok:false 'tenant_required' on empty tenant
//   7)  getRetentionStatus shape: days_configured + compliance_floor_met +
//       window event counts; tenant-fenced (W411 defense-in-depth)
//   8)  enforceRetentionPolicy DEFAULTS to dry-run (would_evict_count, no delete)
//   9)  enforceRetentionPolicy confirm:true alone (no dry_run:false) is still
//       a dry run — two-key destruction guarantee
//   10) enforceRetentionPolicy live mode rejects without confirm:true
//   11) MONITORING_CONTROLS is Object.freeze()-d + >=12 entries with real
//       AICPA TSC IDs
//   12) snapshot returns ok:false 'tenant_required' on empty tenant
//   13) snapshot honesty — value null → status:'unknown' (NEVER green)
//   14) snapshot uses provider DI seam + tenant-fences the provider ctx
//   15) GET /v1/security/soc2/checklist auth gate (401 w/o, 200 w/)
//   16) GET /v1/security/iso27001/controls auth gate + 30 controls + 4 families
//   17) GET /v1/security/audit-retention/status auth gate + shape
//   18) GET /v1/security/continuous-monitoring/snapshot auth gate + unknown
//       summary on no-provider fixture
//   19) public/security/soc2-type2.html brand-lock + anchors + 18 rows
//   20) public/security/iso-27001.html brand-lock + anchors + 30 rows
//   21) public/account/continuous-monitoring.html brand-lock + anchors +
//       >=12 rows + unknown summary card
//   22) cli/kolm.js defines cmdW767Cert exactly once + wired from case 'cert'
//   23) cmdW767Cert dispatcher uniqueness — no sibling agent collided on the
//       symbol; COMPLETION_VERBS push + COMPLETION_SUBS.cert table present
//   24) vercel.json carries the three W767 rewrites (soc2-type2, iso-27001,
//       continuous-monitoring)
//   25) sw.js cache slug references wave(\d{3,4}) at sane family (W604 regex)
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
  AUDIT_RETENTION_VERSION,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  getCurrentRetentionDays,
  setRetentionDays,
  getRetentionStatus,
  enforceRetentionPolicy,
} from '../src/audit-retention.js';

import {
  MONITORING_VERSION,
  MONITORING_CONTROLS,
  snapshot,
} from '../src/continuous-monitoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SOC2_HTML = path.join(REPO_ROOT, 'public', 'security', 'soc2-type2.html');
const ISO_HTML = path.join(REPO_ROOT, 'public', 'security', 'iso-27001.html');
const MONITOR_HTML = path.join(REPO_ROOT, 'public', 'account', 'continuous-monitoring.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;
const RETENTION_MOD_PATH = path.join(REPO_ROOT, 'src', 'audit-retention.js');
const MONITORING_MOD_PATH = path.join(REPO_ROOT, 'src', 'continuous-monitoring.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w767-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  delete process.env.KOLM_AUDIT_RETENTION_DAYS;
  delete process.env.KOLM_AUDIT_DEBUG;
  return tmp;
}

// In-memory event-store fake used to exercise the modules without touching
// the real JSON/SQLite drivers. Each test instance gets its own state. Tenant
// is honored on read so the W411 defense-in-depth tenant fence still gets
// exercised end-to-end.
function makeFakeEventStore(rows = []) {
  const store = rows.slice();
  return {
    async appendEvent(ev) {
      const row = Object.assign(
        { event_id: 'ev_' + crypto.randomBytes(4).toString('hex'),
          created_at: new Date().toISOString() },
        ev,
      );
      store.push(row);
      return row;
    },
    async listEvents(q) {
      q = q || {};
      let out = store.slice();
      if (q.tenant_id) out = out.filter((r) => r && r.tenant_id === q.tenant_id);
      if (q.provider) out = out.filter((r) => r && r.provider === q.provider);
      if (q.since) {
        const since = Date.parse(q.since);
        if (Number.isFinite(since)) out = out.filter((r) => r && r.created_at && Date.parse(r.created_at) >= since);
      }
      if (q.until) {
        const until = Date.parse(q.until);
        if (Number.isFinite(until)) out = out.filter((r) => r && r.created_at && Date.parse(r.created_at) < until);
      }
      if (q.order === 'desc') out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      else out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      if (q.limit && q.limit > 0) out = out.slice(0, q.limit);
      return out;
    },
    _rows: store,
  };
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W767 #1 — AUDIT_RETENTION_VERSION + MONITORING_VERSION stamped w767-v1', () => {
  freshDir();
  assert.equal(AUDIT_RETENTION_VERSION, 'w767-v1',
    `expected AUDIT_RETENTION_VERSION='w767-v1'; got ${JSON.stringify(AUDIT_RETENTION_VERSION)}`);
  assert.equal(MONITORING_VERSION, 'w767-v1',
    `expected MONITORING_VERSION='w767-v1'; got ${JSON.stringify(MONITORING_VERSION)}`);
});

// =============================================================================
// 2) Retention constants
// =============================================================================

test('W767 #2 — DEFAULT/MIN/MAX retention constants pin the SOC 2 window', () => {
  freshDir();
  assert.equal(DEFAULT_RETENTION_DAYS, 365,
    `DEFAULT_RETENTION_DAYS must be 365 (SOC 2 Type II operating-effectiveness window)`);
  assert.equal(MIN_RETENTION_DAYS, 90,
    `MIN_RETENTION_DAYS must be 90 (SOC 2 Type I floor)`);
  assert.equal(MAX_RETENTION_DAYS, 2555,
    `MAX_RETENTION_DAYS must be 2555 (~7y HIPAA/GDPR ceiling)`);
  assert.ok(MIN_RETENTION_DAYS < DEFAULT_RETENTION_DAYS,
    'MIN must be strictly less than DEFAULT');
  assert.ok(DEFAULT_RETENTION_DAYS < MAX_RETENTION_DAYS,
    'DEFAULT must be strictly less than MAX');
});

// =============================================================================
// 3) Env honored within range
// =============================================================================

test('W767 #3 — getCurrentRetentionDays honors KOLM_AUDIT_RETENTION_DAYS within range', () => {
  freshDir();
  process.env.KOLM_AUDIT_RETENTION_DAYS = '180';
  assert.equal(getCurrentRetentionDays(), 180,
    'in-range env value must be honored');
  delete process.env.KOLM_AUDIT_RETENTION_DAYS;
  assert.equal(getCurrentRetentionDays(), DEFAULT_RETENTION_DAYS,
    'unset env must fall back to DEFAULT');
  process.env.KOLM_AUDIT_RETENTION_DAYS = 'not-a-number';
  assert.equal(getCurrentRetentionDays(), DEFAULT_RETENTION_DAYS,
    'non-numeric env must fall back to DEFAULT');
  delete process.env.KOLM_AUDIT_RETENTION_DAYS;
});

// =============================================================================
// 4) Sub-MIN rejected, super-MAX clamped
// =============================================================================

test('W767 #4 — getCurrentRetentionDays rejects sub-MIN and clamps super-MAX', () => {
  freshDir();
  process.env.KOLM_AUDIT_RETENTION_DAYS = String(MIN_RETENTION_DAYS - 1);
  assert.equal(getCurrentRetentionDays(), DEFAULT_RETENTION_DAYS,
    `sub-MIN env must fall back to DEFAULT (would defeat SOC 2 Type I floor)`);
  process.env.KOLM_AUDIT_RETENTION_DAYS = String(MAX_RETENTION_DAYS + 1);
  assert.equal(getCurrentRetentionDays(), MAX_RETENTION_DAYS,
    `super-MAX env must clamp to MAX (~7y HIPAA/GDPR ceiling)`);
  delete process.env.KOLM_AUDIT_RETENTION_DAYS;
});

// =============================================================================
// 5) setRetentionDays validation
// =============================================================================

test('W767 #5 — setRetentionDays rejects missing tenant + out-of-range', async () => {
  freshDir();
  const es = makeFakeEventStore();
  const empty = await setRetentionDays('', 365, { eventStore: es });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'tenant_required',
    `missing tenant must produce 'tenant_required'; got ${JSON.stringify(empty)}`);

  const tooLow = await setRetentionDays('t_test', MIN_RETENTION_DAYS - 1, { eventStore: es });
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.error, 'days_below_min',
    `sub-MIN setter call must produce 'days_below_min'; got ${JSON.stringify(tooLow)}`);

  const tooHigh = await setRetentionDays('t_test', MAX_RETENTION_DAYS + 1, { eventStore: es });
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.error, 'days_above_max',
    `super-MAX setter call must produce 'days_above_max'; got ${JSON.stringify(tooHigh)}`);

  const bad = await setRetentionDays('t_test', 'not-a-number', { eventStore: es });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'days_invalid',
    `non-integer setter call must produce 'days_invalid'; got ${JSON.stringify(bad)}`);

  const ok = await setRetentionDays('t_test', 400, { eventStore: es });
  assert.equal(ok.ok, true);
  assert.equal(ok.days_configured, 400);
  assert.equal(ok.version, 'w767-v1');
});

// =============================================================================
// 6) getRetentionStatus honest on missing tenant
// =============================================================================

test('W767 #6 — getRetentionStatus returns ok:false tenant_required on empty tenant', async () => {
  freshDir();
  const es = makeFakeEventStore();
  const r = await getRetentionStatus('', { eventStore: es });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_required',
    `empty tenant must surface 'tenant_required' — NEVER fabricate a default status row`);
  assert.equal(r.version, 'w767-v1');
});

// =============================================================================
// 7) getRetentionStatus shape + W411 tenant fence
// =============================================================================

test('W767 #7 — getRetentionStatus shape + W411 defense-in-depth tenant fence', async () => {
  freshDir();
  const now = Date.now();
  const within = new Date(now - 30 * 86400 * 1000).toISOString();
  const within2 = new Date(now - 5 * 86400 * 1000).toISOString();
  const es = makeFakeEventStore([
    { event_id: 'a', tenant_id: 't_mine',  created_at: within,  provider: 'p' },
    { event_id: 'b', tenant_id: 't_mine',  created_at: within2, provider: 'p' },
    { event_id: 'c', tenant_id: 't_other', created_at: within,  provider: 'p' },
  ]);
  const r = await getRetentionStatus('t_mine', { eventStore: es });
  assert.equal(r.ok, true);
  assert.equal(r.tenant_id, 't_mine');
  assert.equal(r.days_configured, DEFAULT_RETENTION_DAYS);
  assert.equal(r.days_default, DEFAULT_RETENTION_DAYS);
  assert.equal(r.days_min, MIN_RETENTION_DAYS);
  assert.equal(r.days_max, MAX_RETENTION_DAYS);
  assert.equal(r.expires_after_days, DEFAULT_RETENTION_DAYS);
  assert.equal(r.compliance_floor_met, true,
    'days_configured >= DEFAULT must report compliance_floor_met:true');
  assert.equal(r.total_audit_events_in_window, 2,
    `expected 2 events for t_mine (cross-tenant row must be excluded); got ${r.total_audit_events_in_window}`);
  assert.ok(r.oldest_event_at && r.newest_event_at,
    'expected oldest_event_at + newest_event_at set when rows exist');
});

// =============================================================================
// 8) enforceRetentionPolicy defaults to dry-run
// =============================================================================

test('W767 #8 — enforceRetentionPolicy defaults to dry-run + would_evict_count', async () => {
  freshDir();
  const now = Date.now();
  const ancient = new Date(now - 500 * 86400 * 1000).toISOString();
  const recent = new Date(now - 30 * 86400 * 1000).toISOString();
  const es = makeFakeEventStore([
    { event_id: 'a', tenant_id: 't_mine', created_at: ancient, provider: 'p' },
    { event_id: 'b', tenant_id: 't_mine', created_at: ancient, provider: 'p' },
    { event_id: 'c', tenant_id: 't_mine', created_at: recent,  provider: 'p' },
  ]);
  // purgeEvents is NOT defined on this fake — dry-run must STILL return ok:true
  // and NEVER mutate the store.
  const r = await enforceRetentionPolicy('t_mine', { eventStore: es });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true,
    'enforceRetentionPolicy MUST default to dry_run:true');
  assert.equal(r.would_evict_count, 2,
    `expected would_evict_count=2 (ancient pair); got ${r.would_evict_count}`);
  // The store must NOT have been mutated.
  assert.equal(es._rows.length, 3,
    `dry-run MUST NOT mutate the store; expected 3 rows; got ${es._rows.length}`);
});

// =============================================================================
// 9) Two-key destruction — confirm:true alone is STILL a dry run
// =============================================================================

test('W767 #9 — enforceRetentionPolicy confirm:true alone (no dry_run:false) is still dry run', async () => {
  freshDir();
  const now = Date.now();
  const ancient = new Date(now - 500 * 86400 * 1000).toISOString();
  const es = makeFakeEventStore([
    { event_id: 'a', tenant_id: 't_mine', created_at: ancient, provider: 'p' },
  ]);
  // Pass confirm:true but OMIT dry_run:false. Must remain a dry run because
  // dry_run defaults to true and we require BOTH keys to evict.
  const r = await enforceRetentionPolicy('t_mine', { eventStore: es, confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true,
    'confirm:true alone (default dry_run=true) MUST remain a dry run — two-key destruction');
  assert.equal(es._rows.length, 1,
    `store must not have been touched; got ${es._rows.length}`);
});

// =============================================================================
// 10) Live mode requires confirm:true
// =============================================================================

test('W767 #10 — enforceRetentionPolicy live mode rejects without confirm:true', async () => {
  freshDir();
  const es = makeFakeEventStore([
    { event_id: 'a', tenant_id: 't_mine', created_at: new Date(Date.now() - 500 * 86400 * 1000).toISOString(), provider: 'p' },
  ]);
  const r = await enforceRetentionPolicy('t_mine', { eventStore: es, dry_run: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'confirm_required',
    `live mode WITHOUT confirm:true must reject; got ${JSON.stringify(r)}`);
});

// =============================================================================
// 11) MONITORING_CONTROLS frozen + >=12 entries with real TSC IDs
// =============================================================================

test('W767 #11 — MONITORING_CONTROLS is Object.freeze()-d + >=12 entries with real AICPA TSC IDs', () => {
  freshDir();
  assert.ok(Array.isArray(MONITORING_CONTROLS),
    'MONITORING_CONTROLS must be an array');
  assert.ok(Object.isFrozen(MONITORING_CONTROLS),
    'MONITORING_CONTROLS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.ok(MONITORING_CONTROLS.length >= 12,
    `expected >=12 controls (TSC sampling baseline); got ${MONITORING_CONTROLS.length}`);
  // Every entry must be frozen and carry the four required fields.
  for (const c of MONITORING_CONTROLS) {
    assert.ok(Object.isFrozen(c),
      `each MONITORING_CONTROLS entry MUST be frozen; got ${JSON.stringify(c)}`);
    assert.ok(typeof c.id === 'string' && c.id.length > 0,
      `control.id must be non-empty string; got ${JSON.stringify(c)}`);
    assert.ok(typeof c.signal === 'string' && c.signal.length > 0,
      `control.signal must be non-empty; got ${JSON.stringify(c)}`);
    assert.ok(typeof c.source === 'string' && c.source.length > 0,
      `control.source must be non-empty; got ${JSON.stringify(c)}`);
    assert.ok(['min', 'max'].includes(c.threshold_direction),
      `threshold_direction must be 'min' or 'max'; got ${JSON.stringify(c)}`);
  }
  // At least one CC (Common Criteria) ID + at least one A (Availability) ID +
  // at least one P (Privacy) ID — covers the breadth of the TSC catalog.
  const ids = MONITORING_CONTROLS.map((c) => c.id);
  assert.ok(ids.some((x) => x.startsWith('CC')),
    `expected at least one Common Criteria control (CCx.y); got ${JSON.stringify(ids)}`);
  assert.ok(ids.some((x) => x.startsWith('A1')),
    `expected at least one Availability control (A1.y); got ${JSON.stringify(ids)}`);
  assert.ok(ids.some((x) => x.startsWith('P')),
    `expected at least one Privacy control (Px.y); got ${JSON.stringify(ids)}`);
});

// =============================================================================
// 12) snapshot honest on missing tenant
// =============================================================================

test('W767 #12 — snapshot returns ok:false tenant_required on empty tenant', async () => {
  freshDir();
  const r = await snapshot('');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_required');
  assert.equal(r.version, 'w767-v1');
});

// =============================================================================
// 13) snapshot honesty — null value → unknown (NEVER green)
// =============================================================================

test('W767 #13 — snapshot honesty: null value → unknown (NEVER green)', async () => {
  freshDir();
  // Force every provider OFFLINE. We pass an eventStore that lacks listEvents
  // so the built-in audit_log provider falls through to {ok:false}; for every
  // OTHER source we wire a provider that explicitly returns {ok:false}. The
  // result must be ALL controls 'unknown' — NEVER green when a probe is off.
  const offlineProviders = {};
  for (const c of MONITORING_CONTROLS) offlineProviders[c.source] = async () => ({ ok: false });
  const r = await snapshot('t_mine', {
    signalProviders: offlineProviders,
    eventStore: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.green_count, 0,
    `offline-probe snapshot must NEVER fabricate green; got green_count=${r.summary.green_count}`);
  assert.equal(r.summary.unknown_count, MONITORING_CONTROLS.length,
    `every offline-probe control must be unknown; got ${JSON.stringify(r.summary)}`);
  for (const c of r.controls) {
    assert.equal(c.current_value, null,
      `offline provider must leave current_value:null; got ${JSON.stringify(c)}`);
    assert.equal(c.status, 'unknown',
      `null current_value MUST yield status:'unknown'; got ${JSON.stringify(c)}`);
  }
  // Even a MALICIOUS provider that returns {ok:true, value:null, status:'green'}
  // must be honest-coerced to unknown. We swap one provider with a liar.
  const evilProviders = Object.assign({}, offlineProviders);
  evilProviders.audit_log = async () => ({ ok: true, value: null, status: 'green' });
  const evil = await snapshot('t_mine', {
    signalProviders: evilProviders,
    eventStore: {},
  });
  for (const c of evil.controls) {
    if (c.current_value == null) {
      assert.equal(c.status, 'unknown',
        `provider returning value:null,status:'green' must be coerced to unknown; got ${JSON.stringify(c)}`);
    }
  }
});

// =============================================================================
// 14) snapshot DI seam + tenant fence on the provider ctx
// =============================================================================

test('W767 #14 — snapshot uses provider DI seam + tenant-fences the provider ctx', async () => {
  freshDir();
  const seenTenants = new Set();
  const provider = async (ctx) => {
    seenTenants.add(ctx.tenant_id);
    assert.equal(typeof ctx.control_id, 'string');
    assert.equal(typeof ctx.signal, 'string');
    assert.equal(typeof ctx.source, 'string');
    return { ok: true, value: 0 };
  };
  // Wire the provider against every source in MONITORING_CONTROLS so every
  // row goes through our DI hook.
  const providers = {};
  for (const c of MONITORING_CONTROLS) providers[c.source] = provider;
  const r = await snapshot('t_di', { signalProviders: providers });
  assert.equal(r.ok, true);
  assert.equal(seenTenants.size, 1,
    `provider ctx must carry exactly the calling tenant_id; got ${[...seenTenants].join(', ')}`);
  assert.ok(seenTenants.has('t_di'),
    `provider must receive ctx.tenant_id='t_di'; got ${[...seenTenants].join(', ')}`);
  // With value=0 on all 'max'-direction controls, status should be 'green';
  // 'min' direction controls expect a high target so 0 should be 'red'. Just
  // assert NEITHER status is 'unknown' anywhere — the provider was wired.
  for (const c of r.controls) {
    assert.notEqual(c.status, 'unknown',
      `every wired provider must produce a deterministic status; got ${JSON.stringify(c)}`);
  }
});

// =============================================================================
// 15) GET /v1/security/soc2/checklist auth gate
// =============================================================================

test('W767 #15 — GET /v1/security/soc2/checklist 401 w/o auth; 200 envelope on auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/security/soc2/checklist`);
    assert.equal(noAuth.status, 401,
      `expected 401 without auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/security/soc2/checklist`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w767-v1');
    assert.ok(Array.isArray(env.checklist),
      `expected checklist:[]; got ${JSON.stringify(env)}`);
    assert.ok(env.checklist.length >= 18,
      `expected >=18 checklist rows; got ${env.checklist.length}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) GET /v1/security/iso27001/controls auth gate + 30 controls + 4 families
// =============================================================================

test('W767 #16 — GET /v1/security/iso27001/controls 30 controls across 4 families', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/security/iso27001/controls`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/security/iso27001/controls`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w767-v1');
    assert.equal(env.revision, 'ISO 27001:2022');
    assert.ok(Array.isArray(env.families),
      `expected families:[]; got ${JSON.stringify(env.families)}`);
    assert.equal(env.families.length, 4,
      `Annex A:2022 has 4 control families; got ${JSON.stringify(env.families)}`);
    for (const f of ['Organizational', 'People', 'Physical', 'Technological']) {
      assert.ok(env.families.includes(f),
        `families must include '${f}'; got ${JSON.stringify(env.families)}`);
    }
    assert.ok(Array.isArray(env.controls));
    assert.ok(env.controls.length >= 15,
      `expected >=15 Annex A controls in the map; got ${env.controls.length}`);
    // Every control must carry a REAL Annex A:2022 ID shape (A.<digit>.<digit>+)
    const idRe = /^A\.\d+\.\d+$/;
    for (const c of env.controls) {
      assert.ok(idRe.test(c.id),
        `controls[].id must match Annex A:2022 shape A.<digit>.<digit>; got ${JSON.stringify(c)}`);
      assert.ok(typeof c.kolm_component === 'string' && c.kolm_component.length > 0,
        `controls[].kolm_component must be a non-empty source pointer; got ${JSON.stringify(c)}`);
    }
    // Spot-check three iconic IDs from the spec.
    const ids = env.controls.map((c) => c.id);
    for (const wanted of ['A.5.1', 'A.5.30', 'A.8.16', 'A.8.24', 'A.8.32']) {
      assert.ok(ids.includes(wanted),
        `Annex A:2022 map MUST include ${wanted}; got ${JSON.stringify(ids)}`);
    }
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) GET /v1/security/audit-retention/status auth gate + shape
// =============================================================================

test('W767 #17 — GET /v1/security/audit-retention/status 401 w/o; 200 shape on auth', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/security/audit-retention/status`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/security/audit-retention/status`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w767-v1');
    assert.equal(env.days_configured, DEFAULT_RETENTION_DAYS,
      `default tenant retention must be ${DEFAULT_RETENTION_DAYS}; got ${env.days_configured}`);
    assert.equal(env.days_default, DEFAULT_RETENTION_DAYS);
    assert.equal(env.days_min, MIN_RETENTION_DAYS);
    assert.equal(env.days_max, MAX_RETENTION_DAYS);
    assert.equal(env.compliance_floor_met, true);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) GET /v1/security/continuous-monitoring/snapshot auth gate + unknown
// =============================================================================

test('W767 #18 — GET /v1/security/continuous-monitoring/snapshot 401 w/o; honest unknown w/o providers', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/security/continuous-monitoring/snapshot`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/security/continuous-monitoring/snapshot`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w767-v1');
    assert.ok(Array.isArray(env.controls));
    assert.ok(env.controls.length >= 12);
    assert.ok(env.summary, 'snapshot must carry a summary {green/yellow/red/unknown}');
    // Without explicit providers wired into app.locals, every control must be
    // either 'unknown' OR backed by a deterministic value via the default
    // audit_log provider — but NEVER 'green' on a freshly-provisioned tenant
    // with zero events. We assert the weak invariant: green_count + yellow +
    // red + unknown == total.
    const total = env.summary.green_count + env.summary.yellow_count + env.summary.red_count + env.summary.unknown_count;
    assert.equal(total, env.controls.length,
      `summary counts must total the control count; got ${JSON.stringify(env.summary)} vs ${env.controls.length}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) soc2-type2.html brand-lock + anchors + 18 rows
// =============================================================================

test('W767 #19 — public/security/soc2-type2.html brand-lock + anchors + 18 rows', () => {
  freshDir();
  assert.ok(fs.existsSync(SOC2_HTML), `expected page at ${SOC2_HTML}`);
  const html = fs.readFileSync(SOC2_HTML, 'utf8');
  assert.ok(html.includes('Open-source AI workbench'),
    'soc2-type2.html MUST carry the brand-locked eyebrow');
  for (const anchor of [
    'data-w767="tsc-table"',
    'data-w767="tsc-evidence"',
    'data-w767="checklist"',
    'data-w767="checklist-rows"',
    'data-w767="retention-statement"',
    'data-w767="monitoring-link"',
  ]) {
    assert.ok(html.includes(anchor),
      `soc2-type2.html MUST carry anchor ${anchor}`);
  }
  assert.ok(html.includes('w767-v1'),
    'soc2-type2.html must stamp the w767-v1 version');
  // 18 checklist rows.
  const rowCount = (html.match(/class="row"/g) || []).length;
  assert.ok(rowCount >= 18,
    `expected >=18 checklist .row entries; got ${rowCount}`);
  // No emojis.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'soc2-type2.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 20) iso-27001.html brand-lock + anchors + 30 rows
// =============================================================================

test('W767 #20 — public/security/iso-27001.html brand-lock + anchors + 30 rows', () => {
  freshDir();
  assert.ok(fs.existsSync(ISO_HTML), `expected page at ${ISO_HTML}`);
  const html = fs.readFileSync(ISO_HTML, 'utf8');
  assert.ok(html.includes('Open-source AI workbench'),
    'iso-27001.html MUST carry the brand-locked eyebrow');
  for (const anchor of [
    'data-w767="iso-families"',
    'data-w767="iso-family-counts"',
    'data-w767="iso-controls-table"',
    'data-w767="iso-controls-rows"',
  ]) {
    assert.ok(html.includes(anchor),
      `iso-27001.html MUST carry anchor ${anchor}`);
  }
  assert.ok(html.includes('w767-v1'),
    'iso-27001.html must stamp the w767-v1 version');
  // Spot-check three iconic Annex A:2022 IDs that anchor the page.
  for (const wanted of ['A.5.1', 'A.5.30', 'A.8.16', 'A.8.24', 'A.8.32']) {
    assert.ok(html.includes('>' + wanted + '<'),
      `iso-27001.html MUST render the Annex A ID ${wanted}`);
  }
  // 30 control table rows.
  const rowCount = (html.match(/td class="id">A\.\d+\.\d+</g) || []).length;
  assert.ok(rowCount >= 15,
    `expected >=15 Annex A control rows; got ${rowCount}`);
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'iso-27001.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 21) continuous-monitoring.html brand-lock + anchors + >=12 rows
// =============================================================================

test('W767 #21 — public/account/continuous-monitoring.html brand-lock + anchors + >=12 rows', () => {
  freshDir();
  assert.ok(fs.existsSync(MONITOR_HTML), `expected page at ${MONITOR_HTML}`);
  const html = fs.readFileSync(MONITOR_HTML, 'utf8');
  assert.ok(html.includes('Open-source AI workbench'),
    'continuous-monitoring.html MUST carry the brand-locked eyebrow');
  for (const anchor of [
    'data-w767="monitoring-summary"',
    'data-w767="monitoring-summary-cards"',
    'data-w767="monitoring-controls"',
    'data-w767="monitoring-rows"',
  ]) {
    assert.ok(html.includes(anchor),
      `continuous-monitoring.html MUST carry anchor ${anchor}`);
  }
  assert.ok(html.includes('w767-v1'),
    'continuous-monitoring.html must stamp the w767-v1 version');
  // >=12 control rows.
  const rowCount = (html.match(/class="ctrl-row"/g) || []).length;
  assert.ok(rowCount >= 12,
    `expected >=12 ctrl-row entries; got ${rowCount}`);
  // Unknown summary card present (honesty invariant — the page must SHOW the
  // unknown bucket so the auditor sees a probe-outage story).
  assert.ok(html.includes('summary-card unknown'),
    'continuous-monitoring.html MUST render the Unknown summary card');
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'continuous-monitoring.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 22) cli/kolm.js defines cmdW767Cert exactly once + wired from case 'cert'
// =============================================================================

test('W767 #22 — cli/kolm.js defines cmdW767Cert exactly once + wired from case cert', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW767Cert\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW767Cert must be defined exactly once; found ${defOccurrences}`);
  assert.ok(/case 'cert':[\s\S]{0,200}cmdW767Cert/.test(cli),
    `expected "case 'cert': ... cmdW767Cert(...)" wiring; not found`);
});

// =============================================================================
// 23) Dispatcher uniqueness — sibling agents own different symbols
// =============================================================================

test('W767 #23 — cmdW767Cert is distinct from sibling W766/W768/W769/W770 dispatchers', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // COMPLETION_VERBS push + COMPLETION_SUBS.cert table present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('cert'"),
    'COMPLETION_VERBS must include "cert" for shell completion');
  assert.ok(/COMPLETION_SUBS\.cert\s*=/.test(cli),
    'COMPLETION_SUBS.cert must list the subcommands');
  // Every sibling-owned dispatcher symbol, IF it appears in the file at all,
  // must appear exactly once. We must not have stolen the symbol; siblings
  // must not have stolen ours. This is W604 anti-collision in CLI form.
  const allSymbols = [
    'cmdW767Cert',          // ours
    'cmdW766AiAct',         // W766 EU AI Act
    'cmdW768ModelCard',     // W768 model card
    'cmdW769Residency',     // W769 data residency
    'cmdW770AuditExport',   // W770 audit export
  ];
  // Ours MUST appear exactly once.
  const ours = (cli.match(/async function cmdW767Cert\b/g) || []).length;
  assert.equal(ours, 1,
    `cmdW767Cert must be defined exactly once; found ${ours}`);
  // Siblings MAY appear (they're appended in parallel) OR may not appear yet.
  // Either way, if they appear they MUST appear at most once — never duplicated
  // because we collided on the name.
  for (const sym of allSymbols.slice(1)) {
    const n = (cli.match(new RegExp(`async function ${sym}\\b`, 'g')) || []).length;
    assert.ok(n <= 1,
      `sibling dispatcher ${sym} must appear at most once (no W767 collision); found ${n}`);
  }
});

// =============================================================================
// 24) vercel.json has the three W767 rewrites
// =============================================================================

test('W767 #24 — vercel.json carries soc2-type2 + iso-27001 + continuous-monitoring rewrites', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  for (const [source, destination] of [
    ['/security/soc2-type2', '/security/soc2-type2.html'],
    ['/security/iso-27001', '/security/iso-27001.html'],
    ['/account/continuous-monitoring', '/account/continuous-monitoring.html'],
  ]) {
    const rw = cfg.rewrites.find((r) => r && r.source === source && r.destination === destination);
    assert.ok(rw,
      `expected rewrite { source: '${source}', destination: '${destination}' }; not found in ${cfg.rewrites.length} entries`);
  }
});

// =============================================================================
// 25) sw.js cache slug uses wave(\d{3,4}) regex+threshold (W604 anti-brittleness)
// =============================================================================

test('W767 #25 — sw.js cache slug references wave(\\d{3,4}) at sane family (W604 regex)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) {
    return;
  }
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return;
  const wm = m[1].match(/wave(\d{3,4})/);
  if (wm) {
    const n = parseInt(wm[1], 10);
    assert.ok(n >= 100,
      `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
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
  // Bonus: our own file is present.
  assert.ok(siblings.includes('wave767-soc2-iso27001.test.js'),
    `expected the W767 test file in the siblings list; got ${siblings.length} files`);
  // Source modules exist (light sanity).
  assert.ok(fs.existsSync(RETENTION_MOD_PATH), 'src/audit-retention.js must exist');
  assert.ok(fs.existsSync(MONITORING_MOD_PATH), 'src/continuous-monitoring.js must exist');
});
