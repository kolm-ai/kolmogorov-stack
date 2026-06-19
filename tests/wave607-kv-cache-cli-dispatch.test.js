// Wave 607: user-facing KV policy dispatch through `kolm serve`.
//
// The frontier KV dispatcher already existed in src/serve-config.js. These
// checks pin the CLI wiring so `kolm serve --http` emits KOLM_KV_POLICY instead
// of falling back to the legacy Shard/default-only env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectKvCachePolicy } from '../src/serve-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');
const KVPOLICY = path.join(ROOT, 'workers', 'itkv', 'scripts', 'kvpolicy.py');
const ITKV_REQUIREMENTS = path.join(ROOT, 'workers', 'itkv', 'requirements.txt');

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const bin of candidates) {
    const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (!res.error && (res.status === 0 || /python/i.test((res.stdout || '') + (res.stderr || '')))) {
      return bin;
    }
  }
  return null;
}

test('1. serve usage exposes the full KV policy set and tuning flags', () => {
  const src = fs.readFileSync(CLI, 'utf8');

  assert.match(src, /--kv-cache auto\|off\|streaming\|h2o\|snapkv\|pyramidkv\|kivi2\|kivi4\|shard/);
  for (const flag of ['--kv-budget F', '--kv-sink N', '--kv-window N', '--kv-group N', '--kv-residual N']) {
    assert.ok(src.includes(flag), `usage missing ${flag}`);
  }
});

test('2. CLI serve path emits structured KOLM_KV_POLICY and keeps Shard back-compat', () => {
  const src = fs.readFileSync(CLI, 'utf8');

  assert.match(src, /selectKvCachePolicy/);
  assert.match(src, /emitKvPolicyVllmConfig/);
  assert.match(src, /serveEnv\.KOLM_KV_POLICY\s*=\s*JSON\.stringify\(\{ policy: applied\.policy, kind: applied\.kind, params: applied\.params \}\)/);
  assert.match(src, /serveEnv\.KOLM_KV_CACHE_BACKEND\s*=\s*applied\.policy === 'shard' \? 'shard' : 'default'/);
  assert.match(src, /kv_profile:\s*m\.kv_profile \|\| null/);
  assert.match(src, /artifact_id:\s*m\.artifact_id \|\| m\.artifact_hash \|\| m\.id \|\| ap/);
});

test('3. vLLM eviction requests fall back to enforceable KIVI quant policy', () => {
  const requested = selectKvCachePolicy({ format: 'vllm', requested: 'snapkv', workload: 'rag' });
  assert.equal(requested.runtime_can_enforce, false);
  assert.equal(requested.fallback, 'kivi2');

  const applied = selectKvCachePolicy({ format: 'vllm', requested: requested.fallback, workload: 'rag' });
  assert.equal(applied.policy, 'kivi2');
  assert.equal(applied.kind, 'quant');
  assert.equal(applied.runtime_can_enforce, true);
});

test('4. backend spec records W607 closure and W1006 KV measurement closure', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /W607/);
  assert.match(spec, /real KV policy dispatcher into `kolm serve`/);
  assert.match(spec, /W1006/);
  assert.match(spec, /paired no-KV baseline/);
  assert.match(spec, /probe\.py no longer records only the kv_policy name/);
});

test('5. ITKV kvpolicy sidecar mirrors serve.py policy builders and pins worker deps', () => {
  assert.equal(fs.existsSync(KVPOLICY), true, 'workers/itkv/scripts/kvpolicy.py must exist');
  assert.equal(fs.existsSync(ITKV_REQUIREMENTS), true, 'workers/itkv/requirements.txt must exist');

  const sidecar = fs.readFileSync(KVPOLICY, 'utf8');
  assert.match(sidecar, /def build_press\(/);
  assert.match(sidecar, /def quantized_cache_for\(/);
  for (const symbol of [
    'StreamingLLMPress',
    'SnapKVPress',
    'ObservedAttentionPress',
    'PyramidKVPress',
    'HQQQuantizedCache',
    'QuantizedCacheConfig',
  ]) {
    assert.ok(sidecar.includes(symbol), `kvpolicy.py missing ${symbol}`);
  }
  assert.match(sidecar, /--doctor/);
  assert.match(sidecar, /return 0 if out\["ok"\] else 2/);

  const reqs = fs.readFileSync(ITKV_REQUIREMENTS, 'utf8');
  assert.match(reqs, /^kvpress==0\.5\.3$/m);
  assert.match(reqs, /^hqq==0\.2\.8\.post1$/m);
  assert.match(reqs, /^transformers>=4\.42$/m);
});

test('6. ITKV kvpolicy sidecar self-test and doctor are GPU-free', (t) => {
  const py = findPython();
  if (!py) return t.skip('python not available');

  const self = spawnSync(py, [KVPOLICY, '--self-test'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(self.status, 0, `self-test failed: ${self.stderr || self.stdout}`);
  const selfJson = JSON.parse(self.stdout.trim());
  assert.equal(selfJson.ok, true);
  assert.equal(selfJson.version, 'w633-v1');

  const doctor = spawnSync(py, [KVPOLICY, '--doctor'], { encoding: 'utf8', timeout: 10000 });
  assert.ok([0, 2].includes(doctor.status), `doctor exits 0 when deps exist or 2 when missing; got ${doctor.status}`);
  const report = JSON.parse(doctor.stdout.trim());
  assert.equal(report.spec, 'kolm-itkv-kvpolicy-doctor');
  assert.equal(report.version, 'w633-v1');
  for (const dep of ['kvpress', 'transformers', 'hqq']) {
    assert.equal(typeof report.dependencies[dep].ok, 'boolean');
  }
  if (doctor.status === 2) {
    assert.equal(report.ok, false);
    assert.match(report.install_hint, /workers\/itkv\/requirements\.txt/);
  }
});
