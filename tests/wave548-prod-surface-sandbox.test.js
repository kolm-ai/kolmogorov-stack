// Wave 548 - prod-surface smoke must not report a fake production outage when
// Codex disables child-process network.
//
// The live product can be reachable from the CLI while this harness blocks raw
// child-process TCP with CODEX_SANDBOX_NETWORK_DISABLED=1. In that environment
// the production surface runner should report a skipped external-network gate,
// not 58 route failures.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W548 - prod-surface smoke skips external probes under Codex network sandbox EACCES', () => {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'prod-surface-smoke.cjs'),
    '--deep',
    '--require-auth',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      KOLM_PROD_SMOKE_FORCE_EACCES: '1',
    },
  });

  assert.equal(r.status, 0, `prod-surface smoke should skip, not fail. stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped, true);
  assert.match(parsed.reason, /Codex sandbox disables child-process network/);
  assert.equal(parsed.failed, 0);
  assert.ok(parsed.probes >= 50, 'skip envelope should still report the planned probe count');
  assert.ok(Array.isArray(parsed.surfaces));
  assert.ok(parsed.surfaces.every((surface) => surface.skipped === true));
});
