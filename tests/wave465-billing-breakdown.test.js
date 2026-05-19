// W465 — per-namespace cost attribution + team-level rollup.
//
// Closes audit P1 Billing cluster open item ("hosted dashboard for usage
// breakdown; per-namespace cost attribution; team-level rollup").
//
// Tests assert behavior, not page copy:
//   1) src/billing-breakdown.js exports periodBounds + tenantNamespaceBreakdown + teamRollup.
//   2) periodBounds returns half-open UTC ISO bounds for a YYYY-MM month + validates format + month range.
//   3) tenantNamespaceBreakdown aggregates event-store rows per namespace, sorted by cost desc.
//   4) tenantNamespaceBreakdown is tenant-fenced (foreign rows never leak into totals).
//   5) teamRollup walks members + aggregates totals + gates per-member detail by role.
//   6) GET /v1/billing/breakdown is auth-gated (401 without auth).
//   7) GET /v1/billing/breakdown returns by=namespace envelope by default; ?by=team requires team_id.
//   8) GET /v1/billing/breakdown rejects invalid period (?period=garbage → 400).
//   9) Connector capture path stamps namespace from x-kolm-namespace header (was hardcoded 'default').
//  10) CLI wires `kolm billing breakdown` subcommand + HELP + TUI 16th view (billing-breakdown) + sw.js slug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as billingBreakdown from '../src/billing-breakdown.js';
import * as teams from '../src/teams.js';
import * as kolmStore from '../src/store.js';
import * as auth from '../src/auth.js';
import { buildRouter } from '../src/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w465-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  return tmp;
}

async function buildApp() {
  const tmpdir = freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// Seed an event-store row directly. Caller supplies tenant_id + namespace +
// cost_micro_usd + tokens. Other fields get sensible defaults so we don't
// fight backfillLegacy.
async function seedEvent(tenant_id, namespace, cost_micro_usd, tokens_in = 10, tokens_out = 20, opts = {}) {
  const created_at = opts.created_at || new Date().toISOString();
  return await eventStore.appendEvent({
    tenant_id,
    namespace,
    provider: opts.provider || 'openai',
    vendor: opts.vendor || 'openai',
    model: opts.model || 'gpt-4o-mini',
    tokens_in,
    tokens_out,
    prompt_tokens: tokens_in,
    completion_tokens: tokens_out,
    cost_micro_usd,
    estimated_cost_usd: cost_micro_usd / 1_000_000,
    latency_ms: opts.latency_ms || 100,
    status: 'ok',
    created_at,
  });
}

// =============================================================================
// 1) Module exports
// =============================================================================

test('W465 #1 — src/billing-breakdown.js exports periodBounds + tenantNamespaceBreakdown + teamRollup', () => {
  assert.equal(typeof billingBreakdown.periodBounds, 'function', 'periodBounds must be exported');
  assert.equal(typeof billingBreakdown.tenantNamespaceBreakdown, 'function', 'tenantNamespaceBreakdown must be exported');
  assert.equal(typeof billingBreakdown.teamRollup, 'function', 'teamRollup must be exported');
});

// =============================================================================
// 2) periodBounds validates + returns half-open UTC bounds
// =============================================================================

test('W465 #2 — periodBounds returns half-open UTC bounds + rejects malformed periods + month range', () => {
  const { periodBounds } = billingBreakdown;
  const b = periodBounds('2026-05');
  assert.equal(b.period, '2026-05');
  assert.equal(b.since, '2026-05-01T00:00:00.000Z');
  assert.equal(b.until, '2026-06-01T00:00:00.000Z');
  // Year-end rollover.
  const dec = periodBounds('2026-12');
  assert.equal(dec.since, '2026-12-01T00:00:00.000Z');
  assert.equal(dec.until, '2027-01-01T00:00:00.000Z');
  // Invalid period throws with code='invalid_period'.
  let err = null;
  try { periodBounds('2026/05'); } catch (e) { err = e; }
  assert.ok(err && err.code === 'invalid_period', 'malformed period must throw invalid_period');
  // Out-of-range month also rejected.
  let err2 = null;
  try { periodBounds('2026-13'); } catch (e) { err2 = e; }
  assert.ok(err2 && err2.code === 'invalid_period', 'month > 12 must throw invalid_period');
  let err3 = null;
  try { periodBounds('2026-00'); } catch (e) { err3 = e; }
  assert.ok(err3 && err3.code === 'invalid_period', 'month < 1 must throw invalid_period');
  // Empty period falls back to currentPeriod() — should not throw.
  const cur = periodBounds(null);
  assert.match(cur.period, /^\d{4}-\d{2}$/, 'null period defaults to current YYYY-MM');
});

// =============================================================================
// 3) tenantNamespaceBreakdown aggregates per namespace, sorted by cost desc
// =============================================================================

test('W465 #3 — tenantNamespaceBreakdown aggregates per-namespace + sorts by cost desc', async () => {
  freshDir();
  const tenant = 'tenant_w465_3';
  // Stamp 3 rows on support_chat (cheap), 2 rows on premium_chat (expensive).
  await seedEvent(tenant, 'support_chat',  100_000, 5, 10);
  await seedEvent(tenant, 'support_chat',  150_000, 7, 14);
  await seedEvent(tenant, 'support_chat',  120_000, 6, 12);
  await seedEvent(tenant, 'premium_chat', 5_000_000, 50, 100);
  await seedEvent(tenant, 'premium_chat', 3_000_000, 30, 60);

  const out = await billingBreakdown.tenantNamespaceBreakdown({ tenant_id: tenant });
  assert.equal(out.tenant_id, tenant);
  assert.equal(out.totals.captures, 5);
  assert.equal(out.totals.cost_micro_usd, 100_000 + 150_000 + 120_000 + 5_000_000 + 3_000_000);
  assert.equal(out.namespaces.length, 2);
  // Sorted: premium first (more $).
  assert.equal(out.namespaces[0].namespace, 'premium_chat');
  assert.equal(out.namespaces[0].captures, 2);
  assert.equal(out.namespaces[0].cost_micro_usd, 8_000_000);
  assert.equal(out.namespaces[1].namespace, 'support_chat');
  assert.equal(out.namespaces[1].captures, 3);
  assert.equal(out.namespaces[1].cost_micro_usd, 370_000);
});

// =============================================================================
// 4) Tenant fence: foreign rows never leak into totals
// =============================================================================

test('W465 #4 — tenantNamespaceBreakdown is tenant-fenced (foreign rows excluded)', async () => {
  freshDir();
  // Seed two tenants in the same period.
  await seedEvent('tenant_w465_4_A', 'shared_ns', 1_000_000, 10, 20);
  await seedEvent('tenant_w465_4_B', 'shared_ns', 9_999_999, 50, 100);

  const outA = await billingBreakdown.tenantNamespaceBreakdown({ tenant_id: 'tenant_w465_4_A' });
  assert.equal(outA.totals.captures, 1);
  assert.equal(outA.totals.cost_micro_usd, 1_000_000,
    'tenant A must NOT see tenant B rows (got: ' + outA.totals.cost_micro_usd + ')');
  const outB = await billingBreakdown.tenantNamespaceBreakdown({ tenant_id: 'tenant_w465_4_B' });
  assert.equal(outB.totals.captures, 1);
  assert.equal(outB.totals.cost_micro_usd, 9_999_999);
});

// =============================================================================
// 5) Team rollup walks members + role-gates detail
// =============================================================================

test('W465 #5 — teamRollup aggregates member totals + role-gates per-member detail', async () => {
  freshDir();

  // Pretend owner + member tenants exist; we only need their ids
  // because teamRollup walks the team_members table.
  const ownerId  = 'tenant_w465_owner';
  const memberId = 'tenant_w465_member';
  const team = teams.createTeam({ ownerTenantId: ownerId, name: 'W465 Test Team', plan: 'team', seatsMax: 5 });
  // Add a second tenant as member.
  kolmStore.insert('team_members', {
    id: 'tm_w465_member',
    team_id: team.id,
    tenant_id: memberId,
    role: 'member',
    status: 'active',
    invited_at: new Date().toISOString(),
    joined_at: new Date().toISOString(),
  });

  // Owner spends $0.50, member spends $1.00.
  await seedEvent(ownerId,  'ops',       500_000, 100, 200);
  await seedEvent(memberId, 'support', 1_000_000, 50, 100);

  // Caller=owner: privileged view, sees BOTH members' namespaces.
  const ownerView = await billingBreakdown.teamRollup({ team_id: team.id, caller_tenant_id: ownerId });
  assert.equal(ownerView.team_id, team.id);
  assert.equal(ownerView.privileged, true);
  assert.equal(ownerView.members.length, 2, 'rollup must include both team members (got ' + ownerView.members.length + ')');
  assert.equal(ownerView.totals.cost_micro_usd, 500_000 + 1_000_000);
  const oRow = ownerView.members.find(m => m.tenant_id === ownerId);
  const mRow = ownerView.members.find(m => m.tenant_id === memberId);
  assert.ok(Array.isArray(oRow.namespaces), 'owner view: owner.namespaces visible');
  assert.ok(Array.isArray(mRow.namespaces), 'owner view: member.namespaces visible');

  // Caller=member: NOT privileged. Own detail visible; other member's hidden.
  const memberView = await billingBreakdown.teamRollup({ team_id: team.id, caller_tenant_id: memberId });
  assert.equal(memberView.privileged, false);
  const oRow2 = memberView.members.find(m => m.tenant_id === ownerId);
  const mRow2 = memberView.members.find(m => m.tenant_id === memberId);
  assert.equal(oRow2.namespaces, null, 'member view: owner detail must be hidden');
  assert.ok(Array.isArray(mRow2.namespaces), 'member view: own detail visible');

  // Caller=non-member: forbidden.
  let err = null;
  try { await billingBreakdown.teamRollup({ team_id: team.id, caller_tenant_id: 'tenant_nonmember' }); }
  catch (e) { err = e; }
  assert.ok(err && err.code === 'forbidden', 'non-member must get forbidden');
});

// =============================================================================
// 6) Route is auth-gated
// =============================================================================

test('W465 #6 — GET /v1/billing/breakdown is auth-gated (401 without auth)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const res = await fetch(`${base}/v1/billing/breakdown`);
    assert.equal(res.status, 401, 'unauthed request must 401');
    const body = await res.json();
    // Either the auth middleware ("missing api key") or the route's
    // defense-in-depth ("auth_required") may fire — both are 401 + non-ok.
    assert.notEqual(body.ok, true, 'unauthed body must not be ok:true');
    assert.ok(
      body.error === 'auth_required' || body.error === 'missing api key' || /api[ _]key/i.test(String(body.error || '')),
      'unauthed body must surface an auth-related error (got: ' + JSON.stringify(body) + ')'
    );
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 7) Route returns by=namespace by default + by=team requires team_id
// =============================================================================

test('W465 #7 — GET /v1/billing/breakdown returns by=namespace envelope + by=team requires team_id', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    // Seed an event for the tenant so the envelope has rows.
    await seedEvent(tenant.id, 'sales', 2_500_000, 25, 50);

    // Default: by=namespace.
    const r1 = await fetch(`${base}/v1/billing/breakdown`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(r1.status, 200);
    const env1 = await r1.json();
    assert.equal(env1.ok, true);
    assert.equal(env1.by, 'namespace');
    assert.equal(env1.tenant_id, tenant.id, 'tenant_id must be forced from auth, not query');
    assert.ok(Array.isArray(env1.namespaces));
    assert.ok(env1.namespaces.length >= 1, 'namespaces array must include the seeded row (got: ' + JSON.stringify(env1.namespaces) + ')');
    const salesRow = env1.namespaces.find(n => n.namespace === 'sales');
    assert.ok(salesRow, 'sales row must be present');
    assert.equal(salesRow.cost_micro_usd, 2_500_000);

    // by=team without team_id → 400.
    const r2 = await fetch(`${base}/v1/billing/breakdown?by=team`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(r2.status, 400);
    const env2 = await r2.json();
    assert.equal(env2.error, 'team_id_required');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 8) Invalid period rejected with 400
// =============================================================================

test('W465 #8 — GET /v1/billing/breakdown rejects invalid period (?period=garbage → 400)', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const tenant = await auth.provisionAnonTenant();
    // Malformed format (slash not dash).
    const r1 = await fetch(`${base}/v1/billing/breakdown?period=garbage`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(r1.status, 400);
    const env1 = await r1.json();
    assert.equal(env1.error, 'invalid_period');
    // Out-of-range month.
    const r2 = await fetch(`${base}/v1/billing/breakdown?period=2026-13`, {
      headers: { authorization: `Bearer ${tenant.api_key}` },
    });
    assert.equal(r2.status, 400);
    const env2 = await r2.json();
    assert.equal(env2.error, 'invalid_period');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 9) Connector capture path threads x-kolm-namespace header through to event row
// =============================================================================

test('W465 #9 — connector capture reads x-kolm-namespace header + stamps it on the event row', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  // The literal regression we are pinning: __connectorProxy used to write
  // `namespace: 'default'` (hardcoded) on every capture. W465 reads the
  // header (or body fallback) and stamps the sanitized slug on:
  //   - the connector-event row (namespace: callerNamespace),
  //   - the bridge insertCapture call (corpus_namespace: callerNamespace),
  //   - the response header (res.set('x-kolm-namespace', callerNamespace)).
  assert.match(router, /const callerNamespace = sanitizeNamespace\(/,
    'connector path must build callerNamespace via sanitizeNamespace');
  assert.match(router, /req\.headers\['x-kolm-namespace'\]/,
    'connector path must read x-kolm-namespace header');
  assert.match(router, /namespace: callerNamespace,\s*\n\s*provider,/,
    'connector event row must use callerNamespace, not literal default');
  assert.match(router, /res\.set\('x-kolm-namespace', callerNamespace\)/,
    'connector response must surface x-kolm-namespace for audit');
  // And the four old hardcoded literals are gone inside __connectorProxy.
  const proxyStart = router.indexOf('async function __connectorProxy(');
  const proxyEnd = router.indexOf('function __connectorFixtureBody');
  assert.ok(proxyStart > 0 && proxyEnd > proxyStart, 'sanity: located __connectorProxy bounds');
  const proxyBody = router.slice(proxyStart, proxyEnd);
  assert.doesNotMatch(proxyBody, /namespace: 'default',/,
    'no hardcoded `namespace: \'default\'` inside __connectorProxy after W465');
  assert.doesNotMatch(proxyBody, /corpus_namespace: 'default',/,
    'no hardcoded `corpus_namespace: \'default\'` inside __connectorProxy after W465');
});

// =============================================================================
// 10) CLI + TUI + sw.js wired correctly
// =============================================================================

test('W465 #10 — CLI wires `kolm billing breakdown` + TUI 16th view + sw.js slug + family-relaxed', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // billing endpoint mapping includes breakdown.
  assert.match(cli, /else if \(sub === 'breakdown'\) endpoint = '\/v1\/billing\/breakdown';/,
    'cmdBilling must route breakdown sub to /v1/billing/breakdown');
  // HELP gained breakdown USAGE line.
  assert.match(cli, /kolm billing breakdown \[--by namespace\|team\]/,
    'HELP.billing must document breakdown USAGE');
  // TUI 16th view defined with id billing-breakdown + key J.
  assert.match(cli, /id: 'billing-breakdown',\s*key: 'J',\s*endpoint: '\/v1\/billing\/breakdown'/,
    'TUI must register billing-breakdown view at key J');
  // VIEW_ALIAS includes :breakdown.
  assert.match(cli, /'breakdown':\s*'billing-breakdown'/,
    ":breakdown alias must map to billing-breakdown");
  // CLI envelope unwrap chain handles `namespaces` + `members`.
  assert.match(cli, /Array\.isArray\(data\.namespaces\)\s*\?\s*data\.namespaces/,
    'TUI loadViewGet must unwrap `namespaces`');
  assert.match(cli, /Array\.isArray\(data\.members\)\s*\?\s*data\.members/,
    'TUI loadViewGet must unwrap team rollup `members`');

  // sw.js cache slug points at W465 family (relaxed past w465 once W466+ lands).
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'sw.js must define CACHE');
  const wm = m[1].match(/wave(\d{3,4})/);
  assert.ok(wm, 'sw.js CACHE slug must include a waveNNN token');
  const n = parseInt(wm[1], 10);
  assert.ok(n >= 465, 'sw.js CACHE slug must reference the W465+ family, got: ' + m[1]);

  // Changelog source-of-truth lists W465 + breakdown route imported in router.
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'src', 'changelog.js'), 'utf8');
  assert.match(changelog, /wave:\s*'W465'/, 'changelog.js must list W465');
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.get\('\/v1\/billing\/breakdown'/,
    'router must wire GET /v1/billing/breakdown');
  assert.match(router, /billingTenantNamespaceBreakdown|tenantNamespaceBreakdown as billingTenantNamespaceBreakdown/,
    'router must import the breakdown helper');
});
