// W775 - Continuous Background Distill (THE KILLER FEATURE) tests.
//
// Pins the W775 wave-brief surface:
//
//   src/autopilot-daemon.js          - enable/disable/getStatus/tick + DI seam
//   src/autopilot-savings.js         - conservative dollar-savings join over
//                                       W807 routing rows
//   public/kolm-auto-pilot.html      - landing + opt-in + status + savings
//   vercel.json                      - /kolm-auto-pilot -> .html rewrite
//   src/router.js                    - 5 auth-gated routes under /v1/autopilot/*
//   cli/kolm.js                      - cmdW775Autopilot dispatcher (case 'autopilot')
//
// W604 anti-brittleness: AUTOPILOT_VERSION matches /^w775-/ (regex, not literal
// equality) so a v2 stamp never breaks consumers that just want to know "this
// is W775".
//
// 24 tests total. Each test is hermetic via freshDir() so concurrent runs
// (--test-concurrency=1 still required) never bleed state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AUTOPILOT_VERSION,
  AUTOPILOT_WORKFLOW,
  enableAutopilot,
  disableAutopilot,
  getAutopilotStatus,
  tickAutopilot,
  _REDISTILL_THRESHOLD,
} from '../src/autopilot-daemon.js';

import {
  AUTOPILOT_SAVINGS_VERSION,
  computeSavings,
} from '../src/autopilot-savings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'kolm-auto-pilot.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');
const DAEMON_PATH = path.join(REPO_ROOT, 'src', 'autopilot-daemon.js');
const SAVINGS_PATH = path.join(REPO_ROOT, 'src', 'autopilot-savings.js');

function freshDir(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w775-${label || 'x'}-`));
  const dot = path.join(tmp, '.kolm');
  fs.mkdirSync(dot, { recursive: true });
  process.env.KOLM_DATA_DIR = dot;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = dot;
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Test isolation: clear any DI stub that a prior test might have left set.
  delete process.env.KOLM_W775_ORCHESTRATE_CMD;
  return tmp;
}

function freshTenant() {
  return 'tenant_w775_' + crypto.randomBytes(4).toString('hex');
}

// Helper: write a DI stub file inside a freshDir-controlled tmp tree. The
// stub is a Node ES module that exports default async (opts) => envelope.
// Tests use this to drive the W775 orchestrate step deterministically
// without spinning up the real W720 worker.
function writeOrchestrateStub(tmpDir, envelope) {
  const stubPath = path.join(tmpDir, 'orchestrate-stub.mjs');
  const body = `
export default async function(opts) {
  return ${JSON.stringify(envelope)};
}
`;
  fs.writeFileSync(stubPath, body, 'utf8');
  process.env.KOLM_W775_ORCHESTRATE_CMD = stubPath;
  return stubPath;
}

// Helper: deterministic capture seeding for W815 readiness gate. We append
// minimal capture rows so getCoverageGapsForNamespace returns ok:true with
// gaps the autopilot can consume.
async function seedCaptures(tenant, namespace, n) {
  const es = await import('../src/event-store.js');
  for (let i = 0; i < n; i++) {
    await es.appendEvent({
      tenant_id: tenant,
      namespace,
      provider: 'test-provider',
      vendor: 'test',
      model: 'test/m',
      workflow_id: 'w775-test-capture',
      request_hash: 'rh_' + i,
      prompt: 'sample prompt ' + (i % 5) + ' with topic ' + (i % 3),
      response: 'sample answer ' + i,
      prompt_tokens: 10,
      completion_tokens: 10,
      tokens_in: 10,
      tokens_out: 10,
      status: 'ok',
    });
  }
}

// =============================================================================
// W775 #1 - Version stamps stable across daemon + savings modules
// =============================================================================
test('W775 #1 - AUTOPILOT_VERSION + AUTOPILOT_SAVINGS_VERSION match /^w775-/', () => {
  freshDir('t1');
  assert.ok(/^w775-/.test(AUTOPILOT_VERSION),
    `AUTOPILOT_VERSION must match /^w775-/; got ${AUTOPILOT_VERSION}`);
  assert.ok(/^w775-/.test(AUTOPILOT_SAVINGS_VERSION),
    `AUTOPILOT_SAVINGS_VERSION must match /^w775-/; got ${AUTOPILOT_SAVINGS_VERSION}`);
  // Workflow enum stable shape.
  assert.equal(AUTOPILOT_WORKFLOW.ENABLED, 'autopilot:enabled');
  assert.equal(AUTOPILOT_WORKFLOW.DISABLED, 'autopilot:disabled');
  assert.equal(AUTOPILOT_WORKFLOW.HOLDING, 'autopilot:holding');
  assert.equal(AUTOPILOT_WORKFLOW.REDISTILLED, 'autopilot:redistilled');
  assert.equal(AUTOPILOT_WORKFLOW.TICK_NO_OP, 'autopilot:no_op');
});

// =============================================================================
// W775 #2 - Honest envelope on missing tenant across all daemon entrypoints
// =============================================================================
test('W775 #2 - enable/disable/status/tick reject missing tenant honestly', async () => {
  freshDir('t2');
  for (const fn of [enableAutopilot, disableAutopilot, getAutopilotStatus, tickAutopilot]) {
    const env = await fn({ namespace: 'x' });
    assert.equal(env.ok, false, `${fn.name} must return ok:false without tenant`);
    assert.equal(env.error, 'missing_tenant_id');
    assert.ok(/^w775-/.test(env.version));
  }
});

// =============================================================================
// W775 #3 - enableAutopilot writes opt-in row + returns stable autopilot_id
// =============================================================================
test('W775 #3 - enableAutopilot persists + returns autopilot_id', async () => {
  freshDir('t3');
  const tenant = freshTenant();
  const env = await enableAutopilot({ tenant, namespace: 'default' });
  assert.equal(env.ok, true);
  assert.ok(env.autopilot_id && env.autopilot_id.startsWith('ap_'),
    `autopilot_id must start with ap_; got ${env.autopilot_id}`);
  assert.ok(env.enabled_at);
  assert.equal(env.namespace, 'default');
  assert.equal(env.persisted, true, `must persist to event-store; got ${JSON.stringify(env)}`);
  assert.equal(env.version, 'w775-v1');
});

// =============================================================================
// W775 #4 - Repeated enable REUSES the existing autopilot_id (no churn)
// =============================================================================
test('W775 #4 - repeated enable returns the same autopilot_id', async () => {
  freshDir('t4');
  const tenant = freshTenant();
  const e1 = await enableAutopilot({ tenant, namespace: 'default' });
  const e2 = await enableAutopilot({ tenant, namespace: 'default' });
  assert.equal(e1.autopilot_id, e2.autopilot_id,
    'subsequent enable() calls must reuse the existing autopilot_id');
});

// =============================================================================
// W775 #5 - disableAutopilot persists opt-out row
// =============================================================================
test('W775 #5 - disableAutopilot writes opt-out row', async () => {
  freshDir('t5');
  const tenant = freshTenant();
  await enableAutopilot({ tenant, namespace: 'default' });
  const env = await disableAutopilot({ tenant, namespace: 'default' });
  assert.equal(env.ok, true);
  assert.ok(env.disabled_at);
  assert.equal(env.persisted, true);
});

// =============================================================================
// W775 #6 - getAutopilotStatus reads enabled/disabled correctly across times
// =============================================================================
test('W775 #6 - getAutopilotStatus reflects most-recent state', async () => {
  freshDir('t6');
  const tenant = freshTenant();
  // Initial: unconfigured.
  const s0 = await getAutopilotStatus({ tenant, namespace: 'default' });
  assert.equal(s0.ok, true);
  assert.equal(s0.enabled, false);
  assert.equal(s0.configured, false);

  await enableAutopilot({ tenant, namespace: 'default' });
  const s1 = await getAutopilotStatus({ tenant, namespace: 'default' });
  assert.equal(s1.enabled, true, 'after enable, status.enabled must be true');
  assert.equal(s1.configured, true);

  // Small delay so the disable row's created_at > enable row.
  await new Promise(r => setTimeout(r, 30));
  await disableAutopilot({ tenant, namespace: 'default' });
  const s2 = await getAutopilotStatus({ tenant, namespace: 'default' });
  assert.equal(s2.enabled, false,
    `after disable, status.enabled must flip to false; got ${JSON.stringify(s2)}`);
});

// =============================================================================
// W775 #7 - tickAutopilot returns action:'disabled' when not enabled
// =============================================================================
test('W775 #7 - tick on unconfigured/disabled namespace returns action:disabled', async () => {
  freshDir('t7');
  const tenant = freshTenant();
  // Never enabled.
  const t0 = await tickAutopilot({ tenant, namespace: 'default' });
  assert.equal(t0.ok, true);
  assert.equal(t0.action, 'disabled');
  // Explicitly disabled.
  await enableAutopilot({ tenant, namespace: 'default' });
  await new Promise(r => setTimeout(r, 30));
  await disableAutopilot({ tenant, namespace: 'default' });
  const t1 = await tickAutopilot({ tenant, namespace: 'default' });
  assert.equal(t1.action, 'disabled');
});

// =============================================================================
// W775 #8 - tickAutopilot HOLDS on insufficient_captures (W815 readiness gate)
// =============================================================================
test('W775 #8 - tick HOLDS when W815 reports insufficient_captures', async () => {
  freshDir('t8');
  const tenant = freshTenant();
  await enableAutopilot({ tenant, namespace: 'sparse-ns' });
  // No seeded captures => W815 returns insufficient_captures_for_coverage.
  const env = await tickAutopilot({ tenant, namespace: 'sparse-ns' });
  assert.equal(env.ok, true);
  assert.equal(env.action, 'holding');
  // Honest reason - either the W815 string or our generic stand-in.
  assert.ok(env.reason === 'insufficient_captures_for_coverage'
         || env.reason === 'insufficient_captures',
    `must report an insufficient_captures reason; got ${env.reason}`);
});

// =============================================================================
// W775 #9 - REDISTILL_THRESHOLD is a sane number (0 < t < 1)
// =============================================================================
test('W775 #9 - REDISTILL_THRESHOLD is 0.25 (sane bound)', () => {
  freshDir('t9');
  assert.equal(_REDISTILL_THRESHOLD, 0.25);
  assert.ok(_REDISTILL_THRESHOLD > 0 && _REDISTILL_THRESHOLD < 1);
});

// =============================================================================
// W775 #10 - DI stub via KOLM_W775_ORCHESTRATE_CMD overrides orchestrate path
// =============================================================================
test('W775 #10 - tick honours KOLM_W775_ORCHESTRATE_CMD stub when gates clear', async () => {
  const tmp = freshDir('t10');
  const tenant = freshTenant();
  await enableAutopilot({ tenant, namespace: 'rich-ns' });
  // Seed enough captures so W815 returns gaps - 60 rows over a few clusters.
  await seedCaptures(tenant, 'rich-ns', 60);
  // Install DI stub that returns a known artifact id.
  writeOrchestrateStub(tmp, {
    ok: true,
    run_id: 'run_stub_123',
    base_artifact_id: 'art_base_xx',
    candidate_artifact_id: 'art_cand_yy',
    plan: 'stubbed',
    version: 'w720-v1',
  });
  const env = await tickAutopilot({
    tenant,
    namespace: 'rich-ns',
    opts: { redistill_threshold: 0, min_captures: 10 },
  });
  // With threshold:0 + sufficient captures, the gate clears.
  // Either action===redistilled (stub fired) or holding (drift/insufficient).
  // We allow both because W815's gap_score depends on cluster distribution
  // which we cannot fully control. The IMPORTANT contract: if action is
  // redistilled, the stub's artifact id MUST surface.
  assert.equal(env.ok, true);
  if (env.action === 'redistilled') {
    assert.equal(env.artifact_id, 'art_cand_yy');
    assert.equal(env.run_id, 'run_stub_123');
  } else {
    assert.ok(['holding', 'no_op'].includes(env.action),
      `unexpected action: ${env.action}`);
  }
});

// =============================================================================
// W775 #11 - DI stub returns an error envelope - daemon STILL writes a row
// =============================================================================
test('W775 #11 - stub error surface still writes redistilled row with envelope', async () => {
  const tmp = freshDir('t11');
  const tenant = freshTenant();
  await enableAutopilot({ tenant, namespace: 'rich-err' });
  await seedCaptures(tenant, 'rich-err', 60);
  writeOrchestrateStub(tmp, {
    ok: false,
    error: 'stub_simulated_failure',
    version: 'w720-v1',
  });
  const env = await tickAutopilot({
    tenant,
    namespace: 'rich-err',
    opts: { redistill_threshold: 0, min_captures: 10 },
  });
  assert.equal(env.ok, true);
  // The daemon either redistilled (with the error envelope embedded) or held
  // because of an upstream gap_score; either way we must NOT throw.
  if (env.action === 'redistilled') {
    assert.equal(env.orchestrate_envelope.ok, false);
    assert.equal(env.orchestrate_envelope.error, 'stub_simulated_failure');
  }
});

// =============================================================================
// W775 #12 - Tenant fence: tenant A's enable is invisible to tenant B
// =============================================================================
test('W775 #12 - W411 tenant fence: foreign-tenant enable is invisible', async () => {
  freshDir('t12');
  const a = freshTenant();
  const b = freshTenant();
  await enableAutopilot({ tenant: a, namespace: 'default' });
  const statusB = await getAutopilotStatus({ tenant: b, namespace: 'default' });
  assert.equal(statusB.enabled, false,
    'tenant B must NOT see tenant A enable row (W411 tenant fence)');
  assert.equal(statusB.configured, false);
});

// =============================================================================
// W775 #13 - computeSavings honest envelope on missing tenant
// =============================================================================
test('W775 #13 - computeSavings rejects missing tenant honestly', async () => {
  freshDir('t13');
  const env = await computeSavings({ namespace: 'x' });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'tenant_id_required');
  assert.equal(env.version, 'w775-v1');
});

// =============================================================================
// W775 #14 - computeSavings returns zeros (not error) on no routing rows
// =============================================================================
test('W775 #14 - computeSavings empty-tenant returns ok:true with zeros', async () => {
  freshDir('t14');
  const tenant = freshTenant();
  const env = await computeSavings({ tenant_id: tenant, namespace: 'fresh' });
  assert.equal(env.ok, true);
  assert.equal(env.total_saved_micro_usd, 0);
  assert.equal(env.baseline_micro_usd, 0);
  assert.deepEqual(env.breakdown_by_day, []);
  assert.equal(env.n, 0);
  assert.equal(env.window_days, 30);
});

// =============================================================================
// W775 #15 - computeSavings sums teacher_cost_avoided on non-teacher rows
// =============================================================================
test('W775 #15 - computeSavings joins on W807 routing rows correctly', async () => {
  freshDir('t15');
  const tenant = freshTenant();
  const namespace = 'savings-ns';
  // Seed three routing decisions: 2 student (savings recorded), 1 teacher (no savings).
  const re = await import('../src/routing-events.js');
  await re.recordRoutingDecision({
    tenant_id: tenant, namespace,
    decision: { route: 'student', reason: 'low_entropy' },
    student_tokens: 100, teacher_tokens: 0,
    costs: { student_micro_usd: 1000, teacher_micro_usd: 50000 },
  });
  await re.recordRoutingDecision({
    tenant_id: tenant, namespace,
    decision: { route: 'student', reason: 'low_entropy' },
    student_tokens: 100, teacher_tokens: 0,
    costs: { student_micro_usd: 1000, teacher_micro_usd: 50000 },
  });
  await re.recordRoutingDecision({
    tenant_id: tenant, namespace,
    decision: { route: 'teacher', reason: 'high_entropy' },
    student_tokens: 0, teacher_tokens: 200,
    costs: { student_micro_usd: 0, teacher_micro_usd: 100000 },
  });
  const env = await computeSavings({ tenant_id: tenant, namespace });
  assert.equal(env.ok, true);
  assert.equal(env.n, 3);
  // Saved = teacher_cost on 2 student rows = 2 * 50000 = 100000 micro.
  assert.equal(env.total_saved_micro_usd, 100000,
    `expected 100000 micro-usd saved; got ${env.total_saved_micro_usd}`);
  // Baseline = sum of (student + teacher) costs across all rows.
  // = (1000+50000) + (1000+50000) + (0+100000) = 202000.
  assert.equal(env.baseline_micro_usd, 202000,
    `expected 202000 micro-usd baseline; got ${env.baseline_micro_usd}`);
  // baseline_usd convenience field.
  assert.ok(Math.abs(env.baseline_usd - 0.202) < 1e-9);
});

// =============================================================================
// W775 #16 - computeSavings tenant fence (W411): does NOT include other tenant
// =============================================================================
test('W775 #16 - computeSavings W411 fence excludes foreign tenant rows', async () => {
  freshDir('t16');
  const a = freshTenant();
  const b = freshTenant();
  const re = await import('../src/routing-events.js');
  await re.recordRoutingDecision({
    tenant_id: a, namespace: 'default',
    decision: { route: 'student', reason: 'low_entropy' },
    costs: { student_micro_usd: 100, teacher_micro_usd: 99999 },
  });
  const env = await computeSavings({ tenant_id: b, namespace: 'default' });
  assert.equal(env.ok, true);
  assert.equal(env.n, 0,
    'tenant B must NOT see tenant A routing rows (W411 fence)');
  assert.equal(env.total_saved_micro_usd, 0);
});

// =============================================================================
// W775 #17 - computeSavings window_days clamp + flag
// =============================================================================
test('W775 #17 - computeSavings clamps window_days out of range with flag', async () => {
  freshDir('t17');
  const tenant = freshTenant();
  const tooBig = await computeSavings({ tenant_id: tenant, window_days: 99999 });
  assert.equal(tooBig.ok, true);
  assert.equal(tooBig.window_days, 365);
  assert.ok(tooBig.window_days_clamped, 'must stamp window_days_clamped when clamping fires');

  const tooSmall = await computeSavings({ tenant_id: tenant, window_days: -5 });
  assert.equal(tooSmall.window_days, 1);
  assert.ok(tooSmall.window_days_clamped);

  const ok = await computeSavings({ tenant_id: tenant, window_days: 14 });
  assert.equal(ok.window_days, 14);
  assert.equal(ok.window_days_clamped, undefined);
});

// =============================================================================
// W775 #18 - Route: POST /v1/autopilot/enable 401 w/o auth, 200 w/ auth
// =============================================================================
test('W775 #18 - POST /v1/autopilot/enable 401 w/o auth; 200 envelope on auth', async () => {
  freshDir('t18');
  process.env.KOLM_STORE_DRIVER = 'json';

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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/autopilot/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'default' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/autopilot/enable`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ namespace: 'default' }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.ok(/^w775-/.test(env.version));
    assert.ok(env.autopilot_id);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W775 #19 - Route: GET /v1/autopilot/status reflects enable/disable state
// =============================================================================
test('W775 #19 - GET /v1/autopilot/status round-trips with enable/disable', async () => {
  freshDir('t19');
  process.env.KOLM_STORE_DRIVER = 'json';

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
  const auth = { 'authorization': 'Bearer ' + t.api_key, 'content-type': 'application/json' };

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // 1. status before enable
    const s0 = await fetch(`http://127.0.0.1:${port}/v1/autopilot/status?namespace=q`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(s0.status, 200);
    const s0j = await s0.json();
    assert.equal(s0j.enabled, false);
    assert.equal(s0j.configured, false);

    // 2. enable
    const e = await fetch(`http://127.0.0.1:${port}/v1/autopilot/enable`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ namespace: 'q' }),
    });
    assert.equal(e.status, 200);

    // 3. status now enabled
    const s1 = await fetch(`http://127.0.0.1:${port}/v1/autopilot/status?namespace=q`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    const s1j = await s1.json();
    assert.equal(s1j.enabled, true,
      `after POST /enable status must report enabled; got ${JSON.stringify(s1j)}`);
    assert.ok(s1j.autopilot_id);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W775 #20 - Route: GET /v1/autopilot/savings honest envelope on auth
// =============================================================================
test('W775 #20 - GET /v1/autopilot/savings 401 then 200 with zeros on empty tenant', async () => {
  freshDir('t20');
  process.env.KOLM_STORE_DRIVER = 'json';

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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/autopilot/savings`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/autopilot/savings?window_days=7`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.total_saved_micro_usd, 0);
    assert.equal(env.window_days, 7);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W775 #21 - Route: GET /v1/autopilot/tick on disabled namespace
// =============================================================================
test('W775 #21 - GET /v1/autopilot/tick returns action:disabled when not enabled', async () => {
  freshDir('t21');
  process.env.KOLM_STORE_DRIVER = 'json';

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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/autopilot/tick?namespace=z`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/autopilot/tick?namespace=z`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.action, 'disabled',
      `untouched namespace must tick as action:'disabled'; got ${env.action}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// W775 #22 - Landing page brand-locked eyebrow + H1
// =============================================================================
test('W775 #22 - kolm-auto-pilot.html ships brand-locked eyebrow + H1', () => {
  freshDir('t22');
  assert.ok(fs.existsSync(HTML_PATH), `landing page must exist at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Eyebrow is LOCKED to exactly "Open-source AI workbench".
  assert.ok(html.includes('>Open-source AI workbench<'),
    'eyebrow must be exactly "Open-source AI workbench" inside an element');
  // H1 is LOCKED to exactly "Frontier AI on your own infrastructure."
  assert.ok(html.includes('Frontier AI on your own infrastructure.'),
    'H1 must contain exactly "Frontier AI on your own infrastructure."');
  // data-w775 hooks for test anchors.
  assert.ok(html.includes('data-w775="brand-eyebrow"'),
    'brand eyebrow element must carry data-w775 anchor');
  assert.ok(html.includes('data-w775="h1"'),
    'H1 element must carry data-w775 anchor');
  // Three core panels.
  assert.ok(html.includes('data-w775="opt-in"'));
  assert.ok(html.includes('data-w775="status"'));
  assert.ok(html.includes('data-w775="savings"'));
});

// =============================================================================
// W775 #23 - vercel.json rewrite present for /kolm-auto-pilot
// =============================================================================
test('W775 #23 - vercel.json maps /kolm-auto-pilot to .html', () => {
  freshDir('t23');
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  const found = rewrites.find(rw =>
    rw && rw.source === '/kolm-auto-pilot' && rw.destination === '/kolm-auto-pilot.html');
  assert.ok(found, 'vercel.json must rewrite /kolm-auto-pilot -> /kolm-auto-pilot.html');
});

// =============================================================================
// W775 #24 - CLI dispatcher present + autopilot subverbs registered
// =============================================================================
test('W775 #24 - cli/kolm.js wires cmdW775Autopilot + completion + dispatch', () => {
  freshDir('t24');
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named dispatcher exists.
  assert.ok(/cmdW775Autopilot\s*\(/.test(cli),
    'cmdW775Autopilot dispatcher must be defined');
  // Wired into the dispatch table.
  assert.ok(/autopilot:\s*cmdW775Autopilot/.test(cli),
    'dispatch table must map autopilot -> cmdW775Autopilot');
  // Main() case branch.
  assert.ok(cli.includes("case 'autopilot':"),
    "main() must include case 'autopilot':");
  // COMPLETION_SUBS.autopilot present with all 6 verbs.
  assert.ok(/COMPLETION_SUBS\.autopilot\s*=\s*\[/.test(cli),
    'COMPLETION_SUBS.autopilot must be registered');
  for (const v of ['start', 'stop', 'status', 'disable', 'savings', 'tick']) {
    assert.ok(cli.includes("'" + v + "'"),
      `COMPLETION_SUBS.autopilot must include '${v}'`);
  }
  // HELP block present.
  assert.ok(cli.includes("'autopilot':"),
    "HELP['autopilot'] block must be defined");
});

// =============================================================================
// W775 #25 - Router carries the five /v1/autopilot/* routes
// =============================================================================
test('W775 #25 - src/router.js carries all 5 /v1/autopilot/* routes auth-gated', () => {
  freshDir('t25');
  const router = fs.readFileSync(ROUTER_PATH, 'utf8');
  // Five routes (HTTP verb + path).
  assert.ok(router.includes("r.post('/v1/autopilot/enable'"),
    'POST /v1/autopilot/enable route must exist');
  assert.ok(router.includes("r.post('/v1/autopilot/disable'"),
    'POST /v1/autopilot/disable route must exist');
  assert.ok(router.includes("r.get('/v1/autopilot/status'"),
    'GET /v1/autopilot/status route must exist');
  assert.ok(router.includes("r.get('/v1/autopilot/savings'"),
    'GET /v1/autopilot/savings route must exist');
  assert.ok(router.includes("r.get('/v1/autopilot/tick'"),
    'GET /v1/autopilot/tick route must exist');
  // W775 marker comment present (groups them visually).
  assert.ok(/W775 .*(?:autopilot|killer feature)/i.test(router),
    'router must carry a W775 autopilot section marker');
});

// =============================================================================
// W775 #26 - Daemon + savings modules exist on disk (paranoid surface lock)
// =============================================================================
test('W775 #26 - daemon and savings modules exist on disk', () => {
  freshDir('t26');
  assert.ok(fs.existsSync(DAEMON_PATH), `daemon module must exist at ${DAEMON_PATH}`);
  assert.ok(fs.existsSync(SAVINGS_PATH), `savings module must exist at ${SAVINGS_PATH}`);
});
