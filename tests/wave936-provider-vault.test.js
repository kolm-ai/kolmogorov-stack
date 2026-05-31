// W936 — provider-key vault: per-employee/team upstream provider keys.
// Locks the security invariants: encrypted at rest, no plaintext/ciphertext in
// the redacted list, member vs team scope resolution, and delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Isolate the store + vault key to a temp dir before importing the modules.
process.env.KOLM_DATA_DIR = path.join(os.tmpdir(), 'kolm-pv-test-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });

const { putProviderKey, resolveProviderKey, listProviderKeys, deleteProviderKey } = await import('../src/provider-vault.js');

const T = 'tenant_pv', TEAM = 'team_pv', A = 'member_a', B = 'member_b';

test('W936 #1 — member key resolves for the storing member only', () => {
  putProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'openai', scope: 'member', value: 'sk-MEMBER-A' });
  assert.equal(resolveProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'openai' }), 'sk-MEMBER-A');
  assert.equal(resolveProviderKey({ tenantId: T, teamId: TEAM, actorId: B, provider: 'openai' }), null);
});

test('W936 #2 — team key resolves for any member', () => {
  putProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'anthropic', scope: 'team', value: 'sk-TEAM-999' });
  assert.equal(resolveProviderKey({ tenantId: T, teamId: TEAM, actorId: B, provider: 'anthropic' }), 'sk-TEAM-999');
});

test('W936 #3 — member key wins over team key for the same provider', () => {
  putProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'google', scope: 'team', value: 'sk-TEAM-G' });
  putProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'google', scope: 'member', value: 'sk-MINE-G' });
  assert.equal(resolveProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'google' }), 'sk-MINE-G');
});

test('W936 #4 — the redacted list never leaks the secret or ciphertext', () => {
  const list = listProviderKeys({ tenantId: T, teamId: TEAM, actorId: A, isAdmin: true });
  const blob = JSON.stringify(list);
  for (const secret of ['sk-MEMBER-A', 'sk-TEAM-999', 'sk-MINE-G', 'ciphertext', 'iv', 'tag']) {
    assert.equal(blob.includes(secret), false, `redacted list must not contain ${secret}`);
  }
  assert.ok(list.every((k) => k.value_included === false && k.encrypted_at_rest === true));
  assert.ok(list.every((k) => typeof k.key_prefix === 'string' && k.key_prefix.includes('...')));
});

test('W936 #5 — cross-tenant isolation: another tenant sees none of these keys', () => {
  assert.equal(resolveProviderKey({ tenantId: 'tenant_other', teamId: TEAM, actorId: A, provider: 'openai' }), null);
  assert.equal(listProviderKeys({ tenantId: 'tenant_other', teamId: TEAM, actorId: A, isAdmin: true }).length, 0);
});

test('W936 #6 — delete removes the key (member can delete own; team key needs admin)', () => {
  const mine = listProviderKeys({ tenantId: T, teamId: TEAM, actorId: A, isAdmin: false }).find((k) => k.provider === 'openai' && k.scope === 'member');
  // a non-admin member cannot delete a team key
  const teamKey = listProviderKeys({ tenantId: T, teamId: TEAM, actorId: A, isAdmin: true }).find((k) => k.scope === 'team');
  assert.equal(deleteProviderKey({ tenantId: T, id: teamKey.id, actorId: B, isAdmin: false }).deleted, false);
  // owner deletes their own member key
  assert.equal(deleteProviderKey({ tenantId: T, id: mine.id, actorId: A }).deleted, true);
  assert.equal(resolveProviderKey({ tenantId: T, teamId: TEAM, actorId: A, provider: 'openai' }), null);
});
