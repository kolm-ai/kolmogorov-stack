// W409y — real billing-units metering test battery.
//
// Boots buildRouter() in-process and asserts the 10 W409y billing units are
// metered correctly:
//
//   1. Local-only mode (no api key, no x-kolm-hosted opt-in) → NO usage events fire
//   2. One hosted /v1/chat/completions call → hosted_inference incremented by token count
//   3. One build → builds incremented
//   4. Hitting hard cap → 429 returned + structured body
//   5. Soft cap → x-kolm-quota-warning header set
//   6. /v1/billing/usage returns current period usage map
//   7. Tier check: Team tier has higher cap than Indie
//
// Tests assert HTTP responses + counter values (behavior, not page copy).
//
// Harness pattern mirrors wave409h: provisionTenant → buildRouter →
// app.listen(0) → fetch. KOLM_CONNECTOR_FIXTURE=1 forces the connector
// proxy to return deterministic chat-completion envelopes so the assertions
// over token counts (prompt_tokens=4 + completion_tokens=6 = 10) are stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409y-'));
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
}

function snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_USAGE_DIR: process.env.KOLM_USAGE_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_CONNECTOR_FIXTURE: process.env.KOLM_CONNECTOR_FIXTURE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    KOLM_HOSTED_INFERENCE: process.env.KOLM_HOSTED_INFERENCE,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
  };
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.KOLM_USAGE_DIR = path.join(home, '.kolm', 'usage');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_CONNECTOR_FIXTURE = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.KOLM_HOSTED_INFERENCE;
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'w409y-test-secret-32-chars-minimum-len';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(process.env.KOLM_USAGE_DIR, { recursive: true });
}

async function makeAppAndTenant({ plan = 'indie' } = {}) {
  // Late binding (after env vars are set) so router.js picks up KOLM_USAGE_DIR.
  const { buildRouter } = await import('../src/router.js');
  const { provisionTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const name = `w409y-${plan}-` + Math.random().toString(36).slice(2, 8);
  const t = provisionTenant(name, { plan, quota: 1_000_000, kind: 'user', email: name + '@example.com' });
  return { app, apiKey: t.api_key, tenantId: t.id, plan };
}

async function makeAnonAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 50000 });
  return { app, apiKey: t.api_key, tenantId: t.id };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const realPort = server.address().port;
        const out = await fn(`http://127.0.0.1:${realPort}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// Read the per-period usage JSON for a tenant. Returns {} if no file exists
// (which is the expected state for un-metered callers).
function readTenantUsage(tenantId) {
  const dir = process.env.KOLM_USAGE_DIR;
  if (!dir || !fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter(f => /^period_\d{4}-\d{2}\.json$/.test(f));
  let agg = {};
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const tt = (j && j.tenants && j.tenants[tenantId]) || {};
      for (const [k, v] of Object.entries(tt)) agg[k] = (agg[k] || 0) + Number(v || 0);
    } catch (_) {}
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Test 1 — Local-only mode (no api key, no hosted opt-in) → no usage events fire.
// ---------------------------------------------------------------------------
test('W409y #1 — local-only mode (no key, no hosted opt-in) does NOT fire usage events', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant({ plan: 'indie' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello world' }],
        }),
      });
      assert.equal(r.status, 200, `expected 200 from fixture connector, got ${r.status}`);
      // Drain so the keep-alive socket releases cleanly on Windows.
      await r.text();
    });

    // No usage file should have been written for any real tenant — the
    // connector proxy stamps tenant_id='local' which shouldMeter() blocks.
    const dir = process.env.KOLM_USAGE_DIR;
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => /^period_\d{4}-\d{2}\.json$/.test(f));
      for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // The 'local' synthetic tenant MUST NOT appear.
        assert.ok(!j.tenants || !j.tenants.local,
          `privacy promise violated: 'local' tenant was metered (${f}: ${JSON.stringify(j.tenants && j.tenants.local || {})})`);
      }
    }
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — One hosted /v1/chat/completions call → hosted_inference incremented.
// ---------------------------------------------------------------------------
test('W409y #2 — hosted /v1/chat/completions increments hosted_inference by token count', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant({ plan: 'indie' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'x-kolm-hosted': 'true',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
      const body = await r.json();
      // Fixture returns prompt_tokens=4 + completion_tokens=6 = 10.
      const usage = body && body.usage;
      assert.ok(usage, `expected usage{} in response body, got: ${JSON.stringify(body).slice(0, 300)}`);
      assert.equal(usage.prompt_tokens, 4);
      assert.equal(usage.completion_tokens, 6);
    });

    const tu = readTenantUsage(tenantId);
    assert.equal(tu.hosted_inference, 10,
      `expected hosted_inference=10 (4+6 fixture tokens), got ${tu.hosted_inference} — usage map: ${JSON.stringify(tu)}`);
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — One /v1/compile call → builds incremented.
// ---------------------------------------------------------------------------
test('W409y #3 — /v1/compile increments builds by 1', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant({ plan: 'indie' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/compile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          task: 'classify SMS messages as spam or not spam',
          examples: [
            { input: 'WIN FREE $$$', output: 'spam' },
            { input: 'hi mom', output: 'not_spam' },
          ],
        }),
      });
      assert.ok(r.status === 202 || r.status === 200,
        `expected 200/202 from /v1/compile, got ${r.status}: ${await r.text()}`);
    });

    const tu = readTenantUsage(tenantId);
    assert.equal(tu.builds, 1,
      `expected builds=1, got ${tu.builds} — usage map: ${JSON.stringify(tu)}`);
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Hitting hard cap on hosted_inference returns 429 + structured body.
// ---------------------------------------------------------------------------
test('W409y #4 — hosted_inference hard cap returns 429 + structured body', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant({ plan: 'indie' });

    // Pre-seed the period file with usage already at the indie hard cap
    // (1,000,000 tokens) so the next call cannot fit.
    const { TIER_LIMITS, currentPeriod, usageFilePath } = await import('../src/usage.js');
    const cap = TIER_LIMITS.indie.hosted_inference;
    const period = currentPeriod();
    const file = usageFilePath(period);
    const state = {
      period,
      updated_at: new Date().toISOString(),
      tenants: { [tenantId]: { hosted_inference: cap.hard } },
    };
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');

    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'x-kolm-hosted': 'true',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      assert.equal(r.status, 429, `expected 429 at hard cap, got ${r.status}`);
      const body = await r.json();
      assert.ok(body && body.error, `expected structured error body, got: ${JSON.stringify(body)}`);
      assert.equal(body.error.type, 'hosted_inference_quota_exceeded');
      assert.equal(body.error.unit, 'hosted_inference');
      assert.equal(body.error.tier, 'indie');
      assert.equal(body.error.hard, cap.hard);
      assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0);
      assert.ok(typeof body.error.hint === 'string' && body.error.hint.length > 0,
        'expected upgrade hint in 429 body');
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Soft cap → x-kolm-quota-warning header set.
// ---------------------------------------------------------------------------
test('W409y #5 — soft cap sets x-kolm-quota-warning header', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant({ plan: 'indie' });

    // Seed usage between soft (800k) and hard (1M) so the next call is
    // allowed but should set the warning header.
    const { TIER_LIMITS, currentPeriod, usageFilePath } = await import('../src/usage.js');
    const limits = TIER_LIMITS.indie.hosted_inference;
    const period = currentPeriod();
    const file = usageFilePath(period);
    const state = {
      period,
      updated_at: new Date().toISOString(),
      tenants: { [tenantId]: { hosted_inference: limits.soft + 1 } },
    };
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');

    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'x-kolm-hosted': 'true',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(r.status, 200, `expected 200 below hard cap, got ${r.status}`);
      const warn = r.headers.get('x-kolm-quota-warning');
      assert.equal(warn, 'true',
        `expected x-kolm-quota-warning=true between soft+hard, got ${warn}`);
      await r.text();
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 6 — /v1/billing/usage returns current period usage map.
// ---------------------------------------------------------------------------
test('W409y #6 — /v1/billing/usage dashboard returns current period usage map', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant({ plan: 'indie' });

    // Pre-seed two meters so the dashboard has something to display.
    const { incrementMeter, currentPeriod } = await import('../src/usage.js');
    await incrementMeter(tenantId, 'builds', 3);
    await incrementMeter(tenantId, 'hosted_inference', 1234);

    await withServer(app, async (base) => {
      const r = await fetch(`${base}/v1/billing/usage`, {
        headers: { 'authorization': `Bearer ${apiKey}` },
      });
      assert.equal(r.status, 200, `expected 200 from /v1/billing/usage, got ${r.status}`);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal(body.tier, 'indie');
      assert.equal(body.period, currentPeriod());
      assert.ok(body.meters && typeof body.meters === 'object', 'expected meters map');
      assert.equal(body.meters.builds, 3);
      assert.equal(body.meters.hosted_inference, 1234);
      // limits + soft_limits should expose the indie tier caps.
      assert.ok(body.limits && typeof body.limits === 'object', 'expected hard limits map');
      assert.equal(body.limits.builds, 50);
      assert.equal(body.limits.hosted_inference, 1_000_000);
      assert.ok(body.soft_limits && typeof body.soft_limits === 'object', 'expected soft limits map');
      assert.equal(body.soft_limits.hosted_inference, 800_000);
      // back-compat: `used` mirrors `meters`.
      assert.ok(body.used && body.used.builds === 3);
    });
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Test 7 — Team tier has higher hosted_inference cap than Indie.
// ---------------------------------------------------------------------------
test('W409y #7 — Team tier has higher hosted_inference cap than Indie', async () => {
  const home = mkHome();
  const saved = snapEnv();
  try {
    setIsolatedHome(home);
    const { TIER_LIMITS, tierForPlan, checkLimit } = await import('../src/usage.js');

    const indieHard = TIER_LIMITS.indie.hosted_inference.hard;
    const teamHard = TIER_LIMITS.team.hosted_inference.hard;
    assert.ok(teamHard > indieHard,
      `team hard cap (${teamHard}) should exceed indie (${indieHard})`);

    // Plan-label normalization: indie/starter/pro all map to indie tier;
    // team/teams/business map to team.
    assert.equal(tierForPlan('indie'), 'indie');
    assert.equal(tierForPlan('starter'), 'indie');
    assert.equal(tierForPlan('pro'), 'indie');
    assert.equal(tierForPlan('team'), 'team');
    assert.equal(tierForPlan('teams'), 'team');
    assert.equal(tierForPlan('business'), 'business'); // V1 launch: dedicated tier (was team alias)
    assert.equal(tierForPlan('enterprise'), 'enterprise');
    assert.equal(tierForPlan('free'), 'free');
    assert.equal(tierForPlan(null), 'free');
    assert.equal(tierForPlan('unknown_plan_xyz'), 'free');

    // checkLimit() should permit a 5M token call on team but block it on indie.
    const indieCheck = checkLimit({ tenantId: 'indie_x', tier: 'indie', unit: 'hosted_inference', amount: 5_000_000 });
    assert.equal(indieCheck.allowed, false, 'indie tier should reject a 5M-token request');
    assert.equal(indieCheck.hard, indieHard);

    const teamCheck = checkLimit({ tenantId: 'team_x', tier: 'team', unit: 'hosted_inference', amount: 5_000_000 });
    assert.equal(teamCheck.allowed, true, 'team tier should allow a 5M-token request');
    assert.equal(teamCheck.hard, teamHard);

    // Run the same paid-vs-paid contrast through a live HTTP call against
    // /v1/billing/usage so the dashboard echo of `tier` is verified.
    const { app: appIndie, apiKey: keyIndie } = await makeAppAndTenant({ plan: 'indie' });
    const { app: appTeam,  apiKey: keyTeam  } = await makeAppAndTenant({ plan: 'team' });
    const indieRes = await withServer(appIndie, async (base) => {
      const r = await fetch(`${base}/v1/billing/usage`, { headers: { authorization: `Bearer ${keyIndie}` } });
      return r.json();
    });
    const teamRes = await withServer(appTeam, async (base) => {
      const r = await fetch(`${base}/v1/billing/usage`, { headers: { authorization: `Bearer ${keyTeam}` } });
      return r.json();
    });
    assert.equal(indieRes.tier, 'indie');
    assert.equal(teamRes.tier, 'team');
    assert.equal(indieRes.limits.hosted_inference, indieHard);
    assert.equal(teamRes.limits.hosted_inference, teamHard);
    assert.ok(teamRes.limits.hosted_inference > indieRes.limits.hosted_inference);
  } finally {
    restoreEnv(saved);
    cleanup(home);
  }
});
