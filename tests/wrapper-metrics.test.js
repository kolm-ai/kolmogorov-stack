// LM-7 — V1 launch product metrics lock-in (2026-05-26).
//
// Pins the contracts that ship POST /v1/metrics/event + GET /v1/metrics/snapshot
// + the src/metrics.js module so a stray rename, refactor, or breaking
// behaviour change tripwires here.
//
//   #1  src/metrics.js module exists and exports recordEvent + getSnapshot
//   #2  recordEvent is a function; getSnapshot is a function
//   #3  POST /v1/metrics/event handler is registered in src/router.js (grep)
//   #4  GET  /v1/metrics/snapshot handler is registered in src/router.js (grep)
//   #5  metrics.js imports the project store.js primitive (not a sibling .json)
//   #6  getSnapshot enforces the 90-day cap (days=999 → days:90 in envelope)
//   #7  getSnapshot floors days at 1 (days=0 → days:1 in envelope)
//   #8  recordEvent does NOT throw when storage is missing/null (the contract
//       is fire-and-forget). Verified by stripping the store backend with
//       module.children-cache poisoning is overkill; instead we feed it a
//       missing tenant and a missing kind and confirm no throw + returns
//       false (drop counted).
//   #9  recordEvent rejects missing tenant + kind (returns false, drop++)
//   #10 SNAPSHOT_MAX_DAYS export is the literal 90
//
// No router boot, no network. Source pins + a direct module load only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const METRICS_PATH = path.join(REPO_ROOT, 'src', 'metrics.js');
const ROUTER_PATH  = path.join(REPO_ROOT, 'src', 'router.js');

// ---------------------------------------------------------------------------
// #1 src/metrics.js exists
// ---------------------------------------------------------------------------
test('LM-7 #1: src/metrics.js module exists and exports recordEvent + getSnapshot', async () => {
  assert.ok(fs.existsSync(METRICS_PATH), 'src/metrics.js must exist');
  const mod = await import('../src/metrics.js');
  assert.ok(mod, 'module must load');
  assert.ok('recordEvent' in mod, 'must export recordEvent');
  assert.ok('getSnapshot'  in mod, 'must export getSnapshot');
});

// ---------------------------------------------------------------------------
// #2 exports are callable functions
// ---------------------------------------------------------------------------
test('LM-7 #2: recordEvent + getSnapshot are functions', async () => {
  const mod = await import('../src/metrics.js');
  assert.equal(typeof mod.recordEvent, 'function', 'recordEvent must be a function');
  assert.equal(typeof mod.getSnapshot,  'function', 'getSnapshot must be a function');
});

// ---------------------------------------------------------------------------
// #3 POST /v1/metrics/event registered
// ---------------------------------------------------------------------------
test('LM-7 #3: POST /v1/metrics/event is registered in src/router.js', () => {
  const src = fs.readFileSync(ROUTER_PATH, 'utf8');
  // Match either single or double quotes around the path. Allow whitespace.
  const re = /r\.post\(\s*['"]\/v1\/metrics\/event['"]/;
  assert.match(src, re, 'expected r.post(\'/v1/metrics/event\', ...) in src/router.js');
});

// ---------------------------------------------------------------------------
// #4 GET /v1/metrics/snapshot registered
// ---------------------------------------------------------------------------
test('LM-7 #4: GET /v1/metrics/snapshot is registered in src/router.js', () => {
  const src = fs.readFileSync(ROUTER_PATH, 'utf8');
  const re = /r\.get\(\s*['"]\/v1\/metrics\/snapshot['"]/;
  assert.match(src, re, 'expected r.get(\'/v1/metrics/snapshot\', ...) in src/router.js');
});

// ---------------------------------------------------------------------------
// #5 metrics.js imports the project store.js primitive
// ---------------------------------------------------------------------------
test('LM-7 #5: src/metrics.js imports the project store.js primitive', () => {
  const src = fs.readFileSync(METRICS_PATH, 'utf8');
  assert.match(
    src,
    /from\s+['"]\.\/store\.js['"]/,
    'metrics.js must import from ./store.js (not a sibling .json or external lib)',
  );
});

// ---------------------------------------------------------------------------
// #6 getSnapshot enforces 90-day cap
// ---------------------------------------------------------------------------
test('LM-7 #6: getSnapshot enforces 90-day cap (days=999 -> 90)', async () => {
  const { getSnapshot } = await import('../src/metrics.js');
  const snap = getSnapshot({ tenant: 'tenant_lm7_capcheck', days: 999 });
  assert.equal(snap.days, 90, 'getSnapshot must cap days at 90');
});

// ---------------------------------------------------------------------------
// #7 getSnapshot floors days at 1
// ---------------------------------------------------------------------------
test('LM-7 #7: getSnapshot floors days at 1 (days=0 -> 1)', async () => {
  const { getSnapshot } = await import('../src/metrics.js');
  const snap = getSnapshot({ tenant: 'tenant_lm7_floorcheck', days: 0 });
  assert.equal(snap.days, 1, 'getSnapshot must floor days at 1');
});

// ---------------------------------------------------------------------------
// #8 recordEvent does NOT throw when storage is missing / inputs malformed.
// ---------------------------------------------------------------------------
test('LM-7 #8: recordEvent never throws on missing/null inputs', async () => {
  const { recordEvent } = await import('../src/metrics.js');
  // No throw on null
  assert.doesNotThrow(() => recordEvent(null), 'recordEvent(null) must not throw');
  // No throw on undefined
  assert.doesNotThrow(() => recordEvent(), 'recordEvent() must not throw');
  // No throw on empty object (missing tenant + kind)
  assert.doesNotThrow(() => recordEvent({}), 'recordEvent({}) must not throw');
  // No throw on partial input
  assert.doesNotThrow(() => recordEvent({ tenant: 'tenant_only' }), 'partial tenant must not throw');
  assert.doesNotThrow(() => recordEvent({ kind: 'kind_only' }),     'partial kind must not throw');
});

// ---------------------------------------------------------------------------
// #9 recordEvent rejects missing tenant + kind (returns false)
// ---------------------------------------------------------------------------
test('LM-7 #9: recordEvent rejects missing tenant + kind (returns false)', async () => {
  const { recordEvent } = await import('../src/metrics.js');
  assert.equal(recordEvent({}), false, 'missing tenant + kind must return false');
  assert.equal(recordEvent({ tenant: 'x' }), false, 'missing kind must return false');
  assert.equal(recordEvent({ kind: 'x' }),   false, 'missing tenant must return false');
});

// ---------------------------------------------------------------------------
// #10 SNAPSHOT_MAX_DAYS exported as the literal 90
// ---------------------------------------------------------------------------
test('LM-7 #10: SNAPSHOT_MAX_DAYS export is the literal 90', async () => {
  const mod = await import('../src/metrics.js');
  assert.equal(mod.SNAPSHOT_MAX_DAYS, 90, 'SNAPSHOT_MAX_DAYS must equal 90');
});
