// W888-I — Ship Gate smoke test.
//
// Pins the framework contract for scripts/ship-gate.cjs so we can keep
// touching it without breaking the JSON shape downstream tooling
// (release-verify gate #11, the website's audit JSONs, the dashboard
// fleet readiness widget) depends on. The actual 52 checks pass or fail
// based on the codebase state; this test only checks the orchestrator's
// envelope and surface-count contract.
//
// Three lock-ins:
//   1. Running with every check skipped (--skip=1..52) returns valid JSON
//      with shape { total: 52, passed: 0, failed: 0, not_yet: 0, skipped: 52, checks: [...] }.
//   2. Each check has the required fields { id, name, surface }.
//   3. Surface counts match the PART D breakdown:
//        wrapper=10, studio=10, run=10, cross=5, infra=12, account=3, perf=2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ship-gate.cjs');

test('W888-I smoke — ship-gate.cjs exists and is a CommonJS script', () => {
  assert.ok(fs.existsSync(SCRIPT), `${SCRIPT} must exist`);
  const head = fs.readFileSync(SCRIPT, 'utf8').slice(0, 4000);
  // sanity: must be CJS (not ESM)
  assert.match(head, /'use strict'|require\(/, 'ship-gate.cjs must use CJS (require())');
  // sanity: must document the surface breakdown
  assert.match(head, /wrapper.*10/i, 'header must document wrapper=10 surface count');
});

test('W888-I smoke — --json --skip=1..52 emits a valid all-skipped envelope', () => {
  // Skip every single check. The script should still complete, emit a single
  // JSON line on stdout, and return exit 0 (since no blockers failed and no
  // not_yet warnings fired).
  const allIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--json', `--skip=${allIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0,
    `script must exit 0 when every check is skipped; got ${r.status}; stderr: ${(r.stderr || '').slice(0, 500)}`);
  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout || '').trim()); } catch (e) {
    assert.fail('stdout was not valid JSON: ' + (r.stdout || '').slice(0, 500) + ' err=' + e.message);
  }
  assert.equal(parsed.total, 52, 'total must be 52');
  assert.equal(parsed.passed, 0, 'passed must be 0 when everything skipped');
  assert.equal(parsed.failed, 0, 'failed must be 0 when everything skipped');
  assert.equal(parsed.not_yet, 0, 'not_yet must be 0 when everything skipped');
  assert.equal(parsed.skipped, 52, 'skipped must be 52');
  assert.ok(Array.isArray(parsed.checks), 'checks must be an array');
  assert.equal(parsed.checks.length, 52, 'checks array must have 52 entries');
});

test('W888-I smoke — every check has { id, name, surface } and unique sequential ids', () => {
  const allIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--json', `--skip=${allIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(r.stdout || '').trim());
  const seenIds = new Set();
  const validSurfaces = new Set(['wrapper', 'studio', 'run', 'cross', 'infra', 'account', 'perf']);
  for (let i = 0; i < parsed.checks.length; i++) {
    const c = parsed.checks[i];
    assert.equal(typeof c.id, 'number', `check[${i}] must have numeric id`);
    assert.equal(typeof c.name, 'string', `check[${i}] must have string name`);
    assert.equal(typeof c.surface, 'string', `check[${i}] must have string surface`);
    assert.ok(c.name.length > 0, `check[${i}] name must be non-empty`);
    assert.ok(validSurfaces.has(c.surface),
      `check[${i}] surface "${c.surface}" must be one of: wrapper/studio/run/cross/infra/account/perf`);
    assert.ok(!seenIds.has(c.id), `check[${i}] id ${c.id} duplicated`);
    seenIds.add(c.id);
    assert.equal(c.id, i + 1, `check[${i}] id must equal ${i + 1} (sequential lock-in)`);
  }
});

test('W888-I smoke — surface counts match PART D breakdown (10/10/10/5/12/3/2)', () => {
  const allIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--json', `--skip=${allIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(r.stdout || '').trim());
  const expected = { wrapper: 10, studio: 10, run: 10, cross: 5, infra: 12, account: 3, perf: 2 };
  // Cross-check both the per-check tally and the script's own surfaces summary.
  const tallied = {};
  for (const c of parsed.checks) tallied[c.surface] = (tallied[c.surface] || 0) + 1;
  for (const [surface, count] of Object.entries(expected)) {
    assert.equal(tallied[surface], count,
      `surface=${surface} expected ${count} checks, got ${tallied[surface]}`);
    assert.ok(parsed.surfaces && parsed.surfaces[surface],
      `surfaces summary missing entry for ${surface}`);
    assert.equal(parsed.surfaces[surface].total, count,
      `surfaces.${surface}.total expected ${count}, got ${parsed.surfaces[surface].total}`);
  }
  // Total must equal sum of surface counts.
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  assert.equal(total, 52, 'PART D surface sum lock-in: must equal 52');
});

test('W888-I smoke — --failures-only flag is accepted (does not fault)', () => {
  // We don't need to assert content here; just that the flag parses without
  // crashing the orchestrator. Run with all skipped so the call completes fast.
  const allIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--failures-only', `--skip=${allIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `--failures-only must accept --skip cleanly; got exit=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`);
});

test('W888-I smoke — --report <path> writes a Markdown report', async (t) => {
  const os = await import('node:os');
  const tmpReport = path.join(os.tmpdir(), `kolm-w888i-ship-gate-report-${process.pid}-${Date.now()}.md`);
  t.after(() => { try { fs.unlinkSync(tmpReport); } catch {} }); // deliberate: cleanup
  const allIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--report', tmpReport, `--skip=${allIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `--report must complete cleanly; exit=${r.status}`);
  assert.ok(fs.existsSync(tmpReport), 'Markdown report file must be written');
  const md = fs.readFileSync(tmpReport, 'utf8');
  assert.match(md, /^#\s*W888-I Ship Gate Report/m, 'report must start with the canonical header');
  assert.match(md, /By Surface/, 'report must have a By Surface table');
  assert.match(md, /\| wrapper \| 0 \| 0 \| 0 \| 10 \| 10 \|/, 'wrapper row must reflect 10 skipped');
});
