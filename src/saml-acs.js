// src/saml-acs.js - real SAML 2.0 Assertion Consumer Service (ACS) consumption.
//
// ES module (repo is "type":"module"). Validates a base64 SAMLResponse
// end-to-end with node:crypto only:
//   1. XML signature: extract <ds:SignedInfo>, verify its enveloped signature
//      against the IdP signing certificate's public key, and confirm the
//      SignedInfo Reference DigestValue matches the SHA of the signed element
//      (the Response or the Assertion). This is the security-critical step.
//   2. Conditions: NotBefore / NotOnOrAfter window + AudienceRestriction.
//   3. SubjectConfirmationData: Recipient (== our ACS URL) + NotOnOrAfter.
//   4. Clock-skew tolerance on every time bound.
//   5. Extract NameID + <AttributeStatement> attributes.
//   6. create-or-link a tenant user (matched to the configured tenant) and
//      issue a kolm session key - the same ks_ key the kolm_session cookie
//      carries everywhere else in this codebase.
//
// ── Limitation (documented, intentional) ────────────────────────────────────
// XML is parsed DOMless with anchored regular expressions, NOT a full XML/DSIG
// library. This is acceptable for the well-formed, single-Assertion responses
// emitted by mainstream IdPs (Okta, Azure AD, OneLogin, Google) but it does NOT
// implement full Exclusive XML Canonicalization (xml-exc-c14n). We canonicalize
// the SignedInfo region by trimming inter-tag whitespace, which matches the
// serialization those IdPs produce in practice. For a fully spec-compliant
// deployment behind an adversarial IdP, swap _verifyXmlSignature() for a vetted
// xml-crypto implementation. Signature-wrapping (XSW) is mitigated by reading
// the NameID/attributes ONLY from the element the signature's Reference covers.

import crypto from 'node:crypto';
import {
  findOne,
  findByField,
  insert,
  update,
  remove,
  id as storeId,
} from './store.js';
import { provisionTenant, mintScopedKey } from './auth.js';

export const DEFAULT_SKEW_MS = 5 * 60 * 1000; // 5 minutes, RFC-typical tolerance

// ── small DOMless XML helpers (namespace-prefix agnostic) ───────────────────

function _elRe(local, flags = 'i') {
  // Match <[ns:]Local ...>inner</[ns:]Local> OR a self-closing <[ns:]Local .../>
  return new RegExp(
    '<(?:[\\w.-]+:)?' + local + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?' + local + '>)',
    flags
  );
}
function _findEl(xml, local) {
  const m = _elRe(local).exec(String(xml || ''));
  if (!m) return null;
  return { attrs: m[1] || '', inner: m[2] != null ? m[2] : '', full: m[0] };
}
function _findAllEls(xml, local) {
  const re = _elRe(local, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(xml || '')))) {
    out.push({ attrs: m[1] || '', inner: m[2] != null ? m[2] : '', full: m[0] });
  }
  return out;
}
function _attr(attrs, name) {
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(attrs || '');
  return m ? _xmlUnescape(m[1]) : null;
}
function _text(s) {
  return _xmlUnescape(String(s == null ? '' : s).trim());
}
function _xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// ── certificate / key handling ──────────────────────────────────────────────

function _normalizeCertPem(certPem) {
  if (!certPem) return null;
  const p = String(certPem).trim();
  if (p.includes('BEGIN CERTIFICATE')) return p;
  // bare base64 DER (as embedded in IdP metadata <X509Certificate>) -> wrap PEM
  const b64 = p.replace(/\s+/g, '');
  const lines = b64.match(/.{1,64}/g) || [b64];
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----\n';
}

function _certToPublicKey(certPem) {
  try {
    const x = new crypto.X509Certificate(_normalizeCertPem(certPem));
    return x.publicKey;
  } catch {
    return null;
  }
}

function _algoFor(signatureMethodUri) {
  const u = String(signatureMethodUri || '').toLowerCase();
  if (u.includes('sha512')) return 'RSA-SHA512';
  if (u.includes('sha384')) return 'RSA-SHA384';
  if (u.includes('sha1')) return 'RSA-SHA1';
  return 'RSA-SHA256';
}
function _digestFor(digestMethodUri) {
  const u = String(digestMethodUri || '').toLowerCase();
  if (u.includes('sha512')) return 'sha512';
  if (u.includes('sha384')) return 'sha384';
  if (u.includes('sha1')) return 'sha1';
  return 'sha256';
}

// Minimal canonicalization: strip the inter-element whitespace mainstream IdPs
// serialize around SignedInfo / signed elements. Documented limitation above.
function _canonicalize(fragment) {
  return String(fragment)
    .replace(/\r\n/g, '\n')
    .replace(/>\s+</g, '><')
    .trim();
}

// Enveloped-signature transform: remove the <ds:Signature> before digesting.
function _stripSignature(fragment) {
  return String(fragment).replace(
    /<(?:[\w.-]+:)?Signature\b[\s\S]*?<\/(?:[\w.-]+:)?Signature>/i,
    ''
  );
}

// Find <X ID="id" ...>...</X> for any element carrying the given ID attribute.
function _findElementById(xml, id) {
  const re = new RegExp(
    '<((?:[\\w.-]+:)?[\\w.-]+)\\b[^>]*\\bID\\s*=\\s*"' +
      String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '"[\\s\\S]*?</\\1>',
    'i'
  );
  const m = re.exec(String(xml || ''));
  return m ? m[0] : null;
}

// ── core signature verification ─────────────────────────────────────────────
//
// Verifies the enveloped XML signature. Returns { ok, signedElement } where
// signedElement is the canonical element whose digest the signature covers
// (Response or Assertion) - claims MUST be read only from this element.
export function _verifyXmlSignature(xml, certPem) {
  const sig = _findEl(xml, 'Signature');
  if (!sig) return { ok: false, error: 'no_signature' };

  const signedInfo = _findEl(sig.full, 'SignedInfo');
  if (!signedInfo) return { ok: false, error: 'no_signedinfo' };

  const sigValEl = _findEl(sig.full, 'SignatureValue');
  if (!sigValEl) return { ok: false, error: 'no_signature_value' };
  const signatureValue = _text(sigValEl.inner).replace(/\s+/g, '');

  const sigMethod = _attr((_findEl(signedInfo.inner, 'SignatureMethod') || {}).attrs, 'Algorithm');
  const algo = _algoFor(sigMethod);

  // 1) Verify the SignedInfo block itself against the cert public key. The
  // signature is computed over the canonical SignedInfo bytes - reconstruct
  // the exact <SignedInfo>...</SignedInfo> region from the document.
  const siMatch = /<((?:[\w.-]+:)?SignedInfo)\b[\s\S]*?<\/\1>/i.exec(sig.full);
  if (!siMatch) return { ok: false, error: 'signedinfo_extract_failed' };
  const signedInfoCanon = _canonicalize(siMatch[0]);

  const pubKey = _certToPublicKey(certPem);
  if (!pubKey) return { ok: false, error: 'bad_certificate' };

  let sigOk = false;
  try {
    const v = crypto.createVerify(algo);
    v.update(signedInfoCanon, 'utf8');
    v.end();
    sigOk = v.verify(pubKey, signatureValue, 'base64');
  } catch (e) {
    return { ok: false, error: 'verify_threw', detail: e.message };
  }
  if (!sigOk) return { ok: false, error: 'signature_invalid' };

  // 2) Verify the Reference digest actually covers the signed element.
  const ref = _findEl(signedInfo.inner, 'Reference');
  if (!ref) return { ok: false, error: 'no_reference' };
  const refUri = (_attr(ref.attrs, 'URI') || '').replace(/^#/, '');
  const digestMethod = _attr((_findEl(ref.inner, 'DigestMethod') || {}).attrs, 'Algorithm');
  const digestValueEl = _findEl(ref.inner, 'DigestValue');
  if (!digestValueEl) return { ok: false, error: 'no_digest_value' };
  const expectedDigest = _text(digestValueEl.inner).replace(/\s+/g, '');
  const digestAlgo = _digestFor(digestMethod);

  // Locate the element the Reference URI points at (by ID), else top-level
  // Assertion, else the whole Response.
  let signedElementXml = null;
  if (refUri) {
    const byId = _findElementById(xml, refUri);
    if (byId) signedElementXml = byId;
  }
  if (!signedElementXml) {
    const asn = _findEl(xml, 'Assertion');
    signedElementXml = asn ? asn.full : String(xml);
  }

  const toDigest = _canonicalize(_stripSignature(signedElementXml));
  const computed = crypto.createHash(digestAlgo).update(toDigest, 'utf8').digest('base64');
  if (computed !== expectedDigest) return { ok: false, error: 'digest_mismatch' };

  return { ok: true, signedElement: signedElementXml };
}

// ── time + condition validation ─────────────────────────────────────────────

function _parseTime(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function _checkTimeWindow({ notBefore, notOnOrAfter }, now, skewMs) {
  if (notBefore != null && now + skewMs < notBefore) return { ok: false, error: 'assertion_not_yet_valid' };
  if (notOnOrAfter != null && now - skewMs >= notOnOrAfter) return { ok: false, error: 'assertion_expired' };
  return { ok: true };
}

// ── tenant user create-or-link + session issuance (real auth.js path) ────────
//
// The "session" in this codebase is a raw ks_ key carried in the kolm_session
// cookie. There is no separate session table. For SSO we:
//   - resolve the matched tenant row (caller passes a tenant id/name OR we look
//     it up by the asserted email),
//   - record / refresh an sso_users link row keyed by `${tenant}:${nameId}`,
//   - mint a fresh session key for that tenant via rotateTenantKey (so the
//     browser gets a usable credential - same trade-off as OAuth signin).
// If no matching tenant exists and allowJitProvision is on, provision one.
//
// SECURITY: an EXPLICIT tenant hint is authoritative - if the caller names a
// tenant (id or name) that does not resolve, we DO NOT fall back to matching by
// the asserted email. Silent email fallback would let one tenant's IdP log a
// user into a different tenant when email addresses collide. The email match is
// used ONLY when the caller passes no tenant hint at all (SP-initiated flow
// where the SP did not carry a tenant).
function _resolveTenantRow({ tenant, email, allowJitProvision, jitPlan }) {
  let row = null;
  if (tenant) {
    row = findOne('tenants', (t) => !t._deleted && (t.id === tenant || t.name === tenant));
    // Explicit-but-unresolved tenant: fail closed below (no email fallback),
    // unless JIT provisioning is enabled (then we mint against the email).
  } else if (email) {
    row = findOne('tenants', (t) => !t._deleted && t.email === email && t.kind !== 'anon');
  }
  if (!row && allowJitProvision) {
    const base = (email && email.split('@')[0]) || 'sso-user';
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'sso-user';
    // provisionTenant returns { ...t, api_key } and is idempotent on name.
    const provisioned = provisionTenant(`${slug}-${Date.now().toString(36).slice(-4)}`, {
      plan: jitPlan || 'enterprise',
      email: email || null,
    });
    row = findOne('tenants', (t) => t.id === provisioned.id) || provisioned;
  }
  return row;
}

// ── public API ──────────────────────────────────────────────────────────────
//
// consumeAssertion({ samlResponseB64, tenant, idpCertPem, ... })
//   -> { ok:true, status:200, key, tenant, tenantName, plan, nameId, email,
//        attributes, sessionId } on success (key is the raw ks_ session key)
//   -> { ok:false, status, error, detail } on failure
//
// `tenant` may be a tenant id, a tenant name, or null (then we match by the
// asserted email). Signature verification ALWAYS runs before any claim is read.
export async function consumeAssertion(opts) {
  const {
    samlResponseB64,
    tenant = null,
    idpCertPem,
    audience = null,
    acsUrl = null,
    allowJitProvision = false,
    jitPlan = 'enterprise',
    clockSkewMs = DEFAULT_SKEW_MS,
    allowReplay = false,
    now = Date.now(),
  } = opts || {};

  if (!samlResponseB64) return { ok: false, status: 400, error: 'missing_saml_response' };
  if (!idpCertPem) return { ok: false, status: 503, error: 'missing_idp_certificate' };

  // 1) base64 -> XML
  let xml;
  try {
    xml = Buffer.from(String(samlResponseB64), 'base64').toString('utf8');
  } catch {
    return { ok: false, status: 400, error: 'saml_response_not_base64' };
  }
  if (!/<[\w.-]*:?Response\b/i.test(xml) && !/<[\w.-]*:?Assertion\b/i.test(xml)) {
    return { ok: false, status: 400, error: 'saml_response_not_xml' };
  }

  // 2) verify signature (security-critical, before reading any claim)
  const ver = _verifyXmlSignature(xml, idpCertPem);
  if (!ver.ok) {
    return { ok: false, status: 401, error: 'signature_verification_failed', detail: ver.error };
  }

  // Read claims ONLY from the signed element (XSW mitigation). If the Response
  // was signed, descend to its Assertion; if the Assertion was signed, use it.
  const signed = ver.signedElement;
  const innerAssertion = _findEl(signed, 'Assertion');
  const assertionEl = innerAssertion || { attrs: '', inner: signed, full: signed };
  const assertion = assertionEl.full;

  // 3) Conditions: time window + audience
  const conditionsEl = _findEl(assertion, 'Conditions');
  if (conditionsEl) {
    const cw = _checkTimeWindow(
      {
        notBefore: _parseTime(_attr(conditionsEl.attrs, 'NotBefore')),
        notOnOrAfter: _parseTime(_attr(conditionsEl.attrs, 'NotOnOrAfter')),
      },
      now,
      clockSkewMs
    );
    if (!cw.ok) return { ok: false, status: 401, error: cw.error };

    if (audience) {
      const audValues = _findAllEls(conditionsEl.inner, 'Audience').map((a) => _text(a.inner));
      if (audValues.length && !audValues.includes(String(audience))) {
        return { ok: false, status: 401, error: 'audience_mismatch', detail: audValues.join(',') };
      }
    }
  }

  // 4) SubjectConfirmationData: Recipient + NotOnOrAfter
  const scd = _findEl(assertion, 'SubjectConfirmationData');
  if (scd) {
    const scw = _checkTimeWindow(
      { notBefore: null, notOnOrAfter: _parseTime(_attr(scd.attrs, 'NotOnOrAfter')) },
      now,
      clockSkewMs
    );
    if (!scw.ok) return { ok: false, status: 401, error: 'subject_confirmation_expired' };
    if (acsUrl) {
      const recipient = _attr(scd.attrs, 'Recipient');
      if (recipient && recipient !== String(acsUrl)) {
        return { ok: false, status: 401, error: 'recipient_mismatch', detail: recipient };
      }
    }
  }

  // 5) extract NameID + attributes (from the signed Subject)
  const subjectEl = _findEl(assertion, 'Subject');
  const nameIdEl = subjectEl ? _findEl(subjectEl.inner, 'NameID') : _findEl(assertion, 'NameID');
  const nameId = nameIdEl ? _text(nameIdEl.inner) : null;
  if (!nameId) return { ok: false, status: 401, error: 'no_nameid' };

  const attributes = {};
  const attrStmt = _findEl(assertion, 'AttributeStatement');
  if (attrStmt) {
    for (const a of _findAllEls(attrStmt.inner, 'Attribute')) {
      const name = _attr(a.attrs, 'Name') || _attr(a.attrs, 'FriendlyName');
      if (!name) continue;
      const vals = _findAllEls(a.inner, 'AttributeValue').map((v) => _text(v.inner));
      attributes[name] = vals.length <= 1 ? (vals[0] || '') : vals;
    }
  }
  const email =
    attributes.email ||
    attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ||
    (String(nameId).includes('@') ? nameId : null);

  // 6) resolve tenant + create-or-link the SSO user + mint a session key.
  const tenantRow = _resolveTenantRow({ tenant, email, allowJitProvision, jitPlan });
  if (!tenantRow) {
    return { ok: false, status: 404, error: 'tenant_not_found', detail: 'no tenant matched and JIT provisioning disabled' };
  }
  const tenantId = tenantRow.id;
  const nowIso = new Date(now).toISOString();

  // 6a) Replay protection (SAML 2.0 §1.3.4 / RFC 7522): an Assertion ID may be
  // consumed at most once per tenant. The consumed-ID cache is durable (store
  // table, survives restarts) so a process bounce does not reopen the replay
  // window. We burn the ID immediately on first sight - before linking the user
  // or minting a session - so a concurrent double-submit cannot both succeed.
  const assertionId = _attr(assertionEl.attrs, 'ID') || null;
  if (!allowReplay && assertionId) {
    const seen = findOne(
      'sso_consumed_assertions',
      (a) => !a._deleted && a.tenant_id === tenantId && a.assertion_id === assertionId
    );
    if (seen) return { ok: false, status: 401, error: 'assertion_replayed', detail: assertionId };
  }
  if (assertionId) {
    const replayExpiry =
      _attr((scd || {}).attrs, 'NotOnOrAfter') ||
      _attr((conditionsEl || {}).attrs, 'NotOnOrAfter') ||
      null;
    insert('sso_consumed_assertions', {
      id: storeId('saml_aid'),
      tenant_id: tenantId,
      assertion_id: assertionId,
      not_on_or_after: replayExpiry,
      consumed_at: nowIso,
    });
    // Opportunistic prune: drop this tenant's already-expired replay rows so the
    // cache stays bounded (an expired ID can never be replayed within its window
    // again - the time-window check would reject it first).
    try {
      const cutoff = now - clockSkewMs;
      const rows = findByField('sso_consumed_assertions', 'tenant_id', tenantId);
      if (rows.some((a) => a && a.not_on_or_after && Date.parse(a.not_on_or_after) < cutoff)) {
        remove(
          'sso_consumed_assertions',
          (a) => a.tenant_id === tenantId && a.not_on_or_after && Date.parse(a.not_on_or_after) < cutoff
        );
      }
    } catch { /* prune is best-effort */ }
  }

  // sso_users link table: one row per (tenant_id, name_id).
  const linkKey = `${tenantId}:${nameId}`;
  const existingLink = findOne(
    'sso_users',
    (u) => !u._deleted && u.tenant_id === tenantId && u.name_id === nameId
  );
  if (existingLink) {
    update('sso_users', (u) => u.id === existingLink.id, {
      email: email || existingLink.email || null,
      attributes,
      last_login_at: nowIso,
    });
  } else {
    insert('sso_users', {
      id: storeId('sso_user'),
      link_key: linkKey,
      tenant_id: tenantId,
      name_id: nameId,
      email: email || null,
      attributes,
      linked_via: 'saml',
      created_at: nowIso,
      last_login_at: nowIso,
    });
  }

  // Mint a per-login scoped session credential for the browser. We deliberately
  // do NOT rotate the tenant-primary key here: rotateTenantKey would invalidate
  // every other member's session and any server-to-server key on every single
  // SSO login - unacceptable for a multi-seat enterprise tenant. mintScopedKey
  // inserts a fresh api_keys row that findTenantByApiKey resolves, so the
  // browser gets a usable session while the tenant's primary key and peers'
  // sessions stay intact. Only the hash is persisted; we return the raw ks_ key
  // for the caller to set as the kolm_session cookie (exactly like signin).
  const minted = mintScopedKey(tenantId, { scopes: ['*'], label: `sso:${String(nameId).slice(0, 64)}` });
  const sessionKey = minted.key;

  // Audit row for the SSO session (no secret stored - key_prefix only).
  const sessionId = 'sso_' + crypto.randomBytes(12).toString('hex');
  insert('sso_sessions', {
    id: sessionId,
    tenant_id: tenantId,
    name_id: nameId,
    key_prefix: String(sessionKey).slice(0, 10),
    via: 'saml',
    issued_at: nowIso,
  });

  return {
    ok: true,
    status: 200,
    key: sessionKey,
    tenant: tenantId,
    tenantName: tenantRow.name,
    plan: tenantRow.plan || jitPlan,
    nameId,
    email: email || null,
    attributes,
    sessionId,
  };
}

// Peek the (still UNTRUSTED) Issuer entityID from a base64 SAMLResponse. Used
// only to resolve which tenant's IdP config + pinned signing certificate to
// verify the assertion against - the value MUST NOT be trusted for any security
// decision until consumeAssertion has verified the XML signature.
export function extractIssuer(samlResponseB64) {
  let xml;
  try {
    xml = Buffer.from(String(samlResponseB64 || ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const el = _findEl(xml, 'Issuer');
  return el ? _text(el.inner) : null;
}

// Exported internals for unit testing.
export const _internal = {
  _findEl,
  _findAllEls,
  _attr,
  _parseTime,
  _checkTimeWindow,
  _normalizeCertPem,
  _canonicalize,
};
