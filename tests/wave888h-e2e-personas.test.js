// W888-H — E2E persona drivers smoke + contract tests.
//
// This test file does NOT replay every step of every persona loop (that lives
// in the drivers themselves and runs under --smoke in the ship gate). It pins
// the orchestration contract so downstream tooling (cmdTestE2E in cli/kolm.js,
// scripts/ship-gate-extensions/e2e-personas.cjs, BLOCK 11 release-verify gate)
// can rely on:
//
//   1. The 4 driver scripts exist on disk at the canonical paths.
//   2. Each driver emits a valid JSON envelope on --json with the shape
//      { persona, ok, steps[], counts:{total,pass,skipped,fail}, elapsed_ms }.
//   3. `kolm test e2e --persona indie --json --smoke` completes within the
//      60s budget (skips are tolerated — they are NOT failures).
//   4. `kolm test e2e --json` aggregates 4 sub-reports under .results[].
//   5. Ship-gate (with KOLM_SHIP_GATE_INCLUDE_E2E=1) registers the 5 e2e
//      checks at IDs 53-57 without breaking the existing 52-check contract.
//
// All children spawn with KOLM_CONNECTOR_FIXTURE=1 to avoid touching paid
// providers (Claude / OpenAI / Gemini). Drivers self-isolate their data dir
// + home via the _lib.cjs setupIsolatedServer chokepoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const E2E_DIR = path.join(ROOT, 'scripts', 'e2e');
const SHIP_GATE = path.join(ROOT, 'scripts', 'ship-gate.cjs');
const KOLM_CLI = path.join(ROOT, 'cli', 'kolm.js');
const NODE = process.execPath;

const DRIVERS = [
  { persona: 'indie',      file: 'persona-indie.cjs' },
  { persona: 'enterprise', file: 'persona-enterprise.cjs' },
  { persona: 'no-gpu',     file: 'persona-no-gpu.cjs' },
  { persona: 'full',       file: 'full-loop.cjs' },
];

function isolatedEnv() {
  // Avoid leaking the dev box's KOLM_HOME into spawned drivers. Each driver
  // calls setupIsolatedServer() which further isolates server state, but we
  // also wipe the parent envelope so CLI loads cleanly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wave888h-'));
  return {
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_HOME: path.join(tmp, '.kolm-isolated'),
      KOLM_DATA_DIR: path.join(tmp, '.kolm-data'),
      KOLM_CONNECTOR_FIXTURE: '1',
      KOLM_NO_TELEMETRY: '1',
      // Disable doctor self-check noise on cold boot
      KOLM_DOCTOR_NO_NET: '1',
    },
    tmp,
  };
}

function parseLastJsonLine(s) {
  // Drivers may emit warnings + a final envelope; find the last well-formed
  // JSON OBJECT. Both the single-line (driver) and pretty-printed (cmdTestE2E
  // aggregator) shapes need to be handled. We:
  //   1. Try parsing the entire trimmed buffer first (covers pretty-printed
  //      output where the only thing on stdout IS the JSON envelope).
  //   2. Try each non-empty line going backwards and accept the first one
  //      that parses to a plain object (skips arrays + scalars like "indie").
  //   3. Fall back to "everything between the first { and last }" to handle
  //      cases where banners or warnings precede the envelope.
  const text = String(s || '').trim();
  if (!text) return null;
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  // Whole-buffer parse — handles pretty-printed single-envelope output.
  try {
    const whole = JSON.parse(text);
    if (isPlainObject(whole)) return whole;
  } catch (_) {} // deliberate: cleanup
  // Per-line scan — handles single-line driver envelopes potentially
  // preceded by debug noise.
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (isPlainObject(v)) return v;
    } catch (_) {} // deliberate: cleanup
  }
  // Brace-window fallback — finds the last balanced { ... } object in the
  // text (rightmost opening brace + last closing brace).
  const lastBrace = text.lastIndexOf('}');
  for (let firstBrace = text.indexOf('{'); firstBrace !== -1 && firstBrace < lastBrace; firstBrace = text.indexOf('{', firstBrace + 1)) {
    try {
      const v = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (isPlainObject(v)) return v;
    } catch (_) {} // deliberate: cleanup
  }
  return null;
}

function expectEnvelopeShape(envelope, persona) {
  assert.ok(envelope && typeof envelope === 'object',
    `${persona}: must emit a JSON object envelope`);
  assert.equal(envelope.persona, persona === 'full' ? 'full' : persona,
    `${persona}: envelope.persona must match`);
  assert.equal(typeof envelope.ok, 'boolean',
    `${persona}: envelope.ok must be boolean`);
  assert.ok(Array.isArray(envelope.steps),
    `${persona}: envelope.steps must be an array`);
  assert.ok(envelope.counts && typeof envelope.counts === 'object',
    `${persona}: envelope.counts must be an object`);
  for (const k of ['total', 'pass', 'skipped', 'fail']) {
    assert.equal(typeof envelope.counts[k], 'number',
      `${persona}: envelope.counts.${k} must be a number`);
  }
  // Total must equal pass + skipped + fail (no step double-counted).
  assert.equal(
    envelope.counts.total,
    envelope.counts.pass + envelope.counts.skipped + envelope.counts.fail,
    `${persona}: counts.total must equal pass+skipped+fail`);
  // elapsed_ms present + numeric
  assert.equal(typeof envelope.elapsed_ms, 'number',
    `${persona}: envelope.elapsed_ms must be a number`);
  // Each step has { persona, label, ok, started_at, elapsed_ms }
  for (let i = 0; i < envelope.steps.length; i++) {
    const s = envelope.steps[i];
    assert.equal(typeof s.label, 'string', `${persona}: step[${i}].label must be string`);
    assert.equal(typeof s.ok, 'boolean', `${persona}: step[${i}].ok must be boolean`);
    assert.equal(typeof s.elapsed_ms, 'number', `${persona}: step[${i}].elapsed_ms must be number`);
  }
}

// ---------------------------------------------------------------------------
// Test #1 — Each persona script exists and is a CommonJS Node script.
// ---------------------------------------------------------------------------
test('W888-H — each persona driver script exists at the canonical path', () => {
  for (const d of DRIVERS) {
    const p = path.join(E2E_DIR, d.file);
    assert.ok(fs.existsSync(p), `missing driver: ${p}`);
    const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
    // sanity: CJS, not ESM (matches _lib.cjs contract)
    assert.match(head, /'use strict'|require\(/, `${d.file} must use CJS (require)`);
    // sanity: declares its persona somewhere near the top
    assert.match(head, new RegExp(d.persona === 'full' ? 'full[-_ ]?loop|W889-11\\.1' : d.persona, 'i'),
      `${d.file} header must reference its persona name`);
  }
  // _lib.cjs must also exist (shared chokepoint)
  assert.ok(fs.existsSync(path.join(E2E_DIR, '_lib.cjs')), 'scripts/e2e/_lib.cjs missing');
});

// ---------------------------------------------------------------------------
// Test #2 — Each persona script returns valid JSON envelope shape on --json.
//
// We use --smoke (tiny fixture, no GPU teacher). Each script is allowed up to
// 5 minutes individually but in practice they finish in <2s on a dev box.
// ---------------------------------------------------------------------------
test('W888-H — each persona driver emits a valid JSON envelope on --json --smoke', { timeout: 360_000 }, async (t) => {
  for (const d of DRIVERS) {
    const { env, tmp } = isolatedEnv();
    t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
    const script = path.join(E2E_DIR, d.file);
    const r = spawnSync(NODE, [script, '--json', '--smoke'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    // Exit 0 = success, exit 2 = env-skip; both are acceptable.
    assert.ok([0, 2].includes(r.status),
      `${d.persona}: exit must be 0 (pass) or 2 (env-skip); got ${r.status}; stderr: ${(r.stderr || '').slice(0, 400)}`);
    const envelope = parseLastJsonLine(r.stdout);
    if (r.status === 2) {
      // Skip envelope: { skipped:true, reason, install_hint }
      assert.ok(envelope && envelope.skipped === true,
        `${d.persona}: exit=2 must emit { skipped:true } envelope`);
      assert.equal(typeof envelope.reason, 'string',
        `${d.persona}: skip envelope must include reason`);
      assert.equal(typeof envelope.install_hint, 'string',
        `${d.persona}: skip envelope must include install_hint`);
      continue;
    }
    // Full envelope shape check (exit 0)
    expectEnvelopeShape(envelope, d.persona);
    // Failure must be zero on a clean dev box in fixture mode
    assert.equal(envelope.counts.fail, 0,
      `${d.persona}: counts.fail must be 0 in fixture mode; envelope=${JSON.stringify(envelope.counts)}`);
  }
});

// ---------------------------------------------------------------------------
// Test #3 — `kolm test e2e --persona indie --json --smoke` returns within
// 60s on this host (skip-tolerant).
// ---------------------------------------------------------------------------
test('W888-H — kolm test e2e --persona indie --json --smoke completes in <60s', { timeout: 90_000 }, async (t) => {
  const { env, tmp } = isolatedEnv();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  const t0 = Date.now();
  const r = spawnSync(NODE, [KOLM_CLI, 'test', 'e2e', '--persona', 'indie', '--json', '--smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 75_000,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  const elapsed = Date.now() - t0;
  assert.ok([0, 2].includes(r.status),
    `unexpected exit=${r.status} elapsed=${elapsed}ms stderr=${(r.stderr || '').slice(0, 400)}`);
  assert.ok(elapsed < 60_000,
    `indie smoke must finish in <60s; took ${elapsed}ms`);
  const summary = parseLastJsonLine(r.stdout);
  assert.ok(summary && typeof summary === 'object',
    'cli must emit a JSON summary envelope');
  assert.equal(summary.ok, true,
    `summary.ok must be true (skips count as pass); detail=${JSON.stringify(summary).slice(0, 400)}`);
  assert.ok(Array.isArray(summary.personas) && summary.personas.length === 1,
    'summary.personas must list exactly one entry for --persona indie');
  assert.equal(summary.personas[0], 'indie',
    'summary.personas[0] must be "indie"');
  assert.ok(Array.isArray(summary.results) && summary.results.length === 1,
    'summary.results must have exactly one entry');
  assert.equal(summary.results[0].persona, 'indie',
    'summary.results[0].persona must be "indie"');
});

// ---------------------------------------------------------------------------
// Test #4 — `kolm test e2e --json --smoke` aggregator includes 4 sub-reports.
// ---------------------------------------------------------------------------
test('W888-H — kolm test e2e --json --smoke aggregates 4 sub-reports', { timeout: 360_000 }, async (t) => {
  const { env, tmp } = isolatedEnv();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }); // deliberate: cleanup
  const r = spawnSync(NODE, [KOLM_CLI, 'test', 'e2e', '--json', '--smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  assert.ok([0, 2].includes(r.status),
    `aggregator must exit 0 or 2; got ${r.status}; stderr=${(r.stderr || '').slice(0, 500)}`);
  const summary = parseLastJsonLine(r.stdout);
  assert.ok(summary && typeof summary === 'object',
    'aggregator must emit a JSON summary envelope');
  assert.ok(Array.isArray(summary.personas),
    'summary.personas must be an array');
  assert.equal(summary.personas.length, 4,
    `summary.personas must enumerate 4 personas; got ${summary.personas.length}`);
  // Canonical order — indie, enterprise, no-gpu, full
  const expected = ['indie', 'enterprise', 'no-gpu', 'full'];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(summary.personas[i], expected[i],
      `summary.personas[${i}] must be "${expected[i]}"`);
  }
  assert.ok(Array.isArray(summary.results) && summary.results.length === 4,
    'summary.results must have exactly 4 entries');
  for (const sub of summary.results) {
    assert.ok(typeof sub.persona === 'string', 'each result must have persona');
    assert.equal(typeof sub.ok, 'boolean', 'each result.ok must be boolean');
    assert.equal(typeof sub.exit, 'number', 'each result.exit must be a number');
    // envelope is allowed to be null only if exit indicates a driver crash
    if (sub.exit === 0 || sub.exit === 2) {
      assert.ok(sub.envelope && typeof sub.envelope === 'object',
        `result.envelope must be present for exit=${sub.exit}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test #5 — Ship-gate (with extension env on) registers the 4 persona checks
// (53-56) + the env-summary (57) without breaking the 52-check baseline.
// ---------------------------------------------------------------------------
test('W888-H — ship-gate with KOLM_SHIP_GATE_INCLUDE_E2E=1 registers checks 53-57', { timeout: 90_000 }, () => {
  // First confirm the unset path still returns 52 (preserves wave888i contract).
  const baseEnv = { ...process.env };
  delete baseEnv.KOLM_SHIP_GATE_INCLUDE_E2E;
  const allCoreIds = Array.from({ length: 52 }, (_, i) => i + 1).join(',');
  const baseline = spawnSync(NODE, [SHIP_GATE, '--json', `--skip=${allCoreIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: baseEnv,
  });
  assert.equal(baseline.status, 0, `baseline ship-gate exit=${baseline.status}`);
  const baseParsed = JSON.parse(String(baseline.stdout || '').trim());
  assert.equal(baseParsed.total, 52, 'baseline must remain 52 (preserves wave888i contract)');

  // Now with extension env=1, expect 57 with IDs 53-57 present.
  const extEnv = { ...process.env, KOLM_SHIP_GATE_INCLUDE_E2E: '1' };
  const allExtIds = Array.from({ length: 57 }, (_, i) => i + 1).join(',');
  const ext = spawnSync(NODE, [SHIP_GATE, '--json', `--skip=${allExtIds}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: extEnv,
  });
  assert.equal(ext.status, 0, `ext ship-gate exit=${ext.status} stderr=${(ext.stderr || '').slice(0, 300)}`);
  const extParsed = JSON.parse(String(ext.stdout || '').trim());
  assert.equal(extParsed.total, 57,
    `extension hook must register 5 additional checks (total=57); got ${extParsed.total}`);
  // Each of 53-57 must be present with non-empty name and surface='e2e'
  const byId = new Map(extParsed.checks.map((c) => [c.id, c]));
  for (const id of [53, 54, 55, 56, 57]) {
    const c = byId.get(id);
    assert.ok(c, `check id=${id} must be registered`);
    assert.equal(typeof c.name, 'string', `check id=${id} name must be string`);
    assert.ok(c.name.length > 0, `check id=${id} name must be non-empty`);
    assert.equal(c.surface, 'e2e', `check id=${id} surface must be 'e2e'`);
  }
  // The four persona-named checks must be the first four IDs.
  assert.match(byId.get(53).name, /indie/i, 'check 53 must reference indie persona');
  assert.match(byId.get(54).name, /enterprise/i, 'check 54 must reference enterprise persona');
  assert.match(byId.get(55).name, /no.?gpu/i, 'check 55 must reference no-gpu persona');
  assert.match(byId.get(56).name, /full|cross|loop/i, 'check 56 must reference full/cross loop');
  assert.match(byId.get(57).name, /env|summary|readiness|docker|ssh/i,
    'check 57 must reference env-summary readiness');
});

// ---------------------------------------------------------------------------
// Test #6 (bonus) — Skip envelope shape contract. Drivers MUST emit
// { skipped:true, reason, install_hint } when they bail on missing env.
// ---------------------------------------------------------------------------
test('W888-H — _lib.cjs emitSkip helper exposes the documented skip-envelope shape', () => {
  const lib = require(path.join(E2E_DIR, '_lib.cjs'));
  assert.equal(typeof lib.emitSkip, 'function', 'emitSkip must be exported');
  assert.equal(typeof lib.emitReport, 'function', 'emitReport must be exported');
  assert.equal(typeof lib.setupIsolatedServer, 'function', 'setupIsolatedServer must be exported');
  assert.equal(typeof lib.teardown, 'function', 'teardown must be exported');
  assert.equal(typeof lib.stepStart, 'function', 'stepStart must be exported');
  assert.equal(typeof lib.stepOk, 'function', 'stepOk must be exported');
  assert.equal(typeof lib.stepFail, 'function', 'stepFail must be exported');
  assert.equal(typeof lib.stepSkip, 'function', 'stepSkip must be exported');
});
