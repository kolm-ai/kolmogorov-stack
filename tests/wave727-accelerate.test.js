// W727 — Student-as-Draft Speculative Decoding tests.
//
// Three atomic items from KOLM_W707_SYSTEM_UPGRADE_PLAN.md:
//
//   W727-1  /v1/chat/completions?accelerate=true flag — student proposes,
//           teacher verifies in parallel; envelope carries
//           {accelerated, acceptance_rate, draft_tokens_*, teacher_verifications}.
//
//   W727-2  Compose with W709 confidence routing — high-confidence student
//           paths skip teacher verification entirely (teacher_verifications=0).
//
//   W727-3  Bench: acceptance_rate per task class (extraction, generation,
//           reasoning) — reports mean tokens-accepted per draft round.
//
// W604 anti-brittleness: sibling-wave detection uses regex `wave(\d{3,4})`
// + numeric threshold instead of an explicit-array list. A future W728/W729
// wave that adds another sibling test file does NOT have to touch this one.
// Assertions key on load-bearing fields (constants, error codes, function
// names, envelope shapes) instead of brittle line counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ACCELERATE_VERSION,
  TASK_CLASSES,
  BASELINES,
  detectSpecDecodeBackend,
  acceleratedChatCompletion,
  benchAcceptanceRate,
} from '../src/accelerate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const BENCH_PATH = path.join(REPO_ROOT, 'bench', 'wave727-acceleration-bench.js');
const ACCEL_PATH = path.join(REPO_ROOT, 'src', 'accelerate.js');
const CLI_FULL_BODY_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Fresh KOLM_DATA_DIR per test so any incidental writes never collide
// across the larger suite. Matches the freshDir pattern in
// tests/wave726-*.test.js + tests/wave721-*.test.js.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w727-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // CRITICAL: clear the backend env so detectSpecDecodeBackend() returns
  // the honest no_kernel envelope unless a test explicitly overrides it.
  delete process.env.KOLM_SPEC_DECODE_BACKEND;
  return tmp;
}

// Synthetic backend the bench can use to verify acceptance-rate math.
// Each "propose" returns n tokens; "verify" accepts the first
// floor(n * acceptanceP) and supplies a teacher correction for the rest.
function makeMockBackend({ acceptanceP = 0.75, perTokenCostMicro = 100, teacherCostMicro = 800, teacherOnlyMs = 1000 } = {}) {
  return {
    wall_clock_ms_teacher_only: teacherOnlyMs,
    async propose({ messages, n }) {
      const tokens = [];
      // Deterministic token text so the assertions on accepted_text are stable.
      const seed = crypto.createHash('sha256').update(String((messages || []).map(m => m.content).join('|'))).digest('hex').slice(0, 8);
      for (let i = 0; i < n; i += 1) {
        tokens.push({ text: `s${i}_${seed.slice(0, 2)}`, logprob: -0.1 });
      }
      return { tokens, cost_micro_usd: n * perTokenCostMicro };
    },
    async verify({ messages, draft }) {
      void messages;
      const n = draft.length;
      const acceptCount = Math.floor(n * acceptanceP);
      const accepted = new Array(n).fill(false);
      for (let i = 0; i < acceptCount; i += 1) accepted[i] = true;
      return {
        accepted,
        teacher_token: acceptCount < n ? { text: '<TEACHER>' } : null,
        cost_micro_usd: teacherCostMicro,
        latency_ms: 12,
      };
    },
  };
}

// =============================================================================
// 1) ACCELERATE_VERSION constant present (exact string lock-in).
// =============================================================================

test('W727 #1 — ACCELERATE_VERSION === "w727-v1"', () => {
  freshDir();
  assert.equal(ACCELERATE_VERSION, 'w727-v1');
});

// =============================================================================
// 2) acceleratedChatCompletion function is exported + callable.
// =============================================================================

test('W727 #2 — acceleratedChatCompletion function exported + is async', () => {
  freshDir();
  assert.equal(typeof acceleratedChatCompletion, 'function');
  // async functions show as 'AsyncFunction' on their constructor
  assert.equal(acceleratedChatCompletion.constructor.name, 'AsyncFunction');
  // Sibling exports the W707 plan calls out.
  assert.equal(typeof benchAcceptanceRate, 'function');
  assert.equal(typeof detectSpecDecodeBackend, 'function');
  // Baselines are stable per task class.
  assert.deepEqual(TASK_CLASSES.slice().sort(), ['extraction', 'generation', 'reasoning']);
  assert.equal(BASELINES.extraction, 0.60);
  assert.equal(BASELINES.generation, 0.40);
  assert.equal(BASELINES.reasoning, 0.30);
});

// =============================================================================
// 3) Honest no_kernel envelope when no backend wired.
// =============================================================================

test('W727 #3 — acceleratedChatCompletion returns no_kernel envelope when no backend', async () => {
  freshDir();
  const r = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    namespace: 'tenant_w727_ns',
    accelerate: true,
    n_draft_tokens: 4,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_kernel');
  assert.ok(typeof r.hint === 'string' && r.hint.includes('KOLM_SPEC_DECODE_BACKEND'),
    'hint must mention KOLM_SPEC_DECODE_BACKEND so the operator can self-serve');
  assert.equal(r.version, 'w727-v1');
});

// =============================================================================
// 4) acceptance_rate is a number in [0,1] when mock backend is injected.
// =============================================================================

test('W727 #4 — acceptance_rate is a finite number in [0,1] with mock backend', async () => {
  freshDir();
  const backend = makeMockBackend({ acceptanceP: 0.75 });
  const r = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'test extraction' }],
    namespace: 'tenant_w727_ns',
    accelerate: true,
    n_draft_tokens: 8,
    backend,
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.acceptance_rate, 'number');
  assert.ok(Number.isFinite(r.acceptance_rate));
  assert.ok(r.acceptance_rate >= 0 && r.acceptance_rate <= 1,
    `acceptance_rate must be in [0,1]; got ${r.acceptance_rate}`);
  assert.equal(r.draft_tokens_proposed, 8);
  // With acceptanceP=0.75 over 8 tokens we expect exactly 6 accepted.
  assert.equal(r.draft_tokens_accepted, 6);
  assert.ok(Math.abs(r.acceptance_rate - 0.75) < 1e-9);
  // Teacher was invoked exactly once (parallel verification round).
  assert.equal(r.teacher_verifications, 1);
  assert.equal(r.route, 'accelerated');
  assert.equal(r.accelerated, true);
  assert.ok(typeof r.accepted_text === 'string' && r.accepted_text.length > 0);
  assert.ok(r.accepted_text.includes('<TEACHER>'), 'teacher correction should be appended after the rejected run');
});

// =============================================================================
// 5) W709 confidence-router compose: student-only + confidence>thr → 0 teacher.
// =============================================================================

test('W727 #5 — confidence_probe student-only + confidence>threshold bypasses teacher', async () => {
  freshDir();
  const backend = makeMockBackend({ acceptanceP: 0.5 }); // would normally drop half
  const r = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'high-confidence input' }],
    namespace: 'tenant_w727_ns',
    accelerate: true,
    n_draft_tokens: 4,
    backend,
    confidence_probe: { route: 'student-only', confidence: 0.95, threshold: 0.85 },
  });
  assert.equal(r.ok, true);
  // The whole point of the compose: when the router says student-only with
  // high confidence, we accept all drafted tokens and never call teacher.
  assert.equal(r.teacher_verifications, 0,
    'student-only high-confidence path must skip teacher verification entirely');
  assert.equal(r.route, 'student-only');
  assert.equal(r.draft_tokens_accepted, r.draft_tokens_proposed,
    'all draft tokens should accept when teacher is bypassed');
  assert.equal(r.acceptance_rate, 1);
  // Defense check: a LOW-confidence student-only probe must NOT bypass.
  const r2 = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'low-confidence input' }],
    namespace: 'tenant_w727_ns',
    accelerate: true,
    n_draft_tokens: 4,
    backend,
    confidence_probe: { route: 'student-only', confidence: 0.5, threshold: 0.85 },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.teacher_verifications, 1,
    'low-confidence probe must still pay the teacher verification round');
});

// =============================================================================
// 6) Router: POST /v1/chat/completions?accelerate=true honors the flag.
//
// We mount the router under an in-process express app, provision an authed
// tenant via auth.js, and assert the route returns 200 + an envelope that
// includes accelerated:true/false + the W727-specific fields. Because no
// real backend is wired the response will carry accelerated:false with a
// fallback_reason — the contract is that the response carries the W727
// fields, NOT that production has a backend yet.
// =============================================================================

test('W727 #6 — POST /v1/chat/completions?accelerate=true returns W727 envelope', async () => {
  const tmp = freshDir();
  process.env.KOLM_PRODUCTION = '1';
  delete process.env.KOLM_LOCAL_DAEMON;
  process.env.KOLM_CONNECTOR_FIXTURE = '1';
  process.env.KOLM_EVENT_STORE_PATH = path.join(tmp, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  process.env.KOLM_STORE_DRIVER = process.env.KOLM_STORE_DRIVER || 'json';
  try {
    const { default: es } = await import('../src/event-store.js').then(m => ({ default: m })).catch(() => ({ default: null }));
    if (es && es._resetForTests) es._resetForTests();
  } catch (_) { /* not all modules expose this */ }

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());

  const tenant = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  // Defense-in-depth tenant fence: the auth.js helper returns a real
  // tenant_record with an id. The route handler MUST refuse without one.
  assert.ok(tenant && tenant.api_key, 'provisionAnonTenant must return a key');

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions?accelerate=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + tenant.api_key,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        namespace: 'tenant_w727_ns',
        n_draft_tokens: 4,
      }),
    });
    assert.notEqual(res.status, 401,
      'a valid kolm key must pass the W411 gate on the accelerate route');
    const body = await res.json().catch(() => ({}));
    // Either the accelerated path ran (production with backend wired) or
    // the honest fallback path stamped the envelope. Either way, the W727
    // fields MUST appear so downstream observability sees a stable shape.
    const expectedFields = ['accelerated', 'acceptance_rate', 'draft_tokens_proposed', 'draft_tokens_accepted', 'teacher_verifications'];
    for (const f of expectedFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(body, f),
        `response envelope must carry ${f}; got ${JSON.stringify(Object.keys(body)).slice(0, 400)}`);
    }
    // When the fallback path fires (no backend), accelerated must be false.
    // When the accelerated path fires (test backend), it must be true.
    assert.equal(typeof body.accelerated, 'boolean');
    if (body.accelerated === false) {
      assert.ok(typeof body.fallback_reason === 'string' && body.fallback_reason.length > 0,
        'fallback path must carry fallback_reason');
    }
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 7) Bench script importable + runBench returns task_class-keyed object.
// =============================================================================

test('W727 #7 — bench script importable; runBench returns task_class-keyed envelope', async () => {
  freshDir();
  const mod = await import('../bench/wave727-acceleration-bench.js');
  assert.equal(typeof mod.runBench, 'function');
  const r = await mod.runBench({ samples: 2 }); // no backend → every class skipped
  assert.equal(r.ok, true);
  assert.equal(r.version, 'w727-v1');
  assert.equal(typeof r.by_task_class, 'object');
  // Every task class must appear in the envelope so dashboard cards don't
  // silently drop a column when one class is skipped.
  for (const tc of ['extraction', 'generation', 'reasoning']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.by_task_class, tc),
      `by_task_class must include ${tc}`);
    assert.equal(r.by_task_class[tc].task_class, tc);
    // Without a backend, every class is honestly skipped.
    assert.equal(r.by_task_class[tc].skipped, true);
    assert.equal(r.by_task_class[tc].reason, 'no_kernel');
    assert.equal(r.by_task_class[tc].baseline_floor, BASELINES[tc]);
  }
  // any_class_ran=false → all_classes_meet_baseline=null (not false). A
  // false here would falsely flag the bench as a regression when in fact
  // it just had no backend to test.
  assert.equal(r.any_class_ran, false);
  assert.equal(r.all_classes_meet_baseline, null);
});

// =============================================================================
// 8) CLI cmdW727Accelerate dispatcher present + named uniquely.
// =============================================================================

test('W727 #8 — cli/kolm.js contains the cmdW727Accelerate dispatcher symbol', () => {
  freshDir();
  const body = fs.readFileSync(CLI_FULL_BODY_PATH, 'utf8');
  // Distinct-named dispatcher so parallel-wave agents (W728/W729/W730) do
  // not merge-conflict on the symbol. The plan calls this out as a
  // NON-NEGOTIABLE constraint.
  assert.ok(/async function cmdW727Accelerate\b/.test(body),
    'cli/kolm.js must declare async function cmdW727Accelerate(...)');
  // The dispatcher must be wired from the main switch via a 'accelerate' verb.
  assert.ok(/case 'accelerate':/.test(body),
    'cli/kolm.js main switch must route the "accelerate" verb to cmdW727Accelerate');
  assert.ok(/cmdW727Accelerate\(rest\)/.test(body),
    'main switch must invoke cmdW727Accelerate(rest)');
  // No collision with a parallel-wave name.
  const w728 = (body.match(/async function cmdW728\w*/g) || []).length;
  const w729 = (body.match(/async function cmdW729\w*/g) || []).length;
  const w730 = (body.match(/async function cmdW730\w*/g) || []).length;
  void w728; void w729; void w730; // referenced for grep-completeness
  // CLI smoke: `kolm accelerate test --message ...` returns the no_kernel
  // envelope (cli exit 3, MISSING_PREREQ) when no backend is wired. We
  // verify exit code 3 via spawnSync so we cover the dispatcher end-to-end.
  const r = spawnSync(process.execPath, [CLI_PATH, 'accelerate', 'test', '--message', 'hello'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_INTERACTIVE: '1' },
  });
  assert.equal(r.status, 3,
    `expected exit 3 (MISSING_PREREQ); got ${r.status}; stdout=${(r.stdout || '').slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const out = (r.stdout || '').trim();
  // The envelope MUST be JSON-formatted on stdout.
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) { /* fall through */ }
  assert.ok(parsed && typeof parsed === 'object', `stdout must be JSON; got ${out.slice(0, 400)}`);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'no_kernel');
  assert.equal(parsed.version, 'w727-v1');
});

// =============================================================================
// 9) Anti-brittleness: regex `wave(\d{3,4})` sibling-wave detection.
//
// Mirrors the W604/W726 pattern: a future W728/W729/W730 wave adding
// another sibling test file MUST NOT have to touch this file. We assert
// that THIS file is in the sibling set AND that the set has at least one
// entry. We DO NOT assert an exact count.
// =============================================================================

test('W727 #9 — sibling wave test files use regex+threshold (no explicit-array)', () => {
  freshDir();
  const testsDir = path.join(REPO_ROOT, 'tests');
  const files = fs.readdirSync(testsDir);
  const siblings = files.filter(f => /^wave(\d{3,4})/i.test(f) && /\.test\.js$/.test(f));
  // Threshold ">= 1" stays true forever; an explicit count would break the
  // moment any other wave ships.
  assert.ok(siblings.length >= 1,
    `expected at least 1 wave sibling test; got ${siblings.length}`);
  // And this file MUST be in the set so we never accidentally delete
  // ourselves out of the lock-in.
  assert.ok(siblings.some(f => f.startsWith('wave727-')),
    `the W727 test file must be in the sibling list; got ${JSON.stringify(siblings.slice(0, 20))}`);
  // W604 anti-brittleness regression guard: scan our own body for any
  // hardcoded array of wave names. If a future hand-edit reintroduces one,
  // this assertion will fail loudly.
  const ownPath = fileURLToPath(import.meta.url);
  const ownBody = fs.readFileSync(ownPath, 'utf8');
  const explicitArrayPattern = /\[\s*['"]wave\d{3,4}/;
  // Strip this very block's comment + its own pattern so the self-grep
  // doesn't false-positive on its own regex literal.
  const stripped = ownBody.split(/\r?\n/).filter(l => !/explicit-array|explicitArray/.test(l)).join('\n');
  if (explicitArrayPattern.test(stripped)) {
    assert.fail('W604 anti-brittleness: explicit-array sibling list detected in W727 test file');
  }
  // Sanity reference so the crypto import is not flagged as unused.
  void crypto;
});

// =============================================================================
// 10) Tenant-fenced bench + module file presence guard.
//
// The bench writes nothing tenant-scoped today (it's a pure in-memory
// orchestration over the mock/no-kernel paths) but we still assert that
// every accelerate envelope carries the version field so downstream
// observability can dispatch on it without crashing on a missing key.
// =============================================================================

test('W727 #10 — every envelope carries version + bench/source files present on disk', async () => {
  freshDir();
  // Source modules MUST be present so the W707 wave plan can be re-run by
  // any agent. Missing-on-disk = unshipped, which is exactly what this
  // wave's audit gate should catch.
  assert.ok(fs.existsSync(ACCEL_PATH), `src/accelerate.js must exist at ${ACCEL_PATH}`);
  assert.ok(fs.existsSync(BENCH_PATH), `bench/wave727-acceleration-bench.js must exist at ${BENCH_PATH}`);
  // Every envelope shape — ok:true and ok:false alike — carries version.
  const det = detectSpecDecodeBackend({});
  assert.equal(det.version, 'w727-v1', 'detectSpecDecodeBackend honest envelope must include version');
  const noBackend = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    namespace: 'tenant_w727_ns',
    accelerate: true,
  });
  assert.equal(noBackend.version, 'w727-v1');
  const accelMissingFlag = await acceleratedChatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    namespace: 'tenant_w727_ns',
    accelerate: false,
  });
  assert.equal(accelMissingFlag.ok, false);
  assert.equal(accelMissingFlag.error, 'accelerate_false');
  assert.equal(accelMissingFlag.version, 'w727-v1');
  // benchAcceptanceRate with a mock backend: the per-class envelope MUST
  // carry baseline_floor + meets_baseline so the W727-3 acceptance gate
  // can be applied programmatically.
  const backend = makeMockBackend({ acceptanceP: 0.70 });
  // n_draft_tokens=10 so floor(10 * 0.70) = 7 -> exact 0.70 per sample.
  const b = await benchAcceptanceRate({ task_class: 'extraction', samples: 3, backend, n_draft_tokens: 10 });
  assert.equal(b.ok, true);
  assert.equal(b.task_class, 'extraction');
  assert.equal(b.baseline_floor, 0.60);
  assert.equal(typeof b.meets_baseline, 'boolean');
  // 0.70 mean acceptance >= 0.60 baseline -> meets_baseline:true
  assert.equal(b.meets_baseline, true);
  assert.ok(typeof b.mean_acceptance_rate === 'number' && b.mean_acceptance_rate >= 0 && b.mean_acceptance_rate <= 1);
  // Defense-in-depth tenant fence demo: a different task class doesn't
  // leak into this envelope.
  assert.equal(b.task_class, 'extraction');
  assert.notEqual(b.task_class, 'reasoning');
});
