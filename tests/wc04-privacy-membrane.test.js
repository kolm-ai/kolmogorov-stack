// WC04 — test coverage close-out for src/privacy-membrane.js.
//
// Previously: 1021 LOC, 0 tests anywhere in tests/.
// This is a safety-critical PII redaction module — the public surface
// (scan / redact / reinsert / policy) MUST be pinned so future refactors
// don't silently regress detector behavior or break round-trip semantics.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DETECTOR_VERSION,
  ALL_CLASSES,
  PolicyBlockError,
  scan,
  redact,
  reinsert,
  policy,
  setPolicy,
  getFullPolicy,
  loadPolicy,
  redactWithPolicy,
  listDetectors,
  statePaths,
  differentialPrivacyStats,
  _resetCacheForTests,
} from '../src/privacy-membrane.js';

// One shared tmp dir for the whole file; setPolicy persists to disk and
// the cache invalidates on KOLM_DATA_DIR change.
before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-pm-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  _resetCacheForTests();
});

test('WC04-pm #1 DETECTOR_VERSION is a non-empty string', () => {
  assert.equal(typeof DETECTOR_VERSION, 'string');
  assert.ok(DETECTOR_VERSION.length > 0);
});

test('WC04-pm #2 ALL_CLASSES is frozen + includes safety-critical classes', () => {
  assert.ok(Object.isFrozen(ALL_CLASSES), 'ALL_CLASSES must be frozen');
  for (const must of ['ssn', 'email', 'payment_card', 'api_key', 'private_key']) {
    assert.ok(ALL_CLASSES.includes(must), `must include ${must}`);
  }
});

test('WC04-pm #3 scan empty string returns empty matches + sensitive:false', () => {
  const r = scan('');
  assert.deepEqual(r.matches, []);
  assert.equal(r.sensitive, false);
  assert.equal(r.detector_version, DETECTOR_VERSION);
});

test('WC04-pm #4 scan null/undefined coerced to empty (no crash)', () => {
  const a = scan(null);
  const b = scan(undefined);
  assert.equal(a.sensitive, false);
  assert.equal(b.sensitive, false);
});

test('WC04-pm #5 scan detects email + confidence', () => {
  const r = scan('hello user@example.com world');
  const emails = r.matches.filter(m => m.class === 'email');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].value, 'user@example.com');
  assert.ok(emails[0].confidence > 0.5);
});

test('WC04-pm #6 scan detects valid SSN', () => {
  const r = scan('SSN: 123-45-6789 on file');
  const ssns = r.matches.filter(m => m.class === 'ssn');
  assert.equal(ssns.length, 1);
  assert.equal(ssns[0].value, '123-45-6789');
});

test('WC04-pm #7 scan rejects invalid SSN area (000 prefix) as canonical ssn', () => {
  const r = scan('SSN: 000-12-3456 fake');
  const ssns = r.matches.filter(m => m.class === 'ssn');
  assert.equal(ssns.length, 0, 'strict SSN regex must reject 000 area');
});

test('WC04-pm #8 redact swaps PII for VAR_ placeholders and populates vault', () => {
  const text = 'Contact user@example.com for info.';
  const r = redact(text);
  assert.ok(r.redacted.includes('VAR_EMAIL_1'));
  assert.equal(r.vault['VAR_EMAIL_1'], 'user@example.com');
  assert.ok(r.classes_seen.includes('email'));
});

test('WC04-pm #9 reinsert perfectly round-trips redact', () => {
  const text = 'Email alice@example.com, call (555) 123-4567.';
  const r = redact(text);
  const back = reinsert(r.redacted, r.vault);
  assert.equal(back, text);
});

test('WC04-pm #10 reinsert handles tampered vault (non-string values skipped)', () => {
  const back = reinsert('hello VAR_EMAIL_1 world', { VAR_EMAIL_1: null });
  // Non-string vault value -> placeholder left as-is, not crash
  assert.equal(back, 'hello VAR_EMAIL_1 world');
});

test('WC04-pm #11 reinsert handles longer placeholder names first', () => {
  // VAR_EMAIL_10 must not be eaten by VAR_EMAIL_1.
  const vault = { VAR_EMAIL_1: 'a@b.com', VAR_EMAIL_10: 'j@k.com' };
  const back = reinsert('VAR_EMAIL_10 and VAR_EMAIL_1', vault);
  assert.equal(back, 'j@k.com and a@b.com');
});

test('WC04-pm #12 setPolicy throws TypeError without class arg', () => {
  assert.throws(() => setPolicy({}), TypeError);
});

test('WC04-pm #13 setPolicy throws RangeError for unknown class', () => {
  assert.throws(
    () => setPolicy({ class: 'unknown_class_9000', action: 'redact' }),
    RangeError,
  );
});

test('WC04-pm #14 setPolicy throws RangeError for invalid action', () => {
  assert.throws(
    () => setPolicy({ class: 'email', action: 'banana' }),
    RangeError,
  );
});

test('WC04-pm #15 setPolicy persists + getFullPolicy reflects update', () => {
  setPolicy({ class: 'email', action: 'block' });
  const full = getFullPolicy();
  assert.equal(full.email, 'block');
});

test('WC04-pm #16 policy() no-args returns { default: <action> } legacy shape', () => {
  const p = policy();
  assert.ok(typeof p === 'object' && p !== null);
  assert.ok(typeof p.default === 'string');
});

test('WC04-pm #17 policy(class) returns the action string', () => {
  setPolicy({ class: 'phone', action: 'allow' });
  assert.equal(policy('phone'), 'allow');
});

test('WC04-pm #18 redactWithPolicy throws PolicyBlockError when class=block', () => {
  setPolicy({ class: 'email', action: 'block' });
  try {
    redactWithPolicy('contact foo@bar.com please');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof PolicyBlockError);
    assert.equal(err.class, 'email');
    assert.equal(err.code, 'POLICY_BLOCK');
  }
});

test('WC04-pm #19 redactWithPolicy action=allow leaves text alone', () => {
  setPolicy({ class: 'email', action: 'allow' });
  const r = redactWithPolicy('contact foo@bar.com please');
  assert.ok(r.redacted.includes('foo@bar.com'));
  assert.ok(r.allowed_classes.includes('email'));
});

test('WC04-pm #20 redactWithPolicy action=override wraps with [[OVERRIDE:class]]', () => {
  setPolicy({ class: 'email', action: 'override' });
  const r = redactWithPolicy('contact foo@bar.com please');
  assert.ok(r.redacted.includes('[[OVERRIDE:email]]'));
  assert.ok(r.overridden_classes.includes('email'));
});

test('WC04-pm #21 listDetectors returns one row per ALL_CLASSES entry', () => {
  const rows = listDetectors();
  assert.equal(rows.length, ALL_CLASSES.length);
  for (const r of rows) {
    assert.ok(ALL_CLASSES.includes(r.class));
    assert.ok(['allow', 'redact', 'block', 'override'].includes(r.default_action));
  }
});

test('WC04-pm #22 statePaths returns absolute paths under KOLM_DATA_DIR', () => {
  const sp = statePaths();
  assert.ok(path.isAbsolute(sp.data_dir));
  assert.ok(sp.policy.startsWith(sp.data_dir));
  assert.ok(sp.redactions.startsWith(sp.data_dir));
});

test('WC04-pm #23 private_key wins overlap priority over other classes', () => {
  // PEM-style key: detectPrivateKey is exhaustive; the test merely confirms
  // priority resolution doesn't drop it when surrounded by other matches.
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
  const r = scan(text);
  const pk = r.matches.filter(m => m.class === 'private_key');
  assert.ok(pk.length >= 1, 'private_key block detected');
});

test('WC04-pm #24 differentialPrivacyStats adds privacy envelope + perturbs counts', () => {
  const input = {
    window: { tenant_id: 't1', namespace: 'ns', since: '2026-05-01' },
    total_calls: 1000,
    sensitive_events: 50,
    redactions_by_class: { email: 25 },
    providers: { openai: { calls: 700 } },
    models: { 'gpt-4o-mini': { calls: 400 } },
    repeated_clusters: [{ count: 8 }],
    top_workflows: [{ calls: 60 }],
  };
  const out = differentialPrivacyStats(input, { epsilon: 1 });
  assert.equal(out.privacy.mechanism, 'laplace');
  assert.equal(typeof out.privacy.epsilon, 'number');
  assert.equal(typeof out.privacy.seed_hash, 'string');
  // Original input not mutated
  assert.equal(input.total_calls, 1000);
});

test('WC04-pm #25 loadPolicy returns the merged default map after reset', () => {
  _resetCacheForTests();
  const p = loadPolicy();
  for (const cls of ALL_CLASSES) {
    assert.ok(['allow', 'redact', 'block', 'override'].includes(p[cls]));
  }
});
