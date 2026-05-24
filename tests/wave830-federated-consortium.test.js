// W830 — Federated consortium integration tests.
//
// Coverage map (12 tests; behavior-only, no page-copy assertions other
// than the brand-lock H1 which the spec calls out explicitly):
//
//   #1  src/federated-mia.js exports the 3 functions
//   #2  calibrateMIA with empty shadow_models -> honest envelope
//   #3  verifyArtifactMIAResistance shape (artifact_id + verdict)
//   #4  dpEpsilonAudit reads manifest.privacy.dp_epsilon + recomputes
//   #5  consortium opt-in writes the correct json under
//       ~/.kolm/federated-consortium/<consortium_id>.json
//   #6  consortium budget calc (spent + allocated + remaining + pct)
//   #7  all 6 routes registered (path table introspection)
//   #8  all 6 routes auth-gated (401 without tenant_record)
//   #9  /account/federated/consortium.html exists + brand-lock H1
//  #10  docs/federated/CONSORTIUM_GUIDE.md exists + >=4 cURL examples
//  #11  vercel.json has /account/federated/consortium rewrite
//  #12  W604 regex pattern check (brand-anchor + Frontier H1 lock)
//  #13  sw.js cache slug carries wave token >= 830 (regex+threshold)
//
// W604 anti-brittleness:
//   - sw.js cache key uses regex+threshold, NOT explicit array equality.
//   - cURL count uses ">=" not "=" so future expansion doesn't break.
//   - route registry test asserts presence, not order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

import * as mia from '../src/federated-mia.js';
import {
  registerFederatedConsortiumRoutes,
  _recordAggregationForTests,
  _wipeLocalConsortiumState,
} from '../src/federated-consortium-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w830-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  try { _wipeLocalConsortiumState(); } catch (_) {}
  return tmp;
}

function buildApp({ tenant_id = null } = {}) {
  const app = express();
  app.use(express.json());
  if (tenant_id) {
    app.use((req, _res, next) => {
      req.tenant_record = { id: tenant_id };
      next();
    });
  }
  registerFederatedConsortiumRoutes(app);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

async function callJSON(base, method, urlPath, body) {
  const opts = { method, headers: { 'Accept': 'application/json' } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(base + urlPath, opts);
  let data;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, body: data };
}

// =============================================================================
// 1) src/federated-mia.js exports the 3 functions
// =============================================================================

test('W830 #1 - src/federated-mia.js exports calibrateMIA + verifyArtifactMIAResistance + dpEpsilonAudit', () => {
  assert.equal(typeof mia.calibrateMIA, 'function', 'calibrateMIA must be exported');
  assert.equal(typeof mia.verifyArtifactMIAResistance, 'function', 'verifyArtifactMIAResistance must be exported');
  assert.equal(typeof mia.dpEpsilonAudit, 'function', 'dpEpsilonAudit must be exported');
  assert.equal(typeof mia.MIA_SPEC_VERSION, 'string', 'MIA_SPEC_VERSION must be exported (string)');
  assert.match(mia.MIA_SPEC_VERSION, /^mia-/, 'spec version must start with mia-');
});

// =============================================================================
// 2) calibrateMIA with empty shadow -> honest envelope
// =============================================================================

test('W830 #2 - calibrateMIA with empty shadow_models returns honest envelope', () => {
  const env = mia.calibrateMIA({ shadow_models: [], train_set: ['a', 'b'], holdout_set: ['c', 'd'] });
  assert.equal(env.ok, false, 'must NOT silently certify when no shadow models');
  assert.equal(env.error, 'mia_requires_shadow_models');
  assert.ok(env.install_hint && env.install_hint.length > 0, 'install_hint must be present');
  assert.equal(env.auc_attack, null, 'must NOT fabricate an AUC');
  // Also <3 shadow models should fail similarly.
  const env2 = mia.calibrateMIA({ shadow_models: [() => 0.5], train_set: ['a'], holdout_set: ['c'] });
  assert.equal(env2.ok, false, '<3 shadow models must still be insufficient');
  assert.equal(env2.error, 'mia_requires_shadow_models');
});

// =============================================================================
// 3) verifyArtifactMIAResistance shape
// =============================================================================

test('W830 #3 - verifyArtifactMIAResistance returns the {artifact_id, verdict, attack_auc} shape', () => {
  // Honest stub path: no shadow models -> verdict=unknown + ok=false.
  const stub = mia.verifyArtifactMIAResistance({ artifact_id: 'art_w830_3', test_inputs: ['x', 'y'] });
  assert.equal(stub.ok, false);
  assert.equal(stub.verdict, 'unknown');
  assert.equal(stub.artifact_id, 'art_w830_3');
  assert.equal(stub.attack_auc, null);
  assert.equal(stub.p_at_threshold, mia.DEFAULT_P_MEMBER_THRESHOLD);

  // Real path: three shadow models that strongly prefer "members" so AUC -> 1.
  // test_inputs is non-empty because verifyArtifactMIAResistance enforces
  // that gate; the actual scoring uses the explicit train_set + holdout_set.
  const leakyShadow = (x) => (String(x).startsWith('m_') ? 0.9 : 0.1);
  const out = mia.verifyArtifactMIAResistance({
    artifact_id: 'art_w830_3b',
    test_inputs: ['m_1', 'h_1'],
    shadow_models: [leakyShadow, leakyShadow, leakyShadow],
    train_set: ['m_1', 'm_2', 'm_3'],
    holdout_set: ['h_1', 'h_2', 'h_3'],
    p_threshold: 0.55,
  });
  assert.equal(out.ok, true, 'ok must be true when calibration succeeds (got error: ' + (out.error || '<none>') + ')');
  assert.equal(out.artifact_id, 'art_w830_3b');
  assert.equal(out.verdict, 'leaking', 'leaky shadow should be flagged as leaking');
  assert.ok(out.attack_auc > 0.9, 'attack_auc should be high (got ' + out.attack_auc + ')');
});

// =============================================================================
// 4) dpEpsilonAudit reads manifest.privacy.dp_epsilon
// =============================================================================

test('W830 #4 - dpEpsilonAudit reads manifest.privacy.dp_epsilon + recomputes via Gaussian formula', () => {
  // No manifest -> ok:false.
  const e1 = mia.dpEpsilonAudit({});
  assert.equal(e1.ok, false);
  // Manifest with claim but no sensitivity/sigma/delta -> ok:true but verified:false.
  const e2 = mia.dpEpsilonAudit({ artifact_manifest: { privacy: { dp_epsilon: 1.0 } } });
  assert.equal(e2.ok, true);
  assert.equal(e2.claimed_epsilon, 1.0);
  assert.equal(e2.audit_method, 'gaussian-mechanism-formula');
  assert.equal(e2.verified, false, 'verified must stay false when no recompute inputs');
  // Manifest with full DP parameters: sensitivity=1, sigma=2.0, delta=1e-5 ->
  // epsilon = sqrt(2 * ln(1.25 / 1e-5)) / 2.0 ~= 2.43. Claim must match.
  const sensitivity = 1, sigma = 2.0, delta = 1e-5;
  const expected_eps = (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / sigma;
  const e3 = mia.dpEpsilonAudit({
    artifact_manifest: {
      privacy: {
        dp_epsilon: expected_eps,
        dp_sensitivity: sensitivity,
        dp_sigma: sigma,
        dp_delta: delta,
      },
    },
  });
  assert.equal(e3.ok, true);
  assert.equal(e3.verified, true, 'verified must be true when claim matches recompute');
  assert.ok(Math.abs(e3.recomputed_epsilon - expected_eps) < 1e-9, 'recomputed must equal expected');
  assert.equal(typeof e3.audit_digest, 'string', 'audit_digest must be string');
});

// =============================================================================
// 5) consortium opt-in writes correct JSON
// =============================================================================

test('W830 #5 - consortium opt-in writes ~/.kolm/federated-consortium/<id>.json', async () => {
  freshDir();
  const app = buildApp({ tenant_id: 'tenant_w830_5' });
  const { server, base } = await listen(app);
  try {
    const r = await callJSON(base, 'POST', '/v1/federated/consortium/opt-in', {
      consortium_id: 'cons-w830-5',
      scope: ['ns_a', 'ns_b'],
      epsilon_allocated: 7.5,
      note: 'test opt-in',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.consortium_id, 'cons-w830-5');
    assert.equal(r.body.epsilon_allocated, 7.5);
    assert.deepEqual(r.body.member.scope, ['ns_a', 'ns_b']);
    assert.equal(r.body.member.tenant_id, 'tenant_w830_5');
    // Verify the file exists with expected content.
    const file = path.join(process.env.KOLM_DATA_DIR, 'federated-consortium', 'cons-w830-5.json');
    assert.ok(fs.existsSync(file), 'consortium JSON file must exist at ' + file);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(state.consortium_id, 'cons-w830-5');
    assert.equal(state.epsilon_allocated, 7.5);
    assert.equal(state.members.tenant_w830_5.contribution_count, 0);
    assert.equal(state.members.tenant_w830_5.last_share_at, null);
  } finally {
    server.close();
  }
});

// =============================================================================
// 6) consortium budget calc
// =============================================================================

test('W830 #6 - consortium budget calc (spent + allocated + remaining + pct)', async () => {
  freshDir();
  const app = buildApp({ tenant_id: 'tenant_w830_6' });
  const { server, base } = await listen(app);
  try {
    // Opt in with epsilon_allocated = 10.0.
    await callJSON(base, 'POST', '/v1/federated/consortium/opt-in', {
      consortium_id: 'cons-w830-6',
      epsilon_allocated: 10.0,
    });
    // Seed 2 aggregations: epsilon=2.0 and epsilon=3.5 (total spent = 5.5).
    _recordAggregationForTests({
      consortium_id: 'cons-w830-6',
      aggregation_id: 'agg_1',
      round_id: 'round_1',
      status: 'completed',
      privacy_budget: { epsilon: 2.0 },
      participants: ['tenant_w830_6'],
      started_at: '2026-05-20T00:00:00.000Z',
      completed_at: '2026-05-20T00:10:00.000Z',
    });
    _recordAggregationForTests({
      consortium_id: 'cons-w830-6',
      aggregation_id: 'agg_2',
      round_id: 'round_2',
      status: 'completed',
      privacy_budget: { epsilon: 3.5 },
      participants: ['tenant_w830_6', 'tenant_other'],
      started_at: '2026-05-21T00:00:00.000Z',
      completed_at: '2026-05-21T00:11:00.000Z',
    });
    // Read budget.
    const r = await callJSON(base, 'GET', '/v1/federated/consortium/budget?consortium_id=cons-w830-6');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.epsilon_allocated, 10.0);
    assert.equal(r.body.epsilon_spent, 5.5);
    assert.equal(r.body.epsilon_spent_by_self, 5.5, 'both rounds include this tenant');
    assert.equal(r.body.epsilon_remaining, 4.5);
    assert.ok(Math.abs(r.body.pct_spent - 0.55) < 1e-9, 'pct_spent must equal 5.5/10.0');
    assert.equal(r.body.n_aggregations, 2);
  } finally {
    server.close();
  }
});

// =============================================================================
// 7) all 6 routes registered (path introspection)
// =============================================================================

test('W830 #7 - all 6 consortium routes are registered', () => {
  const app = buildApp({ tenant_id: 'tenant_w830_7' });
  // Express stores routes on app._router.stack[i].route.path
  const routes = app._router.stack
    .filter((l) => l.route)
    .map((l) => l.route.path + ':' + Object.keys(l.route.methods).join(','));
  const required = [
    '/v1/federated/consortium/opt-in:post',
    '/v1/federated/consortium/opt-out:post',
    '/v1/federated/consortium/members:get',
    '/v1/federated/consortium/budget:get',
    '/v1/federated/consortium/aggregations:get',
    '/v1/federated/consortium/verify-mia:post',
  ];
  for (const r of required) {
    assert.ok(routes.includes(r), 'route must be registered: ' + r + ' (got ' + JSON.stringify(routes) + ')');
  }
});

// =============================================================================
// 8) all 6 routes auth-gated (401 without tenant_record)
// =============================================================================

test('W830 #8 - all 6 consortium routes are auth-gated (401 without tenant_record)', async () => {
  freshDir();
  const app = buildApp(); // no tenant_id -> no req.tenant_record stamped
  const { server, base } = await listen(app);
  try {
    const cases = [
      ['POST', '/v1/federated/consortium/opt-in', { consortium_id: 'x' }],
      ['POST', '/v1/federated/consortium/opt-out', { consortium_id: 'x' }],
      ['GET', '/v1/federated/consortium/members?consortium_id=x', null],
      ['GET', '/v1/federated/consortium/budget?consortium_id=x', null],
      ['GET', '/v1/federated/consortium/aggregations?consortium_id=x', null],
      ['POST', '/v1/federated/consortium/verify-mia', { artifact_id: 'a', test_inputs: ['x', 'y'] }],
    ];
    for (const [m, u, b] of cases) {
      const r = await callJSON(base, m, u, b);
      assert.equal(r.status, 401, m + ' ' + u + ' must reject with 401 (got ' + r.status + ')');
      assert.equal(r.body && r.body.ok, false, m + ' ' + u + ' must return ok:false');
      assert.equal(r.body && r.body.error, 'auth_required', m + ' ' + u + ' error must be auth_required');
    }
  } finally {
    server.close();
  }
});

// =============================================================================
// 9) consortium.html exists + brand-lock H1
// =============================================================================

test('W830 #9 - /account/federated/consortium.html exists + carries brand-lock H1', () => {
  const html = fs.readFileSync(
    path.join(REPO_ROOT, 'public', 'account', 'federated', 'consortium.html'),
    'utf8'
  );
  assert.match(html, /<h1[^>]*>Frontier AI on your own infrastructure\.?<\/h1>/i,
    'H1 must be the W830 brand-lock "Frontier AI on your own infrastructure."');
  assert.match(html, /Open-source AI workbench/,
    'eyebrow must carry "Open-source AI workbench"');
  // Spec calls out 4 sections - confirm presence (id markers).
  assert.match(html, /id="optin-card"/, 'opt-in card must be present');
  assert.match(html, /id="budget-card"/, 'budget panel must be present');
  assert.match(html, /id="members-card"/, 'members list must be present');
  assert.match(html, /id="aggregations-card"/, 'aggregations table must be present');
  // Confirm the 4 route fetches are wired client-side.
  assert.match(html, /\/v1\/federated\/consortium\/opt-in/, 'opt-in fetch must be present');
  assert.match(html, /\/v1\/federated\/consortium\/members/, 'members fetch must be present');
  assert.match(html, /\/v1\/federated\/consortium\/budget/, 'budget fetch must be present');
  assert.match(html, /\/v1\/federated\/consortium\/aggregations/, 'aggregations fetch must be present');
});

// =============================================================================
// 10) CONSORTIUM_GUIDE.md exists + >=4 cURL examples
// =============================================================================

test('W830 #10 - docs/federated/CONSORTIUM_GUIDE.md exists + has >=4 cURL examples', () => {
  const guide = fs.readFileSync(
    path.join(REPO_ROOT, 'docs', 'federated', 'CONSORTIUM_GUIDE.md'),
    'utf8'
  );
  assert.ok(guide.length >= 1000, 'guide must be substantive (>=1000 chars, got ' + guide.length + ')');
  // Count cURL examples (lines starting with `curl `).
  const curlCount = (guide.match(/^\s*curl /gm) || []).length;
  assert.ok(curlCount >= 4, 'guide must have >=4 cURL examples (got ' + curlCount + ')');
  // Each base route should appear at least once.
  const required = [
    '/v1/federated/consortium/opt-in',
    '/v1/federated/consortium/opt-out',
    '/v1/federated/consortium/members',
    '/v1/federated/consortium/budget',
  ];
  for (const r of required) {
    assert.ok(guide.includes(r), 'guide must reference route: ' + r);
  }
  // The spec sections (matched case-insensitively against the body; the
  // existing guide uses "Why consortium", "Opt-in flow", "Audit", "Withdrawal"
  // headings + the W830 supplement adds the route table + cURL blocks).
  for (const section of ['consortium', 'opt-in', 'audit', 'opt-out']) {
    assert.match(guide, new RegExp(section, 'i'), 'guide must cover section: ' + section);
  }
});

// =============================================================================
// 11) vercel.json has /account/federated/consortium rewrite
// =============================================================================

test('W830 #11 - vercel.json has the /account/federated/consortium rewrite', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.rewrites), 'rewrites must be an array');
  const hit = cfg.rewrites.find((r) => r.source === '/account/federated/consortium');
  assert.ok(hit, '/account/federated/consortium rewrite must exist');
  assert.equal(hit.destination, '/account/federated/consortium.html',
    'rewrite must target consortium.html');
});

// =============================================================================
// 12) W604 brand-anchor + Frontier H1 regex lock
// =============================================================================

test('W830 #12 - W604 brand-anchor + Frontier H1 regex pattern present', () => {
  const html = fs.readFileSync(
    path.join(REPO_ROOT, 'public', 'account', 'federated', 'consortium.html'),
    'utf8'
  );
  // W604 invariant: every account page carries a Frontier brand-anchor span.
  assert.match(html, /class=["']brand-anchor["']/, 'must carry brand-anchor span');
  assert.match(html, /Frontier AI on your own infrastructure/, 'brand-anchor must contain Frontier line');
  // W775 marker (brand-eyebrow) is also expected on workbench pages.
  assert.match(html, /class=["']brand-eyebrow["']/, 'must carry brand-eyebrow class');
});

// =============================================================================
// 13) sw.js cache slug carries wave token >= 830
// =============================================================================

test('W830 #13 - sw.js cache slug carries a wave token >= 830', () => {
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  // Regex + threshold (forward-compat) per W604 / W835 #13 standing pattern.
  const matches = [...sw.matchAll(/wave(\d{3,4})/g)].map((m) => Number(m[1]));
  assert.ok(matches.length > 0, 'sw.js must carry at least one wave token');
  const maxWave = Math.max(...matches);
  assert.ok(maxWave >= 830, 'max wave token in sw.js must be >= 830 (got ' + maxWave + ')');
});

// W806 honesty-scan close-out: pin the two defensive guards inside
// calibrateMIA so future refactors can't silently drop them.
test('W830 #14 - calibrateMIA empty train_set returns mia_requires_train_set', () => {
  const shadow = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r = mia.calibrateMIA({ shadow_models: shadow, train_set: [], holdout_set: [{ x: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mia_requires_train_set');
  assert.ok(typeof r.install_hint === 'string' && r.install_hint.length > 0);
});

test('W830 #15 - calibrateMIA empty holdout_set returns mia_requires_holdout_set', () => {
  const shadow = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r = mia.calibrateMIA({ shadow_models: shadow, train_set: [{ x: 1 }], holdout_set: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mia_requires_holdout_set');
  assert.ok(typeof r.install_hint === 'string' && r.install_hint.length > 0);
});
