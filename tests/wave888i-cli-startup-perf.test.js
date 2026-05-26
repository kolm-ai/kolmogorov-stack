// W888-I ship-gate check #52 — CLI startup time.
//
// Pin `node cli/kolm.js --version` to return in well under 500ms p50 on a
// quiet machine. The path is the documented user-facing first-touch latency
// budget — `kolm --version` is what every CI script / Dockerfile / install
// guide says to run first to confirm the CLI is wired.
//
// Threshold rationale:
//   - Linux / macOS:  p50 < 500ms (the documented budget).
//   - Windows:        p50 < 1500ms. spawnSync('node') incurs a fixed ~700ms
//                     process-create + JIT-warmup cost on Windows vs ~50ms on
//                     Linux. We still report the measurement, but the gate is
//                     widened so this test isn't the long pole that blocks an
//                     otherwise-green Windows CI run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const KOLM_CLI = path.join(ROOT, 'cli', 'kolm.js');

const ITERATIONS = 10;
const PLATFORM_WIN32 = process.platform === 'win32';
// p50 thresholds. Windows widened per the rationale above.
const P50_BUDGET_MS = PLATFORM_WIN32 ? 1500 : 500;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) return (s[mid - 1] + s[mid]) / 2;
  return s[mid];
}

test(`W888-I #52 — kolm --version p50 startup < ${P50_BUDGET_MS}ms across ${ITERATIONS} runs (platform=${process.platform})`, () => {
  const timings = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [KOLM_CLI, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      // Suppress first-run welcome banner side effects by pointing at a
      // throwaway HOME so the CLI doesn't try to read user config.
      env: {
        ...process.env,
        KOLM_HOME: path.join(os.tmpdir(), `kolm-w888i-perf-${process.pid}-${i}`),
        // Disable the banner — it does small I/O that adds noise to the
        // measurement. The CLI honors --plain to bypass terminal probes.
        NO_COLOR: '1',
        CI: '1',
      },
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0, `iter ${i} exit=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
    assert.match(r.stdout || '', /\d+\.\d+\.\d+/, 'stdout must contain a SemVer');
    timings.push(elapsed);
  }
  const p50 = median(timings);
  const min = Math.min(...timings);
  const max = Math.max(...timings);
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
  const report = {
    iterations: ITERATIONS,
    p50_ms: p50,
    min_ms: min,
    max_ms: max,
    mean_ms: Math.round(mean),
    threshold_ms: P50_BUDGET_MS,
    platform: process.platform,
    expected_slow_on_win32: PLATFORM_WIN32,
    timings,
  };
  // Print so the ship-gate report can surface the actual number even on pass.
  process.stderr.write('[W888-I #52] ' + JSON.stringify(report) + '\n');
  assert.ok(p50 < P50_BUDGET_MS,
    `p50 ${p50}ms exceeded budget ${P50_BUDGET_MS}ms (platform=${process.platform}, iterations=${ITERATIONS}, all=${timings.join('/')})`);
});
