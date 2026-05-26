// Wave 424 — Agent telemetry tenant-scope lock-in.
//
// P0-6 from .agent/docs/w415-outstanding-diffs-from-prior-feedback-2026-05-19.md
// flagged that src/agent-telemetry.js exports (listAgents, listSessions,
// getSession, recommendModel, topFailingPromptShapes, agentTelemetryStats —
// plus inferAcceptance) all read the GLOBAL canonical event-store with no
// tenant filter, and that the /v1/agents/* routes in src/router.js mounted
// those helpers WITHOUT an auth gate. Tenant A asking for /v1/agents/stats
// would see tenant B's total_agent_calls, top_workflows, cost_by_app, etc.
//
// This file pins the W424 closure in three places:
//
//   (a) Static-source: every one of the 7 exported helpers in
//       src/agent-telemetry.js accepts a `tenant_id` parameter (with `= null`
//       default so legacy local callers don't break).
//   (b) Static-source: every one of the 6 /v1/agents/* routes in src/router.js
//       gates on req.tenant_record (401 envelope `{ok:false, error:'auth required'}`)
//       and forwards _tenantScope(req) as `tenant_id` into the helper call.
//   (c) Behavior: seed events for two tenants into the same namespace; assert
//       that each helper, when called with tenant_id A, returns only A's rows
//       — never B's. Also assert HTTP 401 with no api key, and that the api
//       key for tenant A never surfaces tenant B's data.
//
// The tests assert BEHAVIOR (counts, returned rows, status codes) — not page
// copy. Per-test tmpdirs (KOLM_DATA_DIR + HOME) keep the dev box's real
// ~/.kolm untouched. Run with `--test-concurrency=1` to avoid the SQLite
// parallel-test trap (W311 + W319).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function _mkTmp(label = 'w424') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISABLE_RATE_LIMIT: process.env.KOLM_DISABLE_RATE_LIMIT,
    KOLM_DB_PATH: process.env.KOLM_DB_PATH,
    DEFAULT_TENANT: process.env.DEFAULT_TENANT,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Same rationale as W411-T: row store needs 'json' so tenant_record path
  // does not pull node:sqlite in the test box.
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'wave424-agent-telemetry-tenant-scope-32chars';
  process.env.KOLM_DB_PATH = path.join(tmp, 'kolm.sqlite');
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// Seed N events directly into the canonical event-store under a specific
// tenant_id + app_id. Each event has a unique session_id so listSessions can
// observe it.
async function _seedAgentEvents(tenantId, namespace, appId, n) {
  const { appendEvent } = await import('../src/event-store.js');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ev = await appendEvent({
      namespace,
      tenant_id: tenantId,
      app_id: appId,
      session_id: `${tenantId}_sess_${i}`,
      prompt_redacted: `${tenantId} prompt ${i}`,
      response_redacted: `${tenantId} reply ${i}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      estimated_cost_usd: 0.001,
      latency_ms: 42,
      workflow_id: `${tenantId}_wf`,
    });
    ids.push(ev.event_id);
  }
  return ids;
}

async function _bustModuleCache() {
  const ev = await import('../src/event-store.js');
  if (typeof ev._resetForTests === 'function') ev._resetForTests();
}

async function _makeAppTwoTenants() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const tA = provisionAnonTenant({ ttl_days: 1, quota: 100000 });
  const tB = provisionAnonTenant({ ttl_days: 1, quota: 100000 });
  return { app, A: tA, B: tB };
}

function _withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// #1 — Static-source: every one of the 7 exported helpers in
//      src/agent-telemetry.js declares a `tenant_id` parameter. Pinned by
//      reading the file text + matching each export's signature region.
// ---------------------------------------------------------------------------
test('W424 #1 — each of 7 agent-telemetry helpers accepts tenant_id', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'agent-telemetry.js'), 'utf8');

  // For each helper, isolate its signature/body up to the first `await listEvents`
  // (or end-of-function for inferAcceptance) and assert it mentions tenant_id.
  const helpers = [
    'inferAcceptance',
    'listAgents',
    'listSessions',
    'getSession',
    'recommendModel',
    'topFailingPromptShapes',
    'agentTelemetryStats',
  ];

  for (const name of helpers) {
    const re = new RegExp(`export (?:async )?function ${name}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`);
    const m = src.match(re);
    assert.ok(m, `helper ${name} export signature parseable`);
    const sigRegion = m[1] || '';
    // Either the param appears inline in the destructure / arg list, OR the
    // first ~30 lines of the body unpack it from opts.
    const startIdx = (m.index || 0) + m[0].length;
    const body = src.slice(startIdx, startIdx + 1500);
    const found =
      /\btenant_id\b/.test(sigRegion) ||
      /\btenant_id\b/.test(body);
    assert.ok(found, `helper ${name} must accept a tenant_id parameter (W424)`);
  }
});

// ---------------------------------------------------------------------------
// #2 — Static-source: each /v1/agents/* route gates on req.tenant_record and
//      passes tenant_id into the helper. Asserts the literal pattern is
//      present in router.js for all 6 routes.
// ---------------------------------------------------------------------------
test('W424 #2 — each /v1/agents/* route requires req.tenant_record and forwards tenant_id', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');

  const routes = [
    { path: "'/v1/agents'", helper: 'agentListAgents' },
    { path: "'/v1/agents/sessions'", helper: 'agentListSessions' },
    { path: "'/v1/agents/sessions/:id'", helper: 'agentGetSession' },
    { path: "'/v1/agents/recommend'", helper: 'agentRecommendModel' },
    { path: "'/v1/agents/failing'", helper: 'agentTopFailing' },
    { path: "'/v1/agents/stats'", helper: 'agentStats' },
  ];

  for (const route of routes) {
    // Anchor: start at the route declaration; end at the *next* `r.get(`
    // (or end of /v1/agents/* block ending with /v1/lake comment). This gives
    // us the full handler body including the try/catch.
    const startMarker = `r.get(${route.path}, async (req, res) => {`;
    const startIdx = src.indexOf(startMarker);
    assert.ok(startIdx >= 0, `route ${route.path} declaration found`);
    // End: next `r.get(` after this declaration, or the next-section banner.
    const afterStart = startIdx + startMarker.length;
    const nextRoute = src.indexOf('r.get(', afterStart);
    const nextBanner = src.indexOf('// ==============', afterStart);
    const end = Math.min(
      nextRoute > 0 ? nextRoute : Number.MAX_SAFE_INTEGER,
      nextBanner > 0 ? nextBanner : Number.MAX_SAFE_INTEGER,
    );
    const block = src.slice(startIdx, end);

    // (a) auth gate present.
    assert.match(block, /if \(!req\.tenant_record\)/, `${route.path} must gate on req.tenant_record`);
    assert.match(block, /\.status\(401\)/, `${route.path} must return 401`);
    assert.match(block, /auth required/, `${route.path} 401 body must say 'auth required'`);
    assert.match(block, /ok:\s*false/, `${route.path} 401 envelope must be {ok:false}`);
    // (b) helper called with tenant_id: _tenantScope(req).
    assert.ok(
      block.includes(route.helper),
      `${route.path} must call helper ${route.helper}`,
    );
    assert.match(block, /tenant_id:\s*_tenantScope\(req\)/, `${route.path} must forward _tenantScope(req) as tenant_id`);
  }
});

// ---------------------------------------------------------------------------
// #3 — Behavior: two tenants seed events in the same namespace; helper called
//      with tenant_id A returns only A's rows (every helper that reads the
//      store).
// ---------------------------------------------------------------------------
test('W424 #3 — listAgents({tenant_id}) returns only requested tenant', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  await _seedAgentEvents('tenant_A_at', 'ns_at', 'claude-code', 5);
  await _seedAgentEvents('tenant_B_at', 'ns_at', 'cursor', 3);

  const { listAgents } = await import('../src/agent-telemetry.js');

  // Global (no filter) sees both apps.
  const all = await listAgents({});
  const allApps = new Set(all.map(r => r.app_id));
  assert.ok(allApps.has('claude-code'), 'global view sees claude-code');
  assert.ok(allApps.has('cursor'), 'global view sees cursor');

  // tenant A: only claude-code.
  const aOnly = await listAgents({ tenant_id: 'tenant_A_at' });
  assert.equal(aOnly.length, 1, 'A sees only 1 app_id');
  assert.equal(aOnly[0].app_id, 'claude-code');
  assert.equal(aOnly[0].events, 5, 'event count is A\'s 5');

  // tenant B: only cursor.
  const bOnly = await listAgents({ tenant_id: 'tenant_B_at' });
  assert.equal(bOnly.length, 1, 'B sees only 1 app_id');
  assert.equal(bOnly[0].app_id, 'cursor');
  assert.equal(bOnly[0].events, 3, 'event count is B\'s 3');
});

test('W424 #4 — listSessions/getSession/recommend/failing/stats are all tenant-scoped', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  await _seedAgentEvents('tenant_A_sess', 'ns_sess', 'codex', 4);
  await _seedAgentEvents('tenant_B_sess', 'ns_sess', 'codex', 6);

  const at = await import('../src/agent-telemetry.js');

  // listSessions
  const sessA = await at.listSessions({ tenant_id: 'tenant_A_sess' });
  assert.equal(sessA.length, 4, 'A sees only A\'s 4 sessions');
  for (const s of sessA) assert.match(s.session_id, /^tenant_A_sess_/);
  const sessB = await at.listSessions({ tenant_id: 'tenant_B_sess' });
  assert.equal(sessB.length, 6, 'B sees only B\'s 6 sessions');

  // getSession: A's session_id must NOT be visible when scoped to B.
  const aSid = 'tenant_A_sess_sess_0';
  const aHit = await at.getSession({ session_id: aSid, tenant_id: 'tenant_A_sess' });
  assert.ok(aHit, 'A finds its own session');
  assert.equal(aHit.session_id, aSid);
  const aMiss = await at.getSession({ session_id: aSid, tenant_id: 'tenant_B_sess' });
  assert.equal(aMiss, null, 'B cannot see A\'s session by id');

  // recommendModel: candidates only over A's events.
  const recA = await at.recommendModel({ tenant_id: 'tenant_A_sess' });
  assert.equal(recA.candidates.length, 1, 'A has 1 model');
  // Sessions count must be exactly A's (4), not the global 10.
  assert.equal(recA.candidates[0].sessions, 4, 'recommend.candidates sessions count is A-only');

  // topFailingPromptShapes: row count comes from A only.
  const failA = await at.topFailingPromptShapes({ tenant_id: 'tenant_A_sess' });
  const aTotalCount = failA.reduce((sum, r) => sum + r.count, 0);
  assert.equal(aTotalCount, 4, 'topFailing aggregates A\'s 4 rows only');
  const failB = await at.topFailingPromptShapes({ tenant_id: 'tenant_B_sess' });
  const bTotalCount = failB.reduce((sum, r) => sum + r.count, 0);
  assert.equal(bTotalCount, 6, 'topFailing aggregates B\'s 6 rows only');

  // agentTelemetryStats: total_agent_calls is per-tenant.
  const statsA = await at.agentTelemetryStats({ tenant_id: 'tenant_A_sess' });
  assert.equal(statsA.total_agent_calls, 4, 'stats sees A\'s 4 calls only');
  assert.equal(statsA.total_sessions, 4, 'stats sees A\'s 4 sessions only');
  const statsB = await at.agentTelemetryStats({ tenant_id: 'tenant_B_sess' });
  assert.equal(statsB.total_agent_calls, 6, 'stats sees B\'s 6 calls only');
});

// ---------------------------------------------------------------------------
// #5 — HTTP: missing api key -> 401; api key for A surfaces ONLY A's events
//      via /v1/agents and /v1/agents/stats.
// ---------------------------------------------------------------------------
test('W424 #5 — /v1/agents/* requires auth and is scoped to caller\'s tenant_record', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => { _restoreEnv(saved); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  await _bustModuleCache();

  const { app, A, B } = await _makeAppTwoTenants();
  await _seedAgentEvents(A.id, 'ns_http_agents', 'claude-code', 4);
  await _seedAgentEvents(B.id, 'ns_http_agents', 'cursor', 7);

  await _withServer(app, async (base) => {
    // No api key -> 401 on every /v1/agents/* route. (The global
    // /v1/* auth middleware short-circuits before our per-route
    // `if (!req.tenant_record)` gate, returning {error:'missing api key'}.
    // The per-route gate added in W424 is a defense-in-depth check
    // exercised when an admin key reaches the handler without a
    // tenant_record stamped — pinned by static-source assertion #2.)
    const routes = [
      '/v1/agents',
      '/v1/agents/sessions',
      '/v1/agents/sessions/sess_anything',
      '/v1/agents/recommend',
      '/v1/agents/failing',
      '/v1/agents/stats',
    ];
    for (const r of routes) {
      const res = await fetch(base + r);
      assert.equal(res.status, 401, `${r} requires auth`);
      const body = await res.json();
      assert.ok(typeof body.error === 'string' && body.error.length > 0, `${r} 401 has error string`);
    }

    // Tenant A: /v1/agents shows ONLY claude-code (4 events).
    const ra = await fetch(base + '/v1/agents', { headers: { authorization: 'Bearer ' + A.api_key } });
    assert.equal(ra.status, 200);
    const aBody = await ra.json();
    assert.equal(aBody.ok, true);
    assert.equal(aBody.agents.length, 1, 'A sees 1 agent');
    assert.equal(aBody.agents[0].app_id, 'claude-code');
    assert.equal(aBody.agents[0].events, 4, 'A sees 4 events (not 11)');

    // Tenant B independently sees ONLY cursor (7 events).
    const rb = await fetch(base + '/v1/agents', { headers: { authorization: 'Bearer ' + B.api_key } });
    const bBody = await rb.json();
    assert.equal(bBody.agents.length, 1, 'B sees 1 agent');
    assert.equal(bBody.agents[0].app_id, 'cursor');
    assert.equal(bBody.agents[0].events, 7);

    // /v1/agents/stats: per-tenant total_agent_calls.
    const sA = await fetch(base + '/v1/agents/stats', { headers: { authorization: 'Bearer ' + A.api_key } });
    const sABody = await sA.json();
    assert.equal(sABody.total_agent_calls, 4, 'stats: A\'s call count');

    const sB = await fetch(base + '/v1/agents/stats', { headers: { authorization: 'Bearer ' + B.api_key } });
    const sBBody = await sB.json();
    assert.equal(sBBody.total_agent_calls, 7, 'stats: B\'s call count');
  });
});
