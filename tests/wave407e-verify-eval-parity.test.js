// Wave 407e — verify/eval parity gate.
//
// Trust bug from the user's deep audit on demo-log-triage.kolm:
//   `kolm verify demo-log-triage.kolm` -> production_ready:true, K~0.864
//   `kolm eval   demo-log-triage.kolm` -> 7/10 passed (70%)
//
// Two verbs on the same .kolm gave contradictory verdicts. Root cause:
// productionReady() trusted the EMBEDDED build-time K-score / eval block but
// never re-ran the embedded cases against the bundled recipe at verify time.
// If the bundled recipe drifted from the recipe-as-of-build (or the compiler
// over-counted), verify kept printing the stale score while every other
// surface disagreed.
//
// W407e adds an `eval_parity` gate that re-runs evalArtifact() against the
// embedded cases inside the same .kolm and fails verify when the live
// accuracy is more than 5 points below the gate / composite / claimed
// accuracy.
//
// These tests assert BEHAVIOR (the production_ready boolean changes when the
// embedded eval lies, and stays true when the recipe + cases actually pass)
// so a later gate-floor adjustment doesn't require touching the test logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CLAIMS_KOLM = path.join(ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');

function lastJsonObject(stdout) {
  const text = String(stdout || '');
  try { return JSON.parse(text); } catch (_) { /* fallthrough */ }
  let depth = 0; let start = -1; let lastObj = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        try { lastObj = JSON.parse(slice); } catch (_) { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return lastObj;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 60_000,
    env: { ...process.env, KOLM_NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Build a tiny drifted artifact by copying a known-good .kolm and rebuilding
// the zip with extra eval cases the bundled recipe cannot satisfy. We add
// cases via a fresh AdmZip().writeZip(); updateFile() + writeZip() on an
// existing handle corrupts the central directory on Windows.
function buildDriftedArtifact(tmpDir, label) {
  const src = new AdmZip(CLAIMS_KOLM);
  const out = new AdmZip();
  for (const entry of src.getEntries()) {
    if (entry.entryName === 'evals.json') {
      const evals = JSON.parse(entry.getData().toString('utf8'));
      // Inject 3 unsatisfiable cases. The recipe redacts PHI; expected
      // outputs that are literal sentinel strings never appear in any
      // redacted output, so every injected case fails -> live accuracy
      // drops well below the 5-point drift floor.
      evals.cases = evals.cases.concat([
        { id: `${label}_unsat_a`, input: { text: 'unrelated payload alpha' }, expected: { redacted: 'WAVE407E_NEVER_MATCH_A', classes: ['NEVER'] } },
        { id: `${label}_unsat_b`, input: { text: 'unrelated payload beta'  }, expected: { redacted: 'WAVE407E_NEVER_MATCH_B', classes: ['NEVER'] } },
        { id: `${label}_unsat_c`, input: { text: 'unrelated payload gamma' }, expected: { redacted: 'WAVE407E_NEVER_MATCH_C', classes: ['NEVER'] } },
      ]);
      evals.n = evals.cases.length;
      out.addFile(entry.entryName, Buffer.from(JSON.stringify(evals, null, 2)));
    } else {
      out.addFile(entry.entryName, entry.getData());
    }
  }
  const dst = path.join(tmpDir, `drifted-${label}.kolm`);
  out.writeZip(dst);
  return dst;
}

function copyPassingArtifact(tmpDir) {
  const dst = path.join(tmpDir, 'passing.kolm');
  fs.copyFileSync(CLAIMS_KOLM, dst);
  return dst;
}

test('W407e #1 — verify reports production_ready:false with a parity/drift word when embedded eval lies about coverage', () => {
  assert.ok(fs.existsSync(CLAIMS_KOLM), `curated claims-redactor.kolm missing at ${CLAIMS_KOLM}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w407e-'));
  try {
    const drifted = buildDriftedArtifact(tmp, 't1');
    const { stdout } = runCli(['verify', drifted, '--json']);
    const obj = lastJsonObject(stdout);
    assert.ok(obj && typeof obj === 'object', `verify --json must emit a JSON envelope; got: ${stdout.slice(0, 400)}`);
    assert.equal(
      obj.production_ready, false,
      `production_ready should be false when bundled recipe disagrees with embedded eval; envelope: ${JSON.stringify(obj.gates && obj.gates.eval_parity)}`,
    );
    // Diagnosis must mention drift / parity / rebuild so the user knows WHY.
    const reasonsBlob = (obj.gate_reasons || []).join(' ').toLowerCase();
    assert.match(
      reasonsBlob,
      /(drift|parity|rebuild)/,
      `gate_reasons should mention drift/parity/rebuild; got: ${reasonsBlob}`,
    );
    // The dedicated gate must surface its live numbers so a binder/CI can
    // show exactly which cases collapsed.
    assert.ok(obj.gates && obj.gates.eval_parity, 'gates.eval_parity must be present');
    assert.equal(obj.gates.eval_parity.ok, false, 'gates.eval_parity.ok must be false');
    assert.equal(
      typeof obj.gates.eval_parity.live_accuracy, 'number',
      'eval_parity must include numeric live_accuracy for diagnosis',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

test('W407e #2 — verify reports production_ready:true when embedded eval matches the live rerun', () => {
  assert.ok(fs.existsSync(CLAIMS_KOLM), `curated claims-redactor.kolm missing at ${CLAIMS_KOLM}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w407e-'));
  try {
    const passing = copyPassingArtifact(tmp);
    const { stdout } = runCli(['verify', passing, '--json']);
    const obj = lastJsonObject(stdout);
    assert.ok(obj && typeof obj === 'object', `verify --json must emit a JSON envelope; got: ${stdout.slice(0, 400)}`);
    assert.equal(
      obj.production_ready, true,
      `claims-redactor.kolm (live eval 11/11) must report production_ready:true; reasons: ${(obj.gate_reasons || []).join('; ')}`,
    );
    assert.ok(obj.gates && obj.gates.eval_parity, 'gates.eval_parity must be present');
    assert.equal(obj.gates.eval_parity.ok, true, 'gates.eval_parity.ok must be true for a passing artifact');
    // The gate must have actually run (n > 0) — a vacuous skip would hide the
    // very bug this wave fixes.
    assert.ok(
      typeof obj.gates.eval_parity.n === 'number' && obj.gates.eval_parity.n > 0,
      `eval_parity must have re-run real cases; got: ${JSON.stringify(obj.gates.eval_parity)}`,
    );
    assert.equal(
      obj.gates.eval_parity.passed, obj.gates.eval_parity.n,
      'every embedded case must pass when verify says production_ready:true',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

test('W407e #3 — productionReady() exposes the eval_parity gate name so callers (binder, /account, CI) can render it', () => {
  // We exercise the gate through the CLI surface (the real public interface).
  // Calling productionReady() in-process would need a host-specific
  // RECIPE_RECEIPT_SECRET that the CLI loads from ~/.kolm/config.json on
  // startup; the kolm verify spawn already handles that bootstrap.
  assert.ok(fs.existsSync(CLAIMS_KOLM), `curated claims-redactor.kolm missing at ${CLAIMS_KOLM}`);
  const { stdout } = runCli(['verify', CLAIMS_KOLM, '--json']);
  const obj = lastJsonObject(stdout);
  assert.ok(obj && obj.gates && typeof obj.gates === 'object', `verify --json must emit gates; got: ${stdout.slice(0, 400)}`);
  assert.ok(
    'eval_parity' in obj.gates,
    `eval_parity gate must be present in verify --json; got: ${Object.keys(obj.gates).join(', ')}`,
  );
  assert.equal(obj.gates.eval_parity.ok, true, 'eval_parity must pass on the curated 11/11 artifact');
});
