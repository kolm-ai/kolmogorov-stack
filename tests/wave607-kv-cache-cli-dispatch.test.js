// Wave 607: user-facing KV policy dispatch through `kolm serve`.
//
// The frontier KV dispatcher already existed in src/serve-config.js. These
// checks pin the CLI wiring so `kolm serve --http` emits KOLM_KV_POLICY instead
// of falling back to the legacy Shard/default-only env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectKvCachePolicy } from '../src/serve-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'cli', 'kolm.js');

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

test('4. backend spec records W607 closure while leaving KV measurement open', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /W607/);
  assert.match(spec, /real KV policy dispatcher into `kolm serve`/);
  assert.match(spec, /No measurement: probe\.py records the kv_policy NAME/);
});
