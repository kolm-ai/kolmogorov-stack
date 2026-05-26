// W888-H — ship-gate extension: e2e persona checks.
//
// This module is LOADED OPT-IN by scripts/ship-gate.cjs when the environment
// variable KOLM_SHIP_GATE_INCLUDE_E2E=1 is set. By default the ship-gate sees
// only the core 52 checks documented in PART D. The extension hook in the
// orchestrator appends our 5 additional check entries AFTER the core 52
// self-check has passed, so the existing wave888i-ship-gate-smoke contract
// (parsed.total === 52 when env is unset) remains intact.
//
// Each persona check shells out to a scripts/e2e/*.cjs script with --json
// and parses the resulting envelope. Skip envelopes count as PASS (so a
// missing Docker / SSH key / RUNPOD_API_KEY environment does not break the
// gate). Hard failures count as FAIL.
//
// IDs 53-57:
//   53 — persona indie loop
//   54 — persona enterprise loop
//   55 — persona no-gpu loop
//   56 — full cross-surface loop (BLOCK 11 headline)
//   57 — env-summary (reports which optional deps are present for all 4 above)
//
// Surface: 'e2e' (not in the PART D 7-surface set).

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

function runPersona(scriptName, timeoutMs) {
  const file = path.join(ROOT, 'scripts', 'e2e', scriptName);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      not_yet: true,
      detail: 'NO_TEST_YET',
      install_hint: `create scripts/e2e/${scriptName}`,
      elapsed_ms: 0,
    };
  }
  const t0 = Date.now();
  const r = spawnSync(NODE, [file, '--json', '--smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = (r.stdout || '').trim();
  let parsed = null;
  // The script may emit multiple lines (warnings + final envelope). Take the
  // last well-formed JSON line.
  const lines = out.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch (_) {} // deliberate: cleanup
  }
  const elapsed = Date.now() - t0;
  // Exit-code policy:
  //   0 -> pass (parsed.ok === true)
  //   1 -> fail
  //   2 -> environment skip (treat as PASS for ship-gate purposes)
  if (r.status === 2) {
    return {
      ok: true,
      detail: 'env-skip: ' + (parsed && parsed.reason ? parsed.reason : 'optional deps missing'),
      install_hint: parsed && parsed.install_hint ? parsed.install_hint : null,
      elapsed_ms: elapsed,
      skipped_env: true,
    };
  }
  if (r.status === 0 && parsed && parsed.ok) {
    const counts = parsed.counts || {};
    return {
      ok: true,
      detail: `pass=${counts.pass} skip=${counts.skipped} fail=${counts.fail}`,
      elapsed_ms: elapsed,
      passes: counts.pass,
    };
  }
  // Failure path
  const counts = (parsed && parsed.counts) || {};
  const failStep = (parsed && Array.isArray(parsed.steps))
    ? parsed.steps.find((s) => !s.ok && !s.skipped)
    : null;
  return {
    ok: false,
    detail: failStep
      ? `failed at ${failStep.label}: ${(failStep.detail || '').slice(0, 200)}`
      : `exit=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`,
    elapsed_ms: elapsed,
    fails: counts.fail || 1,
  };
}

module.exports = [
  {
    id: 53,
    name: 'E2E persona: indie (W888-H)',
    surface: 'e2e',
    run: async () => runPersona('persona-indie.cjs', 180_000),
  },
  {
    id: 54,
    name: 'E2E persona: enterprise (W888-H)',
    surface: 'e2e',
    run: async () => runPersona('persona-enterprise.cjs', 180_000),
  },
  {
    id: 55,
    name: 'E2E persona: no-gpu (W888-H)',
    surface: 'e2e',
    run: async () => runPersona('persona-no-gpu.cjs', 180_000),
  },
  {
    id: 56,
    name: 'E2E full cross-surface loop (W889-11.1)',
    surface: 'e2e',
    run: async () => runPersona('full-loop.cjs', 240_000),
  },
  {
    id: 57,
    name: 'E2E env summary (Docker/SSH/RunPod/llama-cpp readiness)',
    surface: 'e2e',
    run: async () => {
      // Cheap env-aggregator check — never fails, just reports.
      const { spawnSync: ss } = require('node:child_process');
      const isWin = process.platform === 'win32';
      const which = (cmd) => {
        try {
          const r = ss(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 3000 });
          return r.status === 0;
        } catch (_) { return false; }
      };
      const docker = which('docker');
      const llama = which('llama-cli') || which('llama');
      const ssh = which('ssh');
      const runpod = !!process.env.RUNPOD_API_KEY;
      const modal = !!(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
      const detail = `docker=${docker} llama=${llama} ssh=${ssh} runpod-key=${runpod} modal-key=${modal}`;
      return { ok: true, detail, elapsed_ms: 0 };
    },
  },
];
