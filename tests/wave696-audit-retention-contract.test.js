// W696 - direct contract/security test for src/audit-retention.js.
//
// Retention is a destructive compliance boundary. These tests pin dry-run
// defaults, tenant-scoped live eviction, redacted failures, deterministic
// cutoff/proof metadata, and the event-store purge selector it depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUDIT_RETENTION_PROOF_VERSION,
  AUDIT_RETENTION_VERSION,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  enforceRetentionPolicy,
  getCurrentRetentionDays,
  getRetentionStatus,
  setRetentionDays,
} from '../src/audit-retention.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW_ISO = '2026-06-18T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const HEX_64 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function daysAgo(days, tenant_id = 'tenant-a', event_id = `evt_${tenant_id}_${days}`) {
  return {
    event_id,
    tenant_id,
    namespace: 'default',
    provider: 'openai',
    model: 'gpt',
    status: 'ok',
    request_hash: `rh_${event_id}`,
    created_at: new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function withEnv(patch, fn) {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeEventStore(seedRows = [], opts = {}) {
  let rows = seedRows.slice();
  const calls = [];
  const api = {
    calls,
    rows: () => rows.slice(),
    async appendEvent(ev) {
      calls.push({ fn: 'appendEvent', ev });
      if (opts.appendError) throw new Error(opts.appendError);
      const persisted = {
        ...ev,
        event_id: ev.event_id || `evt_set_${rows.length}`,
        created_at: ev.created_at || NOW_ISO,
      };
      rows.push(persisted);
      return persisted;
    },
    async listEvents(query = {}) {
      calls.push({ fn: 'listEvents', query: { ...query } });
      if (opts.listError) throw new Error(opts.listError);
      let out = rows.slice();
      if (query.provider) out = out.filter((r) => r.provider === query.provider);
      if (query.tenant_id) out = out.filter((r) => r.tenant_id === query.tenant_id);
      if (query.since) out = out.filter((r) => Date.parse(r.created_at) >= Date.parse(query.since));
      if (query.until) out = out.filter((r) => Date.parse(r.created_at) <= Date.parse(query.until));
      out.sort((a, b) => {
        const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
        return query.order === 'desc' ? -delta : delta;
      });
      return opts.leakForeignRows ? out.concat(daysAgo(40, 'tenant-b', 'evt_leaked_foreign')) : out;
    },
    async purgeEvents(query = {}) {
      calls.push({ fn: 'purgeEvents', query: { ...query } });
      if (opts.purgeError) throw new Error(opts.purgeError);
      if (opts.purgeResult !== undefined) return opts.purgeResult;
      const beforeMs = Date.parse(query.before || '');
      let deleted = 0;
      rows = rows.filter((r) => {
        const matchTenant = query.tenant_id ? r.tenant_id === query.tenant_id : true;
        const matchBefore = Number.isFinite(beforeMs) ? Date.parse(r.created_at) < beforeMs : true;
        if (matchTenant && matchBefore) {
          deleted += 1;
          return false;
        }
        return true;
      });
      return { deleted, would_delete: deleted };
    },
  };
  return api;
}

function freshEventStoreDir(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  delete process.env.KOLM_EVENT_STORE_PATH;
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

test('W696 audit retention source and depth wiring pin destructive boundary hardening', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(ROOT, 'src/audit-retention.js'), 'utf8');
  const eventStore = fs.readFileSync(path.join(ROOT, 'src/event-store.js'), 'utf8');

  assert.equal(AUDIT_RETENTION_VERSION, 'w767-v1');
  assert.equal(AUDIT_RETENTION_PROOF_VERSION, 'w696-v1');
  assert.match(pkg.scripts['verify:audit-retention'], /wave696-audit-retention-contract\.test\.js/);
  assert.match(pkg.scripts['verify:depth'], /verify:audit-retention/);
  assert.match(source, /function _proofFields/);
  assert.match(source, /candidate_read_failed/);
  assert.match(source, /purgeEvents\(\{\s*tenant_id: tenant,\s*before: cutoffISO/s);
  assert.match(eventStore, /tenant_id\|tenant/);
  assert.match(eventStore, /tenantFilter/);
});

test('W696 environment retention floor defaults, clamps, and rejects sub-floor values', () => {
  assert.equal(withEnv({ KOLM_AUDIT_RETENTION_DAYS: undefined }, () => getCurrentRetentionDays()), DEFAULT_RETENTION_DAYS);
  assert.equal(withEnv({ KOLM_AUDIT_RETENTION_DAYS: 'garbage' }, () => getCurrentRetentionDays()), DEFAULT_RETENTION_DAYS);
  assert.equal(withEnv({ KOLM_AUDIT_RETENTION_DAYS: '89' }, () => getCurrentRetentionDays()), DEFAULT_RETENTION_DAYS);
  assert.equal(withEnv({ KOLM_AUDIT_RETENTION_DAYS: '400' }, () => getCurrentRetentionDays()), 400);
  assert.equal(withEnv({ KOLM_AUDIT_RETENTION_DAYS: String(MAX_RETENTION_DAYS + 500) }, () => getCurrentRetentionDays()), MAX_RETENTION_DAYS);
});

test('W696 setRetentionDays validates tenant/day bounds and redacts persistence errors', async () => {
  assert.equal((await setRetentionDays(' ', 365, { eventStore: fakeEventStore() })).error, 'tenant_required');
  assert.equal((await setRetentionDays('tenant-a', 89, { eventStore: fakeEventStore() })).error, 'days_below_min');
  assert.equal((await setRetentionDays('tenant-a', MAX_RETENTION_DAYS + 1, { eventStore: fakeEventStore() })).error, 'days_above_max');

  const store = fakeEventStore();
  const ok = await setRetentionDays(' tenant-a ', 400, { eventStore: store });
  assert.equal(ok.ok, true);
  assert.equal(ok.tenant_id, 'tenant-a');
  assert.equal(ok.days_configured, 400);
  assert.equal(ok.proof_version, AUDIT_RETENTION_PROOF_VERSION);
  assert.equal(store.calls[0].ev.provider, 'kolm_audit_retention');
  assert.equal(store.calls[0].ev.request_hash, 'retention_days=400');

  const failed = await setRetentionDays('tenant-a', 365, {
    eventStore: fakeEventStore([], { appendError: 'boom sk_testsecret1234567890' }),
  });
  assert.equal(failed.error, 'persist_failed');
  assert.doesNotMatch(failed.detail, /sk_testsecret/);
  assert.match(failed.detail, /\[redacted_secret\]/);
});

test('W696 getRetentionStatus is tenant-fenced, deterministic, and proof-backed', async () => {
  const store = fakeEventStore([
    daysAgo(30, 'tenant-a', 'evt_a_new'),
    daysAgo(100, 'tenant-a', 'evt_a_mid'),
    daysAgo(30, 'tenant-b', 'evt_b_new'),
    {
      ...daysAgo(1, 'tenant-a', 'evt_policy_a'),
      provider: 'kolm_audit_retention',
      request_hash: 'retention_days=400',
    },
    {
      ...daysAgo(1, 'tenant-b', 'evt_policy_b'),
      provider: 'kolm_audit_retention',
      request_hash: 'retention_days=90',
    },
  ], { leakForeignRows: true });

  const out = await getRetentionStatus('tenant-a', { eventStore: store, now: NOW_ISO });
  assert.equal(out.ok, true);
  assert.equal(out.as_of, NOW_ISO);
  assert.equal(out.days_configured, 400);
  assert.equal(out.total_audit_events_in_window, 3);
  assert.equal(out.compliance_floor_met, true);
  assert.equal(out.proof_version, AUDIT_RETENTION_PROOF_VERSION);
  assert.match(out.event_set_sha256, HEX_64);
  assert.match(out.manifest_sha256, HEX_64);
  assert.equal(out.proof.manifest.kind, 'audit_retention_status');
  assert.equal(out.proof.manifest.event_set_sha256, out.event_set_sha256);
  assert.notEqual(out.event_set_sha256, sha256(''));
});

test('W696 enforceRetentionPolicy dry-runs by default and proof-binds the candidate set', async () => {
  const store = fakeEventStore([
    daysAgo(500, 'tenant-a', 'evt_a_old'),
    daysAgo(10, 'tenant-a', 'evt_a_new'),
    daysAgo(500, 'tenant-b', 'evt_b_old'),
  ], { leakForeignRows: true });

  const out = await enforceRetentionPolicy('tenant-a', {
    eventStore: store,
    now_ms: NOW_MS,
  });

  assert.equal(out.ok, true);
  assert.equal(out.dry_run, true);
  assert.equal(out.as_of, NOW_ISO);
  assert.equal(out.would_evict_count, 1);
  assert.equal(out.oldest_kept_at, daysAgo(10, 'tenant-a', 'evt_a_new').created_at);
  assert.equal(store.calls.some((c) => c.fn === 'purgeEvents'), false);
  assert.equal(out.proof.manifest.kind, 'audit_retention_dry_run');
  assert.equal(out.proof.manifest.event_count, 1);
});

test('W696 live retention requires confirm and uses tenant-scoped before purges', async () => {
  const store = fakeEventStore([
    daysAgo(500, 'tenant-a', 'evt_a_old'),
    daysAgo(700, 'tenant-a', 'evt_a_older'),
    daysAgo(10, 'tenant-a', 'evt_a_new'),
    daysAgo(500, 'tenant-b', 'evt_b_old'),
  ], { purgeResult: { deleted: 999, would_delete: 999 } });

  const missingConfirm = await enforceRetentionPolicy('tenant-a', {
    eventStore: store,
    now: NOW_ISO,
    dry_run: false,
  });
  assert.equal(missingConfirm.ok, false);
  assert.equal(missingConfirm.error, 'confirm_required');
  assert.equal(missingConfirm.would_evict_count, 2);

  const live = await enforceRetentionPolicy('tenant-a', {
    eventStore: store,
    now: NOW_ISO,
    dry_run: false,
    confirm: true,
  });
  assert.equal(live.ok, true);
  assert.equal(live.dry_run, false);
  assert.equal(live.would_evict_count, 2);
  assert.equal(live.evicted_count, 2, 'over-reported store count is capped to candidates');
  assert.equal(live.proof.manifest.kind, 'audit_retention_live_eviction');

  const purge = store.calls.find((c) => c.fn === 'purgeEvents');
  assert.deepEqual(Object.keys(purge.query).sort(), ['before', 'tenant_id']);
  assert.equal(purge.query.tenant_id, 'tenant-a');
  assert.equal(typeof purge.query.before, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(purge.query, 'until'), false);
});

test('W696 retention failures fail closed and redact secrets', async () => {
  const candidateFailed = await enforceRetentionPolicy('tenant-a', {
    eventStore: fakeEventStore([], { listError: 'bad Bearer ks_secret1234567890' }),
    now: NOW_ISO,
  });
  assert.equal(candidateFailed.ok, false);
  assert.equal(candidateFailed.error, 'candidate_read_failed');
  assert.doesNotMatch(candidateFailed.detail, /ks_secret/);
  assert.match(candidateFailed.detail, /\[redacted_secret\]/);

  const badShape = await enforceRetentionPolicy('tenant-a', {
    eventStore: fakeEventStore([daysAgo(500)], { purgeResult: { unknown: true } }),
    now: NOW_ISO,
    dry_run: false,
    confirm: true,
  });
  assert.equal(badShape.ok, false);
  assert.equal(badShape.error, 'eviction_result_bad_shape');

  const purgeFailed = await enforceRetentionPolicy('tenant-a', {
    eventStore: fakeEventStore([daysAgo(500)], { purgeError: 'nope sk_testsecret1234567890' }),
    now: NOW_ISO,
    dry_run: false,
    confirm: true,
  });
  assert.equal(purgeFailed.ok, false);
  assert.equal(purgeFailed.error, 'eviction_failed');
  assert.doesNotMatch(purgeFailed.detail, /sk_testsecret/);
});

test('W696 event-store purgeEvents supports tenant-scoped before purges', async () => {
  freshEventStoreDir('kolm-w696-event-store-');
  const es = await import(`../src/event-store.js?w696=${Date.now()}-${Math.random()}`);
  es._resetForTests();

  await es.appendEvent({ ...daysAgo(500, 'tenant-a', 'evt_a_old'), prompt_redacted: 'a', response_redacted: 'a' });
  await es.appendEvent({ ...daysAgo(10, 'tenant-a', 'evt_a_new'), prompt_redacted: 'b', response_redacted: 'b' });
  await es.appendEvent({ ...daysAgo(500, 'tenant-b', 'evt_b_old'), prompt_redacted: 'c', response_redacted: 'c' });

  const before = new Date(NOW_MS - 365 * 24 * 60 * 60 * 1000).toISOString();
  const dry = await es.purgeEvents({ tenant_id: 'tenant-a', before, dryRun: true });
  assert.deepEqual(dry, { deleted: 0, would_delete: 1 });

  const live = await es.purgeEvents({ tenant_id: 'tenant-a', before });
  assert.equal(live.deleted, 1);
  assert.equal(live.would_delete, 1);

  const remaining = await es.listEvents({ limit: 0, order: 'asc' });
  assert.deepEqual(remaining.map((r) => r.event_id).sort(), ['evt_a_new', 'evt_b_old']);
});
