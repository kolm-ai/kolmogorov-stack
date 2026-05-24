// WC07 — type-safe env readers: envBool + envSecret.
//
// Background: a prior audit found 10 sites where `!!process.env.FOO` or
// `process.env.FOO || ''` silently corrupted the intent. `=false` was treated
// as truthy (any non-empty string), so setting an env var to literal "false"
// did the OPPOSITE of disabling the feature. envBool fixes the boolean case;
// envSecret fixes the "must-be-set-and-meaningful" case.

import test from 'node:test';
import assert from 'node:assert/strict';

import { envBool, envSecret } from '../src/env.js';

// All test env keys live under a fixed prefix so the afterEach cleanup is
// scoped and we don't accidentally trample real env vars.
const PREFIX = 'KOLM_TEST_WC07_';

function clearTestEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith(PREFIX)) delete process.env[k];
  }
}

test.beforeEach(() => { clearTestEnv(); });
test.afterEach(() => { clearTestEnv(); });

// --- envBool ----------------------------------------------------------------

test('WC07 envBool unset returns false by default', () => {
  assert.equal(envBool(PREFIX + 'UNSET'), false);
});

test('WC07 envBool unset returns provided fallback', () => {
  assert.equal(envBool(PREFIX + 'UNSET', true), true);
  assert.equal(envBool(PREFIX + 'UNSET', false), false);
});

test('WC07 envBool literal "false" returns false (the critical fix)', () => {
  // This is the bug that motivated WC07. Bare `!!process.env.FOO` would
  // return TRUE here because "false" is a non-empty string.
  process.env[PREFIX + 'FALSE_STR'] = 'false';
  assert.equal(envBool(PREFIX + 'FALSE_STR'), false);
});

test('WC07 envBool literal "0" returns false', () => {
  process.env[PREFIX + 'ZERO'] = '0';
  assert.equal(envBool(PREFIX + 'ZERO'), false);
});

test('WC07 envBool "no" and "off" also return false', () => {
  process.env[PREFIX + 'NO'] = 'no';
  process.env[PREFIX + 'OFF'] = 'off';
  assert.equal(envBool(PREFIX + 'NO'), false);
  assert.equal(envBool(PREFIX + 'OFF'), false);
});

test('WC07 envBool literal "true" returns true', () => {
  process.env[PREFIX + 'TRUE_STR'] = 'true';
  assert.equal(envBool(PREFIX + 'TRUE_STR'), true);
});

test('WC07 envBool literal "1" returns true', () => {
  process.env[PREFIX + 'ONE'] = '1';
  assert.equal(envBool(PREFIX + 'ONE'), true);
});

test('WC07 envBool "yes" and "on" also return true', () => {
  process.env[PREFIX + 'YES'] = 'yes';
  process.env[PREFIX + 'ON'] = 'on';
  assert.equal(envBool(PREFIX + 'YES'), true);
  assert.equal(envBool(PREFIX + 'ON'), true);
});

test('WC07 envBool unrecognized non-empty string returns fallback (does NOT coerce)', () => {
  // Critical: "maybe" is not a recognized boolean, so we return the fallback
  // rather than silently treating it as truthy (the bare `!!` would say
  // true, which is exactly the failure mode this helper exists to prevent).
  process.env[PREFIX + 'GIBBERISH'] = 'maybe';
  assert.equal(envBool(PREFIX + 'GIBBERISH', false), false);
  assert.equal(envBool(PREFIX + 'GIBBERISH', true), true);
});

test('WC07 envBool empty string returns fallback', () => {
  process.env[PREFIX + 'EMPTY'] = '';
  assert.equal(envBool(PREFIX + 'EMPTY', true), true);
  assert.equal(envBool(PREFIX + 'EMPTY', false), false);
});

test('WC07 envBool is case-insensitive', () => {
  process.env[PREFIX + 'FALSE_UP'] = 'FALSE';
  process.env[PREFIX + 'TRUE_MIXED'] = 'True';
  process.env[PREFIX + 'OFF_UP'] = 'OFF';
  assert.equal(envBool(PREFIX + 'FALSE_UP'), false);
  assert.equal(envBool(PREFIX + 'TRUE_MIXED'), true);
  assert.equal(envBool(PREFIX + 'OFF_UP'), false);
});

test('WC07 envBool trims surrounding whitespace', () => {
  process.env[PREFIX + 'PADDED'] = '  true  ';
  assert.equal(envBool(PREFIX + 'PADDED'), true);
});

// --- envSecret --------------------------------------------------------------

test('WC07 envSecret unset returns null', () => {
  assert.equal(envSecret(PREFIX + 'UNSET'), null);
});

test('WC07 envSecret empty string returns null', () => {
  process.env[PREFIX + 'EMPTY'] = '';
  assert.equal(envSecret(PREFIX + 'EMPTY'), null);
});

test('WC07 envSecret whitespace-only returns null', () => {
  // The critical fail-closed case: an operator typing `export FOO="  "`
  // shouldn't get a "configured" secret that empty-string-compares true
  // against an omitted Authorization header.
  process.env[PREFIX + 'WS'] = '   \t\n  ';
  assert.equal(envSecret(PREFIX + 'WS'), null);
});

test('WC07 envSecret non-empty returns trimmed value', () => {
  process.env[PREFIX + 'VAL'] = '  hunter2  ';
  assert.equal(envSecret(PREFIX + 'VAL'), 'hunter2');
});

test('WC07 envSecret NEVER returns empty string', () => {
  // Property: for every possible input, envSecret returns either null OR a
  // non-empty string. Callers can therefore do `if (!secret) ...` without
  // worrying about the '' vs missing-header collision that motivated this
  // helper.
  const inputs = [undefined, null, '', ' ', '\t', '\n', 'x'];
  for (const v of inputs) {
    if (v === undefined) delete process.env[PREFIX + 'CHK'];
    else process.env[PREFIX + 'CHK'] = String(v);
    const got = envSecret(PREFIX + 'CHK');
    assert.ok(got === null || (typeof got === 'string' && got.length > 0),
      `envSecret returned ${JSON.stringify(got)} for input ${JSON.stringify(v)}`);
  }
});
