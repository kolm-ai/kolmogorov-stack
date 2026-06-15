// AUTH (Path to 100%) — passwordless email magic-link sign-in.
//
// New SOTA path: request a one-time signed link by email, click it, signed in.
// Reuses the OAuth findOrCreateTenantByEmail path (mints a session key, never
// rotates the primary). This pins the token security contract.

import { test } from 'node:test';
import assert from 'node:assert';
import { mintMagicToken, verifyMagicToken } from '../src/auth-email.js';
import { findOrCreateTenantByEmail, findTenantByApiKey } from '../src/auth.js';

test('magic-link: mint -> verify round-trip', () => {
  const email = `magic+${process.pid}@kolm.test`;
  const v = verifyMagicToken(mintMagicToken(email));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.email, email);
});

test('magic-link: single-use — a second verify is rejected', () => {
  const email = `magic2+${process.pid}@kolm.test`;
  const token = mintMagicToken(email);
  assert.strictEqual(verifyMagicToken(token).ok, true);
  const second = verifyMagicToken(token);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'already_used');
});

test('magic-link: an expired token is rejected', () => {
  const email = `magic3+${process.pid}@kolm.test`;
  // minted 20 minutes ago (TTL is 15m) → expired now.
  const token = mintMagicToken(email, Date.now() - 20 * 60 * 1000);
  const v = verifyMagicToken(token, Date.now());
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.error, 'expired');
});

test('magic-link: a tampered token is rejected (constant-time signature check)', () => {
  const email = `magic4+${process.pid}@kolm.test`;
  const token = mintMagicToken(email);
  const bad = token.slice(0, 12) + (token[12] === 'A' ? 'B' : 'A') + token.slice(13);
  const v = verifyMagicToken(bad);
  assert.strictEqual(v.ok, false);
  assert.ok(['bad_signature', 'malformed', 'unknown', 'expired'].includes(v.error), 'rejected: ' + v.error);
});

test('magic-link sign-in keeps the primary key safe (uses the OAuth session path)', () => {
  const email = `magic5+${process.pid}@kolm.test`;
  const created = findOrCreateTenantByEmail({ email, name: 'X', provider: 'email', provider_id: email });
  const primary = created.api_key;
  assert.ok(findTenantByApiKey(primary), 'primary key authenticates');

  // A magic-link verify for the same email signs in without touching the primary.
  assert.strictEqual(verifyMagicToken(mintMagicToken(email)).ok, true);
  const session = findOrCreateTenantByEmail({ email, name: 'X', provider: 'email', provider_id: email });
  assert.ok(findTenantByApiKey(primary), 'primary key STILL valid after email sign-in');
  assert.strictEqual(findTenantByApiKey(session.api_key).id, created.tenant.id, 'session resolves to same tenant');
});
