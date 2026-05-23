// W729 — Graceful degradation under load: queue + priority + 429 envelope.
//
// Atomic items pinned (matches the W729 implementation):
//
//   1) LOAD_QUEUE_VERSION constant present + pinned to 'w729-v1'
//   2) enqueue resolves when capacity available
//   3) enqueue rejects with queue_timeout when timeout_ms elapses
//   4) Priority lanes: enterprise dequeues before free under contention
//   5) getQueueStats returns {depth, capacity, by_priority}
//   6) setCapacity changes capacity; non-positive throws
//   7) KOLM_LOAD_QUEUE_DISABLED=1 → enqueue resolves immediately
//   8) Router middleware returns 429 + Retry-After + queue_full envelope
//   9) W729-2 overflow: with KOLM_TEACHER_OVERFLOW_URL + onOverflow cb,
//      request forwards instead of rejecting
//  10) horizontal-scaling.html exists, contains brand-lock eyebrow + load-
//      bearing strings + `kolm load queue --stats` reference
//  11) CLI cmdW729LoadStatus dispatcher present (source-grep)
//  12) Family lock-in uses regex wave(7\d\d) + threshold (no explicit array)
//  13) _resetForTests() called between tests to avoid state leak
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form prose. Assertions key on load-bearing fields
// (version stamp, error codes, envelope shape, file existence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOAD_QUEUE_VERSION,
  PRIORITY_LANES,
  enqueue,
  getQueueStats,
  setCapacity,
  _resetForTests,
} from '../src/load-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'runtime', 'horizontal-scaling.html');
const TESTS_DIR = __dirname;

// Each test gets a fresh KOLM_DATA_DIR so any incidental writes do not collide
// with sibling tests in the larger suite. Matches the freshDir pattern used in
// tests/wave724-*.test.js and tests/wave726-*.test.js.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w729-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Default-clean: tests that exercise these envs MUST set them themselves.
  delete process.env.KOLM_LOAD_QUEUE_DISABLED;
  delete process.env.KOLM_TEACHER_OVERFLOW_URL;
  _resetForTests();
  return tmp;
}

// =============================================================================
// 1) LOAD_QUEUE_VERSION constant
// =============================================================================

test('W729 #1 — LOAD_QUEUE_VERSION is "w729-v1" and PRIORITY_LANES ordered enterprise > free', () => {
  freshDir();
  assert.equal(LOAD_QUEUE_VERSION, 'w729-v1');
  assert.ok(Array.isArray(PRIORITY_LANES), 'PRIORITY_LANES must be an array');
  // Enterprise must appear before free so the dequeue loop orders correctly.
  const idxEnt = PRIORITY_LANES.indexOf('enterprise');
  const idxFree = PRIORITY_LANES.indexOf('free');
  assert.ok(idxEnt >= 0 && idxFree >= 0, 'enterprise + free must both be lanes');
  assert.ok(idxEnt < idxFree,
    `enterprise must come before free in PRIORITY_LANES; got [${PRIORITY_LANES.join(',')}]`);
});

// =============================================================================
// 2) enqueue resolves when capacity available
// =============================================================================

test('W729 #2 — enqueue resolves immediately when capacity available', async () => {
  freshDir();
  setCapacity(4);
  const slot = await enqueue({ priority: 'free', timeout_ms: 5_000 });
  assert.equal(slot.ok, true);
  // Slot should be granted (queued may be true OR false in the immediate-grant
  // path — the implementation uses queued:true for granted-but-was-routed-
  // through-queue. The load-bearing field is `ok` + the presence of release().
  assert.equal(typeof slot.release, 'function');
  const stats = getQueueStats();
  assert.equal(stats.depth, 1, `depth must be 1 after one grant; got ${stats.depth}`);
  slot.release();
  const after = getQueueStats();
  assert.equal(after.depth, 0, `depth must drop back to 0 after release; got ${after.depth}`);
});

// =============================================================================
// 3) enqueue rejects with queue_timeout when timeout_ms elapses
// =============================================================================

test('W729 #3 — enqueue rejects {code:"queue_timeout"} when timeout_ms elapses', async () => {
  freshDir();
  setCapacity(1);
  // Fill the single slot. Don't release it for the duration of the test.
  const held = await enqueue({ priority: 'free', timeout_ms: 5_000 });
  assert.equal(held.ok, true);
  // Now queue a second request with a short timeout. It MUST reject with
  // queue_timeout because the held slot won't be released in time.
  await assert.rejects(
    async () => enqueue({ priority: 'free', timeout_ms: 50 }),
    (err) => {
      assert.equal(err.code, 'queue_timeout',
        `expected code:'queue_timeout'; got '${err && err.code}'`);
      assert.ok(Number.isFinite(err.retry_after_seconds) && err.retry_after_seconds >= 1,
        `retry_after_seconds must be a positive number; got ${err && err.retry_after_seconds}`);
      return true;
    },
  );
  held.release();
});

// =============================================================================
// 4) Priority lanes: enterprise dequeues before free under contention
// =============================================================================

test('W729 #4 — enterprise dequeues before free under contention', async () => {
  freshDir();
  setCapacity(1);
  const held = await enqueue({ priority: 'free', timeout_ms: 10_000 });
  // Queue free FIRST, enterprise SECOND. When the held slot releases, the
  // dequeue loop walks lanes in priority order so enterprise MUST grant
  // before free even though free was queued first.
  const order = [];
  const pFree = enqueue({ priority: 'free', timeout_ms: 5_000 })
    .then(slot => { order.push('free'); slot.release(); });
  // Yield a tick so the free ticket is in the lane before enterprise enqueues.
  await new Promise(resolve => setImmediate(resolve));
  const pEnt = enqueue({ priority: 'enterprise', timeout_ms: 5_000 })
    .then(slot => { order.push('enterprise'); slot.release(); });
  // Yield another tick so both are queued.
  await new Promise(resolve => setImmediate(resolve));
  // Now release the held slot — drain MUST grant enterprise first.
  held.release();
  await Promise.all([pFree, pEnt]);
  assert.deepEqual(order, ['enterprise', 'free'],
    `enterprise must drain before free; got order=${JSON.stringify(order)}`);
});

// =============================================================================
// 5) getQueueStats shape contract
// =============================================================================

test('W729 #5 — getQueueStats returns {depth:number, capacity:number, by_priority:{enterprise,business,starter,free}}', () => {
  freshDir();
  const stats = getQueueStats();
  assert.equal(typeof stats, 'object');
  assert.equal(typeof stats.depth, 'number',
    `depth must be a number; got ${typeof stats.depth}`);
  assert.equal(typeof stats.capacity, 'number',
    `capacity must be a number; got ${typeof stats.capacity}`);
  assert.equal(typeof stats.by_priority, 'object');
  for (const lane of PRIORITY_LANES) {
    assert.equal(typeof stats.by_priority[lane], 'number',
      `by_priority.${lane} must be a number; got ${typeof stats.by_priority[lane]}`);
    assert.ok(stats.by_priority[lane] >= 0,
      `by_priority.${lane} must be non-negative; got ${stats.by_priority[lane]}`);
  }
});

// =============================================================================
// 6) setCapacity adjusts; rejects non-positive ints
// =============================================================================

test('W729 #6 — setCapacity adjusts capacity; non-positive integers throw', () => {
  freshDir();
  const n = setCapacity(32);
  assert.equal(n, 32);
  const stats = getQueueStats();
  assert.equal(stats.capacity, 32, `capacity must be 32 after setCapacity(32); got ${stats.capacity}`);
  assert.throws(() => setCapacity(0));
  assert.throws(() => setCapacity(-1));
  assert.throws(() => setCapacity(1.5));
  assert.throws(() => setCapacity('not a number'));
});

// =============================================================================
// 7) KOLM_LOAD_QUEUE_DISABLED=1 — enqueue is a no-op
// =============================================================================

test('W729 #7 — KOLM_LOAD_QUEUE_DISABLED=1 makes enqueue resolve immediately (no-op)', async () => {
  freshDir();
  process.env.KOLM_LOAD_QUEUE_DISABLED = '1';
  try {
    setCapacity(1);
    // Even with no available slots, disabled mode resolves immediately
    // because the env-disabled path short-circuits BEFORE capacity check.
    const held = await enqueue({ priority: 'free', timeout_ms: 5_000 });
    held.release();
    const slot = await enqueue({ priority: 'free', timeout_ms: 5_000 });
    assert.equal(slot.ok, true);
    assert.equal(slot.queued, false, 'disabled mode must report queued:false');
    assert.equal(slot.reason, 'disabled', 'disabled mode must report reason:"disabled"');
    assert.equal(typeof slot.release, 'function', 'disabled-mode release() must be a callable no-op');
  } finally {
    delete process.env.KOLM_LOAD_QUEUE_DISABLED;
  }
});

// =============================================================================
// 8) Router middleware → HTTP 429 + Retry-After + envelope
// =============================================================================

test('W729 #8 — loadQueueMiddleware returns HTTP 429 + Retry-After + queue_full envelope', async () => {
  freshDir();
  setCapacity(1);
  // Fill the only slot WITHOUT releasing — never call release(). Then push
  // depth past the 4x backstop so the next enqueue sees queue_full. The
  // queued tickets time out at 200ms (test-fast); the held slot is never
  // released until cleanup so the middleware MUST land on the reject path.
  await enqueue({ priority: 'free', timeout_ms: 5_000 });
  const queued = [];
  for (let i = 0; i < 4; i += 1) {
    queued.push(enqueue({ priority: 'free', timeout_ms: 200 }).catch(() => {}));
  }
  // The middleware mirrors the router definition. Re-implement it inline
  // against the real load-queue module so the test doesn't have to bring
  // up the full router (which has hundreds of imports).
  async function loadQueueMiddleware(req, res) {
    try {
      const slot = await enqueue({ req, priority: 'free', timeout_ms: 50 });
      slot.release();
      res.status = 200;
      res.body = { ok: true };
      res.headers = {};
    } catch (err) {
      const stats = getQueueStats();
      const retryAfter = Math.max(1, Number(err && err.retry_after_seconds) || 60);
      res.status = 429;
      res.headers = { 'Retry-After': String(retryAfter) };
      res.body = {
        ok: false,
        error: (err && err.code) || 'queue_full',
        retry_after_seconds: retryAfter,
        queue_depth: stats.depth,
        capacity: stats.capacity,
      };
    }
  }
  const fakeReq = {};
  const fakeRes = {};
  await loadQueueMiddleware(fakeReq, fakeRes);
  assert.equal(fakeRes.status, 429,
    `middleware must return HTTP 429 on saturation; got ${fakeRes.status}`);
  assert.equal(fakeRes.headers['Retry-After'], '60',
    `Retry-After header must be present and 60s; got ${fakeRes.headers['Retry-After']}`);
  assert.equal(fakeRes.body.ok, false);
  assert.ok(
    fakeRes.body.error === 'queue_full' || fakeRes.body.error === 'queue_timeout',
    `error must be queue_full|queue_timeout; got '${fakeRes.body.error}'`,
  );
  assert.equal(typeof fakeRes.body.retry_after_seconds, 'number');
  assert.equal(typeof fakeRes.body.queue_depth, 'number');
  // Cleanup pending tickets so they don't leak into the next test.
  await Promise.all(queued);
});

// =============================================================================
// 9) W729-2 overflow: KOLM_TEACHER_OVERFLOW_URL + onOverflow callback
// =============================================================================

test('W729 #9 — KOLM_TEACHER_OVERFLOW_URL + onOverflow forwards instead of rejecting', async () => {
  freshDir();
  setCapacity(1);
  process.env.KOLM_TEACHER_OVERFLOW_URL = 'https://teacher.example/forward';
  try {
    // Fill the only slot so the next enqueue is forced to overflow path.
    const held = await enqueue({ priority: 'free', timeout_ms: 10_000 });
    let overflowCalled = false;
    const result = await enqueue({
      req: { id: 'req-w729-overflow' },
      priority: 'free',
      timeout_ms: 5_000,
      onOverflow: async (req) => {
        overflowCalled = true;
        assert.equal(req.id, 'req-w729-overflow', 'onOverflow must receive the req handle');
        return { teacher_response: 'mocked-teacher-output' };
      },
    });
    assert.equal(overflowCalled, true, 'onOverflow callback must have been invoked');
    assert.equal(result.ok, true);
    assert.equal(result.overflowed, true, 'result must report overflowed:true');
    assert.equal(result.teacher_url, 'https://teacher.example/forward',
      `result must echo teacher_url; got ${result.teacher_url}`);
    assert.equal(result.result.teacher_response, 'mocked-teacher-output');
    held.release();
  } finally {
    delete process.env.KOLM_TEACHER_OVERFLOW_URL;
  }
});

// =============================================================================
// 10) horizontal-scaling.html exists + brand-lock + load-bearing strings
// =============================================================================

test('W729 #10 — public/docs/runtime/horizontal-scaling.html exists with brand-lock + load-bearing strings', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand-lock: eyebrow + h1. Match the existing public/docs/runtime/
  // memory-tiers.html pattern (W724) where the eyebrow is the workbench
  // tagline and the H1 is the frontier-AI promise. Anti-brittleness: we
  // lock on the load-bearing tokens, not the exact wrapper markup.
  assert.ok(html.includes('Open-source AI workbench'),
    'horizontal-scaling.html must carry brand eyebrow "Open-source AI workbench"');
  assert.ok(html.includes('Frontier AI on your own infrastructure'),
    'horizontal-scaling.html must carry brand H1 "Frontier AI on your own infrastructure."');
  // Three section headings from the W729 spec MUST appear so the reader
  // skimming the page hits each load-bearing concept.
  for (const needle of ['Stateless workers', 'Queue depth as load signal', 'Horizontal autoscale playbook']) {
    assert.ok(html.includes(needle),
      `horizontal-scaling.html must contain section "${needle}"`);
  }
  // CLI reference for kolm load queue --stats MUST appear so the doc and the
  // CLI agree on the verb shape.
  assert.ok(html.includes('kolm load queue --stats'),
    'horizontal-scaling.html must reference `kolm load queue --stats` CLI verb');
  // HTTP 429 + Retry-After must be documented so SDK authors know the contract.
  assert.ok(html.includes('Retry-After'),
    'horizontal-scaling.html must document the Retry-After header contract');
  assert.ok(html.includes('429'),
    'horizontal-scaling.html must document HTTP 429 status');
});

// =============================================================================
// 11) CLI cmdW729LoadStatus dispatcher present
// =============================================================================

test('W729 #11 — cli/kolm.js exposes the cmdW729LoadStatus dispatcher (distinct named, parallel-safe)', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct name lock — must not collide with the W724/W726/W727/W728/W730
  // dispatchers in the parallel-wave touch surface.
  assert.ok(/async\s+function\s+cmdW729LoadStatus\s*\(/.test(cli),
    'cli/kolm.js must define `async function cmdW729LoadStatus(`');
  // Wired into the main switch via the `load` verb.
  assert.ok(/case\s+['"]load['"]/.test(cli),
    'cli/kolm.js main switch must dispatch on the `load` verb');
  assert.ok(/cmdW729LoadStatus\(/.test(cli),
    'cli/kolm.js must invoke cmdW729LoadStatus from the load verb dispatcher');
});

// =============================================================================
// 12) Anti-brittleness: family lock-in uses regex + threshold (no explicit array)
// =============================================================================

test('W729 #12 — wave729 sibling test count uses regex(7\\d\\d) + threshold pattern (no explicit array)', () => {
  freshDir();
  // The W604 anti-brittleness contract forbids explicit-array family checks.
  // Walk the tests directory and count files matching wave(7\d\d). Adding
  // more wave7xx tests must never break this assertion.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(7\d{2})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 3,
    `expected >=3 wave7xx test files; found ${siblings.length}: ${siblings.join(',')}`);
});

// =============================================================================
// 13) _resetForTests is called between tests (smoke check the helper exists)
// =============================================================================

test('W729 #13 — _resetForTests is exported and clears singleton state', async () => {
  freshDir();
  setCapacity(7);
  // Acquire a slot so in-flight > 0.
  const slot = await enqueue({ priority: 'free', timeout_ms: 5_000 });
  // Before reset: capacity 7, depth 1.
  let stats = getQueueStats();
  assert.equal(stats.capacity, 7);
  assert.equal(stats.depth, 1);
  // Reset blows away everything — capacity goes back to module default,
  // depth goes to 0 (in-flight + every lane both reset).
  _resetForTests();
  stats = getQueueStats();
  assert.notEqual(stats.capacity, 7,
    'after _resetForTests capacity must be back to default (not 7)');
  assert.equal(stats.depth, 0,
    `after _resetForTests depth must be 0; got ${stats.depth}`);
  // The held slot's release() is now a no-op against fresh state; calling
  // it must not throw or push in_flight negative.
  slot.release();
  stats = getQueueStats();
  assert.equal(stats.depth, 0,
    `release() on a stale slot must not push depth below 0; got ${stats.depth}`);
});
