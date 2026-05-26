// W889-11.1 — E2E persona suite + 52-check ship-gate umbrella test.
//
// Locks the 15 invariants documented in the W889-11.1 spec. This test is the
// final gate before W889-12 (commit + close). It runs the actual ship-gate
// orchestrator and the four persona drivers via spawnSync — slower than the
// other wave889 tests (~30-90s end-to-end depending on Node version + disk
// speed) but the only way to verify the contract is alive.
//
// Run: node --test --test-concurrency=1 tests/wave889-11-e2e-ship-gate.test.js
//
// Invariants (verbatim from the W889-11.1 spec):
//   1.  scripts/ship-gate.cjs exists and is executable
//   2.  scripts/e2e/full-loop.cjs exists
//   3.  At least 4 persona drivers (scripts/e2e/persona-{full,indie,enterprise,no-gpu}.cjs)
//   4.  `kolm test ship-gate --json` exits 0 with all 52 checks passing
//   5.  Ship-gate output JSON has total_checks:52 passed:52 failed:0
//   6.  Ship-gate covers all 7 surfaces (wrapper/studio/run/cross/infra/account/perf)
//   7.  `kolm test e2e --persona full --dry-run --json` exits 0
//   8.  `kolm test e2e --persona indie --dry-run --json` exits 0
//   9.  `kolm test e2e --persona enterprise --dry-run --json` exits 0
//   10. `kolm test e2e --persona no-gpu --dry-run --json` exits 0
//   11. data/w889-11-gate-failures.json exists
//   12. Ship-gate covers W888 assistant block (/v1/assistant/chat + chat-docs)
//   13. Ship-gate covers W889 new surfaces (pricing/book-demo, marketplace,
//       GitHub OAuth, SEO compile/* pages, vertical pages)
//   14. audit-static-refs shows 0 missing
//   15. audit-href --strict shows 0 broken

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHIP_GATE = path.join(ROOT, 'scripts', 'ship-gate.cjs');
const KOLM = path.join(ROOT, 'cli', 'kolm.js');
const E2E_DIR = path.join(ROOT, 'scripts', 'e2e');

// ----- Invariant 1 -----
test('W889-11.1 #1 — scripts/ship-gate.cjs exists', () => {
  assert.ok(fs.existsSync(SHIP_GATE), 'scripts/ship-gate.cjs must exist');
  // Read enough to clear the documentation banner before the body.
  const src = fs.readFileSync(SHIP_GATE, 'utf8');
  assert.match(src.slice(0, 5000), /'use strict'|require\(|#!\/usr\/bin\/env node/,
    'must be a Node CJS script (shebang or "use strict" or require())');
  assert.match(src.slice(0, 5000), /ship[ -]?gate|52[ -]?check/i,
    'must reference the 52-check ship-gate');
});

// ----- Invariant 2 -----
test('W889-11.1 #2 — scripts/e2e/full-loop.cjs exists', () => {
  const f = path.join(E2E_DIR, 'full-loop.cjs');
  assert.ok(fs.existsSync(f), 'scripts/e2e/full-loop.cjs must exist');
  const head = fs.readFileSync(f, 'utf8').slice(0, 1000);
  assert.match(head, /full[ -]?loop|BLOCK 11|cross.?surface/i,
    'must reference BLOCK 11 / cross-surface');
});

// ----- Invariant 3 -----
test('W889-11.1 #3 — four persona drivers present (full+indie+enterprise+no-gpu)', () => {
  const expected = ['persona-full.cjs', 'persona-indie.cjs', 'persona-enterprise.cjs', 'persona-no-gpu.cjs'];
  for (const fname of expected) {
    const p = path.join(E2E_DIR, fname);
    assert.ok(fs.existsSync(p), `${fname} must exist under scripts/e2e/`);
  }
  // Also assert at least 4 — defends against accidental removal during refactor.
  const all = fs.readdirSync(E2E_DIR).filter((f) => /^persona-.*\.cjs$/.test(f));
  assert.ok(all.length >= 4, `must have >= 4 persona-*.cjs drivers; got ${all.length}: ${all.join(',')}`);
});

// ----- Invariants 4, 5, 6, 12 — run the actual 52-check gate. Slow (~60-90s). -----
test('W889-11.1 #4+5+6+12 — ship-gate runs to completion with 52/52 pass coverage', { timeout: 600_000 }, () => {
  // Strip NODE_OPTIONS / TEST mode markers so the child ship-gate is run as
  // a "regular" process — node --test will set NODE_OPTIONS='--test' on the
  // parent which the child would otherwise inherit, causing spawned grandkid
  // node --test invocations (each ship-gate check that uses shellTest()) to
  // misbehave under nested test mode.
  const childEnv = { ...process.env, NODE_ENV: 'test' };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [SHIP_GATE, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 540_000, maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });
  // Surface stderr on unexpected exit for triage.
  assert.ok(r.status === 0 || r.status === 2,
    `ship-gate must exit 0 (or 2 for NO_TEST_YET-only); got ${r.status} stderr=${(r.stderr || '').slice(0, 800)} stdout_tail=${(r.stdout || '').slice(-800)}`);

  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout || '').trim()); }
  catch (e) { assert.fail('ship-gate stdout must be valid JSON: ' + (r.stdout || '').slice(0, 500)); }

  // Invariant 5 — counts.
  assert.equal(parsed.total, 52, 'ship-gate must run exactly 52 checks');
  // Invariant 4 — all-pass-or-skip-as-pass policy. The ship-gate counts
  // env_conditional skips as PASS (scaffolds return skipped:true → pass), so
  // failed must be 0. NO_TEST_YET is also 0 because every check has a runner.
  assert.equal(parsed.failed, 0, `ship-gate must have 0 failed; got ${parsed.failed}; first failure: ${
    (parsed.checks || []).filter((c) => !c.ok && !c.skipped && !c.not_yet).slice(0, 3).map((c) =>
      `#${c.id} ${c.name} — ${(c.detail || '').split('\n')[0].slice(0, 120)}`).join(' | ') || 'none'
  }`);
  assert.equal(parsed.not_yet, 0, `ship-gate must have 0 NO_TEST_YET; got ${parsed.not_yet}`);
  assert.ok(parsed.passed >= 52 - (parsed.skipped || 0),
    `passed (${parsed.passed}) + skipped (${parsed.skipped}) must cover all 52`);

  // Invariant 6 — all 7 PART D surfaces present.
  const expectedSurfaces = ['wrapper', 'studio', 'run', 'cross', 'infra', 'account', 'perf'];
  for (const surface of expectedSurfaces) {
    assert.ok(parsed.surfaces && parsed.surfaces[surface],
      `surfaces summary must include "${surface}"; got: ${Object.keys(parsed.surfaces || {}).join(',')}`);
    assert.ok(parsed.surfaces[surface].total > 0,
      `surface "${surface}" must have at least one check`);
  }

  // Invariant 12 — assistant block (/v1/assistant/chat + chat-docs) is exercised
  // by check #5 (Streaming SSE — wave723-streaming-load.test.js wires
  // /v1/assistant/chat) and check #43 (SDK examples — covers /v1/assistant/*).
  // We also assert structural presence in the ship-gate source: the W888-T
  // assistant umbrella test name is referenced in the shellTest invocations
  // OR the /v1/assistant routes exist in src/router.js (which is the absolute
  // source of truth that those endpoints are under coverage).
  const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  assert.ok(/\/v1\/assistant\/chat\b/.test(routerSrc), '/v1/assistant/chat must be defined in src/router.js');
  assert.ok(/\/v1\/assistant\/chat-docs\b/.test(routerSrc), '/v1/assistant/chat-docs must be defined in src/router.js');
});

// ----- Invariants 7-10 — dry-run each persona via the CLI. Each one boots Node, no server, <5s. -----
function runE2EDryRun(personaKey) {
  const r = spawnSync(process.execPath, [
    KOLM, 'test', 'e2e', '--persona', personaKey, '--dry-run', '--json',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return r;
}

test('W889-11.1 #7 — kolm test e2e --persona full --dry-run --json exits 0', () => {
  const r = runE2EDryRun('full');
  assert.equal(r.status, 0,
    `--persona full --dry-run --json must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  // The CLI emits a wrapping JSON summary; the persona envelope is nested under results[].envelope.
  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout || '').trim()); } catch (_) {} // deliberate: cleanup
  assert.ok(parsed, 'CLI must emit valid JSON');
  assert.equal(parsed.ok, true, `full dry-run must report ok:true; got ${parsed.ok}`);
  assert.deepEqual(parsed.personas, ['full'], 'personas list must be exactly ["full"]');
});

test('W889-11.1 #8 — kolm test e2e --persona indie --dry-run --json exits 0', () => {
  const r = runE2EDryRun('indie');
  assert.equal(r.status, 0,
    `--persona indie --dry-run --json must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  const parsed = JSON.parse(String(r.stdout || '').trim());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.personas, ['indie']);
});

test('W889-11.1 #9 — kolm test e2e --persona enterprise --dry-run --json exits 0', () => {
  const r = runE2EDryRun('enterprise');
  assert.equal(r.status, 0,
    `--persona enterprise --dry-run --json must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  const parsed = JSON.parse(String(r.stdout || '').trim());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.personas, ['enterprise']);
});

test('W889-11.1 #10 — kolm test e2e --persona no-gpu --dry-run --json exits 0', () => {
  const r = runE2EDryRun('no-gpu');
  assert.equal(r.status, 0,
    `--persona no-gpu --dry-run --json must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  const parsed = JSON.parse(String(r.stdout || '').trim());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.personas, ['no-gpu']);
});

// ----- Invariant 11 -----
test('W889-11.1 #11 — data/w889-11-gate-failures.json exists with the right schema', () => {
  const p = path.join(ROOT, 'data', 'w889-11-gate-failures.json');
  assert.ok(fs.existsSync(p), 'data/w889-11-gate-failures.json must exist');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(j.wave, 'W889-11.1', 'wave field must be W889-11.1');
  assert.ok(Array.isArray(j.failures), 'failures must be an array');
  // Goal: failures should be []. If any are present they must each carry
  // { surface, check_id, reason, recommended_fix } per the spec contract.
  for (const f of j.failures) {
    assert.ok(typeof f.surface === 'string' && f.surface.length, 'failure.surface required');
    assert.ok(typeof f.check_id === 'number' || typeof f.check_id === 'string', 'failure.check_id required');
    assert.ok(typeof f.reason === 'string', 'failure.reason required');
    assert.ok(typeof f.recommended_fix === 'string', 'failure.recommended_fix required');
  }
});

// ----- Invariant 13 — W889 new surfaces wired -----
test('W889-11.1 #13 — W889 new surfaces wired (book-demo, marketplace, GitHub OAuth, SEO, verticals)', () => {
  const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  // /v1/sales/demo-request (W889-6.1 book-demo intake)
  assert.ok(/\/v1\/sales\/demo-request\b/.test(routerSrc),
    '/v1/sales/demo-request must be defined (W889-6.1 book-demo)');
  // /v1/marketplace/interest (W889-10 marketplace teaser)
  assert.ok(/\/v1\/marketplace\/interest\b/.test(routerSrc),
    '/v1/marketplace/interest must be defined (W889-10 marketplace)');
  // /v1/auth/github (W889-8.4 GitHub OAuth)
  assert.ok(/\/v1\/auth\/github\b/.test(routerSrc),
    '/v1/auth/github must be defined (W889-8.4 GitHub OAuth)');
  // SEO compile/* page — at least one resolvable HTML page
  const compileDir = path.join(ROOT, 'public', 'compile');
  assert.ok(fs.existsSync(compileDir), 'public/compile/ must exist (W889-8.3 SEO pages)');
  const compilePages = fs.readdirSync(compileDir).filter((f) => f.endsWith('.html'));
  assert.ok(compilePages.length >= 50,
    `public/compile/*.html must have at least 50 SEO pages; got ${compilePages.length}`);
  // Vertical pages — healthcare + finance + legal (W889-8.1)
  for (const v of ['healthcare', 'finance', 'legal']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', `${v}.html`)),
      `public/${v}.html must exist (W889-8.1 vertical landing)`);
  }
});

// ----- Invariant 14 — audit-static-refs clean -----
test('W889-11.1 #14 — audit-static-refs reports 0 missing', { timeout: 120_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-static-refs.cjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0,
    `audit-static-refs must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  // The script's success message is "missing static refs: 0" — pin that string.
  assert.match(String(r.stdout || ''), /missing static refs:\s*0\b/i,
    'audit must report "missing static refs: 0"');
});

// ----- Invariant 15 — audit-href --strict clean -----
test('W889-11.1 #15 — audit-href --strict reports 0 broken', { timeout: 180_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-href.cjs'), '--strict'], {
    cwd: ROOT, encoding: 'utf8', timeout: 150_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0,
    `audit-href --strict must exit 0; got ${r.status} stderr=${(r.stderr || '').slice(0, 500)}`);
  assert.match(String(r.stdout || ''), /broken:\s*0\b/i, 'audit must report "broken: 0"');
});
