// W714 - direct contract test for src/poisoning-orchestrator.js.
//
// The poisoning orchestrator combines anomaly, copyright, and teacher-HMAC
// signals into a training safety decision. This test pins the public boundary:
// monotone HMAC escalation, bounded capture scanning, redacted detector
// details, safe namespace/capture IDs, and audit payload sanitization.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  POISONING_CONTRACT_VERSION,
  POISONING_LIMITS,
  POISONING_VERSION,
  assessNamespacePoisoningRisk,
  assessPoisoningRisk,
  quarantineCapture,
  releaseFromQuarantine,
} from '../src/poisoning-orchestrator.js';
import { bindTeacherResponse, attachBindingToCapture } from '../src/teacher-response-hmac.js';
import * as store from '../src/store.js';

const HEX_64 = /^[a-f0-9]{64}$/;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w714-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'w714-receipt-secret-32-byte-minimum';
  process.env.KOLM_TEACHER_HMAC_KEY = crypto.createHash('sha256').update('w714-teacher-key').digest('hex');
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  try { store.reset(); } catch (_) {}
  return tmp;
}

function requestHash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

test('W714 poisoning orchestrator is wired into the direct depth verifier', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../src/poisoning-orchestrator.js', import.meta.url), 'utf8');

  assert.match(POISONING_VERSION, /^w761-/);
  assert.equal(POISONING_CONTRACT_VERSION, 'w714-v1');
  assert.equal(
    pkg.scripts['verify:poisoning-orchestrator'],
    'node --test --test-concurrency=1 tests/wave714-poisoning-orchestrator-contract.test.js',
  );
  assert.ok(
    pkg.scripts['verify:depth'].includes('verify:openai-finetune-importer && npm run verify:poisoning-orchestrator && node --test'),
    'verify:depth must run poisoning-orchestrator before the federated foundation bundle',
  );
  assert.ok(POISONING_LIMITS.max_capture_text_chars <= 65_536);
  assert.ok(POISONING_LIMITS.max_evidence_items <= 16);
  assert.match(source, /POISONING_CONTRACT_VERSION/);
  assert.match(source, /_publicCopyrightDetail/);
});

test('W714 invalid teacher HMAC always escalates without leaking raw response content', async () => {
  freshDir();
  const binding = bindTeacherResponse({
    teacher_id: 'anthropic:claude-sonnet',
    request_hash: requestHash('prompt'),
    response_body: 'safe teacher answer',
    timestamp_ms: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(binding.ok, true, JSON.stringify(binding));
  const capture = attachBindingToCapture({
    tenant_id: 'tenant_w714',
    namespace: 'support',
    response: 'evil injected body alice@example.com ghp_abcdefghijklmnopqrst',
  }, binding);

  const out = await assessPoisoningRisk(capture);
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.risk, 'rotate_teacher_key');
  assert.ok(out.evidence.includes('hmac:invalid_signature'));
  assert.equal(out.signals.hmac.status, 'invalid_signature');
  assert.equal(out.signals.hmac.detail.reason, 'signature_mismatch');
  assert.doesNotMatch(json, /evil injected body/);
  assert.doesNotMatch(json, /alice@example\.com/);
  assert.doesNotMatch(json, /ghp_abcdefghijklmnopqrst/);
});

test('W714 copyright and oversized capture paths return bounded public summaries', async () => {
  freshDir();
  const out = await assessPoisoningRisk({
    tenant_id: 'tenant_w714',
    namespace: 'support',
    prompt: 'please inspect this file',
    response: 'Copyright (c) 2026 VerySecretCorp alice@example.com ' + 'x'.repeat(POISONING_LIMITS.max_capture_text_chars + 50),
  });
  const json = JSON.stringify(out);

  assert.equal(out.ok, true);
  assert.equal(out.contract_version, POISONING_CONTRACT_VERSION);
  assert.equal(out.capture_truncated, true);
  assert.equal(out.signals.copyright.hit, true);
  assert.equal(out.signals.copyright.detail.hit_count, 1);
  assert.deepEqual(out.signals.copyright.detail.hit_kinds, ['code_copyright']);
  assert.equal(out.signals.copyright.detail.hits, undefined);
  assert.doesNotMatch(json, /VerySecretCorp/);
  assert.doesNotMatch(json, /alice@example\.com/);
  assert.ok(json.length < 8000, 'public envelope must stay compact');
});

test('W714 namespace sweep hashes unsafe namespace text and caps sample_n', async () => {
  freshDir();
  const out = await assessNamespacePoisoningRisk({
    tenant_id: 'tenant_w714',
    namespace: '../private/alice@example.com',
    sample_n: 999999,
  });
  const json = JSON.stringify(out);

  assert.equal(out.ok, false);
  assert.equal(out.error, 'empty_namespace');
  assert.equal(out.sample_n, 1000);
  assert.match(out.namespace, /^ns_[a-f0-9]{24}$/);
  assert.match(out.namespace_hash, HEX_64);
  assert.doesNotMatch(json, /alice@example\.com/);
  assert.doesNotMatch(json, /\.\.\/private/);
  assert.match(out.hint, /tenant_hash=/);
});

test('W714 quarantine audit payload sanitizes evidence and is idempotent', async () => {
  freshDir();
  const evidence = [
    'alice@example.com 123-45-6789 ghp_abcdefghijklmnopqrst C:\\Users\\alice\\secret.txt',
    ...Array.from({ length: POISONING_LIMITS.max_evidence_items + 5 }, (_, i) => `extra-${i}`),
  ];
  const first = await quarantineCapture({
    tenant_id: 'tenant_w714',
    capture_id: 'cap_w714_001',
    reason: 'manual review',
    evidence,
  });
  const second = await quarantineCapture({
    tenant_id: 'tenant_w714',
    capture_id: 'cap_w714_001',
    reason: 'manual review',
    evidence: ['different raw evidence should not duplicate'],
  });
  const rows = store.all('audit_events').filter((row) => row.op === 'poisoning.capture_quarantined');

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.already_quarantined, true);
  assert.equal(rows.length, 1);
  assert.match(first.capture_id_hash, HEX_64);
  const payload = rows[0].payload;
  const payloadJson = JSON.stringify(payload);
  assert.equal(payload.contract_version, POISONING_CONTRACT_VERSION);
  assert.equal(payload.evidence.length, POISONING_LIMITS.max_evidence_items);
  assert.match(payload.evidence_sha256, HEX_64);
  assert.doesNotMatch(payloadJson, /alice@example\.com/);
  assert.doesNotMatch(payloadJson, /123-45-6789/);
  assert.doesNotMatch(payloadJson, /ghp_abcdefghijklmnopqrst/);
  assert.doesNotMatch(payloadJson, /Users\\alice/);
});

test('W714 quarantine and release reject unsafe identifiers before audit mutation', async () => {
  freshDir();
  const badQuarantine = await quarantineCapture({
    tenant_id: 'tenant_w714',
    capture_id: '../cap_secret',
    reason: 'manual review',
  });
  const badRelease = await releaseFromQuarantine({
    tenant_id: 'tenant_w714',
    capture_id: 'cap_w714_002',
    release_reason: 'bad/reason',
    released_by: 'owner',
  });

  assert.equal(badQuarantine.ok, false);
  assert.equal(badQuarantine.error, 'missing_or_invalid_capture_id');
  assert.equal(badRelease.ok, false);
  assert.equal(badRelease.error, 'invalid_release_reason');
  assert.equal(store.all('audit_events').length, 0);
});
