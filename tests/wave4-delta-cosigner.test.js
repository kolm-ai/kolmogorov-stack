// Agent Security-Review - Wave-4 delta + co-signer integration tests.
//
// Locks the S9 / S11 / polish surface:
//
//   1. S11 NAMED CO-SIGNER (the Reviewed Attestation tier) - a second, named
//      Ed25519 attestation over the SAME signed payload. Adding it does NOT
//      change the canonical bytes (co_signatures is excluded from
//      canonicalizeReport), so the primary signature still verifies; verifyReport
//      surfaces each co-signer; a corrupted co-signature is informational only -
//      the primary signature remains the verdict.
//
//   2. S9 SIGNED DELTA - runDueReattestations stores a drift summary on the new
//      report row, and the PUBLIC GET /v1/trust/:slug/delta route returns the
//      signed drift between a Trust Link's current report and its prior cycle
//      (delta:null + note when there is no prior).
//
//   3. POLISH - the openable GET alias of the seller questionnaire (auth +
//      tenant-fenced), and the clean JSON 404 for an unmatched /v1/audit or
//      /v1/trust GET sub-path.
//
// The route block mounts the audit-routes surface on a minimal Express app with
// NO global auth gate (a tiny test middleware injects req.tenant_record from a
// header), so it exercises THIS module's handlers directly - the delta route is
// public (no auth), the questionnaire alias is auth-gated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave4-test-'));
process.env.KOLM_DATA_DIR = dir;
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ALLOW_JSON_STORE = '1';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
delete process.env.KOLM_TSA_URL;

const { insert, findOne, update } = await import('../src/store.js');
const { runAudit } = await import('../src/audit-orchestrator.js');
const {
  buildAndSignReport, canonicalizeReport, verifyReport, addCoSignature,
} = await import('../src/attestation-report-builder.js');
const { computeAuditDelta } = await import('../src/audit-delta.js');
const { activateSubscription, runDueReattestations, resolvePriorReport } = await import('../src/asr-fulfillment.js');
const { register } = await import('../src/audit-routes.js');
const { generateKeyPair, keyFingerprint } = await import('../src/ed25519.js');

function signerFrom(kp) {
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, key_fingerprint: keyFingerprint(kp.publicKey) };
}

const CLEAN = JSON.stringify({
  request_id: 'ok1', timestamp: '2026-05-01T00:00:00Z', model: 'openai/gpt-4o-2024-08-06',
  user: 'agent-one', metadata: { key_alias: 'k-one' },
  tools: [{ type: 'function', function: { name: 'get_return_policy' } }],
  messages: [
    { role: 'user', content: 'What is your return window?' },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_return_policy', arguments: '{}' } }] },
  ],
});
// The committed dogfood fixture: 0% readiness, ASR-1 blocking, many findings.
const DIRTY = fs.readFileSync(path.join(import.meta.dirname, '..', 'examples', 'agent-audit', 'litellm-export.jsonl'), 'utf8');

// ===========================================================================
// 1) S11 named co-signer (pure, in-process)
// ===========================================================================
test('co-signature: verifies, is excluded from the primary canonical, never flips the verdict', () => {
  const audit = runAudit(DIRTY, { source: 'test' });
  const issuer = signerFrom(generateKeyPair());
  const env = buildAndSignReport(audit, { subject: 'Reviewed Co', tier: 'report', signer: issuer }).envelope;

  assert.equal(verifyReport(env).ok, true, 'issuer-signed report verifies');
  const canonBefore = canonicalizeReport(env);

  const reviewer = signerFrom(generateKeyPair());
  addCoSignature(env, { signer: reviewer, name: 'Jane Reviewer', role: 'Lead Security Reviewer' });

  // Adding a co-signature does NOT change the canonical signed bytes...
  assert.equal(canonicalizeReport(env), canonBefore, 'co_signatures excluded from the canonical payload');
  // ...so the PRIMARY signature still verifies.
  assert.equal(verifyReport(env).ok, true, 'primary signature survives the co-signature');

  assert.ok(Array.isArray(env.co_signatures) && env.co_signatures.length === 1);
  const cs = env.co_signatures[0];
  assert.equal(cs.name, 'Jane Reviewer');
  assert.equal(cs.role, 'Lead Security Reviewer');
  assert.equal(cs.alg, 'ed25519');
  assert.equal(cs.spec, 'kolm-ed25519-v1');
  assert.ok(cs.public_key.includes('BEGIN PUBLIC KEY'), 'co-signature embeds its own public key');
  assert.notEqual(cs.key_fingerprint, env.signature_ed25519.key_fingerprint, 'co-signer key is independent of the issuer key');

  // verifyReport surfaces the co-signer (informational; primary is the verdict).
  const v = verifyReport(env);
  assert.ok(Array.isArray(v.co_signers) && v.co_signers.length === 1);
  assert.equal(v.co_signers[0].ok, true, 'the co-signature verifies against the same payload');
  assert.equal(v.co_signers[0].name, 'Jane Reviewer');
  assert.equal(v.co_signers[0].role, 'Lead Security Reviewer');
  assert.equal(v.co_signers[0].key_fingerprint, cs.key_fingerprint);
});

test('a second co-signer appends without disturbing the first or the primary signature', () => {
  const issuer = signerFrom(generateKeyPair());
  const env = buildAndSignReport(runAudit(DIRTY, { source: 'test' }), { subject: 'Two reviewers', tier: 'report', signer: issuer }).envelope;
  addCoSignature(env, { signer: signerFrom(generateKeyPair()), name: 'First', role: 'A' });
  const canonAfterFirst = canonicalizeReport(env);
  addCoSignature(env, { signer: signerFrom(generateKeyPair()), name: 'Second', role: 'B' });
  assert.equal(canonicalizeReport(env), canonAfterFirst, 'a second co-signature still does not change the signed bytes');
  const v = verifyReport(env);
  assert.equal(v.ok, true);
  assert.equal(v.co_signers.length, 2);
  assert.ok(v.co_signers.every((c) => c.ok === true), 'both co-signatures verify');
});

test('a corrupted co-signature is informational only - the primary verdict stands', () => {
  const issuer = signerFrom(generateKeyPair());
  const env = buildAndSignReport(runAudit(DIRTY, { source: 'test' }), { subject: 'Corrupt cosig', tier: 'report', signer: issuer }).envelope;
  addCoSignature(env, { signer: signerFrom(generateKeyPair()), name: 'Bad', role: 'X' });
  const sig = env.co_signatures[0].signature;
  env.co_signatures[0].signature = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  const v = verifyReport(env);
  assert.equal(v.ok, true, 'primary signature is the verdict; a bad co-sig does not flip it');
  assert.equal(v.co_signers[0].ok, false, 'the bad co-signature is surfaced as not-ok');
});

test('addCoSignature throws NO_SIGNER when no co-signer key is available', () => {
  const env = buildAndSignReport(runAudit(DIRTY, { source: 'test' }), { subject: 'X', tier: 'report', signer: signerFrom(generateKeyPair()) }).envelope;
  let caught = null;
  try { addCoSignature(env, { signer: { privateKey: null, publicKey: null }, name: 'n', role: 'r' }); }
  catch (e) { caught = e; }
  assert.ok(caught && caught.code === 'NO_SIGNER', 'NO_SIGNER thrown with an empty signer');
  assert.ok(!Array.isArray(env.co_signatures) || env.co_signatures.length === 0, 'no partial co-signature attached on failure');
});

// ===========================================================================
// 2) S9 drift storage on re-attestation (in-process)
// ===========================================================================
test('runDueReattestations stores a signed drift summary on the new report row', () => {
  const TENANT = 't_wave4_drift';
  const issuer = signerFrom(generateKeyPair());
  const seedAudit = runAudit(DIRTY, { source: 'import' });
  const seed = buildAndSignReport(seedAudit, { subject: 'Drift fleet', tier: 'report', signer: issuer });
  const SEED_ID = 'audses_wave4drift';
  insert('agent_audits', {
    id: SEED_ID, tenant_id: TENANT, subject: 'Drift fleet', source: 'import',
    status: 'complete', logs: DIRTY, record_count: 2,
    report: seed.envelope, report_id: seed.report_id, summary: seedAudit.summary,
    paid: true, tier: 'report', public: false,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  });
  const ac = activateSubscription({ product: 'starter', tenant_id: TENANT, stripe_subscription_id: 'sub_w4', stripe_customer_id: 'cus_w4' });
  assert.ok(ac.ok && ac.sub.latest_audit_id === SEED_ID, 'subscription seeded from the paid report');

  update('asr_subscriptions', (s) => s.id === ac.sub.id, { next_run_at: '2020-01-01T00:00:00Z' });
  const tick = runDueReattestations({ signer: issuer });
  assert.ok(tick.ran >= 1, 'a re-attestation ran');

  const subAfter = findOne('asr_subscriptions', (s) => s.id === ac.sub.id);
  const latest = findOne('agent_audits', (r) => r.id === subAfter.latest_audit_id);
  assert.notEqual(latest.id, SEED_ID, 'a new report row was produced');
  assert.ok(latest.drift && typeof latest.drift === 'object', 'the new row carries a drift summary');
  assert.equal(typeof latest.drift.regressed, 'boolean');
  assert.equal(latest.drift.from.report_id, seed.report_id, 'drift diffs against the seed report');
  assert.equal(latest.drift.to.report_id, latest.report_id, 'drift to-side is the fresh report');
  // Re-attesting the SAME logs yields no posture change.
  assert.equal(latest.drift.readiness_change, 0);
  assert.equal(latest.drift.regressed, false);

  // resolvePriorReport resolves the seed behind the subscription slug.
  const prior = resolvePriorReport(subAfter.public_slug);
  assert.ok(prior && prior.report_id === seed.report_id, 'prior report resolves to the seed');
});

// ===========================================================================
// 3) Routes (minimal Express mount; no global auth gate)
// ===========================================================================
const TENANT_R = 't_wave4_routes';
const SLUG_SUB = 'wave4subslug00001';
const SLUG_SOLO = 'wave4soloslug0001';
const SESSION_ID = 'audses_wave4_sess';
let server = null;
let base = null;

test('setup: seed store + mount audit routes on a minimal app', async () => {
  const issuer = signerFrom(generateKeyPair());

  // Continuous subscription lineage: a CLEAN seed -> a DIRTY latest report.
  const cleanAudit = runAudit(CLEAN, { source: 'litellm' });
  const cleanRep = buildAndSignReport(cleanAudit, { subject: 'Routes fleet', tier: 'report', signer: issuer });
  insert('agent_audits', {
    id: 'aud_w4_clean', tenant_id: TENANT_R, subject: 'Routes fleet', source: 'litellm',
    status: 'complete', logs: CLEAN, record_count: 1,
    report: cleanRep.envelope, report_id: cleanRep.report_id, summary: cleanAudit.summary,
    paid: true, tier: 'report', public: false,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
  });
  const dirtyAudit = runAudit(DIRTY, { source: 'import' });
  const dirtyRep = buildAndSignReport(dirtyAudit, { subject: 'Routes fleet', tier: 'report', signer: issuer });
  insert('agent_audits', {
    id: 'aud_w4_dirty', tenant_id: TENANT_R, subject: 'Routes fleet', source: 'reattest',
    status: 'complete', logs: DIRTY, record_count: 2,
    report: dirtyRep.envelope, report_id: dirtyRep.report_id, summary: dirtyAudit.summary,
    paid: true, tier: 'report', public: false, subscription_id: 'sub_w4_routes',
    created_at: '2026-06-08T00:00:00Z', updated_at: '2026-06-08T00:00:00Z',
  });
  insert('asr_subscriptions', {
    id: 'sub_w4_routes', tenant_id: TENANT_R, product_key: 'starter', status: 'active',
    cadence: 'weekly', public_slug: SLUG_SUB, source_audit_id: 'aud_w4_clean',
    latest_audit_id: 'aud_w4_dirty', last_run_at: '2026-06-08T00:00:00Z',
    next_run_at: '2026-06-15T00:00:00Z', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-08T00:00:00Z',
  });

  // A standalone $750 paid report (no subscription) -> a Trust Link with no prior.
  insert('agent_audits', {
    id: 'aud_w4_solo', tenant_id: TENANT_R, subject: 'Solo fleet', source: 'import',
    status: 'complete', logs: DIRTY, record_count: 2,
    report: dirtyRep.envelope, report_id: dirtyRep.report_id, summary: dirtyAudit.summary,
    paid: true, tier: 'report', public: true, public_slug: SLUG_SOLO,
    created_at: '2026-06-02T00:00:00Z', updated_at: '2026-06-02T00:00:00Z',
  });

  // A session with a signed report for the questionnaire alias.
  insert('agent_audits', {
    id: SESSION_ID, tenant_id: TENANT_R, subject: 'Session fleet', source: 'import',
    status: 'complete', logs: DIRTY, record_count: 2,
    report: dirtyRep.envelope, report_id: dirtyRep.report_id, summary: dirtyAudit.summary,
    created_at: '2026-06-03T00:00:00Z', updated_at: '2026-06-03T00:00:00Z',
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const t = req.headers['x-test-tenant'];
    if (t) req.tenant_record = { id: String(t) };
    next();
  });
  register(app, { authMiddleware: (req, res, next) => next() });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test('GET /v1/trust/:slug/delta (PUBLIC) returns the signed drift between cycles', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_SUB}/delta`);
  assert.equal(r.status, 200, 'public delta link reachable without a key');
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'continuous');
  assert.ok(j.delta && typeof j.delta === 'object', 'a continuous link with history returns a delta');
  assert.equal(j.delta.regressed, true, 'clean -> dirty regressed');
  assert.ok(j.delta.findings_added.length >= 1, 'findings appeared');
  assert.ok(j.delta.controls_changed.some((c) => c.id === 'ASR-1'), 'ASR-1 transition reported');
  assert.ok(j.delta.readiness_change < 0, 'readiness dropped');
});

test('GET /v1/trust/:slug/delta returns delta:null + note when there is no prior', async () => {
  const r = await fetch(`${base}/v1/trust/${SLUG_SOLO}/delta`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.delta, null, 'a standalone report has no prior to diff');
  assert.match(j.note, /no prior|first attestation/i);
});

test('GET /v1/trust/:slug/delta 404s with a JSON error for an unknown slug', async () => {
  const r = await fetch(`${base}/v1/trust/nope_nope_nope/delta`);
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type') || '', /application\/json/, 'an unknown slug returns JSON, not HTML');
  const j = await r.json();
  assert.equal(j.ok, false);
});

test('GET /v1/audit/sessions/:id/questionnaire alias is auth-gated, tenant-fenced, and openable', async () => {
  // No auth -> 401.
  const anon = await fetch(`${base}/v1/audit/sessions/${SESSION_ID}/questionnaire`);
  assert.equal(anon.status, 401, 'the alias requires auth');

  // A different tenant -> 404 (tenant-fenced).
  const other = await fetch(`${base}/v1/audit/sessions/${SESSION_ID}/questionnaire`, { headers: { 'x-test-tenant': 't_wave4_other' } });
  assert.equal(other.status, 404, 'a non-owner cannot reach the session');

  // The owner -> 200 with cited answers.
  const owner = await fetch(`${base}/v1/audit/sessions/${SESSION_ID}/questionnaire?template=generic-ai-vendor`, { headers: { 'x-test-tenant': TENANT_R } });
  assert.equal(owner.status, 200, 'the owner can open the questionnaire over GET');
  const j = await owner.json();
  assert.equal(j.ok, true);
  assert.equal(j.template, 'generic-ai-vendor');
  assert.ok(Array.isArray(j.answers) && j.answers.length >= 1, 'answers returned');

  // CSV form via the alias.
  const csv = await fetch(`${base}/v1/audit/sessions/${SESSION_ID}/questionnaire?format=csv`, { headers: { 'x-test-tenant': TENANT_R } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
});

test('JSON 404 fallback covers unmatched /v1/audit and /v1/trust GET sub-paths', async () => {
  for (const p of ['/v1/audit/does-not-exist', '/v1/trust/someslug/bogus-subpath']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, `${p} is 404`);
    assert.match(r.headers.get('content-type') || '', /application\/json/, `${p} returns JSON not HTML`);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error, 'not_found');
  }
});

test('teardown', async () => {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch { /* best effort */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
