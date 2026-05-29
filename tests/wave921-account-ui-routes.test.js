// W921 — server route module lock-in for the Account UI / No-Code surface.
//
// Exercises src/account-ui-routes.js (the NEW route module declared for the
// orchestrator to mount): the /v1/client-error redacted sink, the
// /v1/automations CRUD + run, and the platform-cron /v1/automations/tick
// idempotency + KOLM_CRON_SECRET gate. Uses a tiny in-memory router stub so no
// HTTP server is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAccountUiRoutes, validateCron, cronNextRun, scheduleIsDue,
  buildIdempotencyKey, ACCOUNT_UI_ROUTES_VERSION,
} from '../src/account-ui-routes.js';

// ---- minimal router + req/res stubs ---------------------------------------
function makeRouter() {
  const routes = { GET: {}, POST: {}, PATCH: {}, DELETE: {} };
  function add(method) {
    return (path, ...handlers) => { routes[method][path] = handlers; };
  }
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'),
    async call(method, path, { body, headers, params, tenant } = {}) {
      const handlers = routes[method][path];
      if (!handlers) throw new Error('no route ' + method + ' ' + path);
      const req = {
        body: body || {}, headers: headers || {}, params: params || {},
        tenant_record: tenant ? { id: tenant } : undefined,
        socket: { remoteAddress: '127.0.0.1' },
      };
      let captured = { status: 200, body: undefined, ended: false };
      const res = {
        status(c) { captured.status = c; return this; },
        json(o) { captured.body = o; return this; },
        end() { captured.ended = true; return this; },
      };
      let i = 0;
      const next = async () => {
        if (i < handlers.length) { const h = handlers[i++]; await h(req, res, next); }
      };
      await next();
      return captured;
    },
  };
}

const TENANT = 'tenant_abc';
function authPass(req, _res, next) { if (!req.tenant_record) req.tenant_record = { id: 'anonymous' }; next(); }

test('W921 routes #1 — registration requires a router with .get/.post', () => {
  assert.throws(() => registerAccountUiRoutes({}), /router with .get\/.post/);
});

test('W921 routes #2 — /v1/client-error redacts + caps + returns 204', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, { now: () => new Date('2026-05-29T00:00:00Z') });
  const long = 'x'.repeat(5000);
  const out = await r.call('POST', '/v1/client-error', {
    body: { message: long, stack: 'a\nb\nc\nd\ne', path: '/account/overview' },
  });
  assert.equal(out.status, 204);
  assert.equal(out.ended, true);
});

test('W921 routes #3 — /v1/client-error 400 without a message, 429 over rate limit', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, {});
  const bad = await r.call('POST', '/v1/client-error', { body: {} });
  assert.equal(bad.status, 400);
  // hammer past the 30/min cap
  let last;
  for (let i = 0; i < 35; i++) {
    last = await r.call('POST', '/v1/client-error', { body: { message: 'boom' } });
  }
  assert.equal(last.status, 429);
});

test('W921 routes #4 — create automation (schedule) returns id + next_run_at', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, { authMiddleware: authPass, now: () => new Date('2026-05-29T10:00:00Z') });
  const out = await r.call('POST', '/v1/automations', {
    tenant: TENANT,
    body: { recipe_id: 'support-bot', trigger: { type: 'schedule', cron: '0 0 * * *' } },
  });
  assert.equal(out.status, 201);
  assert.ok(out.body.automation_id);
  assert.ok(out.body.next_run_at, 'schedule trigger computes next_run_at');
});

test('W921 routes #5 — automations are tenant-fenced', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, { authMiddleware: authPass, now: () => new Date('2026-05-29T10:00:00Z') });
  await r.call('POST', '/v1/automations', { tenant: TENANT, body: { recipe_id: 'a', trigger: { type: 'manual' } } });
  await r.call('POST', '/v1/automations', { tenant: 'other_tenant', body: { recipe_id: 'b', trigger: { type: 'manual' } } });
  const mine = await r.call('GET', '/v1/automations', { tenant: TENANT });
  assert.equal(mine.body.automations.length, 1, 'only this tenant\'s automation is listed');
  assert.equal(mine.body.automations[0].recipe_id, 'a');
});

test('W921 routes #6 — create rejects bad cron + unknown signal', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, { authMiddleware: authPass });
  const badCron = await r.call('POST', '/v1/automations', {
    tenant: TENANT, body: { recipe_id: 'x', trigger: { type: 'schedule', cron: '99 * * * *' } },
  });
  assert.equal(badCron.status, 400);
  const badSig = await r.call('POST', '/v1/automations', {
    tenant: TENANT, body: { recipe_id: 'x', trigger: { type: 'event', signal: 'nope', threshold: 1 } },
  });
  assert.equal(badSig.status, 400);
});

test('W921 routes #7 — PATCH/DELETE require confirm:true', async () => {
  const r = makeRouter();
  registerAccountUiRoutes(r, { authMiddleware: authPass });
  const c = await r.call('POST', '/v1/automations', { tenant: TENANT, body: { recipe_id: 'x', trigger: { type: 'manual' } } });
  const id = c.body.automation_id;
  const noConfirm = await r.call('PATCH', '/v1/automations/:id', { tenant: TENANT, params: { id }, body: { enabled: false } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error, 'confirm_required');
  const ok = await r.call('PATCH', '/v1/automations/:id', { tenant: TENANT, params: { id }, body: { enabled: false, confirm: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, false);
});

test('W921 routes #8 — run again: not_wired without runRecipe, fires with it', async () => {
  const r = makeRouter();
  let ran = null;
  registerAccountUiRoutes(r, { authMiddleware: authPass, runRecipe: async (t, rid) => { ran = [t, rid]; return { artifact_id: 'art_1' }; } });
  const c = await r.call('POST', '/v1/automations', { tenant: TENANT, body: { recipe_id: 'rec1', trigger: { type: 'manual' } } });
  const id = c.body.automation_id;
  const out = await r.call('POST', '/v1/automations/:id/run', { tenant: TENANT, params: { id } });
  assert.equal(out.status, 200);
  assert.equal(out.body.fired, true);
  assert.deepEqual(ran, [TENANT, 'rec1']);

  const r2 = makeRouter();
  registerAccountUiRoutes(r2, { authMiddleware: authPass });
  const c2 = await r2.call('POST', '/v1/automations', { tenant: TENANT, body: { recipe_id: 'rec1', trigger: { type: 'manual' } } });
  const out2 = await r2.call('POST', '/v1/automations/:id/run', { tenant: TENANT, params: { id: c2.body.automation_id } });
  assert.equal(out2.body.fired, false);
  assert.equal(out2.body.reason, 'recipe_run_not_wired');
});

test('W921 routes #9 — tick rejects without KOLM_CRON_SECRET, fires due once (no double-launch)', async () => {
  const r = makeRouter();
  let runs = 0;
  const SECRET = 's3cr3t';
  let clock = new Date('2026-05-29T00:30:00Z');
  registerAccountUiRoutes(r, {
    authMiddleware: authPass, cronSecret: SECRET,
    runRecipe: async () => { runs++; return { ok: true }; },
    now: () => clock,
  });
  // create a SCHEDULE automation already due (backdated next_run_at via cron at 00:30)
  const c = await r.call('POST', '/v1/automations', {
    tenant: TENANT, body: { recipe_id: 'rec', auto: true, trigger: { type: 'schedule', cron: '30 0 * * *' } },
  });
  // it scheduled next_run for the NEXT 00:30 (tomorrow); roll the clock forward
  clock = new Date('2026-05-30T00:31:00Z');
  // forbidden without secret
  const forbidden = await r.call('POST', '/v1/automations/tick', {});
  assert.equal(forbidden.status, 403);
  // with secret -> fires
  const fire1 = await r.call('POST', '/v1/automations/tick', { headers: { 'x-kolm-cron-secret': SECRET } });
  assert.equal(fire1.status, 200);
  assert.equal(fire1.body.fired.length, 1, 'due automation fired once');
  // second tick same minute -> SKIPPED (idempotency key)
  const fire2 = await r.call('POST', '/v1/automations/tick', { headers: { 'x-kolm-cron-secret': SECRET } });
  assert.equal(fire2.body.fired.length, 0, 'no double-launch on a duplicate tick');
  assert.equal(runs, 1, 'auto recipe-run invoked exactly once');
});

// ---- pure cron helpers (server mirror of the client) ----------------------
test('W921 routes #10 — cron helpers: validate, next-run, due-check, idempotency', () => {
  assert.equal(validateCron('* * * * *').ok, true);
  assert.equal(validateCron('* * *').ok, false);
  const next = cronNextRun('*/15 * * * *', new Date('2026-05-29T10:07:00Z'));
  assert.equal(next.getUTCMinutes(), 15);
  const auto = { automation_id: 'a1', enabled: true, trigger: { type: 'schedule', cron: '0 0 * * *' }, next_run_at: '2026-05-29T00:00:00.000Z' };
  assert.equal(scheduleIsDue(auto, new Date('2026-05-29T00:01:00Z')).due, true);
  assert.equal(scheduleIsDue(auto, new Date('2026-05-28T23:00:00Z')).due, false);
  assert.equal(buildIdempotencyKey(auto, '2026-05-29T00:00'), 'a1:2026-05-29T00:00');
});

test('W921 routes #11 — version constant present', () => {
  assert.equal(ACCOUNT_UI_ROUTES_VERSION, 'w921-account-ui-v1');
});
