// W669 - direct contract for api/cf-config.js.
//
// Exercises the Cloudflare zone-hardening API with a stubbed Cloudflare client
// boundary: header-only admin auth, method allowlists, non-enumerating public
// ping, validated domains, sanitized failures, current rate-limit reads, and
// requested-domain Email Routing rules.

import assert from 'node:assert/strict';
import test from 'node:test';

function makeReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
  };
}

function resetEnv() {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123456789';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-secret-token';
  process.env.ADMIN_KEY = 'admin-secret';
  process.env.KOLM_DOMAIN = 'kolm.ai';
  delete process.env.KOLM_DEBUG;
  delete process.env.KOLM_EMAIL_FORWARD;
  delete process.env.ADMIN_ALLOW_CIDR;
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.cloudflare_zone_id;
}

async function loadHandler() {
  resetEnv();
  const mod = await import(`../api/cf-config.js?wave669=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function installFetchStub(t) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method, headers: { ...(init.headers || {}) }, body: init.body });

    if (u.pathname.endsWith('/zones') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: [
          { id: 'zone-kolm', name: 'kolm.ai', status: 'active', paused: false, type: 'full', account: { id: 'acct123456789' } },
          { id: 'zone-example', name: 'example.com', status: 'active', paused: false, type: 'full', account: { id: 'acct123456789' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.pathname.endsWith('/zones/zone-kolm/rulesets') && method === 'GET') {
      const phase = u.searchParams.get('phase');
      if (phase === 'http_request_firewall_custom') {
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: 'waf-ruleset', phase }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (phase === 'http_ratelimit') {
        return new Response(JSON.stringify({
          success: true,
          result: [{ id: 'rate-ruleset', phase }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }

    if (u.pathname.endsWith('/zones/zone-example/rulesets') && method === 'GET') {
      const phase = u.searchParams.get('phase');
      return new Response(JSON.stringify({
        success: true,
        result: [{ id: phase === 'http_ratelimit' ? 'rate-ruleset' : 'waf-ruleset', phase }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.pathname.endsWith('/zones/zone-kolm/rulesets/waf-ruleset') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: { rules: [{ id: 'waf-live', description: 'live waf rule', action: 'block' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.pathname.endsWith('/zones/zone-kolm/rulesets/rate-ruleset') && method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        result: { rules: [{ id: 'rl-live', description: 'live rate rule', action: 'block' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.pathname.includes('/rulesets') && ['POST', 'PUT'].includes(method)) {
      return new Response(JSON.stringify({ success: true, result: { id: 'updated-ruleset' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (u.pathname.endsWith('/email/routing') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, result: { enabled: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (u.pathname.endsWith('/email/routing/enable') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, result: { enabled: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (u.pathname.endsWith('/email/routing/rules') && method === 'GET') {
      return new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (u.pathname.endsWith('/email/routing/rules') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, result: { tag: 'created' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false, errors: [{ message: 'unexpected stub call' }] }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  return calls;
}

test('W669 CF config ping is public but does not enumerate zones or secrets', async (t) => {
  const calls = installFetchStub(t);
  const handler = await loadHandler();
  const res = makeRes();

  await handler(makeReq({ method: 'GET', query: { op: 'ping' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.configured, true);
  assert.equal(res.jsonBody.zones, undefined);
  assert.equal(res.jsonBody.zone_count, undefined);
  assert.match(res.jsonBody.account_prefix, /^acct1234\.\.\.$/);
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /cf-secret-token|admin-secret|zone-kolm|kolm\.ai/);
  assert.equal(calls.length, 0, 'public ping must not enumerate Cloudflare zones');
});

test('W669 CF config requires x-admin-key header and sanitizes zone listings', async (t) => {
  const calls = installFetchStub(t);
  const handler = await loadHandler();

  const queryKey = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'zones', admin_key: 'admin-secret' },
  }), queryKey);
  assert.equal(queryKey.statusCode, 403);
  assert.equal(queryKey.jsonBody.error, 'admin_only');
  assert.equal(calls.length, 0);

  const headerKey = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'zones' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), headerKey);
  assert.equal(headerKey.statusCode, 200);
  assert.equal(headerKey.jsonBody.count, 2);
  assert.deepEqual(headerKey.jsonBody.zones[0], {
    id: 'zone-kolm',
    name: 'kolm.ai',
    status: 'active',
    paused: false,
    type: 'full',
  });
  assert.equal(headerKey.jsonBody.zones[0].account, undefined);
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer cf-secret-token'));
});

test('W669 CF config enforces per-operation HTTP methods', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();

  const applyViaGet = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'apply-waf' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), applyViaGet);
  assert.equal(applyViaGet.statusCode, 405);
  assert.equal(applyViaGet.headers.allow, 'POST');

  const wafViaPost = makeRes();
  await handler(makeReq({
    method: 'POST',
    query: { op: 'waf' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), wafViaPost);
  assert.equal(wafViaPost.statusCode, 405);
  assert.equal(wafViaPost.headers.allow, 'GET');
});

test('W669 CF config validates domain input and sanitizes upstream failures', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();

  const badDomain = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'waf', domain: 'bad_domain' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), badDomain);
  assert.equal(badDomain.statusCode, 400);
  assert.equal(badDomain.jsonBody.error, 'invalid_domain');

  const missingZone = makeRes();
  await handler(makeReq({
    method: 'GET',
    query: { op: 'waf', domain: 'missing.example' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), missingZone);
  assert.equal(missingZone.statusCode, 500);
  assert.equal(missingZone.jsonBody.error, 'cf_config_api_error');
  assert.equal(missingZone.jsonBody.detail, 'operation failed');
  assert.doesNotMatch(JSON.stringify(missingZone.jsonBody), /acct123456789|cf-secret-token|stack|https:\/\/api\.cloudflare/);
});

test('W669 CF config rate-limit reads current rules instead of returning only planned defaults', async (t) => {
  installFetchStub(t);
  const handler = await loadHandler();
  const res = makeRes();

  await handler(makeReq({
    method: 'GET',
    query: { op: 'rate-limit' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.deepEqual(res.jsonBody.rules, [{ id: 'rl-live', description: 'live rate rule', action: 'block' }]);
  assert.equal(res.jsonBody.planned_count, 4);
  assert.equal(res.jsonBody.planned, undefined);
});

test('W669 CF config applies Email Routing rules to the requested domain', async (t) => {
  const calls = installFetchStub(t);
  const handler = await loadHandler();
  process.env.KOLM_EMAIL_FORWARD = 'ops@example.net';
  t.after(() => { delete process.env.KOLM_EMAIL_FORWARD; });
  const res = makeRes();

  await handler(makeReq({
    method: 'POST',
    query: { op: 'apply-email', domain: 'Example.COM.' },
    headers: { 'x-admin-key': 'admin-secret' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.domain, 'example.com');
  assert.ok(res.jsonBody.applied.every((r) => r.inbound.endsWith('@example.com')));
  const postBodies = calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/email/routing/rules'))
    .map((c) => JSON.parse(c.body));
  assert.equal(postBodies.length, 8);
  assert.ok(postBodies.every((body) => body.matchers[0].value.endsWith('@example.com')));
  assert.ok(postBodies.every((body) => body.actions[0].value[0] === 'ops@example.net'));
});

test('W669 Cloudflare helper validates ADMIN_ALLOW_CIDR before WAF expression emission', async (t) => {
  resetEnv();
  const CF = await import(`../src/cloudflare.js?wave669-helper=${Date.now()}-${Math.random()}`);
  process.env.ADMIN_ALLOW_CIDR = '198.51.100.0/24,2001:db8::/32';
  t.after(() => { delete process.env.ADMIN_ALLOW_CIDR; });

  const adminRule = CF.defaultWafRules().find((r) => r.description.includes('/v1/admin'));
  assert.ok(adminRule);
  assert.match(adminRule.expression, /ip\.src in \{198\.51\.100\.0\/24 2001:db8::\/32\}/);
  assert.doesNotMatch(adminRule.expression, /"198\.51\.100\.0\/24"/);

  process.env.ADMIN_ALLOW_CIDR = '198.51.100.0/999';
  assert.throws(() => CF.defaultWafRules(), /invalid ADMIN_ALLOW_CIDR/);
});
