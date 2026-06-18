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
import crypto from 'node:crypto';
import path from 'node:path';

export const META_ROUTES_CONTRACT_VERSION = 'w710-v1';
export const META_ROUTES_LIMITS = Object.freeze({
  max_features_query_chars: 8192,
  max_feature_keys: 64,
  max_feature_key_chars: 160,
  max_feature_string_chars: 512,
  max_numeric_abs: 1e12,
  max_detail_chars: 500,
});

const RESERVED_FEATURE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function withContract(env = {}) {
  return {
    ...env,
    version: env.version || meta.META_VERSION,
    contract_version: META_ROUTES_CONTRACT_VERSION,
  };
}

export function redactMetaRouteDetail(value) {
  let s = String(value == null ? '' : value);
  const roots = [
    process.cwd(),
    process.env.KOLM_DATA_DIR,
    process.env.HOME,
    process.env.USERPROFILE,
  ].filter(Boolean);
  for (const root of roots) {
    const escaped = String(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(escaped, 'gi'), '[path]');
  }
  s = s
    .replace(/[A-Za-z]:\\(?:[^\\/\s'"<>|]+\\)*[^\\/\s'"<>|]*/g, '[path]')
    .replace(/\/(?:[^/\s'"<>]+\/){1,}[^/\s'"<>]*/g, '[path]')
    .replace(/\[path\](?:[\\/][^\\/\s'"<>|]+)+/g, '[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > META_ROUTES_LIMITS.max_detail_chars
    ? s.slice(0, META_ROUTES_LIMITS.max_detail_chars) + '...'
    : s;
}

function errorEnvelope(error, extra = {}) {
  return withContract({
    ok: false,
    error,
    ...extra,
  });
}

function publicModelPathRef(modelPath) {
  if (!modelPath || typeof modelPath !== 'string') {
    return { model_path_present: false };
  }
  return {
    model_path_present: true,
    model_path_basename: path.basename(modelPath),
    model_path_sha256: crypto.createHash('sha256').update(modelPath).digest('hex'),
  };
}

function isSafeFeatureKey(key) {
  return typeof key === 'string'
    && key.length > 0
    && key.length <= META_ROUTES_LIMITS.max_feature_key_chars
    && !RESERVED_FEATURE_KEYS.has(key)
    && /^[A-Za-z0-9_.:-]+$/.test(key);
}

function coerceFeatureValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > META_ROUTES_LIMITS.max_numeric_abs) {
      return { ok: false, error: 'feature_number_out_of_range' };
    }
    return { ok: true, value };
  }
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'string') {
    if (value.length > META_ROUTES_LIMITS.max_feature_string_chars) {
      return { ok: false, error: 'feature_string_too_large' };
    }
    return { ok: true, value };
  }
  if (value == null) return { ok: true, value: null };
  return { ok: false, error: 'feature_value_type_unsupported' };
}

export function parseMetaRouteFeatures(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      ok: false,
      status: 400,
      body: errorEnvelope('features_required', {
        hint: 'pass ?features=<url-encoded JSON object>',
      }),
    };
  }
  if (raw.length > META_ROUTES_LIMITS.max_features_query_chars) {
    return {
      ok: false,
      status: 413,
      body: errorEnvelope('features_too_large', {
        max_features_query_chars: META_ROUTES_LIMITS.max_features_query_chars,
      }),
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) {
    return {
      ok: false,
      status: 400,
      body: errorEnvelope('features_invalid_json'),
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      body: errorEnvelope('features_invalid_shape', {
        detail: 'features must be a flat JSON object',
      }),
    };
  }
  const keys = Object.keys(parsed);
  if (keys.length > META_ROUTES_LIMITS.max_feature_keys) {
    return {
      ok: false,
      status: 413,
      body: errorEnvelope('features_too_many_keys', {
        max_feature_keys: META_ROUTES_LIMITS.max_feature_keys,
      }),
    };
  }
  const features = {};
  let recognizedFeatureCount = 0;
  for (const key of keys) {
    if (!isSafeFeatureKey(key)) {
      return {
        ok: false,
        status: 400,
        body: errorEnvelope('features_invalid_key'),
      };
    }
    const coerced = coerceFeatureValue(parsed[key]);
    if (!coerced.ok) {
      return {
        ok: false,
        status: 400,
        body: errorEnvelope('features_invalid_value', {
          detail: coerced.error,
        }),
      };
    }
    features[key] = coerced.value;
    if (coerced.value != null && meta.META_FEATURES.includes(key)) recognizedFeatureCount++;
  }
  if (recognizedFeatureCount === 0) {
    return {
      ok: false,
      status: 400,
      body: errorEnvelope('features_required', {
        hint: 'include at least one recognized meta feature',
      }),
    };
  }
  return { ok: true, features };
}

function sanitizeTrainerEnvelope(env) {
  if (!env || typeof env !== 'object') {
    return errorEnvelope('meta_invalid_envelope');
  }
  const out = { ...env };
  delete out.model_path;
  delete out.model;
  if (out.detail != null) out.detail = redactMetaRouteDetail(out.detail);
  return withContract(out);
}

// Both names exported - mountMetaRoutes is the historical name, registerMetaRoutes
// matches the sibling pattern (registerSavingsRoutes_w835, registerPipelineRoutes_w821).
export function registerMetaRoutes(r) {
  return mountMetaRoutes(r);
}

export function mountMetaRoutes(r) {
  // ---------------- GET /v1/meta/status ----------------
  r.get('/v1/meta/status', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json(errorEnvelope('auth_required'));
    try {
      const tenant_id = req.tenant_record.id;
      const rows_tenant = meta.n_rows({ tenant_id });
      const rows_total = meta.n_rows();
      let model_present = false;
      try {
        const env = meta.inferKolmMeta({ features: { capture_count: 0 } });
        model_present = env && env.ok === true;
      } catch (_) { model_present = false; }
      return res.status(200).json(withContract({
        ok: true,
        rows_total,
        rows_tenant,
        min_rows_for_meta: meta.MIN_ROWS_FOR_META,
        meta_insufficient_data: rows_total < meta.MIN_ROWS_FOR_META,
        model_present,
      }));
    } catch (e) {
      return res.status(500).json(errorEnvelope('meta_status_error', {
        detail: redactMetaRouteDetail((e && e.message) || e),
      }));
    }
  });

  // ---------------- POST /v1/meta/retrain ----------------
  r.post('/v1/meta/retrain', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json(errorEnvelope('auth_required'));
    try {
      const rows = meta.readTrainingRows();
      if (rows.length < 2) {
        return res.status(400).json(errorEnvelope('insufficient_rows', {
          rows: rows.length,
          hint: 'need >=2 rows; run more `kolm distill` first',
        }));
      }
      const env = meta.trainKolmMeta({ rows });
      if (!env.ok) return res.status(500).json(sanitizeTrainerEnvelope(env));
      return res.status(200).json(withContract({
        ok: true,
        n_train_rows: rows.length,
        model_path_ref: publicModelPathRef(env.model_path),
        n_train_below_meta_threshold: rows.length < meta.MIN_ROWS_FOR_META,
      }));
    } catch (e) {
      return res.status(500).json(errorEnvelope('meta_retrain_error', {
        detail: redactMetaRouteDetail((e && e.message) || e),
      }));
    }
  });

  // ---------------- GET /v1/meta/predict ----------------
  r.get('/v1/meta/predict', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json(errorEnvelope('auth_required'));
    try {
      const raw = req.query && req.query.features;
      const parsed = parseMetaRouteFeatures(raw);
      if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
      const env = meta.inferKolmMeta({ features: parsed.features });
      return res.status(200).json(sanitizeTrainerEnvelope(env));
    } catch (e) {
      return res.status(500).json(errorEnvelope('meta_predict_error', {
        detail: redactMetaRouteDetail((e && e.message) || e),
      }));
    }
  });
}

export const __metaRouteInternals = Object.freeze({
  publicModelPathRef,
  sanitizeTrainerEnvelope,
});
