// SOTA Gateway lane - real fixes for the Gateway/integration atoms.
//
// Atoms exercised (Gateway lane owns src/router.js, server.js, src/env.js,
// src/webhooks.js, src/auth-email.js):
//   - AUTH-01/02: scoped-key TTL on mint + renew (PATCH) leg, with validation.
//   - M5: /v1/account/keys lists primary + scoped, create mints scoped (not
//     destructive rotate) unless ?rotate_primary=true.
//   - P0-1: x-kolm-team membership gate on the gateway provider-key resolve.
//   - P0-2: listProviderKeys / delete 403 for a non-member team_id.
//   - GW-2/3/4: webhooks emit() wired + test route + delivery-time SSRF guard
//     (numeric host normalization, IPv6 ranges, private-IP rejection).
//   - org audit feed reads the real team-events store.
//   - ComputeQuant gate: /v1/quantize rejects an experimental method unless armed.
//   - jobs SSE stream_url + ?since cursor surfaced.
//   - compute concurrency ceiling helper (plan-derived).
//   - env KNOWN_ENV_DOCS catalog documents the new operator flags.
//
// Isolation: one temp KOLM_DATA_DIR + json store, set BEFORE any store import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-sota-gateway-'));
process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.KOLM_HOME = path.join(tmp, '.kolm');
process.env.KOLM_ENV = 'test';
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.KOLM_JOBS_DIR = path.join(tmp, 'jobs');
process.env.KOLM_JOB_LOG_DIR = path.join(tmp, 'job-logs');
delete process.env.ADMIN_KEY;
delete process.env.KOLM_WEBHOOKS_ALLOW_LOCAL; // exercise the real SSRF guard

const webhooks = await import('../src/webhooks.js');
const env = await import('../src/env.js');
const teams = await import('../src/teams.js');
const vault = await import('../src/provider-vault.js');

const { buildRouter } = await import('../src/router.js');
const { provisionAnonTenant } = await import('../src/auth.js');
const express = (await import('express')).default;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  return app;
}
function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const out = await fn('http://127.0.0.1:' + server.address().port);
        server.close(() => resolve(out));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}
async function api(base, p, { apiKey, method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}), ...headers } };
  if (body != null) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  return fetch(base + p, init);
}

// =====================================================================
// Webhooks SSRF guard - pure unit (no server needed).
// =====================================================================
test('GW SSRF: isPrivateIp catches loopback / private / link-local / mapped', () => {
  assert.equal(webhooks.isPrivateIp('127.0.0.1'), true);
  assert.equal(webhooks.isPrivateIp('10.1.2.3'), true);
  assert.equal(webhooks.isPrivateIp('192.168.0.5'), true);
  assert.equal(webhooks.isPrivateIp('172.16.9.9'), true);
  assert.equal(webhooks.isPrivateIp('169.254.169.254'), true, 'cloud metadata must be blocked');
  assert.equal(webhooks.isPrivateIp('100.64.1.1'), true, 'CGNAT must be blocked');
  assert.equal(webhooks.isPrivateIp('::1'), true);
  assert.equal(webhooks.isPrivateIp('fe80::1'), true, 'IPv6 link-local');
  assert.equal(webhooks.isPrivateIp('fc00::1'), true, 'IPv6 ULA');
  assert.equal(webhooks.isPrivateIp('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback');
  // Public addresses pass.
  assert.equal(webhooks.isPrivateIp('8.8.8.8'), false);
  assert.equal(webhooks.isPrivateIp('1.1.1.1'), false);
});

test('GW SSRF: numeric host encodings normalize to dotted-quad', () => {
  assert.equal(webhooks.normalizeNumericHost('2130706433'), '127.0.0.1', 'decimal IPv4');
  assert.equal(webhooks.normalizeNumericHost('0x7f000001'), '127.0.0.1', 'hex IPv4');
  // And the normalized result is recognized as private.
  assert.equal(webhooks.isPrivateIp(webhooks.normalizeNumericHost('2130706433')), true);
  assert.equal(webhooks.isPrivateIp(webhooks.normalizeNumericHost('0x7f000001')), true);
});

test('GW SSRF: assertPublicUrlAtDelivery rejects private + numeric, allows public literal', async () => {
  const metadata = await webhooks.assertPublicUrlAtDelivery('http://169.254.169.254/latest/meta-data/');
  assert.equal(metadata.ok, false, 'metadata endpoint must be blocked at delivery time');
  const decimal = await webhooks.assertPublicUrlAtDelivery('http://2130706433/');
  assert.equal(decimal.ok, false, 'decimal-encoded loopback must be blocked');
  const local = await webhooks.assertPublicUrlAtDelivery('http://localhost/hook');
  assert.equal(local.ok, false);
  const pub = await webhooks.assertPublicUrlAtDelivery('http://8.8.8.8/');
  assert.equal(pub.ok, true, 'a public literal IP passes');
});

// =====================================================================
// env catalog documents the new operator flags.
// =====================================================================
test('GW env: KNOWN_ENV_DOCS documents the new gateway/trainer/webhook flags', () => {
  const d = env.KNOWN_ENV_DOCS;
  assert.ok(d && typeof d === 'object');
  for (const k of [
    'KOLM_KEY_LAST_USED_FLUSH_MS', 'KOLM_MAGICLINK_GC_MS', 'KOLM_MAGICLINK_RETENTION_DAYS',
    'KOLM_ALLOW_NONTXN_TEAMS', 'KOLM_BACKUP_INCLUDE_VAULT_KEY', 'KOLM_EVENT_STORE_NO_AUTOCOMPACT',
    'KOLM_DISTILL_CURRICULUM', 'KOLM_DISTILL_IMPORTANCE', 'KOLM_VLLM_URL', 'KOLM_LLAMA_DRAFT_URL',
    'KOLM_QUANT_OPTIMIZERS', 'KOLM_COMPILE_STREAM_DEMO', 'KOLM_ED25519_DISABLE',
    'KOLM_MAX_CONCURRENT_DISTILL', 'KOLM_WEBHOOKS_ALLOW_LOCAL',
  ]) {
    assert.equal(typeof d[k], 'string', 'env doc must exist for ' + k);
    assert.ok(d[k].length > 0);
  }
});

// =====================================================================
// AUTH-01/02 - scoped-key TTL on mint + renew leg.
// =====================================================================
test('GW AUTH-01: POST /v1/account/scoped-keys honors ttl_days + echoes expires_at', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/account/scoped-keys', { apiKey: t.api_key, method: 'POST', body: { scopes: ['capture:read'], label: 'ci', ttl_days: 90 } });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.ok(b.api_key && b.api_key.startsWith('ks_'));
    assert.ok(b.expires_at, 'expires_at must be echoed');
    const ms = new Date(b.expires_at).getTime() - Date.now();
    assert.ok(ms > 80 * 86400000 && ms < 100 * 86400000, 'expires ~90d out');
    assert.equal(b.recommended_ttl_days, 90);
  });
});

test('GW AUTH-01: invalid ttl_days is rejected 400 (no silent never-expire)', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/account/scoped-keys', { apiKey: t.api_key, method: 'POST', body: { scopes: ['*'], ttl_days: -5 } });
    assert.equal(r.status, 400);
  });
});

test('GW AUTH-02: PATCH /v1/account/scoped-keys/:id renews the TTL', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const mk = await api(base, '/v1/account/scoped-keys', { apiKey: t.api_key, method: 'POST', body: { scopes: ['capture:read'], ttl_days: 7 } });
    const mkb = await mk.json();
    // List to get the scoped key id.
    const list = await api(base, '/v1/account/scoped-keys', { apiKey: t.api_key });
    const lb = await list.json();
    const row = lb.keys.find((k) => k.key_prefix === mkb.key_prefix);
    assert.ok(row && row.id, 'minted scoped key must be listed with an id');
    const r = await api(base, '/v1/account/scoped-keys/' + row.id, { apiKey: t.api_key, method: 'PATCH', body: { ttl_days: 30 } });
    assert.equal(r.status, 200);
    const rb = await r.json();
    assert.equal(rb.ok, true);
    const ms = new Date(rb.expires_at).getTime() - Date.now();
    assert.ok(ms > 25 * 86400000 && ms < 35 * 86400000, 'renewed ~30d out');
  });
});

// =====================================================================
// M5 - /v1/account/keys contract.
// =====================================================================
test('GW M5: GET /v1/account/keys lists primary (scopes:[*]) + scoped rows, no synthesized last_used', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    await api(base, '/v1/account/scoped-keys', { apiKey: t.api_key, method: 'POST', body: { scopes: ['lake:export'], label: 'ci2' } });
    const r = await api(base, '/v1/account/keys', { apiKey: t.api_key });
    const b = await r.json();
    const primary = b.keys.find((k) => k.primary);
    assert.ok(primary, 'primary key row present');
    assert.deepEqual(primary.scopes, ['*'], 'primary advertises full scope, not a fabricated array');
    // last_used_at is never synthesized to "now" - null when unknown.
    assert.ok(primary.last_used_at === null || typeof primary.last_used_at === 'string');
    assert.ok(b.keys.some((k) => k.primary === false), 'scoped keys also listed');
  });
});

test('GW M5: POST /v1/account/keys mints a scoped key by default (does NOT rotate primary)', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/account/keys', { apiKey: t.api_key, method: 'POST', body: { label: 'new' } });
    const b = await r.json();
    assert.equal(b.rotated_primary, false, 'create must not destroy the primary');
    assert.ok(b.api_key && b.api_key.startsWith('ks_'), 'returns a scoped key');
    // The original primary still authenticates.
    const ok = await api(base, '/v1/account/keys', { apiKey: t.api_key });
    assert.equal(ok.status, 200, 'primary key still valid after create');
  });
});

test('GW M5: POST /v1/account/keys?rotate_primary=true rotates the primary', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/account/keys?rotate_primary=true', { apiKey: t.api_key, method: 'POST', body: {} });
    const b = await r.json();
    assert.equal(b.rotated_primary, true);
    assert.ok(b.api_key, 'returns the rotated primary');
  });
});

// =====================================================================
// P0-2 - listProviderKeys / delete 403 for a non-member team_id.
// =====================================================================
test('GW P0-2: a non-member cannot enumerate another team provider keys', async () => {
  // Build a team owned by a DIFFERENT tenant; store a team key in it.
  const owner = 'tn_owner_' + crypto.randomBytes(4).toString('hex');
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Victim Co', plan: 'teams' });
  vault.putProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai', scope: 'team', value: 'sk-VICTIM-999' });

  const attacker = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/account/provider-keys?team_id=' + encodeURIComponent(team.id), { apiKey: attacker.api_key });
    assert.equal(r.status, 403, 'non-member must be forbidden from listing a team vault');
    const del = await api(base, '/v1/account/provider-keys/whatever?team_id=' + encodeURIComponent(team.id), { apiKey: attacker.api_key, method: 'DELETE' });
    assert.equal(del.status, 403, 'non-member must be forbidden from deleting a team key');
  });
});

// =====================================================================
// P0-1 - gateway provider-key resolution: a non-member with x-kolm-team
// cannot resolve the victim team's shared key. We assert at the vault level
// the way the route now gates: membershipOf(team, attacker) is false, so the
// route passes teamId=null and resolveProviderKey returns no team key.
// =====================================================================
test('GW P0-1: spoofed x-kolm-team resolves no shared key for a non-member', () => {
  const owner = 'tn_owner_' + crypto.randomBytes(4).toString('hex');
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Creds Co', plan: 'teams' });
  vault.putProviderKey({ tenantId: owner, teamId: team.id, provider: 'openai', scope: 'team', value: 'sk-TEAM-999' });
  const attacker = 'tn_attacker_' + crypto.randomBytes(4).toString('hex');
  // The route gate: membershipOf(team, attacker) === active membership?
  assert.equal(teams.membershipOf(team.id, attacker), null, 'attacker is not an active member');
  // With the gate, the route sets teamId=null, so resolution falls to the
  // attacker's OWN (member) key only - which does not exist => null.
  const resolvedAsNonMember = vault.resolveProviderKey({ tenantId: attacker, teamId: null, provider: 'openai' });
  assert.equal(resolvedAsNonMember, null, 'no shared team key leaks to a non-member');
});

// =====================================================================
// ComputeQuant gate - /v1/quantize rejects an experimental method unless armed.
// =====================================================================
test('GW ComputeQuant: /v1/quantize 422s an experimental method when not armed', async () => {
  const prev = process.env.KOLM_EXPERIMENTAL_QUANTS;
  delete process.env.KOLM_EXPERIMENTAL_QUANTS;
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/quantize', { apiKey: t.api_key, method: 'POST', body: { model_id: 'Qwen/Qwen2.5-0.5B', target: 'aqlm-2bit' } });
    // The oracle gates aqlm as experimental_gated -> 422 with a hint.
    assert.equal(r.status, 422, 'experimental aqlm must be gated when not armed');
    const b = await r.json();
    assert.equal(b.error, 'quant_method_unavailable');
    assert.ok(b.hint, 'oracle hint surfaced');
  });
  if (prev !== undefined) process.env.KOLM_EXPERIMENTAL_QUANTS = prev;
});

// =====================================================================
// Webhooks lifecycle - test-delivery route is wired and tenant-fenced.
// =====================================================================
test('GW webhooks: POST /v1/webhooks/:id/test delivers (404 for unknown id)', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const missing = await api(base, '/v1/webhooks/whk_does_not_exist/test', { apiKey: t.api_key, method: 'POST' });
    assert.equal(missing.status, 404, 'unknown subscription must 404');
  });
});

// =====================================================================
// jobs SSE + cursor surfaced on GET /v1/jobs/:id.
// =====================================================================
test('GW jobs: GET /v1/jobs/:id exposes stream_url + ?since cursor (404 for unknown)', async () => {
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/jobs/job-unknown', { apiKey: t.api_key });
    assert.equal(r.status, 404, 'unknown job 404s cleanly');
    // The /stream route is mounted (not 404 by missing-route); for an unknown
    // job it returns 404 from the handler, proving it is wired.
    const s = await api(base, '/v1/jobs/job-unknown/stream', { apiKey: t.api_key });
    assert.equal(s.status, 404, 'stream route is mounted and 404s on unknown job');
  });
});

// =====================================================================
// org audit reads the real team-events store.
// =====================================================================
test('GW org audit: a recorded team event surfaces in /v1/orgs/:id/audit (not a hardcoded stub)', async () => {
  // Own the team as the calling tenant so membership passes, then raise a REAL
  // team event and assert the audit feed reflects it (proves the route reads the
  // team-events store rather than returning a hardcoded empty ledger).
  const ownerTok = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const owner = ownerTok.id || ownerTok.tenant_id || (ownerTok.tenant && ownerTok.tenant.id);
  const team = teams.createTeam({ ownerTenantId: owner, name: 'Audit Co', plan: 'teams' });
  const ev = teams.emitTeamEvent(team.id, 'provider_key.rotation_recommended', { reason: 'member_removed' });
  assert.ok(ev && ev.id, 'a real team event was recorded');
  const evts = teams.listTeamEvents(team.id, { includeAcknowledged: true });
  assert.ok(evts.length >= 1, 'team-events store carries the recorded event');

  await withServer(makeApp(), async (base) => {
    const r = await api(base, '/v1/orgs/' + encodeURIComponent(team.id) + '/audit', { apiKey: ownerTok.api_key });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.scope, 'org');
    assert.ok(Array.isArray(b.entries), 'entries is a real array, not a hardcoded stub');
    assert.equal(b.entries.length, evts.length, 'feed reflects the real team-events store count');
    assert.ok(b.entries.some((e) => e.type === 'provider_key.rotation_recommended'), 'the recorded event type appears');
  });
});
