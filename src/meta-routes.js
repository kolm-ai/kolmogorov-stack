// W832 - HTTP routes for kolm-meta meta-distillation model.
//
// Three auth-gated routes wired by router.js via mountMetaRoutes(r):
//
//   GET  /v1/meta/status     -> {ok, n_rows, model_present, version}
//   POST /v1/meta/retrain    -> rebuild ~/.kolm/meta-model.json
//   GET  /v1/meta/predict?features=<json> -> infer prediction for features
//
// All routes return honest envelopes - meta_insufficient_data, no_model,
// feature_order_mismatch surface as ok:false with status, never silent.

import * as meta from './kolm-meta-trainer.js';

// Both names exported - mountMetaRoutes is the historical name, registerMetaRoutes
// matches the sibling pattern (registerSavingsRoutes_w835, registerPipelineRoutes_w821).
export function registerMetaRoutes(r) {
  return mountMetaRoutes(r);
}

export function mountMetaRoutes(r) {
  // ---------------- GET /v1/meta/status ----------------
  r.get('/v1/meta/status', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const tenant_id = req.tenant_record.id;
      const rows_tenant = meta.n_rows({ tenant_id });
      const rows_total = meta.n_rows();
      let model_present = false;
      try {
        const env = meta.inferKolmMeta({ features: { capture_count: 0 } });
        model_present = env && env.ok === true;
      } catch (_) { model_present = false; }
      return res.status(200).json({
        ok: true,
        version: meta.META_VERSION,
        rows_total,
        rows_tenant,
        min_rows_for_meta: meta.MIN_ROWS_FOR_META,
        meta_insufficient_data: rows_total < meta.MIN_ROWS_FOR_META,
        model_present,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'meta_status_error',
        detail: String((e && e.message) || e),
        version: meta.META_VERSION,
      });
    }
  });

  // ---------------- POST /v1/meta/retrain ----------------
  r.post('/v1/meta/retrain', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const rows = meta.readTrainingRows();
      if (rows.length < 2) {
        return res.status(400).json({
          ok: false,
          error: 'insufficient_rows',
          rows: rows.length,
          hint: 'need >=2 rows; run more `kolm distill` first',
          version: meta.META_VERSION,
        });
      }
      const env = meta.trainKolmMeta({ rows });
      if (!env.ok) return res.status(500).json(env);
      return res.status(200).json({
        ok: true,
        version: meta.META_VERSION,
        n_train_rows: rows.length,
        model_path: env.model_path,
        n_train_below_meta_threshold: rows.length < meta.MIN_ROWS_FOR_META,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'meta_retrain_error',
        detail: String((e && e.message) || e),
        version: meta.META_VERSION,
      });
    }
  });

  // ---------------- GET /v1/meta/predict ----------------
  r.get('/v1/meta/predict', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const raw = req.query && req.query.features;
      if (!raw || typeof raw !== 'string') {
        return res.status(400).json({
          ok: false,
          error: 'features_required',
          hint: 'pass ?features=<url-encoded JSON object>',
          version: meta.META_VERSION,
        });
      }
      let features;
      try { features = JSON.parse(raw); }
      catch (_) {
        return res.status(400).json({
          ok: false,
          error: 'features_invalid_json',
          version: meta.META_VERSION,
        });
      }
      const env = meta.inferKolmMeta({ features });
      return res.status(env.ok ? 200 : 200).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'meta_predict_error',
        detail: String((e && e.message) || e),
        version: meta.META_VERSION,
      });
    }
  });
}
