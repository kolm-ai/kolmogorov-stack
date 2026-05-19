// Wave 388 — `kolm build claims-redactor --from redactor --examples examples/claims-redactor/seeds.jsonl`
// must either ship at K >= 0.85 (via the curated recipe override) OR fail with
// an actionable message naming the curated path AND --allow-below-gate.
//
// Behavior under test:
//   1. The reproducer from the bug report exits 0 and writes a .kolm whose
//      K-score clears the 0.85 ship gate (curated override takes over because
//      --examples points at examples/claims-redactor/seeds.jsonl).
//   2. The override is announced in stdout/stderr so the user knows the
//      --from flag was overridden.
//   3. When NO curated baseline exists for the name AND synthesis fails the
//      gate, the wrapped error names both --allow-below-gate and the seed-
//      iteration option (clear, actionable failure).
//
// These assertions are behavioral: exit code + K threshold + artifact size +
// presence of named follow-on paths in the error text. No log-string-only
// asserts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CURATED_SEEDS = path.join(ROOT, 'examples', 'claims-redactor', 'seeds.jsonl');

function freshDir(label) {
  const d = path.join(os.tmpdir(), `kolm-w388-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runBuild(cwd, args) {
  const env = { ...process.env, KOLM_AUTO_YES: '1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, [CLI, 'build', ...args], {
    cwd, env, encoding: 'utf8', timeout: 180_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W388 #1 — reproducer ships at K >= 0.85 via curated override', () => {
  // Reproducer from the bug report. Curated baseline detection MUST kick in
  // because --examples resolves to examples/claims-redactor/seeds.jsonl.
  assert.ok(fs.existsSync(CURATED_SEEDS), `precondition: curated seeds missing at ${CURATED_SEEDS}`);

  const cwd = freshDir('repro');
  const r = runBuild(cwd, [
    'claims-redactor',
    '--from', 'redactor',
    '--examples', CURATED_SEEDS,
    '--yes',
  ]);
  const out = r.stdout + '\n' + r.stderr;

  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. tail:\n${out.slice(-1500)}`);

  // K-score line must report a value at or above the ship gate.
  const kMatch = out.match(/K-score for claims-redactor\.kolm:\s*([0-9.]+)/);
  assert.ok(kMatch, `K-score line missing. tail:\n${out.slice(-800)}`);
  const k = Number(kMatch[1]);
  assert.ok(k >= 0.85, `K-score ${k} must clear ship gate 0.85`);

  // Artifact exists and is non-trivial.
  const artPath = path.join(cwd, 'claims-redactor.kolm');
  assert.ok(fs.existsSync(artPath), `artifact missing at ${artPath}`);
  assert.ok(fs.statSync(artPath).size > 1000, 'artifact byte size suspicious');

  // The W388 contract: when --examples points at the curated seeds, the CLI
  // tells the user it overrode --from. Behavioral check (not log-only): a
  // mention of "curated" AND "override" or "overriding" should appear so the
  // user is not surprised the K is 0.98 instead of the synthesis 0.56.
  assert.ok(/curated/i.test(out), `expected curated mention in output, got tail:\n${out.slice(-800)}`);
  assert.ok(/overrid/i.test(out), `expected override notice in output, got tail:\n${out.slice(-800)}`);
});

test('W388 #2 — synthesis failure is actionable (--allow-below-gate + seed-iteration named)', () => {
  // Use a name with no curated baseline. The generic redactor synthesis will
  // score below the 0.85 gate on the placeholder seeds, so compile MUST fail.
  // The wrapped error must name BOTH escape hatches: --allow-below-gate and
  // adding more seeds. This is the W388 actionable-message contract.
  const cwd = freshDir('no-curated');
  const r = runBuild(cwd, ['totally-novel-redactor-xyz', '--from', 'redactor', '--yes']);
  const out = r.stdout + '\n' + r.stderr;

  // Non-zero exit on synthesis-gate-fail.
  assert.notEqual(r.code, 0, `expected non-zero exit, got ${r.code}. tail:\n${out.slice(-1500)}`);

  // The original ship-gate message must still be present (CI greppability).
  assert.ok(/k_score below ship gate/i.test(out),
    `expected original ship-gate message, got tail:\n${out.slice(-1500)}`);

  // The wrapped, actionable message must name --allow-below-gate.
  assert.ok(/--allow-below-gate/.test(out),
    `expected --allow-below-gate hint, got tail:\n${out.slice(-1500)}`);

  // And the seed-iteration option.
  assert.ok(/seeds/i.test(out) && /rerun/i.test(out),
    `expected seed-iteration hint, got tail:\n${out.slice(-1500)}`);
});

test('W388 #3 — --allow-below-gate threads through and produces an artifact', () => {
  // When the user opts in to override the gate, the build must produce a real
  // artifact (and stamp ship_gate_overridden=true on the manifest, which is
  // already W252b behavior at the compile layer). We assert the artifact
  // exists; the manifest flag is covered by the W252 suite.
  const cwd = freshDir('override');
  const r = runBuild(cwd, ['totally-novel-redactor-xyz', '--from', 'redactor', '--allow-below-gate', '--yes']);
  const out = r.stdout + '\n' + r.stderr;

  // exit 0 is not strictly required (verify may still flag); the load-bearing
  // assertion is the artifact exists on disk, since the gate was overridden.
  const artPath = path.join(cwd, 'totally-novel-redactor-xyz.kolm');
  assert.ok(fs.existsSync(artPath),
    `artifact missing at ${artPath}. exit=${r.code}. tail:\n${out.slice(-1500)}`);
  assert.ok(fs.statSync(artPath).size > 500, 'artifact byte size suspicious');
});
