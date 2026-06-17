import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const scratch = path.join(os.tmpdir(), `kolm-c9-cap-scopes-${process.pid}-${Date.now()}`);
fs.mkdirSync(scratch, { recursive: true });
process.env.KOLM_DATA_DIR = scratch;
process.env.KOLM_STORE_DRIVER = 'sqlite';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
process.env.RECIPE_RECEIPT_SECRET = 'test-receipt-secret-test-receipt-secret-32';
process.env.NODE_ENV = 'test';

const auth = await import('../src/auth.js');
const store = await import('../src/store.js');
const { buildRouter } = await import('../src/router.js');

after(() => {
  try { store.close(); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
});

function unique(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  return app;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const out = await fn(base);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

async function api(base, pathName, key, { method = 'GET', body } = {}) {
  return fetch(base + pathName, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('C9 scope matcher supports exact, full, and hierarchical wildcard scopes', () => {
  assert.equal(auth.keyHasScope({ key_scopes: ['lake:*'] }, 'lake:export'), true);
  assert.equal(auth.keyHasScope({ key_scopes: ['account:keys:*'] }, 'account:keys:write'), true);
  assert.equal(auth.keyHasScope({ key_scopes: ['billing:*'] }, 'billing:write'), true);
  assert.equal(auth.keyHasScope({ key_scopes: ['provider_keys:*'] }, 'provider_keys:read'), true);
  assert.equal(auth.keyHasScope({ key_scopes: ['capture:read'] }, 'billing:write'), false);
  assert.equal(auth.keyHasScope({ key_scopes: ['account:*'] }, '*'), false);
  assert.equal(auth.keyHasScope({ key_scopes: ['*'] }, 'account:keys:write'), true);
  assert.equal(auth.keyHasScope({ key_scopes: null }, 'anything:at-all'), true);
});

test('C9 scoped capture key cannot mutate account, billing, provider, webhook, identity, or team surfaces', async () => {
  const tenant = auth.provisionTenant(unique('c9-deny'), { plan: 'enterprise', quota: 100000, email: 'deny@example.test' });
  const scoped = auth.mintScopedKey(tenant.id, { scopes: ['capture:read'], label: 'capture-reader' });

  await withServer(makeApp(), async (base) => {
    const cases = [
      ['/v1/account/rotate-key', { method: 'POST', body: {} }, '*'],
      ['/v1/account/billing', { method: 'PATCH', body: { vat_number: 'DE123456789' } }, 'billing:write'],
      ['/v1/account/provider-keys', { method: 'POST', body: { provider: 'openai', value: 'sk-deny' } }, 'provider_keys:write'],
      ['/v1/webhooks', { method: 'POST', body: { url: 'https://example.com/hook', events: ['model.deployed'] } }, 'webhook:write'],
      ['/v1/account/sso/configure', { method: 'POST', body: { metadata_url: 'https://idp.example.test/metadata.xml' } }, 'identity:write'],
      ['/v1/teams', { method: 'POST', body: { name: 'Denied Team', plan: 'enterprise', seats_max: 2 } }, 'team:write'],
    ];

    for (const [pathName, opts, required] of cases) {
      const res = await api(base, pathName, scoped.key, opts);
      assert.equal(res.status, 403, `${pathName} must reject capture-only scoped key`);
      const body = await res.json();
      assert.equal(body.error, 'insufficient_scope');
      assert.equal(body.required, required);
    }
  });
});

test('C9 explicit family scopes can access their own surfaces but not unrelated ones', async () => {
  const tenant = auth.provisionTenant(unique('c9-allow'), { plan: 'enterprise', quota: 100000, email: 'allow@example.test' });
  const billing = auth.mintScopedKey(tenant.id, { scopes: ['billing:*'], label: 'billing' });
  const provider = auth.mintScopedKey(tenant.id, { scopes: ['provider_keys:*'], label: 'provider' });
  const team = auth.mintScopedKey(tenant.id, { scopes: ['team:*'], label: 'team' });
  const accountRead = auth.mintScopedKey(tenant.id, { scopes: ['account:keys:*'], label: 'account-read' });

  await withServer(makeApp(), async (base) => {
    let res = await api(base, '/v1/account/billing', billing.key, {
      method: 'PATCH',
      body: { vat_number: 'DE987654321', company_name: 'Scope GmbH', country_code: 'de' },
    });
    assert.equal(res.status, 200, 'billing:* may edit billing tax fields');

    res = await api(base, '/v1/account/provider-keys', billing.key, {
      method: 'POST',
      body: { provider: 'openai', value: 'sk-wrong-scope' },
    });
    assert.equal(res.status, 403, 'billing:* must not write provider keys');

    res = await api(base, '/v1/account/provider-keys', provider.key, {
      method: 'POST',
      body: { provider: 'openai', value: 'sk-provider-scope', label: 'provider-scope' },
    });
    assert.equal(res.status, 200, 'provider_keys:* may store provider keys');

    res = await api(base, '/v1/teams', team.key, {
      method: 'POST',
      body: { name: 'Scoped Team', plan: 'enterprise', seats_max: 2 },
    });
    assert.equal(res.status, 201, 'team:* may create a team');

    res = await api(base, '/v1/account/keys', accountRead.key);
    assert.equal(res.status, 200, 'account:keys:* may list account key metadata');

    res = await api(base, '/v1/account/rotate-key', accountRead.key, { method: 'POST', body: {} });
    assert.equal(res.status, 403, 'account:keys:* is not full access and cannot rotate the primary key');
  });
});
