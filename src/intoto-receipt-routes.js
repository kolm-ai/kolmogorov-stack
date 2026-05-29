// src/intoto-receipt-routes.js
//
// W921 BET-3 — HTTP route module exposing the in-toto / SLSA / OpenSSF
// Model-Signing-compatible attestation form of a kolm inference receipt.
//
// Exports register(r, deps) so the orchestrator mounts the surface with ONE
// call (import + register) and does NOT edit src/router.js. Mirrors the
// govern-routes.js convention exactly: auth-required, tenant-scoped (tenant_id
// is forced from req.tenant_record.id, never read from body/query), every
// handler returns a well-formed {ok,...} envelope and never throws across the
// boundary.
//
// Routes:
//   GET  /v1/govern/intoto/:receipt_id  — resolve a receipt by id and return
//        its in-toto attestation (signed DSSE bundle when a signer is present,
//        else the unsigned Statement). Optional ?format=oms for the OpenSSF
//        Model-Signing-shaped bundle.
//   POST /v1/govern/intoto/verify       — verify a posted DSSE bundle/envelope
//        (signature + Statement shape; optional subject-digest content check).
//
// `deps` is an injectable seam so the routes unit-test without a live store and
// so the orchestrator supplies the real receipt lookup + signer:
//   deps = {
//     getReceipt({ tenant_id, receipt_id }) -> receipt | null   (preferred)
//     store,                  // src/store.js fallback (findByTenant/find)
//     getSigner,              // () -> {privateKey, publicKey, key_fingerprint}
//     signer,                 // or a static signer object
//   }

import {
  toInTotoStatement,
  signInTotoBundle,
  toOmsBundle,
  verifyInTotoBundle,
  INTOTO_RECEIPT_VERSION,
  KOLM_INFERENCE_CONFORMANCE,
} from './intoto-receipt.js';

export const INTOTO_RECEIPT_ROUTES_VERSION = 'w921-intoto-receipt-routes-v1';

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec) {
    res.status(401).json({ ok: false, error: 'auth_required', hint: 'send Authorization: Bearer <ks_* or kao_* key>' });
    return null;
  }
  return trec;
}

function _err(res, code, error, detail) {
  return res.status(code).json({ ok: false, error, ...(detail ? { detail: String(detail) } : {}) });
}

// Resolve a receipt by id for a tenant, via the injectable resolver or the row
// store fallback. Returns null when not found / no resolver available. Never
// throws (so a handler can map a clean 404).
function _resolveReceipt(deps, tenant_id, receipt_id) {
  if (typeof deps.getReceipt === 'function') {
    try {
      const r = deps.getReceipt({ tenant_id, receipt_id });
      return r || null;
    } catch { return null; }
  }
  const store = deps.store || null;
  if (store) {
    const match = (rows) => {
      if (!Array.isArray(rows)) return null;
      for (const row of rows) {
        const rc = row && (row.receipt || row);
        if (rc && rc.receipt_id === receipt_id) return rc;
      }
      return null;
    };
    if (typeof store.findByTenant === 'function') {
      try { const hit = match(store.findByTenant('receipts', tenant_id)); if (hit) return hit; } catch { /* fall through */ }
      try { const hit = match(store.findByTenant('observations', tenant_id)); if (hit) return hit; } catch { /* fall through */ }
    }
    if (typeof store.find === 'function') {
      try {
        const hit = match(store.find('receipts', (row) => {
          const rc = row && (row.receipt || row);
          return rc && rc.tenant_id === tenant_id && rc.receipt_id === receipt_id;
        }));
        if (hit) return hit;
      } catch { /* ignore */ }
    }
  }
  return null;
}

export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('intoto-receipt-routes.register: router with get/post required');
  }
  const getSigner = typeof deps.getSigner === 'function'
    ? deps.getSigner
    : () => (deps.signer || null);

  // -------------------------------------------------------------------------
  // GET /v1/govern/intoto/:receipt_id
  // -------------------------------------------------------------------------
  r.get('/v1/govern/intoto/:receipt_id', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const receipt_id = req.params && req.params.receipt_id;
    if (!receipt_id) return _err(res, 400, 'receipt_id_required');

    // Allow a caller to POST-less supply a receipt inline for stateless use, but
    // prefer the tenant-scoped store lookup.
    const inline = req.query && req.query.receipt ? null : (req.body && req.body.receipt) || null;
    const receipt = _resolveReceipt(deps, trec.id, receipt_id) || inline;
    if (!receipt) {
      return _err(res, 404, 'receipt_not_found', `no receipt ${receipt_id} for this tenant`);
    }

    const format = (req.query && req.query.format) || 'intoto';
    try {
      const signer = getSigner();
      if (format === 'oms') {
        if (!signer || !signer.privateKey) {
          return _err(res, 503, 'no_signer_configured', 'OMS bundle requires an Ed25519 signer');
        }
        const bundle = toOmsBundle(receipt, signer);
        return res.json({
          ok: true, version: INTOTO_RECEIPT_ROUTES_VERSION,
          receipt_id, format: 'oms', bundle, conformance: KOLM_INFERENCE_CONFORMANCE,
        });
      }
      if (signer && signer.privateKey) {
        const signed = signInTotoBundle(receipt, signer);
        return res.json({
          ok: true, version: INTOTO_RECEIPT_ROUTES_VERSION,
          receipt_id, signed: true, format: 'intoto',
          statement: signed.statement, envelope: signed.envelope, bundle: signed.bundle,
          predicateType: signed.predicateType, conformance: signed.conformance,
          key_fingerprint: signed.key_fingerprint,
        });
      }
      const statement = toInTotoStatement(receipt);
      return res.json({
        ok: true, version: INTOTO_RECEIPT_ROUTES_VERSION,
        receipt_id, signed: false, format: 'intoto', statement,
        predicateType: statement.predicateType,
        note: 'no signer configured; returning unsigned in-toto Statement',
      });
    } catch (e) {
      return _err(res, 400, 'intoto_build_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/govern/intoto/verify
  // body: { bundle | envelope, public_key?, subject_digest_map? }
  // -------------------------------------------------------------------------
  r.post('/v1/govern/intoto/verify', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    const bundleOrEnvelope = body.bundle || body.envelope || null;
    if (!bundleOrEnvelope) {
      return _err(res, 400, 'bundle_or_envelope_required', 'pass {"bundle":{...}} or {"envelope":{...}}');
    }
    try {
      const signer = getSigner();
      const publicKey = body.public_key || (signer && signer.publicKey) || null;
      const verify = verifyInTotoBundle(bundleOrEnvelope, {
        publicKey,
        subjectDigestMap: body.subject_digest_map || null,
      });
      return res.json({ ok: true, version: INTOTO_RECEIPT_ROUTES_VERSION, verify });
    } catch (e) {
      return _err(res, 500, 'intoto_verify_error', (e && e.message) || e);
    }
  });

  return r;
}

export default register;
export const INTOTO_RECEIPT_ROUTES_SPEC = {
  version: INTOTO_RECEIPT_ROUTES_VERSION,
  receipt_module_version: INTOTO_RECEIPT_VERSION,
  routes: ['GET /v1/govern/intoto/:receipt_id', 'POST /v1/govern/intoto/verify'],
};
