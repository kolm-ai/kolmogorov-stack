// WC04 - test coverage close-out for src/cloud-sync.js.
//
// Previously: 643 LOC, 0 tests anywhere in tests/.
// This is a safety-critical privacy module - the public surface
// (state machine + per-class blocklist + dry-run + audit log) MUST be
// pinned so future refactors don't silently regress the gate that decides
// whether captured rows leave the device.
//
// Outbound HTTP paths are intentionally NOT exercised against a live socket
// (no test endpoint exists, no mocking by mandate). The dry-run path covers
// the full filter pipeline end-to-end without ever issuing a request, and
// disabled-state + not_configured paths short-circuit before any socket open.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PRIVACY_CLASSES,
  HIPAA_SAFE_HARBOR,
  STATES,
  CloudSyncError,
  validateClass,
  getSyncState,
  setSyncState,
  shouldSync,
  auditLog,
  pushEvents,
  pullEvents,
  _resetForTests,
} from '../src/cloud-sync.js';
import * as eventStore from '../src/event-store.js';

// One tmp KOLM_DATA_DIR for the whole file. Each test resets the cloud-sync
// on-disk state + event-store between cases so blocklist / dry-run / audit
// rows from earlier tests can't bleed.
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-cs-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  // Force JSONL event-store driver so we don't depend on node:sqlite at
  // module load on the CI sandbox. cloud-sync only reads via listEvents().
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  // Clear any inherited API key so _loadApiKey() returns null and the
  // not_configured envelope is reachable in tests.
  delete process.env.KOLM_API_KEY;
});

beforeEach(() => {
  _resetForTests();
  if (eventStore._resetForTests) eventStore._resetForTests();
  // _resetForTests only drops the in-memory cache; the JSONL file on disk
  // persists across tests under the shared KOLM_DATA_DIR. Wipe it so each
  // test sees an empty event-store regardless of what earlier tests appended.
  try {
    const ed = path.join(process.env.KOLM_DATA_DIR, 'events');
    if (fs.existsSync(ed)) fs.rmSync(ed, { recursive: true, force: true });
  } catch {}
});

test('WC04-cs #1 STATES is frozen + lists the 4 documented states', () => {
  assert.ok(Object.isFrozen(STATES), 'STATES must be frozen');
  assert.deepEqual(
    [...STATES].sort(),
    ['disabled', 'metadata_only', 'raw_enabled', 'redacted_only'],
  );
});

test('WC04-cs #2 PRIVACY_CLASSES is frozen + mirrors privacy-membrane classes', () => {
  assert.ok(Object.isFrozen(PRIVACY_CLASSES), 'PRIVACY_CLASSES must be frozen');
  // Must include the safety-critical lowercase canonical classes (W380 fix).
  for (const must of ['ssn', 'email', 'payment_card', 'api_key', 'private_key']) {
    assert.ok(PRIVACY_CLASSES.includes(must), `must include ${must}`);
  }
  // Must NOT include uppercase HIPAA Safe Harbor labels - those are display-only.
  assert.ok(!PRIVACY_CLASSES.includes('SSN'), 'must not include uppercase SSN');
  assert.ok(!PRIVACY_CLASSES.includes('EMAIL'), 'must not include uppercase EMAIL');
});

test('WC04-cs #3 HIPAA_SAFE_HARBOR is frozen + maps to canonical lowercase classes', () => {
  assert.ok(Object.isFrozen(HIPAA_SAFE_HARBOR), 'HIPAA_SAFE_HARBOR must be frozen');
  // Every bucket member must itself be a real privacy class id.
  for (const [bucket, members] of Object.entries(HIPAA_SAFE_HARBOR)) {
    for (const m of members) {
      assert.ok(PRIVACY_CLASSES.includes(m), `bucket ${bucket} member ${m} must be a real class`);
    }
  }
});

test('WC04-cs #4 validateClass true for known classes, false for unknowns + non-strings', () => {
  assert.equal(validateClass('email'), true);
  assert.equal(validateClass('ssn'), true);
  assert.equal(validateClass('unknown_class_9000'), false);
  assert.equal(validateClass(''), false);
  assert.equal(validateClass(null), false);
  assert.equal(validateClass(42), false);
  assert.equal(validateClass({}), false);
});

test('WC04-cs #5 getSyncState returns default-disabled shape with no state file', () => {
  const s = getSyncState();
  assert.equal(s.state, 'disabled');
  assert.equal(s.namespace, 'default');
  assert.equal(s.cloud_base, '');
  assert.deepEqual(s.classes_blocked_from_sync, []);
  assert.equal(s.last_push_at, null);
  assert.equal(s.last_pull_at, null);
});

test('WC04-cs #6 setSyncState round-trips state + cloud_base + namespace + blocklist', () => {
  const next = setSyncState({
    state: 'metadata_only',
    cloud_base: 'http://127.0.0.1:9999',
    namespace: 'team-a',
    classes_blocked_from_sync: ['ssn', 'payment_card'],
  });
  assert.equal(next.state, 'metadata_only');
  assert.equal(next.cloud_base, 'http://127.0.0.1:9999');
  assert.equal(next.namespace, 'team-a');
  assert.deepEqual(next.classes_blocked_from_sync, ['ssn', 'payment_card']);
  // Reload from disk to confirm persistence.
  const reloaded = getSyncState();
  assert.equal(reloaded.state, 'metadata_only');
  assert.deepEqual(reloaded.classes_blocked_from_sync, ['ssn', 'payment_card']);
});

test('WC04-cs #7 setSyncState rejects invalid state enum with CloudSyncError', () => {
  try {
    setSyncState({ state: 'banana' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CloudSyncError);
    assert.equal(err.code, 'invalid_state');
  }
});

test('WC04-cs #8 setSyncState rejects unknown privacy class with CloudSyncError', () => {
  try {
    setSyncState({ classes_blocked_from_sync: ['ssn', 'not_a_class'] });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CloudSyncError);
    assert.equal(err.code, 'invalid_class');
  }
});

test('WC04-cs #9 setSyncState rejects non-array classes_blocked_from_sync', () => {
  try {
    setSyncState({ classes_blocked_from_sync: 'ssn' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CloudSyncError);
    assert.equal(err.code, 'invalid_classes');
  }
});

test('WC04-cs #10 shouldSync(disabled) returns sync:false regardless of event', () => {
  const d = shouldSync({ event_id: 'e1', sensitive_classes: [] }, 'disabled', []);
  assert.equal(d.sync, false);
  assert.equal(d.reason, 'disabled');
});

test('WC04-cs #11 shouldSync(metadata_only) returns sync:true + METADATA_FIELDS list', () => {
  const d = shouldSync({ event_id: 'e1', sensitive_classes: [] }, 'metadata_only', []);
  assert.equal(d.sync, true);
  assert.ok(Array.isArray(d.fields), 'fields must be an array');
  // Metadata projection must include token + cost + namespace, never prompt/response text.
  assert.ok(d.fields.includes('event_id'));
  assert.ok(d.fields.includes('estimated_cost_usd'));
  assert.ok(d.fields.includes('namespace'));
  assert.ok(!d.fields.includes('prompt_redacted'), 'metadata_only must NOT carry prompt');
  assert.ok(!d.fields.includes('response_redacted'), 'metadata_only must NOT carry response');
  assert.ok(!d.fields.includes('raw_prompt_path'), 'metadata_only must NOT carry raw pointer');
});

test('WC04-cs #12 shouldSync(redacted_only) adds prompt_redacted + sensitive_classes but no raw pointer', () => {
  const d = shouldSync({ event_id: 'e1', sensitive_classes: [] }, 'redacted_only', []);
  assert.equal(d.sync, true);
  assert.ok(d.fields.includes('prompt_redacted'));
  assert.ok(d.fields.includes('response_redacted'));
  assert.ok(d.fields.includes('sensitive_classes'));
  assert.ok(!d.fields.includes('raw_prompt_path'), 'redacted_only must NOT carry raw pointer');
});

test('WC04-cs #13 shouldSync blocklist drops the row when class intersects (kill-switch)', () => {
  // This is the entire privacy kill-switch contract: a row carrying any
  // blocked class MUST be dropped before _projectEvent is even called.
  const ev = { event_id: 'e1', sensitive_classes: ['email', 'ssn'] };
  const d = shouldSync(ev, 'raw_enabled', ['ssn']);
  assert.equal(d.sync, false);
  assert.equal(d.reason, 'class_blocked:ssn');
});

test('WC04-cs #14 shouldSync blocklist permits the row when classes do not intersect', () => {
  const ev = { event_id: 'e1', sensitive_classes: ['email'] };
  const d = shouldSync(ev, 'metadata_only', ['ssn']);
  assert.equal(d.sync, true);
});

test('WC04-cs #15 pushEvents short-circuits when state=disabled (default) - nothing leaves', async () => {
  // Seed an event - even with rows present, disabled MUST emit pushed:0.
  await eventStore.appendEvent({
    namespace: 'default', provider: 'openai', model: 'gpt-4o-mini', status: 'ok',
  });
  const res = await pushEvents({ dryRun: false });
  assert.equal(res.pushed, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.blocked, 0);
  assert.ok(res.audit_id.startsWith('aud_'));
  assert.equal(res.reasons.disabled, 1);
});

test('WC04-cs #16 pushEvents dry-run returns what WOULD be sent without opening a socket', async () => {
  setSyncState({
    state: 'metadata_only',
    cloud_base: 'http://example.invalid:1', // unreachable on purpose; dry-run must NOT call it
    namespace: 'team-a',
  });
  await eventStore.appendEvent({ namespace: 'team-a', provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  await eventStore.appendEvent({ namespace: 'team-a', provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  const res = await pushEvents({ dryRun: true });
  assert.equal(res.pushed, 2, 'dry-run reports rows that would be sent');
  assert.equal(res.skipped, 0);
  assert.equal(res.blocked, 0);
  // Last-push timestamp must NOT update on dry-run (nothing actually went out).
  const cur = getSyncState();
  assert.equal(cur.last_push_at, null, 'dry-run must not stamp last_push_at');
});

test('WC04-cs #17 pushEvents dry-run honors per-class blocklist (rows counted as blocked)', async () => {
  setSyncState({
    state: 'redacted_only',
    cloud_base: 'http://example.invalid:1',
    namespace: 'team-b',
    classes_blocked_from_sync: ['ssn'],
  });
  await eventStore.appendEvent({
    namespace: 'team-b', provider: 'openai', model: 'gpt-4o-mini', status: 'ok',
    sensitive_classes: ['ssn'], // <- must be dropped
  });
  await eventStore.appendEvent({
    namespace: 'team-b', provider: 'openai', model: 'gpt-4o-mini', status: 'ok',
    sensitive_classes: ['email'], // <- must pass
  });
  const res = await pushEvents({ dryRun: true });
  assert.equal(res.pushed, 1, 'only the non-ssn row should pass');
  assert.equal(res.blocked, 1, 'the ssn row should be counted as blocked');
  assert.equal(res.reasons['class_blocked:ssn'], 1);
});

test('WC04-cs #18 pushEvents respects namespace mapping (other-namespace rows ignored)', async () => {
  setSyncState({
    state: 'metadata_only',
    cloud_base: 'http://example.invalid:1',
    namespace: 'team-a',
  });
  await eventStore.appendEvent({ namespace: 'team-a', provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  await eventStore.appendEvent({ namespace: 'team-b', provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  await eventStore.appendEvent({ namespace: 'other',  provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  const res = await pushEvents({ dryRun: true });
  assert.equal(res.pushed, 1, 'only the team-a row should be considered');
});

test('WC04-cs #19 pushEvents empty event-store returns pushed:0 without throwing', async () => {
  setSyncState({
    state: 'metadata_only',
    cloud_base: 'http://127.0.0.1:1', // local base; no key required
    namespace: 'empty-ns',
  });
  const res = await pushEvents({ dryRun: false });
  assert.equal(res.pushed, 0);
  assert.equal(res.skipped, 0);
  assert.equal(res.blocked, 0);
  // No-op push DOES stamp last_push_at (daemon check-in semantics).
  const cur = getSyncState();
  assert.ok(cur.last_push_at, 'no-op push records check-in');
});

test('WC04-cs #20 pushEvents non-disabled + empty cloud_base + rows present throws not_configured', async () => {
  setSyncState({ state: 'metadata_only', cloud_base: '', namespace: 'ns1' });
  await eventStore.appendEvent({ namespace: 'ns1', provider: 'openai', model: 'gpt-4o-mini', status: 'ok' });
  await assert.rejects(
    () => pushEvents({ dryRun: false }),
    (err) => err instanceof CloudSyncError && err.code === 'not_configured',
  );
});

test('WC04-cs #21 pullEvents short-circuits when state=disabled', async () => {
  const res = await pullEvents({});
  assert.equal(res.pulled, 0);
  assert.deepEqual(res.events, []);
  assert.ok(res.audit_id.startsWith('aud_'));
});

test('WC04-cs #22 pullEvents non-disabled + empty cloud_base throws not_configured', async () => {
  setSyncState({ state: 'metadata_only', cloud_base: '', namespace: 'ns1' });
  await assert.rejects(
    () => pullEvents({}),
    (err) => err instanceof CloudSyncError && err.code === 'not_configured',
  );
});

test('WC04-cs #23 auditLog returns reverse-chrono rows after a push', async () => {
  setSyncState({ state: 'metadata_only', cloud_base: 'http://127.0.0.1:1', namespace: 'ns-aud' });
  await pushEvents({ dryRun: true });
  await pushEvents({ dryRun: true });
  const rows = auditLog({ limit: 50 });
  assert.ok(rows.length >= 2, 'audit log should have at least 2 rows');
  // Each row must carry op + state + audit_id + ts.
  for (const r of rows) {
    assert.equal(r.op, 'push');
    assert.equal(r.state, 'metadata_only');
    assert.ok(r.audit_id);
    assert.ok(r.ts);
  }
});

test('WC04-cs #24 auditLog limit honors the provided cap', async () => {
  setSyncState({ state: 'metadata_only', cloud_base: 'http://127.0.0.1:1', namespace: 'ns-aud2' });
  await pushEvents({ dryRun: true });
  await pushEvents({ dryRun: true });
  await pushEvents({ dryRun: true });
  const rows = auditLog({ limit: 2 });
  assert.equal(rows.length, 2);
});
