// W-4a (Path to 100%) — the provider-key vault is wired into the capture proxy
// hot path (src/router.js __connectorProxy), so "store your key → we route your
// traffic" is true. The /v1/gateway path already consulted the vault; the
// /v1/capture/* connector proxy did not (header → bearer → env only).
//
// The security-critical invariant the wiring stands on is tenant isolation:
// resolveProviderKey is keyed to the requesting tenant/actor and can NEVER
// return another tenant's stored key. This test pins that invariant (A3-neg)
// and the positive resolve (A3-pos). The full HTTP round-trip is exercised
// separately; here we prove the credential-resolution contract deterministically.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  putProviderKey,
  resolveProviderKey,
  listProviderKeys,
  deleteProviderKey,
} from '../src/provider-vault.js';

test('W-4a A3: a vaulted key resolves for its owner and NEVER for another tenant', () => {
  const A = 'w4a_A_' + process.pid;
  const B = 'w4a_B_' + process.pid;
  const SECRET = 'sk-ant-w4a-AAA-secret';

  putProviderKey({ tenantId: A, actorId: A, provider: 'anthropic', value: SECRET, label: 'w4a-test' });
  try {
    // A3-pos: the owner's request resolves their own stored key.
    assert.strictEqual(
      resolveProviderKey({ tenantId: A, actorId: A, provider: 'anthropic' }),
      SECRET,
      'owner must resolve their vaulted key (so their traffic routes on it)',
    );

    // A3-neg: a different tenant must NEVER receive tenant A's key.
    const leaked = resolveProviderKey({ tenantId: B, actorId: B, provider: 'anthropic' });
    assert.strictEqual(leaked, null, 'a different tenant must resolve null, never tenant A\'s key');

    // A different provider for the owner also resolves null (scoped per provider).
    assert.strictEqual(
      resolveProviderKey({ tenantId: A, actorId: A, provider: 'openai' }),
      null,
      'resolution is provider-scoped',
    );
  } finally {
    for (const k of (listProviderKeys({ tenantId: A, actorId: A, isAdmin: true }) || [])) {
      try { deleteProviderKey({ tenantId: A, id: k.id, actorId: A, isAdmin: true }); } catch { /* cleanup */ }
    }
  }
});
