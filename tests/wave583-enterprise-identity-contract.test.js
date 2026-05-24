// Wave 583: enterprise identity contract must persist SSO config and SCIM users.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { buildRouter } from '../src/router.js';
import { provisionTenant } from '../src/auth.js';

function makeApp(plan = 'enterprise') {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const tenant = provisionTenant(`w583-${plan}-${Date.now()}-${Math.random().toString(16).slice(2)}`, {
    plan,
    quota: 100000,
    email: `w583-${plan}-${Date.now()}@example.com`,
  });
  return { app, apiKey: tenant.api_key };
}

function withListening(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

async function jsonFetch(base, path, apiKey, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json();
  return { res, body };
}

test('enterprise SSO configure persists tenant metadata without leaking XML secrets', async () => {
  const { app, apiKey } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const before = await jsonFetch(base, '/v1/account/sso/status', apiKey);
    assert.equal(before.res.status, 200);
    assert.equal(before.body.entitled, true);
    assert.equal(before.body.configured, false);

    const configured = await jsonFetch(base, '/v1/account/sso/configure', apiKey, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'okta',
        metadata_xml: '<EntityDescriptor entityID="https://idp.example.com"></EntityDescriptor>',
        domains: ['Example.COM', 'bad local'],
        default_role: 'member',
        scim_enabled: true,
      }),
    });
    assert.equal(configured.res.status, 200);
    assert.equal(configured.body.ok, true);
    assert.equal(configured.body.config.provider, 'okta');
    assert.deepEqual(configured.body.config.domains, ['example.com']);
    assert.match(configured.body.config.metadata_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(configured.body.config.secret_values_included, false);
    assert.doesNotMatch(JSON.stringify(configured.body), /EntityDescriptor/);

    const after = await jsonFetch(base, '/v1/account/sso/status', apiKey);
    assert.equal(after.body.configured, true);
    assert.equal(after.body.enabled, true);
    assert.equal(after.body.config.scim_enabled, true);
    assert.equal(after.body.assertion_consumer_status, 'not_enabled_in_local_runtime');
  });
});

test('SCIM Users supports tenant-scoped create, list, filter, and duplicate rejection', async () => {
  const { app, apiKey } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const empty = await jsonFetch(base, '/v1/scim/v2/Users', apiKey);
    assert.equal(empty.res.status, 200);
    assert.equal(empty.body.totalResults, 0);

    const created = await jsonFetch(base, '/v1/scim/v2/Users', apiKey, {
      method: 'POST',
      body: JSON.stringify({
        externalId: 'okta-123',
        userName: 'Ada@Example.com',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
        emails: [{ value: 'ada@example.com', primary: true }],
      }),
    });
    assert.equal(created.res.status, 201);
    assert.equal(created.body.userName, 'ada@example.com');
    assert.equal(created.body.externalId, 'okta-123');
    assert.equal(created.body.active, true);
    assert.equal(created.body.meta.resourceType, 'User');

    const listed = await jsonFetch(base, '/v1/scim/v2/Users?filter=' + encodeURIComponent('userName eq "ada@example.com"'), apiKey);
    assert.equal(listed.body.totalResults, 1);
    assert.equal(listed.body.Resources[0].id, created.body.id);

    const dup = await jsonFetch(base, '/v1/scim/v2/Users', apiKey, {
      method: 'POST',
      body: JSON.stringify({ userName: 'ada@example.com' }),
    });
    assert.equal(dup.res.status, 409);
    assert.equal(dup.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
  });
});

test('non-enterprise tenants cannot configure SSO or provision SCIM users', async () => {
  const { app, apiKey } = makeApp('free');
  await withListening(app, async (base) => {
    const sso = await jsonFetch(base, '/v1/account/sso/configure', apiKey, {
      method: 'POST',
      body: JSON.stringify({ provider: 'okta', metadata_url: 'https://idp.example.com/metadata.xml' }),
    });
    assert.equal(sso.res.status, 402);
    assert.equal(sso.body.error, 'enterprise_only');

    const scim = await jsonFetch(base, '/v1/scim/v2/Users', apiKey, {
      method: 'POST',
      body: JSON.stringify({ userName: 'blocked@example.com' }),
    });
    assert.equal(scim.res.status, 402);
    assert.equal(scim.body.error, 'enterprise_only');
  });
});
