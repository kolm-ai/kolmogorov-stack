// Enterprise SSO: SAML 2.0 ACS + SCIM 2.0 lifecycle, end to end.
//
// This suite generates a real RSA-signed SAML assertion in-test (node:crypto)
// and drives it through src/saml-acs.js consumeAssertion() AND the live
// POST /v1/account/saml/acs route, asserting:
//   - a valid signed assertion establishes a session (kolm_session cookie that
//     authenticates as the tenant) and 302-redirects to /dashboard;
//   - a tampered assertion is rejected (digest mismatch);
//   - an assertion signed by the wrong key is rejected (bad signature);
//   - an expired assertion is rejected (NotOnOrAfter window);
//   - an audience-mismatched assertion is rejected;
//   - a replayed assertion ID is rejected (single-use cache);
// and for SCIM 2.0 (RFC 7644):
//   - the per-tenant SCIM bearer token drives create -> list -> patch
//     (deactivate) -> get -> put -> delete;
//   - one tenant's SCIM token cannot read another tenant's users (isolation);
//   - SCIM with no credential -> 401.
//
// The certificate + private key below are THROWAWAY, generated solely for this
// test (openssl req -x509 -newkey rsa:2048, CN=kolm-saml-test-idp). They are
// not used by any runtime path and authenticate nothing in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

import { buildRouter } from '../src/router.js';
import { provisionTenant, findTenantByApiKey } from '../src/auth.js';
import { consumeAssertion, extractIssuer, DEFAULT_SKEW_MS } from '../src/saml-acs.js';

// ── throwaway test IdP signing material (cert1/key1 = primary signer) ────────
const IDP_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1/tdmxtWYYgPV
w/L3+YSLYDvilOSmvL3+/pq91cp/gjYUzagfkFlknTr97JYFbCXGTE/bjlHVpw6b
2xQOJAB4t7tqxqs+XqxU6FqG6UN7c9kw10vntbTbkAPzy1SOBoOUNdAdZp6ZeIGS
yVZ1MgQpWMwI+DxGqPjSqawJcyhbbyRXo+/pB4xXiarwtDi8TPwV2f030hLXzMYX
xh1QzZ8pLrcbEVrWnscutQ/Pk6H8dXIvSWBKGy+UbwqpS4x5NT94Sx5U8NtQasFB
69nnzJqizE/FS1Bwax8W3U0YWrfCyzOKH9rgTAH5WTAdgPj8awqm8NM0yFkEjUgq
NzH5AjzlAgMBAAECggEADWifvSJEJWx/RNYhhhSbp9sovlpi+EfqpaljhD4Go9tX
mbPHQcAUXf3ZlVDDgtXDeLcxoQb8z4V15ZTABwSvBjXfOJA3mKpH/x95X/w6rRNN
erQ6EvHHx+914xXlfmtLcXV/hlMDt2HyBfsQhCTxuowgyD5lznzvjDHVC4MxA39u
b9BlCSL/D9Tq2aJIboFV37EqqY9uQ8QBAD4ZmVL4RC4SfMBhecDQlChVpjFfuUrH
iJTM/Qax0zsRHzzLIHqKzzBF36TIDDffNaBL8YTceO+7tjfdKSo1N6ePirHZm3St
6kH+l0OPIqFZNpQqsXvKSq4B6lFodarRj1Xhj3wC0QKBgQDjiJtE0aCRidDxgcVm
fojel8SXNinD1yWGbn1uLQWnv70hliPwulzT5VGf+aw9AfBTQeN5Nz2wDoh3m29V
2n3S1/XThRcTzCBP2J00WK1K4zso0Cs2JFeG1OnY1Kvq5rnjH/KVUBkzrl5A1qTn
4fCzpDpeQKioQy5+8eDw9p3EOQKBgQDMw7/2HGkrYLCn6HG/Ps/x21dO56WdKwA5
5UupXWHSSn1K01KCQNM0GnHymrUcXGRdVmj5WQaK2LHhvngssOteAejQIaZrtxY5
PQKI8FeXVYTe2tnHsVlSA+5ancsmLf4aDC4For87E67IJykxwT+iPtis3vPGwQmS
vEALcPV2DQKBgQCo1dcRK9PP6snGSxslQMNjGI7h/WjkTyMjK52bQYEuxpIa+APX
PxJekY0N/gAWjPe9b+jRK3J0z3Pn/MiSljxDVcitmdZT9GYNmZidHSgJp69gS4ek
9zaTcC3NnZGsDmTk6fHhZbwtozeBOUTIY9luE3DUO3pq0N8Rh334j6bl0QKBgAhB
M/Hl/09iXHzIYB2HmLZ1UzW5HPITE7VByyUOwKzLl/V2Q3NAzcLh9goDtp1oFBu3
KhAzSJI8Xh9toEac80Ac75fEY4MgJGM2VG3U0pMlPXAGfpUQTzuBMRCyH8hwPjgq
mYhcoTzudDNZcM2yrrAJvI5rhoRSr+IceLB9Y0fZAoGAIICryWwd6ibRS76XBWrj
C56EqmLgXS6nbVp0GTYmfF4V1bGngGX1ND+fwaKn4ID9xdRdfxWulP5v3O8piCy5
ZQYCNpk1NfZRoyS707kBhbjZ+fuw1ZX9+ynHT9rO5b9rBfdlK01hbi/w/ljQnDVj
sswH3veI4yjvOkQ6fbFVDC0=
-----END PRIVATE KEY-----
`;

const IDP_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUZdwciIKvo+oXC1asEIi1RDKGp5swDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSa29sbS1zYW1sLXRlc3QtaWRwMCAXDTI2MDYwODE4NTM1
MFoYDzIxMjYwNTE1MTg1MzUwWjAdMRswGQYDVQQDDBJrb2xtLXNhbWwtdGVzdC1p
ZHAwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC1/tdmxtWYYgPVw/L3
+YSLYDvilOSmvL3+/pq91cp/gjYUzagfkFlknTr97JYFbCXGTE/bjlHVpw6b2xQO
JAB4t7tqxqs+XqxU6FqG6UN7c9kw10vntbTbkAPzy1SOBoOUNdAdZp6ZeIGSyVZ1
MgQpWMwI+DxGqPjSqawJcyhbbyRXo+/pB4xXiarwtDi8TPwV2f030hLXzMYXxh1Q
zZ8pLrcbEVrWnscutQ/Pk6H8dXIvSWBKGy+UbwqpS4x5NT94Sx5U8NtQasFB69nn
zJqizE/FS1Bwax8W3U0YWrfCyzOKH9rgTAH5WTAdgPj8awqm8NM0yFkEjUgqNzH5
AjzlAgMBAAGjUzBRMB0GA1UdDgQWBBTeCLGFcq0ZMUOwyailLW+1r5xvhTAfBgNV
HSMEGDAWgBTeCLGFcq0ZMUOwyailLW+1r5xvhTAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQCJriNnSjwx0p5SDEzHdHSx/g0rOqslsOuPQc66BAvC
qA0yOuhsQ4ZOxKImbN1dKEvb2cZJ2Yku9afx38RXulBG1yXZ/XTgOFLN/oUYcg3O
97KuCO8EfV9HH5mXQrOouY/mi72sXfpq5+savdoclb69PX2b0mJaElLM+t8KIDjj
gaMnTLGofqYzA0d/vjb3cwJekMYMgUFtnYqsP/BGnmBr06mN76iFuL1wXkHC0Nz2
Ajp339oLCYLRoZ1/ah91Smm1bzKzgysIdRbl5P/7xQqNgxMhPGm/1c1geXreZhj+
OjTwkDCmhspCqiV5uPBvJj9FKulnqmMHc2y7xG0W+sFp
-----END CERTIFICATE-----
`;

// cert2 = a DIFFERENT valid IdP cert (the "wrong signer" for one rejection case)
const OTHER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUdOElZ9InbFd340P+nb+ihOn0790wDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUa29sbS1zYW1sLXRlc3QtaWRwLTIwIBcNMjYwNjA4MTkw
MjU1WhgPMjEyNjA1MTUxOTAyNTVaMB8xHTAbBgNVBAMMFGtvbG0tc2FtbC10ZXN0
LWlkcC0yMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyuB/ym1uhxoJ
J/HXVv6WWAaxR9CPIVwowaB3RbFV0VQh84U4IVGJcPJoFB00EelYq8SQMtpt37Uv
TjejHJ2PzIPBIOnzHKKQU/tF1JMAbBYGb6040Ungjk1cFdbJq73zBuiWGY/73cKQ
u5LbSII2Z8DMA1OY01j54FxQwfGiflFpyHd/NhsHdEpA3+Q5Xry7F3lBD5Dzg6ka
WsZFGcfHuqTlhtWL0f3hpm9EPLtBxc/KJp5a6WP0o+xJz/rVlxpPc75GTosKcW87
I9KgOW0ej4RusOOEYOi3TUkmEXXXy+OIok3ORotxy4tW2m3q95eLuXy2ug4YbpGl
SNuh0GzubwIDAQABo1MwUTAdBgNVHQ4EFgQUGQBJ5lKT781ZXBepYXtwPApo/5ww
HwYDVR0jBBgwFoAUGQBJ5lKT781ZXBepYXtwPApo/5wwDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEAULVotJo7zbcfVBID7o2JLL1JZnDnoI22j//U
w814kQXsDy11l86jP/6ht1xznxdKikjjso863EQKXtOjJN8gfcx3cKq+Kwr/R2u7
PVr/T4e7kJo/8KKSDQbcHcGWL4UZ22fqp7HZ1MwCJ3ZiF2Kz/NXkDq9+3RzJPRbm
8ujacVaVe+rqfW+MzVy0ijmEPUIUMKdtoRMiOExKofQZM7cAOFF+Bs00RnIP0yPn
tCMF8nr7GPSOnlzNPknW94sOaWVt3Oj+Bhwo+Zu70TcpXyi7gfjDVkskx4p9lNWw
6F0oxAlJMsx8KQjGBXZdmYmfhdkhklnhF5eQTS/N64/h37racA==
-----END CERTIFICATE-----
`;

// ── in-test SAML Response signer ─────────────────────────────────────────────
// Builds a base64 SAMLResponse with an enveloped, RSA-SHA256-signed Assertion.
// Everything is emitted single-line with no inter-element whitespace so it is
// already in the canonical form src/saml-acs.js verifies against - i.e. the
// digest the verifier recomputes equals the digest we sign here.
const certBody = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const canon = (s) => String(s).replace(/\r\n/g, '\n').replace(/>\s+</g, '><').trim();

function signSamlResponse(opts = {}) {
  const {
    issuer = 'https://idp.example.com/saml',
    nameId = 'ada@acme.test',
    email = 'ada@acme.test',
    firstName = 'Ada',
    audience = 'https://sp.kolm.test/saml/sp',
    recipient = 'https://sp.kolm.test/v1/account/saml/acs',
    notBefore,
    notOnOrAfter,
    assertionId = 'id_' + crypto.randomBytes(10).toString('hex'),
    signingKey = IDP_KEY_PEM,
    embedCert = IDP_CERT_PEM,
    tamper = null, // 'content' | 'sig' | null
  } = opts;

  const nowMs = Date.now();
  const iso = new Date(nowMs).toISOString();
  const nb = notBefore || new Date(nowMs - 5 * 60000).toISOString();
  const noa = notOnOrAfter || new Date(nowMs + 30 * 60000).toISOString();

  const assertionNoSig =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${noa}" Recipient="${recipient}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="firstName"><saml:AttributeValue>${firstName}</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement></saml:Assertion>`;

  const digest = crypto.createHash('sha256').update(canon(assertionNoSig), 'utf8').digest('base64');

  const signedInfo =
    `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<ds:Reference URI="#${assertionId}">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference></ds:SignedInfo>`;

  const signatureValue = crypto.createSign('RSA-SHA256').update(canon(signedInfo), 'utf8').sign(signingKey, 'base64');

  const signature =
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}` +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(embedCert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `</ds:Signature>`;

  let assertionWithSig = assertionNoSig.replace('</saml:Issuer>', '</saml:Issuer>' + signature);
  if (tamper === 'content') {
    // Mutate a signed claim AFTER signing -> the recomputed digest no longer
    // matches DigestValue. The verifier must reject this.
    assertionWithSig = assertionWithSig.replace('ada@acme.test</saml:NameID>', 'attacker@evil.test</saml:NameID>');
  }

  const responseId = 'id_' + crypto.randomBytes(10).toString('hex');
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso}" Destination="${recipient}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>${assertionWithSig}</samlp:Response>`;
  if (tamper === 'sig') {
    const flipped = signatureValue.slice(0, -4) + (signatureValue.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    xml = xml.replace(signatureValue, flipped);
  }

  return { xml, b64: Buffer.from(xml, 'utf8').toString('base64'), assertionId, issuer, nameId, email };
}

// ── express harness (mirrors tests/wave583) ──────────────────────────────────
function uniq() {
  return Date.now().toString(36) + Math.random().toString(16).slice(2, 8);
}

function makeApp(plan = 'enterprise') {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(buildRouter());
  const u = uniq();
  const tenant = provisionTenant(`saml-scim-${plan}-${u}`, {
    plan,
    quota: 100000,
    email: `saml-scim-${u}@example.com`,
  });
  return { app, apiKey: tenant.api_key, tenant };
}

function withListening(app, fn) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const port = srv.address().port;
        const out = await fn(`http://127.0.0.1:${port}`, port);
        srv.close(() => resolve(out));
      } catch (e) {
        srv.close(() => reject(e));
      }
    });
  });
}

async function jsonFetch(base, p, token, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + p, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { res, body };
}

function cookieValue(res, name) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(String(c || ''));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// Configure a tenant's SSO for manual SAML (cert + entityID + audience).
async function configureSso(base, apiKey, { issuer, audience }) {
  return jsonFetch(base, '/v1/account/sso/configure', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      provider: 'okta',
      idp_entity_id: issuer,
      idp_cert_pem: IDP_CERT_PEM,
      saml_audience: audience,
      jit_provisioning: true,
      scim_enabled: true,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  SAML 2.0 ACS
// ════════════════════════════════════════════════════════════════════════════

test('SAML ACS: a valid signed assertion establishes a session and redirects to /dashboard', async () => {
  const { app, apiKey, tenant } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const issuer = `https://idp.${uniq()}.test/saml`;
    const audience = `https://sp.kolm.test/${uniq()}/saml/sp`;
    const cfg = await configureSso(base, apiKey, { issuer, audience });
    assert.equal(cfg.res.status, 200, JSON.stringify(cfg.body));
    assert.equal(cfg.body.config.idp_cert_configured, true);
    assert.equal(cfg.body.config.secret_values_included, false);
    // The cert PEM body must never be echoed back.
    assert.doesNotMatch(JSON.stringify(cfg.body), /BEGIN CERTIFICATE/);

    const host = base.replace(/^https?:\/\//, '');
    const saml = signSamlResponse({
      issuer,
      audience,
      recipient: `https://${host}/v1/account/saml/acs`,
    });

    // Default Accept (no application/json) -> the ACS issues a 302 redirect.
    const res = await fetch(base + '/v1/account/saml/acs', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ SAMLResponse: saml.b64 }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/dashboard');

    const session = cookieValue(res, 'kolm_session');
    assert.ok(session && session.startsWith('ks_'), 'kolm_session cookie set with a ks_ key');
    // The session credential authenticates as THIS tenant (real session).
    const resolved = findTenantByApiKey(session);
    assert.ok(resolved, 'session key resolves to a tenant');
    assert.equal(resolved.id, tenant.id);
  });
});

test('SAML ACS: Accept application/json returns the session envelope', async () => {
  const { app, apiKey } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const issuer = `https://idp.${uniq()}.test/saml`;
    const audience = `https://sp.kolm.test/${uniq()}/saml/sp`;
    await configureSso(base, apiKey, { issuer, audience });
    const host = base.replace(/^https?:\/\//, '');
    const saml = signSamlResponse({ issuer, audience, recipient: `https://${host}/v1/account/saml/acs`, nameId: 'grace@acme.test', email: 'grace@acme.test' });

    const { res, body } = await jsonFetch(base, '/v1/account/saml/acs', null, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ SAMLResponse: saml.b64 }),
    });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.email, 'grace@acme.test');
    assert.equal(body.redirect, '/dashboard');
    assert.ok(cookieValue(res, 'kolm_session'));
  });
});

test('SAML ACS: tampered assertion is rejected (digest mismatch)', async () => {
  const { app, apiKey } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const issuer = `https://idp.${uniq()}.test/saml`;
    const audience = `https://sp.kolm.test/${uniq()}/saml/sp`;
    await configureSso(base, apiKey, { issuer, audience });
    const host = base.replace(/^https?:\/\//, '');
    const saml = signSamlResponse({ issuer, audience, recipient: `https://${host}/v1/account/saml/acs`, tamper: 'content' });

    const { res, body } = await jsonFetch(base, '/v1/account/saml/acs', null, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ SAMLResponse: saml.b64 }),
    });
    assert.equal(res.status, 401);
    assert.equal(body.error, 'signature_verification_failed');
    assert.ok(!cookieValue(res, 'kolm_session'), 'no session cookie on a rejected assertion');
  });
});

test('SAML ACS: unresolvable Issuer -> 404 (no tenant federated this IdP)', async () => {
  const { app } = makeApp('enterprise');
  await withListening(app, async (base) => {
    // Never configured: the issuer matches no tenant config.
    const saml = signSamlResponse({ issuer: `https://idp.${uniq()}.unfederated/saml` });
    const { res, body } = await jsonFetch(base, '/v1/account/saml/acs', null, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ SAMLResponse: saml.b64 }),
    });
    assert.equal(res.status, 404);
    assert.equal(body.error, 'sso_tenant_not_resolved');
  });
});

// ── consumeAssertion() unit-level rejection cases (no port needed) ────────────

function consumeOpts(saml, overrides = {}) {
  return {
    samlResponseB64: saml.b64,
    tenant: overrides.tenant,
    idpCertPem: IDP_CERT_PEM,
    audience: 'https://sp.kolm.test/saml/sp',
    acsUrl: 'https://sp.kolm.test/v1/account/saml/acs',
    ...overrides,
  };
}

test('consumeAssertion: valid assertion mints a session credential for the tenant', async () => {
  const t = provisionTenant(`saml-unit-${uniq()}`, { plan: 'enterprise', email: `u-${uniq()}@x.test` });
  const saml = signSamlResponse({
    audience: 'https://sp.kolm.test/saml/sp',
    recipient: 'https://sp.kolm.test/v1/account/saml/acs',
  });
  const out = await consumeAssertion(consumeOpts(saml, { tenant: t.id }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, 200);
  assert.equal(out.tenant, t.id);
  assert.equal(out.email, 'ada@acme.test');
  assert.ok(out.key && out.key.startsWith('ks_'));
  const resolved = findTenantByApiKey(out.key);
  assert.equal(resolved && resolved.id, t.id);
  // Crucially: a fresh SSO login does NOT invalidate the tenant's primary key.
  assert.ok(findTenantByApiKey(t.api_key), 'tenant primary key still valid after SSO login');
});

test('consumeAssertion: assertion signed by the wrong key is rejected', async () => {
  const t = provisionTenant(`saml-wrong-${uniq()}`, { plan: 'enterprise', email: `u-${uniq()}@x.test` });
  // Signed with the real key, but the tenant pins the OTHER cert.
  const saml = signSamlResponse({
    audience: 'https://sp.kolm.test/saml/sp',
    recipient: 'https://sp.kolm.test/v1/account/saml/acs',
  });
  const out = await consumeAssertion(consumeOpts(saml, { tenant: t.id, idpCertPem: OTHER_CERT_PEM }));
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'signature_verification_failed');
});

test('consumeAssertion: expired assertion is rejected (NotOnOrAfter window)', async () => {
  const t = provisionTenant(`saml-exp-${uniq()}`, { plan: 'enterprise', email: `u-${uniq()}@x.test` });
  const past = Date.now() - 60 * 60000;
  const saml = signSamlResponse({
    audience: 'https://sp.kolm.test/saml/sp',
    recipient: 'https://sp.kolm.test/v1/account/saml/acs',
    notBefore: new Date(past - 5 * 60000).toISOString(),
    notOnOrAfter: new Date(past).toISOString(),
  });
  const out = await consumeAssertion(consumeOpts(saml, { tenant: t.id }));
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'assertion_expired');
});

test('consumeAssertion: audience mismatch is rejected', async () => {
  const t = provisionTenant(`saml-aud-${uniq()}`, { plan: 'enterprise', email: `u-${uniq()}@x.test` });
  const saml = signSamlResponse({
    audience: 'https://attacker.example/saml/sp',
    recipient: 'https://sp.kolm.test/v1/account/saml/acs',
  });
  const out = await consumeAssertion(consumeOpts(saml, { tenant: t.id, audience: 'https://sp.kolm.test/saml/sp' }));
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'audience_mismatch');
});

test('consumeAssertion: a replayed assertion ID is rejected (single-use cache)', async () => {
  const t = provisionTenant(`saml-replay-${uniq()}`, { plan: 'enterprise', email: `u-${uniq()}@x.test` });
  const saml = signSamlResponse({
    audience: 'https://sp.kolm.test/saml/sp',
    recipient: 'https://sp.kolm.test/v1/account/saml/acs',
  });
  const first = await consumeAssertion(consumeOpts(saml, { tenant: t.id }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await consumeAssertion(consumeOpts(saml, { tenant: t.id }));
  assert.equal(second.ok, false);
  assert.equal(second.status, 401);
  assert.equal(second.error, 'assertion_replayed');
});

test('extractIssuer reads the Issuer entityID for tenant routing', () => {
  const issuer = `https://idp.${uniq()}.test/saml`;
  const saml = signSamlResponse({ issuer });
  assert.equal(extractIssuer(saml.b64), issuer);
  assert.equal(extractIssuer('not base64 @@@'), null);
});

// ════════════════════════════════════════════════════════════════════════════
//  SCIM 2.0
// ════════════════════════════════════════════════════════════════════════════

// Mint a per-tenant SCIM bearer token via the rotate route.
async function scimToken(base, apiKey) {
  const { res, body } = await jsonFetch(base, '/v1/account/sso/scim-token', apiKey, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.scim_token && body.scim_token.startsWith('scim_'));
  // The plaintext token must be a one-time value; only its hash is stored.
  return body.scim_token;
}

test('SCIM: full lifecycle via the per-tenant SCIM bearer token', async () => {
  const { app, apiKey } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const token = await scimToken(base, apiKey);

    // create
    const created = await jsonFetch(base, '/v1/scim/v2/Users', token, {
      method: 'POST',
      body: JSON.stringify({
        externalId: 'okta-001',
        userName: 'Member.One@Acme.test',
        name: { givenName: 'Member', familyName: 'One' },
        emails: [{ value: 'member.one@acme.test', primary: true }],
      }),
    });
    assert.equal(created.res.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.userName, 'member.one@acme.test');
    assert.equal(created.body.active, true);
    const id = created.body.id;

    // list + filter
    const listed = await jsonFetch(base, '/v1/scim/v2/Users?filter=' + encodeURIComponent('userName eq "member.one@acme.test"'), token);
    assert.equal(listed.body.totalResults, 1);
    assert.equal(listed.body.Resources[0].id, id);

    // patch -> deactivate (the deprovisioning path)
    const patched = await jsonFetch(base, '/v1/scim/v2/Users/' + id, token, {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    assert.equal(patched.res.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.active, false);

    // get reflects deactivation
    const got = await jsonFetch(base, '/v1/scim/v2/Users/' + id, token);
    assert.equal(got.res.status, 200);
    assert.equal(got.body.active, false);

    // put -> full replace (reactivate + rename)
    const put = await jsonFetch(base, '/v1/scim/v2/Users/' + id, token, {
      method: 'PUT',
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member.one@acme.test',
        active: true,
        name: { givenName: 'Member', familyName: 'Renamed' },
      }),
    });
    assert.equal(put.res.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.active, true);
    assert.equal(put.body.name.familyName, 'Renamed');

    // delete -> hard deprovision
    const del = await fetch(base + '/v1/scim/v2/Users/' + id, {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(del.status, 204);

    const after = await jsonFetch(base, '/v1/scim/v2/Users/' + id, token);
    assert.equal(after.res.status, 404);
  });
});

test('SCIM: one tenant\'s token cannot touch another tenant\'s users (isolation)', async () => {
  const a = makeApp('enterprise');
  const b = makeApp('enterprise');
  // Both apps share the same in-process store, so cross-tenant access would be
  // observable if fencing were broken. Run A's app for tokens/users, then probe
  // with B's token against the SAME server (same store) to prove isolation.
  await withListening(a.app, async (base) => {
    const tokenA = await scimToken(base, a.apiKey);
    const tokenB = await scimToken(base, b.apiKey);

    const createdA = await jsonFetch(base, '/v1/scim/v2/Users', tokenA, {
      method: 'POST',
      body: JSON.stringify({ userName: 'fenced.a@acme.test' }),
    });
    assert.equal(createdA.res.status, 201);
    const idA = createdA.body.id;

    // B lists -> must NOT see A's user.
    const listB = await jsonFetch(base, '/v1/scim/v2/Users', tokenB);
    assert.equal(listB.res.status, 200);
    assert.equal(listB.body.Resources.find((u) => u.id === idA), undefined);
    assert.equal(listB.body.totalResults, 0);

    // B reads A's user by id -> 404 (tenant-fenced), not 200.
    const getB = await jsonFetch(base, '/v1/scim/v2/Users/' + idA, tokenB);
    assert.equal(getB.res.status, 404);

    // B deactivates A's user by id -> 404 (cannot deprovision across tenants).
    const patchB = await jsonFetch(base, '/v1/scim/v2/Users/' + idA, tokenB, {
      method: 'PATCH',
      body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: false }] }),
    });
    assert.equal(patchB.res.status, 404);

    // A still sees its user, active.
    const getA = await jsonFetch(base, '/v1/scim/v2/Users/' + idA, tokenA);
    assert.equal(getA.res.status, 200);
    assert.equal(getA.body.active, true);
  });
});

test('SCIM: missing credential -> 401 with a SCIM Error envelope', async () => {
  const { app } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const res = await fetch(base + '/v1/scim/v2/Users');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
    assert.equal(body.status, '401');
  });
});

test('SCIM: a bogus bearer token -> 401 (not a valid SCIM token)', async () => {
  const { app } = makeApp('enterprise');
  await withListening(app, async (base) => {
    const { res, body } = await jsonFetch(base, '/v1/scim/v2/Users', 'scim_deadbeefdeadbeefdeadbeef');
    assert.equal(res.status, 401);
    assert.equal(body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
  });
});

test('SCIM token rotation is gated to entitled plans (free -> 402)', async () => {
  const { app, apiKey } = makeApp('free');
  await withListening(app, async (base) => {
    const { res, body } = await jsonFetch(base, '/v1/account/sso/scim-token', apiKey, { method: 'POST' });
    assert.equal(res.status, 402);
    assert.equal(body.error, 'enterprise_only');
  });
});
