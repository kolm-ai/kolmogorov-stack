// S7 Trust Center + shareable Trust Link analytics tests.
//
// Module-level integration against an isolated JSON store (no spawned server):
// env is set before any store-touching import, then everything is dynamically
// imported. Covers the invariants the Trust Center depends on:
//   * a view hashes the IP (the raw IP is NEVER stored) and keeps only the
//     referer host + a truncated UA;
//   * listing is tenant-fenced (a seller never sees another tenant's views) and
//     summarize rolls up views / unique viewers / first+last;
//   * the optional gate unlock flow (email + accept-terms) mints + verifies a
//     token, and a gate can only be set by the slug's owner;
//   * every exported function NEVER throws on bad input;
//   * the routes: /views is auth + tenant-fenced (404 cross-tenant, 401 no key),
//     /unlock is public;
//   * renderTrustCenterIndex is ASCII, HTML-escapes, and avoids the banned word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-trustcenter-test-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';

const { insert, findByField } = await import('../src/store.js');
const tc = await import('../src/trust-center.js');
const {
  recordTrustView,
  listTrustViews,
  summarizeTrustViews,
  resolveSlugOwner,
  createTrustGate,
  getTrustGate,
  removeTrustGate,
  recordTrustUnlock,
  verifyTrustUnlock,
  listTrustUnlocks,
  listTrustCenter,
  renderTrustCenterIndex,
  register,
  TRUST_CENTER_VERSION,
} = tc;

// --- helpers ---------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }

// Seed an owning agent_audits row so resolveSlugOwner maps slug -> tenant.
function seedAuditOwner(tenant, slug, subject = 'Acme agents') {
  insert('agent_audits', {
    id: 'audses_' + slug,
    tenant_id: tenant,
    subject,
    source: 'import',
    status: 'complete',
    paid: true,
    public: true,
    public_slug: slug,
    report: { tier: 'report', report_id: 'rep_' + slug },
    report_id: 'rep_' + slug,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function seedSubscriptionOwner(tenant, slug, product = 'starter') {
  insert('asr_subscriptions', {
    id: 'asrsub_' + slug,
    tenant_id: tenant,
    product_key: product,
    status: 'active',
    public_slug: slug,
    latest_audit_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function isAscii(str) {
  for (let i = 0; i < str.length; i += 1) if (str.charCodeAt(i) > 127) return false;
  return true;
}

// Minimal Express-shaped router + req/res harness for route tests.
function makeRouter() {
  const routes = { GET: {}, POST: {} };
  return {
    get(p, ...h) { routes.GET[p] = h; return this; },
    post(p, ...h) { routes.POST[p] = h; return this; },
    _routes: routes,
  };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, _ended: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  res.json = (o) => { res.body = o; res._ended = true; return res; };
  res.send = (s) => { res.body = s; res._ended = true; return res; };
  return res;
}
async function invoke(router, method, p, req) {
  const handlers = router._routes[method][p];
  assert.ok(handlers, `route ${method} ${p} not registered`);
  const res = makeRes();
  let i = 0;
  const next = async () => {
    if (res._ended) return;
    const h = handlers[i++];
    if (!h) return;
    await h(req, res, next);
  };
  await next();
  return res;
}

// ===========================================================================

test('recordTrustView hashes the IP (never stores raw), keeps referer host + truncated ua', () => {
  const TENANT = 'tenant_view_a';
  const SLUG = 'slugviewa01';
  seedAuditOwner(TENANT, SLUG);

  const RAW_IP = '203.0.113.77';
  const out = recordTrustView({
    slug: SLUG,
    ip: RAW_IP,
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    referer: 'https://buyer.example.com/procurement/review?token=secret',
    now: '2026-06-01T10:00:00.000Z',
  });
  assert.ok(out.ok, 'view recorded');
  assert.equal(out.view.slug, SLUG);
  assert.equal(out.view.tenant_id, TENANT, 'owner tenant resolved from slug');
  assert.equal(out.view.ts, '2026-06-01T10:00:00.000Z');

  // hashed, never raw
  assert.match(out.view.ip_hash, /^[0-9a-f]{64}$/, 'ip_hash is a sha256 hex digest');
  assert.notEqual(out.view.ip_hash, RAW_IP);
  assert.ok(!JSON.stringify(out.view).includes(RAW_IP), 'raw IP never appears in the stored row');

  // referer reduced to host only (path + query dropped)
  assert.equal(out.view.referer_host, 'buyer.example.com');
  assert.ok(!String(out.view.referer_host).includes('secret'));

  // ua preserved (cleaned)
  assert.match(out.view.ua, /Mozilla\/5\.0/);

  // persisted exactly once
  const rows = findByField('trust_views', 'slug', SLUG);
  assert.equal(rows.length, 1);
});

test('recordTrustView re-hashes an already-hashed ip_hash input (raw never persisted) + truncates ua', () => {
  const SLUG = 'slugviewhash';
  seedAuditOwner('tenant_view_h', SLUG);
  const longUa = 'A'.repeat(5000);
  const out = recordTrustView({ slug: SLUG, ip_hash: '198.51.100.9', ua: longUa });
  assert.ok(out.ok);
  assert.match(out.view.ip_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(out.view).includes('198.51.100.9'), 'value passed as ip_hash is still re-hashed, never stored raw');
  assert.ok(out.view.ua.length <= 256, 'ua truncated to 256');
});

test('listTrustViews is tenant-fenced; cross-tenant cannot read another seller views', () => {
  const A = 'tenant_fence_a';
  const B = 'tenant_fence_b';
  const SA = 'slugfenceA';
  const SB = 'slugfenceB';
  seedAuditOwner(A, SA);
  seedAuditOwner(B, SB);

  recordTrustView({ slug: SA, ip: '10.0.0.1', now: '2026-06-01T00:00:01Z' });
  recordTrustView({ slug: SA, ip: '10.0.0.2', now: '2026-06-01T00:00:02Z' });
  recordTrustView({ slug: SB, ip: '10.0.0.3', now: '2026-06-01T00:00:03Z' });

  const aViews = listTrustViews(A);
  assert.equal(aViews.length, 2, 'A sees only its own 2 views');
  assert.ok(aViews.every((v) => v.tenant_id === A));

  // A asking for B's slug gets nothing (rows are fenced by tenant)
  assert.equal(listTrustViews(A, SB).length, 0, 'A cannot read B slug views');
  assert.equal(listTrustViews(B, SB).length, 1, 'B sees its own slug view');

  // missing tenant -> []
  assert.deepEqual(listTrustViews(null), []);

  // newest-first ordering
  const ordered = listTrustViews(A, SA);
  assert.ok(ordered[0].ts >= ordered[1].ts);
});

test('summarizeTrustViews rolls up views, unique viewers, first + last', () => {
  const SLUG = 'slugsummary';
  seedAuditOwner('tenant_sum', SLUG);
  recordTrustView({ slug: SLUG, ip: '1.1.1.1', now: '2026-06-02T08:00:00Z' });
  recordTrustView({ slug: SLUG, ip: '1.1.1.1', now: '2026-06-02T09:00:00Z' }); // same viewer
  recordTrustView({ slug: SLUG, ip: '2.2.2.2', now: '2026-06-02T07:00:00Z' }); // earliest

  const s = summarizeTrustViews(SLUG);
  assert.equal(s.views, 3);
  assert.equal(s.unique_viewers, 2, 'dedupes by hashed viewer');
  assert.equal(s.first_view, '2026-06-02T07:00:00.000Z');
  assert.equal(s.last_view, '2026-06-02T09:00:00.000Z');

  // unknown slug -> zeroed summary
  assert.deepEqual(summarizeTrustViews('does_not_exist'), { views: 0, unique_viewers: 0, first_view: null, last_view: null });
});

test('resolveSlugOwner resolves audit + subscription slugs, null otherwise', () => {
  seedAuditOwner('tenant_ro', 'slugresolveaud');
  seedSubscriptionOwner('tenant_rs', 'slugresolvesub');
  assert.equal(resolveSlugOwner('slugresolveaud').tenant_id, 'tenant_ro');
  assert.equal(resolveSlugOwner('slugresolveaud').kind, 'report');
  assert.equal(resolveSlugOwner('slugresolvesub').tenant_id, 'tenant_rs');
  assert.equal(resolveSlugOwner('slugresolvesub').kind, 'continuous');
  assert.equal(resolveSlugOwner('nope_nope'), null);
  assert.equal(resolveSlugOwner(null), null);
});

test('gate unlock flow: email + accept-terms required, token minted + verifiable', () => {
  const TENANT = 'tenant_gate';
  const SLUG = 'sluggate01';
  seedAuditOwner(TENANT, SLUG);

  // off by default
  assert.equal(getTrustGate(SLUG), null, 'no gate by default (link open)');

  const cg = createTrustGate({ slug: SLUG, tenant_id: TENANT, require_email: true, nda_text: 'You agree to keep this confidential.' });
  assert.ok(cg.ok);
  const gate = getTrustGate(SLUG);
  assert.ok(gate && gate.require_email === true);

  // missing email -> email_required
  const u0 = recordTrustUnlock({ slug: SLUG });
  assert.equal(u0.ok, false);
  assert.equal(u0.reason, 'email_required');

  // email but no accepted terms (nda present) -> terms_required
  const u1 = recordTrustUnlock({ slug: SLUG, email: 'buyer@acme.test' });
  assert.equal(u1.ok, false);
  assert.equal(u1.reason, 'terms_required');

  // bad email shape -> email_required
  assert.equal(recordTrustUnlock({ slug: SLUG, email: 'not-an-email', accepted_terms: true }).reason, 'email_required');

  // full unlock -> token
  const u2 = recordTrustUnlock({ slug: SLUG, email: 'Buyer@Acme.Test', accepted_terms: true, ip: '9.9.9.9' });
  assert.ok(u2.ok && u2.gated === true);
  assert.match(u2.token, /^tul_[0-9a-f]{48}$/);

  // verify the token
  const v = verifyTrustUnlock(SLUG, u2.token);
  assert.ok(v.ok);
  assert.equal(v.unlock.email, 'buyer@acme.test', 'email normalized lowercase');
  assert.ok(!JSON.stringify(v.unlock).includes('9.9.9.9'), 'unlock ip is hashed too');

  // wrong token / wrong slug -> not ok
  assert.equal(verifyTrustUnlock(SLUG, 'tul_deadbeef').ok, false);
  assert.equal(verifyTrustUnlock('other_slug', u2.token).ok, false);

  // captured lead is tenant-fenced
  const leads = listTrustUnlocks(TENANT, SLUG);
  assert.ok(leads.length >= 1);
  assert.ok(leads.every((l) => l.tenant_id === TENANT));
  assert.equal(listTrustUnlocks('tenant_other', SLUG).length, 0);
});

test('unlock on an OPEN link (no gate) still succeeds and captures the lead', () => {
  const SLUG = 'slugopenlink';
  seedAuditOwner('tenant_open', SLUG);
  const u = recordTrustUnlock({ slug: SLUG, email: 'lead@buyer.test' });
  assert.ok(u.ok);
  assert.equal(u.gated, false, 'no gate -> open, but lead captured');
  assert.match(u.token, /^tul_/);
});

test('createTrustGate is owner-fenced: a non-owner cannot gate another tenant slug; removeTrustGate disables', () => {
  const OWNER = 'tenant_owner';
  const SLUG = 'slugownergate';
  seedAuditOwner(OWNER, SLUG);

  const bad = createTrustGate({ slug: SLUG, tenant_id: 'tenant_attacker', require_email: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'not_owner');
  assert.equal(getTrustGate(SLUG), null, 'no gate was created by the non-owner');

  assert.ok(createTrustGate({ slug: SLUG, tenant_id: OWNER }).ok);
  assert.ok(getTrustGate(SLUG));

  // idempotent update keeps a single enabled gate
  assert.ok(createTrustGate({ slug: SLUG, tenant_id: OWNER, nda_text: 'updated' }).ok);
  assert.equal(findByField('trust_gates', 'slug', SLUG).filter((g) => g.enabled !== false).length, 1);

  // disable reverts to open (tenant-fenced: attacker cannot)
  assert.equal(removeTrustGate({ slug: SLUG, tenant_id: 'tenant_attacker' }).disabled, 0);
  assert.ok(removeTrustGate({ slug: SLUG, tenant_id: OWNER }).disabled >= 1);
  assert.equal(getTrustGate(SLUG), null, 'gate disabled -> link open again');
});

test('every exported function NEVER throws on bad / empty input', () => {
  assert.doesNotThrow(() => {
    assert.equal(recordTrustView().ok, false);
    assert.equal(recordTrustView({}).ok, false);
    assert.equal(recordTrustView({ slug: '' }).ok, false);
    assert.deepEqual(listTrustViews(), []);
    assert.deepEqual(listTrustViews(undefined, undefined), []);
    assert.deepEqual(summarizeTrustViews(), { views: 0, unique_viewers: 0, first_view: null, last_view: null });
    assert.deepEqual(summarizeTrustViews(null), { views: 0, unique_viewers: 0, first_view: null, last_view: null });
    assert.equal(resolveSlugOwner(), null);
    assert.equal(createTrustGate().ok, false);
    assert.equal(createTrustGate({ slug: 'x' }).ok, false);
    assert.equal(getTrustGate(), null);
    assert.equal(removeTrustGate().ok, false);
    assert.equal(recordTrustUnlock().ok, false);
    assert.equal(recordTrustUnlock({}).ok, false);
    assert.equal(verifyTrustUnlock().ok, false);
    assert.deepEqual(listTrustUnlocks(), []);
    assert.deepEqual(listTrustCenter(), []);
    assert.equal(typeof renderTrustCenterIndex(), 'string');
    assert.equal(typeof renderTrustCenterIndex(null), 'string');
    assert.equal(typeof renderTrustCenterIndex('garbage'), 'string');
  });
});

test('GET /v1/trust/:slug/views: auth + tenant fence (200 owner, 404 cross-tenant, 401 no key)', async () => {
  const A = 'tenant_route_a';
  const B = 'tenant_route_b';
  const SA = 'slugrouteA';
  const SB = 'slugrouteB';
  seedAuditOwner(A, SA);
  seedAuditOwner(B, SB);
  recordTrustView({ slug: SA, ip: '5.5.5.5', now: '2026-06-03T00:00:00Z' });

  // deps.authMiddleware injects req.tenant_record then calls next.
  const authAs = (tenantId) => (req, _res, next) => { req.tenant_record = { id: tenantId }; next(); };

  // owner sees views
  const routerA = makeRouter();
  register(routerA, { authMiddleware: authAs(A) });
  const okRes = await invoke(routerA, 'GET', '/v1/trust/:slug/views', { params: { slug: SA }, query: {} });
  assert.equal(okRes.statusCode, 200);
  assert.ok(okRes.body.ok);
  assert.equal(okRes.body.summary.views, 1);
  assert.equal(okRes.body.views.length, 1);
  assert.match(okRes.body.views[0].viewer_hash, /^[0-9a-f]{64}$/, 'timeline exposes the hash, not a raw IP');
  assert.ok(!('ip' in okRes.body.views[0]));

  // cross-tenant -> 404 (never confirm another tenant slug exists)
  const cross = await invoke(routerA, 'GET', '/v1/trust/:slug/views', { params: { slug: SB }, query: {} });
  assert.equal(cross.statusCode, 404);

  // no auth -> 401 (handler reads req.tenant_record; here we do not set it)
  const routerNoAuth = makeRouter();
  register(routerNoAuth); // no authMiddleware
  const unauth = await invoke(routerNoAuth, 'GET', '/v1/trust/:slug/views', { params: { slug: SA }, query: {} });
  assert.equal(unauth.statusCode, 401);
});

test('POST /v1/trust/:slug/unlock is public: open link returns a token; gated requires email (400)', async () => {
  const SLUG_OPEN = 'slugrouteopen';
  const SLUG_GATED = 'slugroutegated';
  seedAuditOwner('tenant_unlock', SLUG_OPEN);
  seedAuditOwner('tenant_unlock', SLUG_GATED);
  createTrustGate({ slug: SLUG_GATED, tenant_id: 'tenant_unlock', require_email: true });

  const router = makeRouter();
  register(router);

  // open link: token issued, gated:false, no auth needed
  const open = await invoke(router, 'POST', '/v1/trust/:slug/unlock', {
    params: { slug: SLUG_OPEN }, body: { email: 'x@y.test' }, headers: { 'user-agent': 'curl/8', referer: 'https://ref.test/p' },
  });
  assert.equal(open.statusCode, 200);
  assert.ok(open.body.ok && open.body.token);
  assert.equal(open.body.gated, false);

  // gated link, missing email -> 400 email_required
  const denied = await invoke(router, 'POST', '/v1/trust/:slug/unlock', {
    params: { slug: SLUG_GATED }, body: {}, headers: {},
  });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.body.error, 'email_required');

  // gated link, with email -> 200 token
  const ok = await invoke(router, 'POST', '/v1/trust/:slug/unlock', {
    params: { slug: SLUG_GATED }, body: { email: 'buyer@firm.test', accept_terms: 'true' }, headers: {},
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.body.token);
});

test('listTrustCenter aggregates the tenant published links with view counts', () => {
  const T = 'tenant_center';
  seedAuditOwner(T, 'slugcenter1', 'Fleet A');
  seedSubscriptionOwner(T, 'slugcenter2');
  recordTrustView({ slug: 'slugcenter1', ip: '7.7.7.7' });
  recordTrustView({ slug: 'slugcenter1', ip: '8.8.8.8' });

  const reports = listTrustCenter(T);
  assert.ok(reports.length >= 2);
  const r1 = reports.find((r) => r.slug === 'slugcenter1');
  assert.equal(r1.views, 2);
  assert.equal(r1.kind, 'report');
  assert.ok(String(r1.trust_url).endsWith('/v1/trust/slugcenter1'));

  // another tenant sees none of these
  assert.equal(listTrustCenter('tenant_center_other').length, 0);
});

test('renderTrustCenterIndex is ASCII, HTML-escapes, omits the banned word, has no em/en dashes', () => {
  // empty state
  const empty = renderTrustCenterIndex([]);
  assert.ok(isAscii(empty));
  assert.match(empty, /Trust Center/);
  assert.match(empty, /No published Trust Links/);

  // populated + XSS-shaped subject
  const html = renderTrustCenterIndex([
    { slug: 'abc', subject: '<script>alert(1)</script>', kind: 'report', views: 5, unique_viewers: 3, last_view: '2026-06-04T12:30:00.000Z', trust_url: 'https://kolm.ai/v1/trust/abc', gated: true },
    { slug: 'def', subject: 'Beta fleet', kind: 'continuous', views: 1, unique_viewers: 1, last_view: null, trust_url: 'https://kolm.ai/v1/trust/def' },
  ]);
  assert.ok(isAscii(html), 'output is pure ASCII');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'subject is HTML-escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, />5</, 'view count rendered');
  assert.match(html, /gated/);
  assert.match(html, /never/, 'null last_view renders as never');
  assert.ok(!/[\u2014\u2013]/.test(html), 'no em or en dashes');
  assert.ok(!/honest/i.test(html), 'banned word absent');
});

test('register throws on an invalid router; SPEC + version are exported', () => {
  assert.throws(() => register(null), /router with get\/post required/);
  assert.throws(() => register({ get() {} }), /router with get\/post required/);
  assert.equal(TRUST_CENTER_VERSION, 'kolm-trust-center-v1');
  assert.ok(Array.isArray(tc.TRUST_CENTER_SPEC.routes));
});

test('cleanup', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
