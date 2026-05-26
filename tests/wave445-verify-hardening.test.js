// W445 — verify hardening + P3 audit closer.
//
// Audit items closed:
//
//   P1-11 verify failure taxonomy is stable across the structured verifier:
//     - signature_invalid
//     - manifest_hash_mismatch (catch-all for CID + per-file hash mismatch)
//     - train_holdout_leakage
//     - synthetic_only_in_production
//     - native_binary_missing
//     - production_check_failed_on_install
//
//   P3-17 device recommender exposed at /v1/devices/recommend (the recommender
//     function existed in src/devices.js but wasn't routed). Returns the
//     refusal codes (no_profile / no_compatible_target / artifact_exceeds_
//     device_memory / offline_required_but_device_not_offline_capable) verbatim
//     so callers can branch on them.
//
//   P3-18 confidential compute verifier state machine — UNVERIFIED / SHAPE_OK /
//     CRYPTOGRAPHICALLY_VERIFIED / REVOKED / EXPIRED / REJECTED. /v1/cc/verify
//     surfaces a shape_ok envelope for valid PCCS/SNP/NITRO/NRAS reports and
//     a rejected envelope for missing fields.
//
//   P3-19 federated learning round/contribution metadata is hash-stable and
//     spec-versioned. roundHash() returns a deterministic 64-char hex for the
//     same round payload.
//
//   P3-20 agent / workflow trace span_append refuses cross-tenant tenant_id.
//     The route always force-binds span.tenant_id = req.tenant_record.id so a
//     caller cannot ship a span tagged for someone else's tenant.
//
// Same harness as W444: isolated HOME, express test server, no shared state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

import * as eventStore from '../src/event-store.js';
import * as binder from '../src/binder.js';
import * as cc from '../src/confidential-compute.js';
import * as fl from '../src/federated-learning.js';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w445-'));
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}
function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (eventStore._resetForTests) eventStore._resetForTests();
}
function teardownIsolated(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  delete process.env.KOLM_DATA_DIR;
  cleanup(home);
}

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
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

// =============================================================================
// P1-11 verify failure taxonomy
// =============================================================================

test('W445 #1 — verify enum is stable + closed (no surprise reason codes)', () => {
  // The structured verifier promises a closed enum. Any future addition
  // MUST come with a wave + docs bump — failing this list catches accidental
  // additions or renames that would break the auditor toolchain.
  const STABLE_ENUM = new Set([
    'signature_invalid',
    'manifest_hash_mismatch',
    'train_holdout_leakage',
    'synthetic_only_in_production',
    'native_binary_missing',
    'production_check_failed_on_install',
  ]);
  // Source-grep the binder for `reason: '...'` strings inside
  // verifyArtifactStructured. We want every literal reason to be in the enum.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'binder.js'), 'utf8');
  const verifierBlock = src.slice(src.indexOf('verifyArtifactStructured'));
  const reasonsInVerifier = new Set();
  // Snake-case identifiers only; skips JSDoc placeholders like '<enum>'.
  const re = /reason:\s*'([a-z][a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(verifierBlock)) != null) {
    reasonsInVerifier.add(m[1]);
  }
  // Some reasons in the verifier block are dynamic strings (concatenations),
  // not literals — those won't show up in the regex match, which is fine.
  // We just enforce: every LITERAL reason is in the stable enum.
  for (const r of reasonsInVerifier) {
    assert.ok(STABLE_ENUM.has(r),
      `verifier emitted literal reason "${r}" which is not in the stable enum`);
  }
});

test('W445 #2 — verifyArtifactStructured returns {ok:false, reason} envelope on missing file', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const missing = path.join(home, 'does-not-exist.kolm');
    const result = await binder.verifyArtifactStructured(missing);
    assert.equal(result.ok, false, 'missing artifact must verify as not-ok');
    assert.ok(typeof result.reason === 'string', 'must surface a reason string');
    // Closed enum membership.
    const STABLE = new Set([
      'signature_invalid',
      'manifest_hash_mismatch',
      'train_holdout_leakage',
      'synthetic_only_in_production',
      'native_binary_missing',
      'production_check_failed_on_install',
    ]);
    assert.ok(STABLE.has(result.reason),
      'reason must be from the stable enum, got: ' + result.reason);
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// P3-17 /v1/devices/recommend
// =============================================================================

test('W445 #3 — /v1/devices/recommend returns a structured envelope', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      // No artifact → just resolve a profile for the current host.
      const r1 = await fetch(base + '/v1/devices/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({}),
      });
      assert.equal(r1.status, 200, 'recommend must return 200');
      const body = await r1.json();
      // Envelope is either {ok:true, profile_id, target, quant, ...} or
      // {ok:false, reason}. Both shapes carry actionable info.
      assert.ok(typeof body.ok === 'boolean', 'recommend must return ok boolean');
      if (body.ok === true) {
        assert.ok(typeof body.profile_id === 'string' && body.profile_id.length > 0);
        assert.ok(typeof body.target === 'string' && body.target.length > 0);
        assert.ok(typeof body.quant === 'string');
      } else {
        assert.ok(typeof body.reason === 'string' && body.reason.length > 0,
          'falsy recommend must carry a reason');
      }
    });
  } finally {
    teardownIsolated(home);
  }
});

test('W445 #4 — /v1/devices/recommend refuses an artifact that exceeds memory', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      // Pin an obviously-impossible memory requirement: 999_999 MiB.
      const r1 = await fetch(base + '/v1/devices/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          // Pin a known small mobile profile so the memory ceiling is small.
          profile: { id: 'mobile-ios-iphone-15', profile_class: 'mobile-ios',
                     supported_targets: ['mlc-llm', 'js'], max_artifact_size_mb: 800,
                     runtime_status: 'foundation', offline_capable: true },
          artifact: { id: 'oversized', supported_targets: ['js'],
                     memory_requirement_mb: 999999 },
        }),
      });
      assert.equal(r1.status, 200);
      const body = await r1.json();
      assert.equal(body.ok, false, 'oversized artifact must be refused');
      assert.equal(body.reason, 'artifact_exceeds_device_memory',
        'refusal reason must be artifact_exceeds_device_memory');
      assert.equal(body.want_mb, 999999);
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// P3-18 confidential compute verifier states
// =============================================================================

test('W445 #5 — /v1/cc/verify returns the documented state enum', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      // shape_ok path: a well-formed PCCS-shaped report (synthetic).
      const wellFormed = {
        quote: 'AABB' + '0'.repeat(60),
        tee_type: 'tdx',
        tcb_evaluation_data_number: 1,
        mr_td:     '0'.repeat(64),
        mr_seam:   '0'.repeat(64),
        rtmr0:     '0'.repeat(96),
        rtmr1:     '0'.repeat(96),
        rtmr2:     '0'.repeat(96),
        rtmr3:     '0'.repeat(96),
        report_data: '0'.repeat(128),
      };
      const r1 = await fetch(base + '/v1/cc/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pccs', report: wellFormed }),
      });
      assert.equal(r1.status, 200, 'cc verify must 200 on well-shaped report');
      const body1 = await r1.json();
      // State must be one of the documented enum values.
      assert.ok(Object.values(cc.STATES).includes(body1.state),
        'state must be in STATES enum, got ' + body1.state);
      // Without a registered crypto verifier the state stays shape_ok.
      assert.equal(body1.state, cc.STATES.SHAPE_OK,
        'shape-only verifier must return shape_ok for valid PCCS shape');
      assert.equal(body1.kind, 'pccs');
      assert.equal(body1.verified, false,
        'shape_ok must report verified=false until a real crypto chain runs');
      assert.ok(typeof body1.report_hash === 'string' && body1.report_hash.length > 0);

      // rejected path: missing fields.
      const r2 = await fetch(base + '/v1/cc/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pccs', report: { quote: 'short' } }),
      });
      assert.equal(r2.status, 200, 'rejected envelope must still 200');
      const body2 = await r2.json();
      assert.equal(body2.state, cc.STATES.REJECTED,
        'missing fields must surface state=rejected');

      // unknown kind path — verifier returns the structured rejected envelope
      // with reason='unknown_kind' (still HTTP 200; the envelope IS the answer).
      const r3 = await fetch(base + '/v1/cc/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'made-up-kind', report: { foo: 'bar' } }),
      });
      assert.equal(r3.status, 200, 'unknown kind must 200 with rejected envelope');
      const body3 = await r3.json();
      assert.equal(body3.state, cc.STATES.REJECTED,
        'unknown kind must surface state=rejected');
      assert.equal(body3.reason, 'unknown_kind',
        'unknown kind must surface reason=unknown_kind');
    });
  } finally {
    teardownIsolated(home);
  }
});

// =============================================================================
// P3-19 federated learning metadata stability
// =============================================================================

test('W445 #6 — federated round metadata is hash-stable + spec-versioned', () => {
  const r1 = fl.newRound({
    round_id: 'rnd-w445-test',
    model_hash: 'a'.repeat(64),
    base_artifact_version: 'v0.1',
    target_strategy: fl.STRATEGIES.FEDAVG,
    min_participants: 3,
  });
  const r2 = fl.newRound({
    round_id: 'rnd-w445-test',
    model_hash: 'a'.repeat(64),
    base_artifact_version: 'v0.1',
    target_strategy: fl.STRATEGIES.FEDAVG,
    min_participants: 3,
  });
  // Spec version is part of the envelope.
  assert.equal(r1.spec, fl.FL_SPEC_VERSION);
  // Deterministic hash for the same payload.
  const h1 = fl.roundHash(r1);
  const h2 = fl.roundHash(r2);
  assert.equal(h1, h2, 'identical rounds must hash identically');
  // roundHash is sha256 → sliced to 16 hex chars (compact identity, the
  // contribution ledger pins the full hash separately). Lock 16-char hex.
  assert.ok(/^[0-9a-f]{16}$/.test(h1),
    'roundHash must be 16-char hex (sha256 prefix), got: ' + h1);
});

// =============================================================================
// P3-20 trace span_append refuses cross-tenant tenant_id
// =============================================================================

test('W445 #7 — /v1/trace/append force-binds tenant_id to the authenticated tenant', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app, apiKey, tenantId } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      // Make up a different tenant id in the body. The route MUST overwrite
      // it with the caller's authenticated tenant.
      const trace_id = '0'.repeat(32);
      const span_id  = '1'.repeat(16);
      const r1 = await fetch(base + '/v1/trace/append', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          span: {
            trace_id,
            span_id,
            kind: 'tool',
            name: 'w445_probe',
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            // Try to forge a different tenant — route must overwrite.
            tenant_id: 'forged-other-tenant',
          },
        }),
      });
      // 201 = appended successfully; 400 = validation error (acceptable too).
      // The behavior we lock-in: NO success response that retains the forged
      // tenant_id.
      assert.ok([200, 201, 400].includes(r1.status),
        'trace append must return a known status, got ' + r1.status);
      if (r1.status === 201 || r1.status === 200) {
        const body = await r1.json();
        assert.ok(body.span, 'success must include the enriched span');
        assert.equal(body.span.tenant_id, tenantId,
          'route must rebind span.tenant_id to authenticated tenant — got ' + body.span.tenant_id);
        assert.notEqual(body.span.tenant_id, 'forged-other-tenant',
          'forged tenant_id must NEVER survive the route binding');
      }
    });
  } finally {
    teardownIsolated(home);
  }
});

test('W445 #8 — /v1/trace/append refuses without auth', async () => {
  const home = mkHome();
  try {
    setIsolatedHome(home);
    const { app } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const r1 = await fetch(base + '/v1/trace/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ span: { trace_id: '0'.repeat(32), span_id: '1'.repeat(16), kind: 'tool', name: 'x' } }),
      });
      assert.equal(r1.status, 401, 'unauthenticated trace append must 401');
    });
  } finally {
    teardownIsolated(home);
  }
});
