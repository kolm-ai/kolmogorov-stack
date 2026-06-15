// W-4a part 2 (Path to 100%) — the completions bridge (kolm:-model / MCP / TUI
// chat path) resolves the upstream provider key the same vault-aware way the
// main proxy does, instead of reading process.env.ANTHROPIC_API_KEY directly.
//
// resolveBridgeKey precedence: explicit opts.upstreamKey → the caller-tenant's
// vaulted key (tenant-isolated) → server env. Backward-compatible: no tenantId
// ⇒ env, exactly as before.

import { test } from 'node:test';
import assert from 'node:assert';
import { resolveBridgeKey } from '../src/completions-api.js';
import { putProviderKey, listProviderKeys, deleteProviderKey } from '../src/provider-vault.js';

const ENV = 'ANTHROPIC_API_KEY';

test('W-4a/2: explicit opts.upstreamKey wins over everything', () => {
  const prev = process.env[ENV];
  process.env[ENV] = 'sk-env';
  try {
    assert.strictEqual(resolveBridgeKey({ upstreamKey: 'sk-explicit' }, 'anthropic', ENV), 'sk-explicit');
  } finally {
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
});

test('W-4a/2: a tenant vaulted key is used, and is tenant-isolated', () => {
  const A = 'w4a2_A_' + process.pid;
  const B = 'w4a2_B_' + process.pid;
  const SECRET = 'sk-ant-bridge-AAA';
  const prev = process.env[ENV];
  process.env[ENV] = 'sk-env';
  putProviderKey({ tenantId: A, actorId: A, provider: 'anthropic', value: SECRET, label: 'w4a2' });
  try {
    // Owner gets their vaulted key (not env).
    assert.strictEqual(resolveBridgeKey({ tenantId: A }, 'anthropic', ENV), SECRET);
    // A different tenant never sees A's key → falls back to env.
    assert.strictEqual(resolveBridgeKey({ tenantId: B }, 'anthropic', ENV), 'sk-env');
  } finally {
    for (const k of (listProviderKeys({ tenantId: A, actorId: A, isAdmin: true }) || [])) {
      try { deleteProviderKey({ tenantId: A, id: k.id, actorId: A, isAdmin: true }); } catch { /* cleanup */ }
    }
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
});

test('W-4a/2: no tenant and no vault ⇒ env (backward compatible)', () => {
  const prev = process.env[ENV];
  process.env[ENV] = 'sk-env-only';
  try {
    assert.strictEqual(resolveBridgeKey({}, 'anthropic', ENV), 'sk-env-only');
  } finally {
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
});

test('W-4a/2: nothing available ⇒ null (caller raises a clean 503)', () => {
  const prev = process.env[ENV];
  delete process.env[ENV];
  try {
    assert.strictEqual(resolveBridgeKey({}, 'anthropic', ENV), null);
  } finally {
    if (prev !== undefined) process.env[ENV] = prev;
  }
});
