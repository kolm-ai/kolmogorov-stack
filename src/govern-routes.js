// src/govern-routes.js
//
// W921 Govern / Receipts & Compliance — HTTP route module.
//
// Exports register(r, deps) so the orchestrator can mount the whole Govern
// surface with ONE call (import + register) and NOT edit src/router.js itself.
//
// All routes are auth-required + tenant-scoped: tenant_id is forced from
// req.tenant_record.id, NEVER read from body/query. Every handler returns a
// well-formed envelope ({ok, ...}) and never throws across the boundary.
//
// `deps` is an injectable seam so the routes unit-test without a live store and
// so the orchestrator can supply the real store/audit/drift/signer:
//   deps = {
//     store,                 // src/store.js (find/insert) — observation rows
//     verifyAuditChain,      // src/audit.js verifyAuditChain(tenant_id)
//     listAuditEvents,       // src/audit.js listAuditEvents(tenant_id, opts)
//     computeDriftSignals,   // a drift computation returning standard_signals
//     getSigner,             // () -> {privateKey, publicKey, key_fingerprint}
//     getLifecycle,          // ({tenant_id,namespace}) -> lifecycle events[]
//     retentionDays,         // configured retention, or null
//   }
//
//   POST /v1/govern/anchor/batch       — Merkle-batch + anchor a set of receipts
//   GET  /v1/govern/anchor/status      — batcher / anchoring status
//   POST /v1/govern/anchor/verify      — two-level offline verify of an anchor
//   POST /v1/govern/transparency/append— append an entry to the tlog
//   GET  /v1/govern/transparency/head  — signed Tree Head + chain verify
//   GET  /v1/govern/transparency/proof/:seq — inclusion proof for an entry
//   POST /v1/govern/provenance/build   — in-toto/SLSA attestation for an artifact
//   POST /v1/govern/provenance/verify  — verify a DSSE attestation
//   POST /v1/govern/c2pa/sign          — C2PA content-credential for an output
//   POST /v1/govern/c2pa/verify        — verify a C2PA manifest
//   GET  /v1/govern/drift/standard     — PSI/MMD/ADWIN standard drift signals
//   GET  /v1/govern/compliance/export  — framework evidence bundle
//   GET  /v1/govern/compliance/ai-act/art12 — Art. 12 logging conformance
//   GET  /v1/govern/compliance/ai-act/art72 — Art. 72 post-market report
//   GET  /v1/govern/compliance/ai-act/art12-export — signed Art. 12 log stream

import {
  TransparencyLog,
  getTransparencyLog,
  signTreeHead,
  verifyTreeHeadSignature,
} from './transparency-log.js';
import {
  governReceiptBatch,
  anchorBatch,
  stampReceiptAnchor,
  verifyReceiptAnchor,
} from './transparency-anchor.js';
import {
  buildSlsaProvenance,
  signSlsaProvenance,
  verifyProvenance,
} from './govern-provenance.js';
import {
  computeStandardSignals,
} from './govern-drift.js';
import {
  signC2paOutput,
  verifyC2paManifest,
} from './compliance-c2pa.js';
import {
  complianceExport,
  buildArt12LoggingConformance,
  buildArt72PostMarketReport,
  exportArt12LogStream,
  listFrameworks,
} from './compliance-export.js';

export const GOVERN_ROUTES_VERSION = 'w921-govern-routes-v1';

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

// Build the injectable deps used by compliance/drift builders from the row store.
function _complianceDeps(deps, trec) {
  const store = deps.store || null;
  return {
    readObservations: ({ tenant_id }) => {
      if (deps.readObservations) return deps.readObservations({ tenant_id });
      if (store && typeof store.findByTenant === 'function') {
        try { return store.findByTenant('observations', tenant_id) || []; } catch { return []; }
      }
      if (store && typeof store.find === 'function') {
        try { return store.find('observations', (r) => r.tenant_id === tenant_id) || []; } catch { return []; }
      }
      return [];
    },
    verifyChain: (tenant_id) => {
      if (deps.verifyAuditChain) { try { return deps.verifyAuditChain(tenant_id); } catch { return { ok: false, total: 0, breaks: [] }; } }
      return { ok: true, total: 0, breaks: [] };
    },
    getLifecycle: (o) => (deps.getLifecycle ? deps.getLifecycle(o) : []),
    computeDrift: (o) => (deps.computeDriftSignals ? deps.computeDriftSignals(o) : null),
    retentionDays: deps.retentionDays != null ? deps.retentionDays : null,
    signer: typeof deps.getSigner === 'function' ? deps.getSigner() : (deps.signer || null),
  };
}

export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('govern-routes.register: router with get/post required');
  }
  const getSigner = typeof deps.getSigner === 'function' ? deps.getSigner : () => (deps.signer || null);

  // -------------------------------------------------------------------------
  // ANCHOR — Merkle batch anchoring of receipts.
  // -------------------------------------------------------------------------
  r.post('/v1/govern/anchor/batch', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    const receipts = Array.isArray(body.receipts) ? body.receipts : null;
    if (!receipts || receipts.length === 0) {
      return _err(res, 400, 'receipts_required', 'pass {"receipts":[ ...receipt objects or {receipt_id,leaf} ... ]}');
    }
    try {
      const batch = governReceiptBatch(receipts);
      const signer = getSigner();
      const anchorResult = await anchorBatch(batch, { signer, submitFn: deps.rekorSubmitFn });
      const stamps = batch.inclusion_proofs.map((p) => ({
        receipt_id: p.receipt_id,
        anchor: stampReceiptAnchor({ ...p, batch_id: batch.batch_id }, anchorResult),
      }));
      return res.json({
        ok: true, version: GOVERN_ROUTES_VERSION,
        batch_id: batch.batch_id, tree_size: batch.tree_size,
        merkle_root: batch.merkle_root, state: anchorResult.state,
        checkpoint: anchorResult.checkpoint, stamps,
      });
    } catch (e) {
      return _err(res, 500, 'anchor_batch_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/anchor/status', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const status = deps.batcher && typeof deps.batcher.status === 'function'
      ? deps.batcher.status()
      : { queued: 0, mode: deps.rekorSubmitFn ? 'anchor' : 'local', version: GOVERN_ROUTES_VERSION };
    return res.json({ ok: true, ...status });
  });

  r.post('/v1/govern/anchor/verify', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (!body.anchor) return _err(res, 400, 'anchor_required');
    try {
      const v = verifyReceiptAnchor({ receipt: body.receipt, anchor: body.anchor, pinnedLogKeyPem: body.pinned_log_key_pem || null });
      return res.json({ ok: true, verify: v });
    } catch (e) {
      return _err(res, 500, 'anchor_verify_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // TRANSPARENCY LOG — append-only verifiable log.
  // -------------------------------------------------------------------------
  function _tlog(trec) {
    return getTransparencyLog({ tenant_id: trec.id, store: deps.store || null, origin: deps.tlogOrigin });
  }

  r.post('/v1/govern/transparency/append', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (!body.kind) return _err(res, 400, 'kind_required');
    try {
      const log = _tlog(trec);
      const before = log.treeHead();
      const entry = log.append(String(body.kind), body.data == null ? null : body.data, { namespace: body.namespace, tenant_id: trec.id });
      const after = log.treeHead();
      const proof = log.inclusionProof(entry.seq);
      return res.json({
        ok: true, version: entry.version,
        entry: { seq: entry.seq, kind: entry.kind, at: entry.at, prev_hash: entry.prev_hash, entry_hash: entry.entry_hash, leaf_hash: entry.leaf_hash },
        before: { tree_size: before.tree_size, root_hash: before.root_hash },
        after: { tree_size: after.tree_size, root_hash: after.root_hash },
        proof,
      });
    } catch (e) {
      return _err(res, 500, 'transparency_append_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/transparency/head', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const log = _tlog(trec);
      const head = log.treeHead();
      const signer = getSigner();
      const signed_tree_head = signer && signer.privateKey ? signTreeHead(head, signer) : null;
      return res.json({ ok: true, tree_head: head, signed_tree_head, chain: log.verifyChain() });
    } catch (e) {
      return _err(res, 500, 'transparency_head_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/transparency/proof/:seq', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const seq = Number(req.params && req.params.seq);
    try {
      const log = _tlog(trec);
      const proof = log.inclusionProof(seq);
      if (!proof.ok) return _err(res, 404, 'inclusion_proof_unavailable', proof.reason);
      return res.json({ ok: true, ...proof });
    } catch (e) {
      return _err(res, 500, 'transparency_proof_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // PROVENANCE — in-toto / SLSA build provenance.
  // -------------------------------------------------------------------------
  r.post('/v1/govern/provenance/build', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const artifact = (req.body && (req.body.artifact || req.body.manifest)) || null;
    if (!artifact) return _err(res, 400, 'artifact_required', 'pass {"artifact":{manifest,hashes,lineage,artifact_hash,...}}');
    try {
      const signer = getSigner();
      if (signer && signer.privateKey) {
        const signed = signSlsaProvenance(artifact, signer);
        return res.json({ ok: true, signed: true, statement: signed.statement, envelope: signed.envelope, predicateType: signed.predicateType, conformance: signed.conformance });
      }
      const statement = buildSlsaProvenance(artifact);
      return res.json({ ok: true, signed: false, statement, note: 'no signer configured; returning unsigned statement' });
    } catch (e) {
      return _err(res, 400, 'provenance_build_error', (e && e.message) || e);
    }
  });

  r.post('/v1/govern/provenance/verify', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (!body.envelope) return _err(res, 400, 'envelope_required');
    try {
      const signer = getSigner();
      const publicKey = body.public_key || (signer && signer.publicKey) || null;
      const v = verifyProvenance(body.envelope, { publicKey, digestMap: body.digest_map || null });
      return res.json({ ok: true, verify: v });
    } catch (e) {
      return _err(res, 500, 'provenance_verify_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // C2PA — content credentials for model outputs.
  // -------------------------------------------------------------------------
  r.post('/v1/govern/c2pa/sign', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (typeof body.output_text !== 'string' && !body.output_bytes_b64) {
      return _err(res, 400, 'output_required', 'pass {"output_text":"..."}');
    }
    try {
      const signer = getSigner();
      if (!signer || !signer.privateKey) return _err(res, 503, 'no_signer_configured', 'C2PA signing needs an Ed25519 signer');
      const outputBytes = body.output_bytes_b64 ? Buffer.from(body.output_bytes_b64, 'base64') : undefined;
      const out = signC2paOutput({
        outputText: body.output_text, outputBytes,
        receipt: body.receipt || {}, signer,
        claimGeneratorVersion: body.claim_generator_version || deps.version,
      });
      return res.json({
        ok: true,
        validation_status: out.validation_status,
        digitalSourceType: out.digitalSourceType,
        manifest_store_b64: out.manifestStoreBytes.toString('base64'),
        cert_source: out.cert_source,
        key_fingerprint: out.key_fingerprint,
      });
    } catch (e) {
      return _err(res, 500, 'c2pa_sign_error', (e && e.message) || e);
    }
  });

  r.post('/v1/govern/c2pa/verify', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (!body.manifest_store_b64) return _err(res, 400, 'manifest_store_b64_required');
    try {
      const signer = getSigner();
      const publicKey = body.public_key || (signer && signer.publicKey) || null;
      const asset = body.output_text != null ? Buffer.from(String(body.output_text), 'utf8')
        : (body.output_bytes_b64 ? Buffer.from(body.output_bytes_b64, 'base64') : undefined);
      const v = verifyC2paManifest(Buffer.from(body.manifest_store_b64, 'base64'), asset, { publicKey });
      return res.json({ ok: true, verify: v });
    } catch (e) {
      return _err(res, 500, 'c2pa_verify_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // DRIFT — standard signals.
  // -------------------------------------------------------------------------
  r.get('/v1/govern/drift/standard', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      if (typeof deps.computeStandardDriftInput === 'function') {
        const input = deps.computeStandardDriftInput({ tenant_id: trec.id, namespace: (req.query && req.query.namespace) || 'default' });
        return res.json({ ok: true, standard_signals: computeStandardSignals(input || {}) });
      }
      return res.json({ ok: true, standard_signals: computeStandardSignals({}), note: 'no drift input provider configured' });
    } catch (e) {
      return _err(res, 500, 'drift_standard_error', (e && e.message) || e);
    }
  });

  // -------------------------------------------------------------------------
  // COMPLIANCE — framework evidence + EU AI Act live reports.
  // -------------------------------------------------------------------------
  r.get('/v1/govern/compliance/frameworks', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    return res.json({ ok: true, frameworks: listFrameworks() });
  });

  r.get('/v1/govern/compliance/export', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const framework = (req.query && req.query.framework) || 'soc2';
    try {
      const out = complianceExport({
        framework, tenant_id: trec.id,
        namespace: (req.query && req.query.namespace) || null,
        from: (req.query && req.query.from) || null,
        to: (req.query && req.query.to) || null,
        ..._complianceDeps(deps, trec),
      });
      const code = out.ok ? 200 : (out.error === 'unknown_framework' ? 400 : 400);
      return res.status(code).json(out);
    } catch (e) {
      return _err(res, 500, 'compliance_export_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/compliance/ai-act/art12', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const out = buildArt12LoggingConformance({
        tenant_id: trec.id, namespace: (req.query && req.query.namespace) || null,
        from: (req.query && req.query.from) || null, to: (req.query && req.query.to) || null,
        ..._complianceDeps(deps, trec),
      });
      return res.json(out);
    } catch (e) {
      return _err(res, 500, 'art12_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/compliance/ai-act/art72', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const out = buildArt72PostMarketReport({
        tenant_id: trec.id, namespace: (req.query && req.query.namespace) || null,
        from: (req.query && req.query.from) || null, to: (req.query && req.query.to) || null,
        risk_category: (req.query && req.query.risk_category) || null,
        ..._complianceDeps(deps, trec),
      });
      return res.json(out);
    } catch (e) {
      return _err(res, 500, 'art72_error', (e && e.message) || e);
    }
  });

  r.get('/v1/govern/compliance/ai-act/art12-export', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const out = exportArt12LogStream({
        tenant_id: trec.id, namespace: (req.query && req.query.namespace) || null,
        from: (req.query && req.query.from) || null, to: (req.query && req.query.to) || null,
        format: (req.query && req.query.format) === 'csv' ? 'csv' : 'jsonl',
        ..._complianceDeps(deps, trec),
      });
      return res.json(out);
    } catch (e) {
      return _err(res, 500, 'art12_export_error', (e && e.message) || e);
    }
  });

  return r;
}

export default register;
