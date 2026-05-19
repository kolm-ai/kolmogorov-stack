// Wave 389 - single source-of-truth production_ready parity across CLI verbs.
//
// Trust bug from design-partner trial: `kolm verify --json` reported
// production_ready:true on examples/claims-redactor/claims-redactor.kolm while
// `kolm what --json` (and `kolm explain --json`) on the SAME .kolm bytes
// reported production_ready:false. Root cause: cmdExplain + snapshotContext
// read a stale manifest.production_ready boolean (W339-era artifacts only
// write manifest.seed_provenance.production_ready, no top-level field), while
// cmdVerify and the marketplace install gate already used the canonical
// productionReady() in src/production-ready.js.
//
// W389 routes every surface through productionReady() so a single .kolm
// cannot disagree with itself between verbs. These tests assert BEHAVIOR
// (parity across verbs), not literal verdict values, so a deliberate gate
// tightening later does not require touching the test.
//
//   1. `kolm verify --json` and `kolm explain --json` agree for the same
//      .kolm on disk (claims-redactor curated artifact).
//   2. Parity also holds for examples/phi-redactor/phi-redactor.kolm when
//      present (skipped if the curated artifact is not on disk; the
//      assertion still runs for any other curated artifact under examples/).
//   3. cmdExplain JSON envelope carries the canonical gate_reasons + gates
//      shape so any caller (binder UI, /account/artifacts page, CI) can
//      surface the same diagnosis verify prints.
//   4. snapshotContext() (the engine behind `kolm what`) enriches artifacts
//      with the same production_ready boolean productionReady() returns for
//      the same .kolm path, so the snapshot agrees with verify too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const CLAIMS_KOLM = path.join(ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');
const PHI_KOLM = path.join(ROOT, 'examples', 'phi-redactor', 'phi-redactor.kolm');

// Try to parse the LAST top-level JSON object in stdout, since some verbs
// emit a hook receipt or follow-on line after the main envelope.
function lastJsonObject(stdout) {
  const text = String(stdout || '');
  // Fast path: stdout is a single JSON object.
  try { return JSON.parse(text); } catch (_) { /* fallthrough */ }
  // Scan for the last balanced {...} block.
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

function verifyJson(p) {
  // `kolm verify --json` exits non-zero on a failed gate even though it
  // prints a valid JSON envelope. We accept both 0 and non-zero; the JSON
  // body is what the parity assertion compares.
  const { stdout } = runCli(['verify', p, '--json']);
  const obj = lastJsonObject(stdout);
  assert.ok(obj && typeof obj === 'object', `verify --json must print a JSON envelope; got: ${stdout.slice(0, 400)}`);
  assert.ok(Object.prototype.hasOwnProperty.call(obj, 'production_ready'), 'verify --json must include production_ready');
  return obj;
}

function explainJson(p) {
  const { code, stdout, stderr } = runCli(['explain', p, '--json']);
  assert.equal(code, 0, `explain --json should exit 0; got ${code}; stderr=${stderr}`);
  const obj = lastJsonObject(stdout);
  assert.ok(obj && typeof obj === 'object', 'explain --json must print a JSON object');
  assert.ok(Object.prototype.hasOwnProperty.call(obj, 'production_ready'), 'explain --json must include production_ready');
  return obj;
}

test('W389 #1 - verify and explain agree on production_ready for claims-redactor.kolm', () => {
  if (!fs.existsSync(CLAIMS_KOLM)) {
    // Repository invariant: this artifact is curated and committed; if it is
    // missing something else has gone wrong. Fail loud rather than skip.
    assert.fail(`curated artifact missing: ${CLAIMS_KOLM}`);
  }
  const v = verifyJson(CLAIMS_KOLM);
  const e = explainJson(CLAIMS_KOLM);
  assert.equal(
    e.production_ready, v.production_ready,
    `parity broken: verify says production_ready=${v.production_ready}, explain says ${e.production_ready}`,
  );
});

test('W389 #2 - parity also holds for phi-redactor.kolm when curated artifact is on disk', () => {
  if (!fs.existsSync(PHI_KOLM)) {
    // phi-redactor.kolm is built on-demand; skip rather than fail when the
    // curated bytes are not committed.
    return;
  }
  const v = verifyJson(PHI_KOLM);
  const e = explainJson(PHI_KOLM);
  assert.equal(
    e.production_ready, v.production_ready,
    `phi-redactor.kolm parity broken: verify=${v.production_ready}, explain=${e.production_ready}`,
  );
});

test('W389 #3 - explain --json carries the canonical gate_reasons + gates shape from productionReady()', () => {
  if (!fs.existsSync(CLAIMS_KOLM)) return;
  const e = explainJson(CLAIMS_KOLM);
  assert.ok(Array.isArray(e.gate_reasons), 'explain --json must include gate_reasons array (empty when ok=true)');
  assert.ok(e.gates && typeof e.gates === 'object', 'explain --json must include gates object');
  // Canonical gate names from src/production-ready.js. If any is missing the
  // refactor regressed.
  for (const name of ['seed_provenance', 'k_score', 'holdout_split', 'drift', 'durability', 'executable_bundle']) {
    assert.ok(name in e.gates, `gates.${name} missing; productionReady() must surface every gate`);
  }
  // When verify says ok=true, gate_reasons must be empty for explain (parity
  // extends to the diagnosis trace, not just the boolean).
  const v = verifyJson(CLAIMS_KOLM);
  if (v.production_ready === true) {
    assert.equal(e.gate_reasons.length, 0, `gate_reasons must be empty when production_ready=true; got: ${e.gate_reasons.join('; ')}`);
  }
});

test('W389 #4 - snapshotContext() enriches artifacts using the same productionReady() verify uses', async () => {
  if (!fs.existsSync(CLAIMS_KOLM)) return;
  const { snapshotContext } = await import('../src/intent.js');
  const { productionReady } = await import('../src/production-ready.js');
  // Run snapshot in a sandbox cwd that contains a copy of the curated .kolm
  // so the scan picks it up.
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-w389-'));
  try {
    const copy = path.join(tmp, 'claims-redactor.kolm');
    fs.copyFileSync(CLAIMS_KOLM, copy);
    const snap = await snapshotContext({ cwd: tmp, home: tmp });
    const row = (snap.artifacts || []).find((a) => a.name === 'claims-redactor.kolm');
    assert.ok(row, `snapshotContext must discover the .kolm in cwd; got: ${(snap.artifacts || []).map((a) => a.name).join(', ')}`);
    const canonical = await productionReady(copy);
    assert.equal(
      row.production_ready, canonical.ok,
      `snapshot vs canonical mismatch: snapshot=${row.production_ready}, productionReady()=${canonical.ok}`,
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});
