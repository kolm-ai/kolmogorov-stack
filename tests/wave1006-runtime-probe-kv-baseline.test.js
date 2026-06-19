// W1006 - runtime probe paired KV-cache baseline contract.

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

test('W1006 apps.export.probe self-test covers paired KV-cache baseline receipts', { skip: !pythonBin() }, () => {
  const py = pythonBin();
  const r = spawnSync(py, ['-m', 'apps.export.probe', '--self-test'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /apps\.export\.probe self-test: OK/);
});

test('W1006 probe CLI defaults to paired KV baseline with explicit opt-out', () => {
  const source = fs.readFileSync(new URL('../apps/export/probe.py', import.meta.url), 'utf8');
  assert.match(source, /paired_kv_baseline: bool = True/);
  assert.match(source, /--no-paired-kv-baseline/);
  assert.match(source, /def _attach_paired_kv_measurement/);
  assert.match(source, /"KOLM_KV_POLICY": json\.dumps\(\{"policy": "off", "kind": "off", "params": \{\}\}\)/);
  assert.match(source, /"kv-cache"/);
  assert.match(source, /"paired_kv_baseline": result\.get\("paired_kv_baseline"\)/);
  assert.match(source, /"kv_cache": result\.get\("kv_cache"\)/);
});

test('W1006 serve.py exposes KV policy telemetry from live token counters', () => {
  const source = fs.readFileSync(new URL('../apps/runtime/serve.py', import.meta.url), 'utf8');
  assert.match(source, /class KvPolicyMeter/);
  assert.match(source, /runtime_token_counter_model_config_accounting/);
  assert.match(source, /self\._kv_meter\.record\(prompt_tokens=prompt_tokens, output_tokens=len\(tok_ids\)\)/);
  assert.match(source, /self\._kv_meter\.record\(prompt_tokens=prompt_tokens, output_tokens=new_tokens\)/);
  assert.match(source, /"kv_policy_active": kv_policy_active/);
  assert.match(source, /"kv_cache": kv_summary/);
});
