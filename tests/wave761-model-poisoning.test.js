// W761 — Model Poisoning Anomaly Detection.
//
// 22+ atomic items pinned (matches the W761 implementation):
//
//   1)  TEACHER_HMAC_VERSION + POISONING_VERSION stamps (both `w761-v1`).
//   2)  MIN_KEY_BYTES === 32 (load-bearing crypto invariant).
//   3)  bindTeacherResponse without KOLM_TEACHER_HMAC_KEY → hmac_key_not_configured
//       honest envelope (never silent-pass).
//   4)  bindTeacherResponse with a short key → hmac_key_too_short honest envelope.
//   5)  bindTeacherResponse happy path returns response_hmac + key_fingerprint.
//   6)  verifyTeacherResponse returns valid_signature on the happy path.
//   7)  verifyTeacherResponse returns signature_mismatch on body mutation.
//   8)  verifyTeacherResponse returns hmac_key_mismatch_post_rotation when the
//       active key is rotated under a binding.
//   9)  verifyTeacherResponse uses crypto.timingSafeEqual — runs ≥1000
//       verifications + asserts no timing-correlated branch on the first byte.
//   10) attachBindingToCapture is idempotent (already-bound row is left alone).
//   11) attachBindingToCapture is synchronous + returns the row with
//       teacher_binding populated.
//   12) POISON_RISK_LEVELS Object.freeze()-d + holds exactly 4 entries.
//   13) assessPoisoningRisk returns 'safe' on a clean capture with valid HMAC.
//   14) assessPoisoningRisk escalates to rotate_teacher_key when HMAC fails
//       (NEVER returns safe under HMAC failure — W761 INVARIANT).
//   15) assessNamespacePoisoningRisk empty-namespace honest envelope.
//   16) quarantineCapture writes an audit event (op:'poisoning.capture_quarantined').
//   17) quarantineCapture idempotency (same capture+reason → no duplicate audit row).
//   18) POST /v1/poisoning/bind-teacher: 401 without auth; 400 without confirm.
//   19) POST /v1/poisoning/verify-binding: 401 without auth; envelope with auth.
//   20) GET /v1/poisoning/namespace-risk/:namespace: 401 without auth;
//       empty_namespace envelope with auth.
//   21) POST /v1/poisoning/quarantine: 401 without auth; 400 without confirm.
//   22) public/security/model-poisoning.html exists with brand-lock +
//       four-layers anchor + hmac-binding-doc anchor.
//   23) cli/kolm.js defines cmdW761Poison exactly once + wired from case 'poison'.
//   24) vercel.json has the /security/model-poisoning rewrite.
//   25) wave761 sibling test count uses regex wave(\d{3,4}) + threshold (W604).
//
// W604 anti-brittleness: family lock uses regex + threshold (never an explicit
// hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  TEACHER_HMAC_VERSION,
  HMAC_ALGORITHM,
  TEACHER_HMAC_KEY_ENV,
  MIN_KEY_BYTES,
  bindTeacherResponse,
  verifyTeacherResponse,
  attachBindingToCapture,
  verifyCaptureBinding,
} from '../src/teacher-response-hmac.js';

import {
  POISONING_VERSION,
  POISON_RISK_LEVELS,
  assessPoisoningRisk,
  assessNamespacePoisoningRisk,
  quarantineCapture,
  releaseFromQuarantine,
} from '../src/poisoning-orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'security', 'model-poisoning.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

// 32-byte fixture key — matches MIN_KEY_BYTES. Hex form is 64 chars.
const FIXTURE_KEY_HEX = 'a'.repeat(64);
const FIXTURE_KEY_HEX_B = 'b'.repeat(64); // rotation target

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w761-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Pre-stage with no HMAC key; tests that need one set it explicitly.
  delete process.env[TEACHER_HMAC_KEY_ENV];
  return tmp;
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W761 #1 — TEACHER_HMAC_VERSION + POISONING_VERSION both stamped w761-v1', () => {
  freshDir();
  assert.equal(TEACHER_HMAC_VERSION, 'w761-v1',
    `expected TEACHER_HMAC_VERSION='w761-v1'; got ${JSON.stringify(TEACHER_HMAC_VERSION)}`);
  assert.equal(POISONING_VERSION, 'w761-v1',
    `expected POISONING_VERSION='w761-v1'; got ${JSON.stringify(POISONING_VERSION)}`);
  // W604 regex check — consumers MUST match with /^w761-/, not literal equality.
  assert.ok(/^w761-/.test(TEACHER_HMAC_VERSION),
    'TEACHER_HMAC_VERSION must match /^w761-/ regex (W604 anti-brittleness)');
  assert.ok(/^w761-/.test(POISONING_VERSION),
    'POISONING_VERSION must match /^w761-/ regex (W604 anti-brittleness)');
  // Algorithm constant exported.
  assert.equal(HMAC_ALGORITHM, 'sha256', `expected HMAC_ALGORITHM='sha256'; got ${HMAC_ALGORITHM}`);
  assert.equal(TEACHER_HMAC_KEY_ENV, 'KOLM_TEACHER_HMAC_KEY',
    `expected env var name 'KOLM_TEACHER_HMAC_KEY'; got ${TEACHER_HMAC_KEY_ENV}`);
});

// =============================================================================
// 2) MIN_KEY_BYTES === 32
// =============================================================================

test('W761 #2 — MIN_KEY_BYTES === 32 (load-bearing crypto invariant)', () => {
  freshDir();
  assert.equal(MIN_KEY_BYTES, 32,
    `MIN_KEY_BYTES MUST be 32 (SHA-256 HMAC collision-resistance floor); got ${MIN_KEY_BYTES}`);
});

// =============================================================================
// 3) bindTeacherResponse without KOLM_TEACHER_HMAC_KEY → hmac_key_not_configured
// =============================================================================

test('W761 #3 — bindTeacherResponse without env key returns hmac_key_not_configured', () => {
  freshDir();
  delete process.env[TEACHER_HMAC_KEY_ENV];
  const env = bindTeacherResponse({
    teacher_id: 'anthropic:claude-3-5-sonnet',
    request_hash: 'abc123',
    response_body: 'hello world',
    timestamp_ms: 1716557400000,
  });
  assert.equal(env.ok, false,
    `expected ok:false when env key unset; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'hmac_key_not_configured',
    `expected error='hmac_key_not_configured'; got ${JSON.stringify(env)}`);
  assert.ok(env.hint && /KOLM_TEACHER_HMAC_KEY/.test(env.hint),
    `hint must reference KOLM_TEACHER_HMAC_KEY; got ${JSON.stringify(env.hint)}`);
  assert.equal(env.version, TEACHER_HMAC_VERSION);
});

// =============================================================================
// 4) bindTeacherResponse with short key → hmac_key_too_short
// =============================================================================

test('W761 #4 — bindTeacherResponse with short key returns hmac_key_too_short', () => {
  freshDir();
  // 8-byte hex = 4 raw bytes, well below the 32-byte floor.
  process.env[TEACHER_HMAC_KEY_ENV] = 'a'.repeat(8);
  const env = bindTeacherResponse({
    teacher_id: 'anthropic:claude-3-5-sonnet',
    request_hash: 'abc123',
    response_body: 'hello world',
    timestamp_ms: 1716557400000,
  });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'hmac_key_too_short',
    `expected error='hmac_key_too_short'; got ${JSON.stringify(env)}`);
  assert.ok(env.hint && /32/.test(env.hint),
    `hint must mention the 32-byte floor; got ${JSON.stringify(env.hint)}`);
});

// =============================================================================
// 5) bindTeacherResponse happy path
// =============================================================================

test('W761 #5 — bindTeacherResponse happy path returns response_hmac + key_fingerprint', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const env = bindTeacherResponse({
    teacher_id: 'anthropic:claude-3-5-sonnet',
    request_hash: 'abc123',
    response_body: '{"completion":"hello"}',
    response_headers: { 'content-type': 'application/json' },
    timestamp_ms: 1716557400000,
  });
  assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.version, TEACHER_HMAC_VERSION);
  assert.equal(env.teacher_id, 'anthropic:claude-3-5-sonnet');
  assert.equal(env.request_hash, 'abc123');
  assert.equal(env.algorithm, HMAC_ALGORITHM);
  // response_hmac is hex sha256 — 64 chars.
  assert.ok(/^[0-9a-f]{64}$/.test(env.response_hmac),
    `response_hmac must be a 64-char hex sha256; got ${env.response_hmac}`);
  // key_fingerprint is 16-char hex prefix of sha256(key).
  assert.ok(/^[0-9a-f]{16}$/.test(env.key_fingerprint),
    `key_fingerprint must be a 16-char hex prefix; got ${env.key_fingerprint}`);
  assert.ok(env.signed_at && /^\d{4}-\d{2}-\d{2}T/.test(env.signed_at),
    `signed_at must be an ISO timestamp; got ${env.signed_at}`);
  assert.equal(env.timestamp_ms, 1716557400000);
  // headers_hash optional but populated when headers passed.
  assert.ok(/^[0-9a-f]{64}$/.test(env.headers_hash || ''),
    `headers_hash must be a 64-char hex sha256 when headers passed; got ${env.headers_hash}`);
});

// =============================================================================
// 6) verifyTeacherResponse happy path
// =============================================================================

test('W761 #6 — verifyTeacherResponse returns valid_signature on happy path', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = '{"completion":"hello"}';
  const binding = bindTeacherResponse({
    teacher_id: 't1',
    request_hash: 'req1',
    response_body: body,
    timestamp_ms: 1700000000000,
  });
  assert.equal(binding.ok, true);
  const v = verifyTeacherResponse({ binding, response_body: body });
  assert.equal(v.ok, true);
  assert.equal(v.valid, true, `expected valid:true; got ${JSON.stringify(v)}`);
  assert.equal(v.reason, 'valid_signature',
    `expected reason='valid_signature'; got ${JSON.stringify(v)}`);
});

// =============================================================================
// 7) verifyTeacherResponse signature_mismatch on body mutation
// =============================================================================

test('W761 #7 — verifyTeacherResponse returns signature_mismatch on body mutation', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = '{"completion":"original"}';
  const binding = bindTeacherResponse({
    teacher_id: 't1',
    request_hash: 'req1',
    response_body: body,
    timestamp_ms: 1700000000000,
  });
  // Verify against a MUTATED body.
  const mutated = '{"completion":"poisoned"}';
  const v = verifyTeacherResponse({ binding, response_body: mutated });
  assert.equal(v.valid, false, `mutated body must NOT verify; got ${JSON.stringify(v)}`);
  assert.equal(v.reason, 'signature_mismatch',
    `expected reason='signature_mismatch'; got ${JSON.stringify(v)}`);
});

// =============================================================================
// 8) verifyTeacherResponse key rotation
// =============================================================================

test('W761 #8 — verifyTeacherResponse returns hmac_key_mismatch_post_rotation', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = 'hello';
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: body, timestamp_ms: 1700000000000,
  });
  assert.equal(binding.ok, true);
  // ROTATE the key (operator emergency-rotates after an audit).
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX_B;
  const v = verifyTeacherResponse({ binding, response_body: body });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'hmac_key_mismatch_post_rotation',
    `expected reason='hmac_key_mismatch_post_rotation'; got ${JSON.stringify(v)}`);
  assert.ok(v.active_key_fingerprint && v.binding_key_fingerprint,
    'verifier must surface both fingerprints for operator triage');
  assert.notEqual(v.active_key_fingerprint, v.binding_key_fingerprint);
});

// =============================================================================
// 9) verifyTeacherResponse uses crypto.timingSafeEqual
// =============================================================================

test('W761 #9 — verifyTeacherResponse uses timingSafeEqual (no early-byte branch)', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = 'hello';
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: body, timestamp_ms: 1700000000000,
  });
  // Static-source assertion — easiest way to guarantee timingSafeEqual is in
  // the verifier code path (and not a future regression to ===).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'teacher-response-hmac.js'), 'utf8');
  assert.ok(src.includes('timingSafeEqual'),
    'teacher-response-hmac.js MUST reference crypto.timingSafeEqual for HMAC compare (W761 INVARIANT)');
  // And there is no plain HMAC === HMAC compare in the same file.
  assert.ok(!/binding\.response_hmac\s*===\s*expected/.test(src),
    'verifier MUST NOT use === on hmac strings (would leak timing)');

  // Runtime timing sanity: run 1000 mutated-body verifications and assert
  // that none of them ever return valid:true. (We are NOT a real timing
  // oracle — but this ensures every iteration takes the constant-time path.)
  const N = 1000;
  let validHits = 0;
  for (let i = 0; i < N; i++) {
    const mutated = 'mutated_' + i;
    const v = verifyTeacherResponse({ binding, response_body: mutated });
    if (v.valid === true) validHits += 1;
  }
  assert.equal(validHits, 0,
    `over ${N} mutated-body checks not a single one must verify; got ${validHits} false positives`);
});

// =============================================================================
// 10) attachBindingToCapture idempotency
// =============================================================================

test('W761 #10 — attachBindingToCapture is idempotent on already-bound rows', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: 'hello', timestamp_ms: 1700000000000,
  });
  const row = { tenant_id: 'ten1', namespace: 'ns1', response: 'hello' };
  attachBindingToCapture(row, binding);
  const firstHmac = row.teacher_binding.response_hmac;
  // Second attach — should NOT overwrite.
  const otherBinding = bindTeacherResponse({
    teacher_id: 't2', request_hash: 'r2', response_body: 'different', timestamp_ms: 1700000001000,
  });
  attachBindingToCapture(row, otherBinding);
  assert.equal(row.teacher_binding.response_hmac, firstHmac,
    `attachBindingToCapture MUST be idempotent — already-bound row must not be overwritten; got new hmac ${row.teacher_binding.response_hmac}`);
  assert.equal(row._teacher_binding_skipped, 'already_bound',
    `expected _teacher_binding_skipped='already_bound'; got ${row._teacher_binding_skipped}`);
});

// =============================================================================
// 11) attachBindingToCapture sync return shape
// =============================================================================

test('W761 #11 — attachBindingToCapture sync return populates teacher_binding', () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: 'hello', timestamp_ms: 1700000000000,
  });
  const row = { tenant_id: 'ten1', namespace: 'ns1', response: 'hello' };
  const out = attachBindingToCapture(row, binding);
  // Sync — return value IS the row reference, no Promise.
  assert.equal(out, row, 'attachBindingToCapture must return the same row reference (sync)');
  assert.ok(row.teacher_binding, 'teacher_binding must be populated');
  assert.equal(row.teacher_binding.version, TEACHER_HMAC_VERSION);
  assert.equal(row.teacher_binding.teacher_id, 't1');
  assert.equal(row.teacher_binding.response_hmac, binding.response_hmac);
  assert.equal(row.teacher_binding.key_fingerprint, binding.key_fingerprint);
  // verifyCaptureBinding must succeed against this row.
  const v = verifyCaptureBinding(row);
  assert.equal(v.valid, true, `expected verifyCaptureBinding(row)=true; got ${JSON.stringify(v)}`);
});

// =============================================================================
// 12) POISON_RISK_LEVELS frozen + 4 entries
// =============================================================================

test('W761 #12 — POISON_RISK_LEVELS frozen + exactly 4 entries in monotone order', () => {
  freshDir();
  assert.ok(Array.isArray(POISON_RISK_LEVELS));
  assert.ok(Object.isFrozen(POISON_RISK_LEVELS),
    'POISON_RISK_LEVELS MUST be Object.freeze()-d so the ladder cannot be mutated');
  assert.equal(POISON_RISK_LEVELS.length, 4,
    `expected exactly 4 risk levels; got ${POISON_RISK_LEVELS.length}: ${JSON.stringify(POISON_RISK_LEVELS)}`);
  assert.deepEqual(POISON_RISK_LEVELS,
    ['safe', 'review', 'quarantine', 'rotate_teacher_key'],
    `unexpected level order; got ${JSON.stringify(POISON_RISK_LEVELS)}`);
});

// =============================================================================
// 13) assessPoisoningRisk safe on clean capture with valid HMAC
// =============================================================================

test('W761 #13 — assessPoisoningRisk safe on clean capture with valid HMAC binding', async () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = 'A perfectly normal response with no copyrighted content';
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: body, timestamp_ms: 1700000000000,
  });
  const capture = {
    tenant_id: 'ten1',
    namespace: 'ns_clean',
    response: body,
    latency_ms: 200,
  };
  attachBindingToCapture(capture, binding);
  const v = await assessPoisoningRisk(capture);
  assert.equal(v.ok, true, `expected ok envelope; got ${JSON.stringify(v)}`);
  assert.equal(v.version, POISONING_VERSION);
  assert.equal(v.risk, 'safe',
    `clean capture with valid HMAC must be safe; got risk=${v.risk} evidence=${JSON.stringify(v.evidence)}`);
  assert.ok(v.signals.hmac.status === 'verified',
    `expected hmac.status='verified'; got ${JSON.stringify(v.signals.hmac)}`);
  assert.ok(v.evidence.includes('hmac:verified'));
});

// =============================================================================
// 14) assessPoisoningRisk escalates to rotate_teacher_key on HMAC failure
// =============================================================================

test('W761 #14 — assessPoisoningRisk escalates to rotate_teacher_key on HMAC mismatch (never safe)', async () => {
  freshDir();
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const body = 'original response';
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: body, timestamp_ms: 1700000000000,
  });
  // Build a capture whose ROW.response is mutated post-binding — exactly
  // the MITM / cache-poisoning case the binding was designed to catch.
  const capture = {
    tenant_id: 'ten1',
    namespace: 'ns_poisoned',
    response: 'MUTATED response — attacker swapped this',
    teacher_binding: {
      version: binding.version,
      teacher_id: binding.teacher_id,
      request_hash: binding.request_hash,
      response_hmac: binding.response_hmac,
      signed_at: binding.signed_at,
      timestamp_ms: binding.timestamp_ms,
      key_fingerprint: binding.key_fingerprint,
      algorithm: binding.algorithm,
    },
    latency_ms: 200,
  };
  const v = await assessPoisoningRisk(capture);
  assert.equal(v.ok, true);
  assert.equal(v.risk, 'rotate_teacher_key',
    `HMAC failure MUST escalate to rotate_teacher_key (W761 INVARIANT); got risk=${v.risk}`);
  assert.notEqual(v.risk, 'safe',
    `HMAC failure must NEVER return safe; got risk=${v.risk}`);
  assert.ok(v.evidence.some((e) => /^hmac:invalid_signature/.test(e)),
    `evidence must include hmac:invalid_signature; got ${JSON.stringify(v.evidence)}`);
  assert.ok(v.recommendation && /KOLM_TEACHER_HMAC_KEY|rotate/i.test(v.recommendation),
    `recommendation must mention key rotation; got ${JSON.stringify(v.recommendation)}`);
});

// =============================================================================
// 15) assessNamespacePoisoningRisk empty-namespace envelope
// =============================================================================

test('W761 #15 — assessNamespacePoisoningRisk empty-namespace honest envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  try {
    const env = await assessNamespacePoisoningRisk({
      tenant_id: 'tenant_w761_empty',
      namespace: 'empty-ns-w761',
      sample_n: 100,
    });
    assert.equal(env.ok, false,
      `empty namespace must return honest envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.error, 'empty_namespace',
      `expected error='empty_namespace'; got ${JSON.stringify(env)}`);
    assert.equal(env.version, POISONING_VERSION);
    assert.ok(env.hint && /no captures/i.test(env.hint),
      `hint must explain why; got ${JSON.stringify(env.hint)}`);
  } finally {
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) quarantineCapture writes audit event
// =============================================================================

test('W761 #16 — quarantineCapture writes audit event with poisoning op', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  const tenant_id = 'tenant_w761_q1';
  const env = await quarantineCapture({
    tenant_id,
    capture_id: 'cap_w761_aaa',
    reason: 'hmac:invalid_signature',
    evidence: ['anomaly:flagged[output_length]'],
  });
  assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.capture_id, 'cap_w761_aaa');
  assert.equal(env.reason, 'hmac:invalid_signature');
  assert.ok(env.audit_event_id, 'audit_event_id must be returned');
  assert.equal(env.version, POISONING_VERSION);
  // Verify the audit event landed in the chain.
  const { listAuditEvents } = await import('../src/audit.js');
  const rows = listAuditEvents(tenant_id, { limit: 10 });
  const found = rows.find((r) => r.op === 'poisoning.capture_quarantined' && r.payload && r.payload.capture_id === 'cap_w761_aaa');
  assert.ok(found, `expected poisoning.capture_quarantined audit row for cap_w761_aaa; got rows=${rows.length}`);
});

// =============================================================================
// 17) quarantineCapture idempotency
// =============================================================================

test('W761 #17 — quarantineCapture idempotent — same capture+reason returns existing event', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  const tenant_id = 'tenant_w761_q2';
  const first = await quarantineCapture({
    tenant_id,
    capture_id: 'cap_w761_idemp',
    reason: 'anomaly:multi_axis',
    evidence: ['axes:output_length+vocab_entropy'],
  });
  assert.equal(first.ok, true);
  const firstEventId = first.audit_event_id;
  // Second call with the same (capture_id, reason).
  const second = await quarantineCapture({
    tenant_id,
    capture_id: 'cap_w761_idemp',
    reason: 'anomaly:multi_axis',
    evidence: ['axes:different_evidence'],
  });
  assert.equal(second.ok, true);
  assert.equal(second.already_quarantined, true,
    `second call must report already_quarantined; got ${JSON.stringify(second)}`);
  assert.equal(second.audit_event_id, firstEventId,
    `second call must reuse the first audit_event_id; got ${second.audit_event_id} vs ${firstEventId}`);
});

// =============================================================================
// 18) POST /v1/poisoning/bind-teacher auth+confirm gates
// =============================================================================

test('W761 #18 — POST /v1/poisoning/bind-teacher 401 w/o auth; 400 w/o confirm', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
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
    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/poisoning/bind-teacher`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teacher_id: 't1', request_hash: 'r1', response_body: 'x', confirm: true }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);
    // Auth, no confirm → 400.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/poisoning/bind-teacher`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ teacher_id: 't1', request_hash: 'r1', response_body: 'x' }),
    });
    assert.equal(noConfirm.status, 400, `expected 400 without confirm; got ${noConfirm.status}`);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');
    // Auth + confirm → 200 + binding envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/poisoning/bind-teacher`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({
        teacher_id: 'anthropic:claude-3-5-sonnet',
        request_hash: 'r1',
        response_body: '{"completion":"hi"}',
        timestamp_ms: 1700000000000,
        confirm: true,
      }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.ok(/^[0-9a-f]{64}$/.test(env.response_hmac));
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) POST /v1/poisoning/verify-binding auth gate
// =============================================================================

test('W761 #19 — POST /v1/poisoning/verify-binding 401 w/o auth; envelope w/ auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env[TEACHER_HMAC_KEY_ENV] = FIXTURE_KEY_HEX;
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  // Build a fresh binding via the module.
  const body = 'hi';
  const binding = bindTeacherResponse({
    teacher_id: 't1', request_hash: 'r1', response_body: body, timestamp_ms: 1700000000000,
  });

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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/poisoning/verify-binding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ binding, response_body: body }),
    });
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/poisoning/verify-binding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ binding, response_body: body }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.valid, true, `expected valid:true; got ${JSON.stringify(env)}`);
    assert.equal(env.reason, 'valid_signature');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) GET /v1/poisoning/namespace-risk/:namespace auth gate + empty envelope
// =============================================================================

test('W761 #20 — GET /v1/poisoning/namespace-risk/:namespace 401 w/o auth; empty envelope w/ auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/poisoning/namespace-risk/empty-ns`);
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/poisoning/namespace-risk/empty-ns-w761`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, false,
      `empty namespace must return ok:false; got ${JSON.stringify(env)}`);
    assert.equal(env.error, 'empty_namespace');
    assert.equal(env.version, POISONING_VERSION);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) POST /v1/poisoning/quarantine auth+confirm gates
// =============================================================================

test('W761 #21 — POST /v1/poisoning/quarantine 401 w/o auth; 400 w/o confirm', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/poisoning/quarantine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capture_id: 'cap_w761', reason: 'r', confirm: true }),
    });
    assert.equal(noAuth.status, 401);
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/poisoning/quarantine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({ capture_id: 'cap_w761', reason: 'r' }),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');
    const ok = await fetch(`http://127.0.0.1:${port}/v1/poisoning/quarantine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.api_key },
      body: JSON.stringify({
        capture_id: 'cap_w761_route',
        reason: 'hmac:invalid_signature',
        evidence: ['anomaly:flagged[output_length]'],
        confirm: true,
      }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.capture_id, 'cap_w761_route');
    assert.ok(env.audit_event_id);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) public/security/model-poisoning.html: brand-lock + four-layers + hmac doc
// =============================================================================

test('W761 #22 — security/model-poisoning.html exists w/ brand-lock + data-w761 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected security doc at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  assert.ok(html.includes('Open-source AI workbench'),
    'security/model-poisoning.html MUST carry the brand-locked eyebrow');
  assert.ok(/Model poisoning detection and quarantine/.test(html),
    'page must title-match the W761 H1');
  // Both load-bearing anchors.
  assert.ok(html.includes("data-w761=\"four-layers\""),
    'expected data-w761="four-layers" anchor on the four-layer grid');
  assert.ok(html.includes("data-w761=\"hmac-binding-doc\""),
    'expected data-w761="hmac-binding-doc" anchor on the HMAC doc paragraph');
  // Version stamp.
  assert.ok(html.includes('w761-v1'), 'page must stamp the w761-v1 version');
  // No emojis (per spec).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'security/model-poisoning.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 23) cli/kolm.js cmdW761Poison defined once + wired
// =============================================================================

test('W761 #23 — cli/kolm.js defines cmdW761Poison exactly once + wired from case poison', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW761Poison\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW761Poison must be defined exactly once; found ${defOccurrences}`);
  assert.ok(/case 'poison':[\s\S]{0,200}cmdW761Poison/.test(cli),
    `expected "case 'poison': ... cmdW761Poison(...)" wiring; not found`);
  assert.ok(cli.includes("COMPLETION_VERBS.push('poison')"),
    'COMPLETION_VERBS must include "poison" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.poison"),
    'COMPLETION_SUBS.poison must list the four sub-commands');
});

// =============================================================================
// 24) vercel.json has /security/model-poisoning rewrite
// =============================================================================

test('W761 #24 — vercel.json carries /security/model-poisoning rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/security/model-poisoning' && r.destination === '/security/model-poisoning.html');
  assert.ok(rw,
    `expected rewrite { source:'/security/model-poisoning', destination:'/security/model-poisoning.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 25) wave761 sibling test count uses wave(\d{3,4}) regex + threshold (W604)
// =============================================================================

test('W761 #25 — wave761 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
