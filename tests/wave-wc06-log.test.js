// WC06 — log wrapper tests.
//
// Coverage targets (from WC06 atomic plan):
//   1. log.info/warn/error are functions
//   2. log.info('foo', 'bar') writes [foo] bar to stdout via console.log
//   3. KOLM_LOG_STRUCTURED=1 triggers appendEvent
//   4. sanitizeFields redacts emails / api-key-shaped strings / JWT-shaped strings
//   5. getLogger(tag) returns a logger bound to that tag
//   6. log doesn't crash when fields is undefined/null
//   7. log handles circular references gracefully
//   8. log writes go to console.warn / console.error (not just console.log)
//
// We DO NOT exercise any HTTP route in this file — that's the router test
// surface's job. This is a pure unit test of src/log.js.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  log,
  Log,
  getLogger,
  sanitizeFields,
  LOG_LEVELS,
  _resetForTests as _resetLog,
} from '../src/log.js';
import * as eventStore from '../src/event-store.js';

// Isolate tmp HOME so the structured emission path can't pollute the dev
// machine's ~/.kolm/events store, and force the JSONL driver so we don't
// depend on node:sqlite being compiled in.
let TMP;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc06-log-'));
  process.env.KOLM_DATA_DIR = path.join(TMP, '.kolm');
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  // Default OFF — individual tests opt in.
  delete process.env.KOLM_LOG_STRUCTURED;
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} // deliberate: cleanup
});

// Save + restore console.{log,warn,error} around each test so a stub never
// bleeds to the next case (and so node:test's own progress output isn't
// captured by accident).
const ORIG = { log: console.log, warn: console.warn, error: console.error };
function stubConsole() {
  const captured = { log: [], warn: [], error: [] };
  console.log = (...args) => { captured.log.push(args.join(' ')); };
  console.warn = (...args) => { captured.warn.push(args.join(' ')); };
  console.error = (...args) => { captured.error.push(args.join(' ')); };
  return captured;
}
function restoreConsole() {
  console.log = ORIG.log;
  console.warn = ORIG.warn;
  console.error = ORIG.error;
}

beforeEach(() => {
  delete process.env.KOLM_LOG_STRUCTURED;
  _resetLog();
  if (eventStore._resetForTests) eventStore._resetForTests();
  // Wipe on-disk events from any prior test in this file.
  try {
    const ed = path.join(process.env.KOLM_DATA_DIR, 'events');
    if (fs.existsSync(ed)) fs.rmSync(ed, { recursive: true, force: true });
  } catch {} // deliberate: cleanup
});

test('WC06-log #1 — log.info / log.warn / log.error are functions', () => {
  assert.equal(typeof log.info, 'function');
  assert.equal(typeof log.warn, 'function');
  assert.equal(typeof log.error, 'function');
  assert.deepEqual([...LOG_LEVELS], ['info', 'warn', 'error']);
});

test('WC06-log #2 — log.info writes [tag] msg via console.log', () => {
  const cap = stubConsole();
  try {
    log.info('foo', 'bar');
  } finally {
    restoreConsole();
  }
  assert.equal(cap.log.length, 1, 'one console.log call expected');
  assert.equal(cap.log[0], '[foo] bar');
  assert.equal(cap.warn.length, 0);
  assert.equal(cap.error.length, 0);
});

test('WC06-log #3 — log.warn / log.error route to console.warn / console.error', () => {
  const cap = stubConsole();
  try {
    log.warn('w', 'caution');
    log.error('e', 'boom');
  } finally {
    restoreConsole();
  }
  assert.equal(cap.warn.length, 1);
  assert.equal(cap.warn[0], '[w] caution');
  assert.equal(cap.error.length, 1);
  assert.equal(cap.error[0], '[e] boom');
  assert.equal(cap.log.length, 0);
});

test('WC06-log #4 — KOLM_LOG_STRUCTURED=1 triggers appendEvent into the lake', async () => {
  process.env.KOLM_LOG_STRUCTURED = '1';
  _resetLog();
  if (eventStore._resetForTests) eventStore._resetForTests();
  const cap = stubConsole();
  try {
    log.info('boot', 'hello world', { ok: true });
    // emit is fire-and-forget — give the microtask queue a chance to flush.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    restoreConsole();
  }
  const rows = await eventStore.listEvents({ namespace: 'log_emission' });
  assert.ok(rows.length >= 1, `expected >=1 structured row, got ${rows.length}`);
  const row = rows[0];
  assert.equal(row.namespace, 'log_emission');
  assert.equal(row.provider, 'boot');
  assert.ok(row.feedback && row.feedback.includes('"tag":"boot"'), 'feedback should carry tag');
  assert.ok(row.feedback.includes('"msg":"hello world"'), 'feedback should carry msg');
  // honest provenance — never label a log emission as 'real' tenant data
  assert.equal(row.source_type, 'simulated');
});

test('WC06-log #5 — sanitizeFields redacts emails, api-key shapes, JWTs, bearer tokens', () => {
  const out = sanitizeFields({
    user: 'attacker@evil.com',
    apikey_value: 'ks_abcdefghijklmnopqrstuv',
    nested: { jwt: 'eyJabcdefgh.eyJ12345678.signaturexx', ok: 1 },
    safe: 'plain text 123',
    auth_header: 'Bearer abcdef0123456789',
  });
  assert.equal(out.user, '[REDACTED]', 'email field must be redacted');
  assert.equal(out.apikey_value, '[REDACTED]', 'api-key shape must be redacted');
  assert.equal(out.nested.jwt, '[REDACTED]', 'jwt shape must be redacted');
  assert.equal(out.nested.ok, 1, 'plain numbers must pass through');
  assert.equal(out.safe, 'plain text 123', 'safe strings must pass through');
  assert.equal(out.auth_header, '[REDACTED]', 'bearer tokens must be redacted');
});

test('WC06-log #6 — sanitizeFields key-name blanket redaction (password / token / secret)', () => {
  const out = sanitizeFields({
    password: 'literally-anything',
    secret: 12345,
    token: ['arr', 'of', 'things'],
    authorization: { sub: 'object' },
    cookie: 'sess=abc',
    fine: 'this is fine',
  });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.secret, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.cookie, '[REDACTED]');
  assert.equal(out.fine, 'this is fine');
});

test('WC06-log #7 — getLogger(tag) returns a logger bound to that tag', () => {
  const cap = stubConsole();
  try {
    const lg = getLogger('mytag');
    assert.ok(lg instanceof Log, 'getLogger must return a Log instance');
    lg.info('m1');
    lg.warn('m2');
    lg.error('m3');
  } finally {
    restoreConsole();
  }
  assert.deepEqual(cap.log, ['[mytag] m1']);
  assert.deepEqual(cap.warn, ['[mytag] m2']);
  assert.deepEqual(cap.error, ['[mytag] m3']);
});

test('WC06-log #8 — log doesn\'t crash when fields is undefined or null', () => {
  const cap = stubConsole();
  try {
    assert.doesNotThrow(() => log.info('t', 'no fields'));
    assert.doesNotThrow(() => log.info('t', 'null fields', null));
    assert.doesNotThrow(() => log.info('t', 'explicit undefined', undefined));
    assert.doesNotThrow(() => log.warn('t', 'empty obj', {}));
    // Even a non-object scalar should not throw.
    assert.doesNotThrow(() => log.error('t', 'scalar fields', 42));
  } finally {
    restoreConsole();
  }
  assert.equal(cap.log.length, 3);
  assert.equal(cap.warn.length, 1);
  assert.equal(cap.error.length, 1);
});

test('WC06-log #9 — log handles circular references gracefully', () => {
  const cap = stubConsole();
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  let result;
  try {
    assert.doesNotThrow(() => {
      result = log.info('cyc', 'circular safe', cyclic);
    });
  } finally {
    restoreConsole();
  }
  assert.equal(cap.log.length, 1);
  assert.equal(cap.log[0], '[cyc] circular safe');
  // sanitizeFields returns the cleaned object; the cyclic edge must have been
  // collapsed to a sentinel rather than blowing the stack.
  assert.equal(result.a, 1);
  assert.equal(result.self, '[circular]');
});

test('WC06-log #10 — Log class can be instantiated directly', () => {
  const cap = stubConsole();
  try {
    const direct = new Log('direct');
    direct.info('hello');
    direct.warn('warn');
    direct.error('err');
  } finally {
    restoreConsole();
  }
  assert.deepEqual(cap.log, ['[direct] hello']);
  assert.deepEqual(cap.warn, ['[direct] warn']);
  assert.deepEqual(cap.error, ['[direct] err']);
});

test('WC06-log #11 — KOLM_LOG_STRUCTURED unset does NOT write to event store', async () => {
  // explicit guard: structured logging must be opt-in.
  delete process.env.KOLM_LOG_STRUCTURED;
  _resetLog();
  if (eventStore._resetForTests) eventStore._resetForTests();
  const cap = stubConsole();
  try {
    log.info('off', 'should not appear in lake');
    await new Promise((r) => setImmediate(r));
  } finally {
    restoreConsole();
  }
  assert.equal(cap.log.length, 1);
  const rows = await eventStore.listEvents({ namespace: 'log_emission' });
  assert.equal(rows.length, 0, 'no structured row when KOLM_LOG_STRUCTURED unset');
});
