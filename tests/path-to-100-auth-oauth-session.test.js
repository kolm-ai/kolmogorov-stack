// AUTH (Path to 100%) — OAuth sign-in must not invalidate the tenant's primary
// API key.
//
// Before: findOrCreateTenantByEmail rotated the primary key on every existing-
// tenant OAuth login, silently breaking any ks_*** key stored in a CLI / CI /
// server integration. Now it mints a separate 30-day full-scope SESSION key for
// the cookie and leaves the primary key intact.

import { test } from 'node:test';
import assert from 'node:assert';
import { findOrCreateTenantByEmail, findTenantByApiKey } from '../src/auth.js';

test('AUTH: a second OAuth login does NOT invalidate the original key', () => {
  const email = `oauthfix+${process.pid}@kolm.test`;

  const first = findOrCreateTenantByEmail({ email, name: 'X', provider: 'google', provider_id: 'g1' });
  assert.strictEqual(first.created, true, 'first login creates the tenant');
  const primaryKey = first.api_key;
  assert.ok(primaryKey && findTenantByApiKey(primaryKey), 'the primary key authenticates');

  // Second OAuth login for the same email (the common returning-user case).
  const second = findOrCreateTenantByEmail({ email, name: 'X', provider: 'google', provider_id: 'g1' });
  assert.strictEqual(second.created, false, 'a returning user signs in, not up');

  // THE FIX: the original primary key still authenticates after re-login.
  const stillValid = findTenantByApiKey(primaryKey);
  assert.ok(stillValid, 'the original primary key MUST still authenticate after OAuth re-login');
  assert.strictEqual(stillValid.id, first.tenant.id);

  // The cookie's session key also authenticates and resolves to the same tenant,
  // and is a DISTINCT credential (not the primary key).
  const viaSession = findTenantByApiKey(second.api_key);
  assert.ok(viaSession, 'the session key authenticates');
  assert.strictEqual(viaSession.id, first.tenant.id, 'session key resolves to the same tenant');
  assert.notStrictEqual(second.api_key, primaryKey, 'the session key is separate from the primary key');
});
