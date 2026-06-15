// W-1 (Path to 100%) — the TUI no longer mocks inference.
//
// Before: cli/kolm-tui.mjs `mockInfer()` substring-matched manifest.examples
// and returned "(local mock) — no matching example …" — pure theater on both
// `:run` and `:serve POST /v1/run`. This test pins the A1 acceptance gate: the
// TUI's inference path executes the real signed runtime (src/artifact-runner.js
// `runArtifact`), and fails HONESTLY on an unrunnable artifact rather than
// faking a success.

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { realInfer } from '../cli/kolm-tui.mjs';

test('W-1 A1: TUI inference runs the real signed runtime, not a mock', async () => {
  // demo-log-triage.kolm is a real signed, JS-runtime artifact in the repo.
  const art = {
    filePath: path.resolve('demo-log-triage.kolm'),
    fileName: 'demo-log-triage.kolm',
  };
  const r = await realInfer(art, 'ERROR database connection refused at db:5432');

  assert.ok(r.ok, 'the real runtime should execute the artifact: ' + r.text);
  assert.ok(
    r.source.startsWith('runtime'),
    'inference must come from the real runtime, got source=' + r.source,
  );
  assert.strictEqual(typeof r.text, 'string');
  assert.ok(r.text.length > 0, 'real output is non-empty');
  // Negative: the deleted mock returned this exact stub for unmatched input.
  assert.ok(!r.text.includes('(local mock)'), 'must never return the old mock stub');
});

test('W-1: an unrunnable artifact fails honestly (no fake success)', async () => {
  // zh-greeter.kolm has an invalid signature → the runtime must reject it.
  const art = {
    filePath: path.resolve('zh-greeter.kolm'),
    fileName: 'zh-greeter.kolm',
  };
  const r = await realInfer(art, 'hi');

  assert.strictEqual(r.ok, false, 'a bad artifact must not report success');
  assert.strictEqual(r.source, 'error');
  assert.ok(
    typeof r.error_code === 'string' && r.error_code.startsWith('KOLM_E'),
    'an honest runtime error code is surfaced, got ' + r.error_code,
  );
});
