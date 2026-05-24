// src/reg-routes.js
//
// W834 — regulatory compliance toolkit HTTP routes.
//
// Lives as a one-call mount (registerRegRoutes(app)) to keep src/router.js
// diff to a single import + a single call — parallel W83x agents are editing
// router.js, so every extra line is a potential merge conflict.
//
// Seven routes, all auth-required + tenant-scoped via req.tenant_record.id:
//
//   POST /v1/reg/eu-aiact-docs      — generate the Annex IV technical-docs blob
//   POST /v1/reg/classify-risk      — classify against the intended-use enum
//   POST /v1/reg/hil/threshold      — set the per-namespace HIL threshold
//   GET  /v1/reg/hil/threshold      — read back the threshold
//   GET  /v1/reg/data-governance    — emit the data-governance markdown report
//   POST /v1/reg/model-card         — emit the extended model card
//   POST /v1/reg/grc-export         — emit a vendor-shaped GRC payload
//
// Honesty contract:
//   * All routes return honest envelopes; never throw across the boundary.
//   * tenant_id is sourced from req.tenant_record.id — NEVER from body/query.
//   * Modules are imported lazily inside the handler so cold daemons that
//     never touch the regulatory surface don't pay for the imports.
//
// W834 sub-items wired:
//   W834-1 → /v1/reg/eu-aiact-docs    (src/reg-eu-aiact-docs.js)
//   W834-2 → /v1/reg/classify-risk    (src/reg-risk-classify.js)
//   W834-3 → /v1/reg/hil/threshold    (src/reg-hil.js)
//   W834-4 → /v1/reg/data-governance  (src/reg-data-governance.js)
//   W834-5 → /v1/reg/model-card       (src/reg-model-card-extended.js)
//   W834-6 → /v1/reg/grc-export       (src/reg-grc-connectors.js)
//
// artifact_id resolution: today we accept inline `manifest` only. A
// `artifact_id` body field returns an honest 400 telling the caller
// manifest-id resolution lands in a follow-up wave (matches W768's pattern).

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
    });
    return null;
  }
  return trec;
}

function _requireManifest(req, res, body, version) {
  if (body && typeof body.artifact_id === 'string' && body.artifact_id && !body.artifact_manifest && !body.manifest) {
    res.status(400).json({
      ok: false,
      error: 'artifact_id_lookup_not_yet_wired',
      hint: 'pass {"artifact_manifest": {...inline manifest...}} — artifact_id resolution is on the W834-followup roadmap.',
      version,
    });
    return null;
  }
  const manifest = body && (body.artifact_manifest || body.manifest);
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    res.status(400).json({
      ok: false,
      error: 'artifact_manifest_required',
      hint: 'pass {"artifact_manifest": {...inline manifest...}}',
      version,
    });
    return null;
  }
  return manifest;
}

export function registerRegRoutes(r) {
  // ---------------------------------------------------------------------
  // W834-1 — POST /v1/reg/eu-aiact-docs
  // ---------------------------------------------------------------------
  r.post('/v1/reg/eu-aiact-docs', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const mod = await import('./reg-eu-aiact-docs.js');
      const manifest = _requireManifest(req, res, body, mod.REG_EU_AIACT_DOCS_VERSION);
      if (!manifest) return;
      const result = mod.generateTechnicalDocs({
        artifact_manifest: manifest,
        tenant_metadata: body.tenant_metadata || { legal_name: trec.id },
        format: body.format,
      });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_eu_aiact_docs_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-2 — POST /v1/reg/classify-risk
  // ---------------------------------------------------------------------
  r.post('/v1/reg/classify-risk', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const mod = await import('./reg-risk-classify.js');
      // intended_use is the gating input here; manifest is OPTIONAL (used only
      // for the manifest_hint field in the envelope).
      const intended_use = typeof body.intended_use === 'string' ? body.intended_use : null;
      // Accept manifest OR artifact_manifest; OR even no manifest (the
      // classifier doesn't strictly require it).
      const manifest = body.artifact_manifest || body.manifest || {};
      const result = mod.classifyArtifactRisk({
        manifest,
        intended_use,
      });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_classify_risk_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-3 — POST /v1/reg/hil/threshold
  // ---------------------------------------------------------------------
  r.post('/v1/reg/hil/threshold', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (body.confirm !== true) {
      return res.status(400).json({
        ok: false,
        error: 'confirm_required',
        hint: 'send {"confirm": true} alongside {namespace, threshold} — threshold is durable and gates EVERY subsequent decision in this namespace.',
        version: 'w834-v1',
      });
    }
    try {
      const mod = await import('./reg-hil.js');
      const result = await mod.setMandatoryHumanReviewThreshold({
        tenant: trec.id,
        namespace: typeof body.namespace === 'string' ? body.namespace : null,
        threshold: body.threshold,
      });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_hil_threshold_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-3 — GET /v1/reg/hil/threshold?namespace=X
  // ---------------------------------------------------------------------
  r.get('/v1/reg/hil/threshold', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const namespace = req.query && typeof req.query.namespace === 'string'
        ? req.query.namespace
        : null;
      if (!namespace) {
        return res.status(400).json({
          ok: false,
          error: 'namespace_required',
          hint: 'pass ?namespace=<namespace>',
          version: 'w834-v1',
        });
      }
      const mod = await import('./reg-hil.js');
      const result = await mod.getHilConfig({
        tenant: trec.id,
        namespace,
      });
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_hil_get_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-4 — GET /v1/reg/data-governance?namespace=X&period=YYYY-MM
  // ---------------------------------------------------------------------
  r.get('/v1/reg/data-governance', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const namespace = req.query && typeof req.query.namespace === 'string'
        ? req.query.namespace
        : null;
      const period = req.query && typeof req.query.period === 'string'
        ? req.query.period
        : null;
      const mod = await import('./reg-data-governance.js');
      const result = await mod.generateGovernanceReport({
        tenant: trec.id,
        namespace,
        period,
      });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_data_governance_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-5 — POST /v1/reg/model-card
  // ---------------------------------------------------------------------
  r.post('/v1/reg/model-card', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const mod = await import('./reg-model-card-extended.js');
      const manifest = _requireManifest(req, res, body, mod.REG_MODEL_CARD_EXTENDED_VERSION);
      if (!manifest) return;
      const result = mod.buildExtendedModelCard(manifest, {
        format: body.format,
        include_environmental: body.include_environmental === true,
        gates_required: Array.isArray(body.gates_required) ? body.gates_required : [],
      });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_model_card_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // ---------------------------------------------------------------------
  // W834-6 — POST /v1/reg/grc-export
  // ---------------------------------------------------------------------
  r.post('/v1/reg/grc-export', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    try {
      const body = req.body || {};
      const report = body.report;
      const vendor = typeof body.vendor === 'string' ? body.vendor : null;
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        return res.status(400).json({
          ok: false,
          error: 'report_required',
          hint: 'pass {"report": {...kolm report envelope...}, "vendor": "onetrust"|"servicenow"|"ibm_openpages"}',
          version: 'w834-v1',
        });
      }
      if (!vendor) {
        return res.status(400).json({
          ok: false,
          error: 'vendor_required',
          hint: 'pass {"vendor": "onetrust"|"servicenow"|"ibm_openpages"}',
          version: 'w834-v1',
        });
      }
      const mod = await import('./reg-grc-connectors.js');
      const result = mod.exportByVendor(report, vendor);
      // Note: result.ok=false with error='no_grc_creds' is the HONEST
      // happy path when env-vars aren't set — we return 200 with the
      // payload still computed so the operator can manually upload. Only
      // genuinely-malformed input returns a 400.
      if (!result.ok && (result.error === 'unknown_vendor' || result.error === 'report_required' || result.error === 'vendor_required')) {
        return res.status(400).json(result);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'reg_grc_export_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  return r;
}

export default registerRegRoutes;
