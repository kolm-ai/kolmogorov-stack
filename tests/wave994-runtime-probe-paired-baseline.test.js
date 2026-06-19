// W994 - live runtime probe paired no-draft baseline contract.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function pythonBin() {
  const candidates = [
    process.env.KOLM_PYTHON,
    process.env.PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (!r.error && r.status === 0) return candidate;
  }
  return null;
}

test('W994 apps.export.probe self-test covers paired speculative baseline receipts', { skip: !pythonBin() }, () => {
  const py = pythonBin();
  const r = spawnSync(py, ['-m', 'apps.export.probe', '--self-test'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /apps\.export\.probe self-test: OK/);
});

test('W994 probe CLI defaults to paired speculative baseline with explicit opt-out', () => {
  const source = fs.readFileSync(new URL('../apps/export/probe.py', import.meta.url), 'utf8');
  assert.match(source, /paired_speculative_baseline: bool = True/);
  assert.match(source, /--no-paired-speculative-baseline/);
  assert.match(source, /"KOLM_SERVE_SPECULATIVE_DRAFT": ""/);
  assert.match(source, /PROBE_MEASUREMENT_RECEIPT_SCHEMA = "kolm\.probe_measurement_receipt\.v1"/);
  assert.match(source, /paired_measurement_receipt_digest_only/);
});
