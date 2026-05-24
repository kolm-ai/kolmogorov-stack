// W833 — HTTP routes for cross-lingual foundation enhancements.
//
// Wired by router.js via `registerLingualRoutes(r)` to keep the W833
// diff against router.js to a single import + a single call line
// (matches the W821/W832/W835 modular-mount convention).
//
// Routes:
//   GET  /v1/lingual/distribution?namespace=X
//        → distributionByLang() summary over the namespace
//   POST /v1/lingual/synthesize {target_lang, count, teacher, namespace?}
//        → synthesizeForUnderrepresented(); writes synthetic_translation
//          rows under the same namespace
//   POST /v1/lingual/mixture/auto-balance {namespace?, target_langs?, floor?}
//        → distributionByLang() + autoBalanceWeights() suggestion
//   GET  /v1/lingual/manifest/:artifact_id
//        → readPerLangKScores() over the requested artifact manifest
//
// Honesty contract (mirrors W774):
//   * Every route is auth-gated via req.tenant_record (401 on missing).
//   * W411 defense-in-depth — listEvents is re-filtered by tenant_id
//     server-side AND the lingual-* modules carry their own fence inside.
//   * Empty namespace / missing artifact → honest envelopes; never
//     fabricate a distribution / kscore from zero rows.
//
// Modular mount keeps merge conflicts off src/router.js when multiple
// wave agents land in parallel (W832 / W835 / W821 / W833).

import * as lingualDetect from './lingual-detect.js';
import * as lingualSynth from './lingual-synthesize.js';
import * as lingualMixture from './lingual-mixture.js';
import * as lingualManifest from './lingual-manifest.js';

export function registerLingualRoutes(app) {
  return mountLingualRoutes(app);
}

export function mountLingualRoutes(app) {
  // ---------------- GET /v1/lingual/distribution ----------------
  app.get('/v1/lingual/distribution', async (req, res) => {
    if (!req.tenant_record) {
      return res.status(401).json({ ok: false, error: 'auth_required' });
    }
    try {
      const es = await import('./event-store.js');
      const namespace = String((req.query && req.query.namespace) || 'default').slice(0, 128);
      const targetRatio = Number(req.query && req.query.target_ratio);

      let rows = [];
      try {
        rows = await es.listEvents({
          tenant_id: req.tenant_record.id,
          namespace,
          limit: 5000,
          order: 'desc',
        });
      } catch (_) { rows = []; }
      // W411 defense-in-depth — never trust a single fence.
      rows = (rows || []).filter((rr) => rr && rr.tenant_id === req.tenant_record.id);
      const captures = rows.map((rr) => ({
        cid: rr.event_id || rr.cid,
        input: rr.prompt_redacted || rr.prompt || rr.input || '',
        output: rr.response_redacted || rr.response || rr.output || '',
      }));

      const dist = lingualDetect.distributionByLang(captures, {
        target_ratio: Number.isFinite(targetRatio) ? targetRatio : undefined,
      });
      return res.status(200).json({
        ok: true,
        namespace,
        ...dist,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'lingual_distribution_error',
        detail: String((e && e.message) || e),
        version: lingualDetect.LINGUAL_DETECT_VERSION,
      });
    }
  });

  // ---------------- POST /v1/lingual/synthesize ----------------
  app.post('/v1/lingual/synthesize', async (req, res) => {
    if (!req.tenant_record) {
      return res.status(401).json({ ok: false, error: 'auth_required' });
    }
    try {
      const body = req.body || {};
      const namespace = String(body.namespace || 'default').slice(0, 128);
      const target_lang = typeof body.target_lang === 'string' ? body.target_lang : '';
      const count = Number.isFinite(Number(body.count))
        ? Math.max(1, Math.min(1000, Math.trunc(Number(body.count))))
        : 0;
      const teacher = typeof body.teacher === 'string' ? body.teacher : 'local';

      const es = await import('./event-store.js');
      const env = await lingualSynth.synthesizeForUnderrepresented({
        tenant: req.tenant_record.id,
        namespace,
        target_lang,
        count,
        teacher,
        opts: {
          storeMod: es,
          // Default: do NOT auto-write rows from the hosted route — the
          // synthetic rows go back in the response and the operator
          // explicitly POSTs them via /v1/capture/log if they want them
          // persisted. This avoids accidental teacher-spend on a typo.
          write: false,
        },
      });
      return res.status(200).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'lingual_synthesize_error',
        detail: String((e && e.message) || e),
        version: lingualSynth.LINGUAL_SYNTH_VERSION,
      });
    }
  });

  // ---------------- POST /v1/lingual/mixture/auto-balance ----------------
  app.post('/v1/lingual/mixture/auto-balance', async (req, res) => {
    if (!req.tenant_record) {
      return res.status(401).json({ ok: false, error: 'auth_required' });
    }
    try {
      const body = req.body || {};
      const namespace = String(body.namespace || 'default').slice(0, 128);
      const floor = Number.isFinite(Number(body.floor)) ? Number(body.floor) : undefined;
      const target_langs = (Array.isArray(body.target_langs) && body.target_langs.length > 0)
        ? body.target_langs.slice(0, 40)
        : undefined;

      const es = await import('./event-store.js');
      let rows = [];
      try {
        rows = await es.listEvents({
          tenant_id: req.tenant_record.id,
          namespace,
          limit: 5000,
          order: 'desc',
        });
      } catch (_) { rows = []; }
      rows = (rows || []).filter((rr) => rr && rr.tenant_id === req.tenant_record.id);
      const captures = rows.map((rr) => ({
        cid: rr.event_id || rr.cid,
        input: rr.prompt_redacted || rr.prompt || rr.input || '',
        output: rr.response_redacted || rr.response || rr.output || '',
      }));

      const dist = lingualDetect.distributionByLang(captures, {});
      const bal = lingualMixture.autoBalanceWeights(dist, {
        floor,
        target_langs,
      });
      return res.status(200).json({
        ok: true,
        namespace,
        distribution: dist,
        suggested: bal,
        version: lingualMixture.LINGUAL_MIXTURE_VERSION,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'lingual_auto_balance_error',
        detail: String((e && e.message) || e),
        version: lingualMixture.LINGUAL_MIXTURE_VERSION,
      });
    }
  });

  // ---------------- GET /v1/lingual/manifest/:artifact_id ----------------
  // Reads the per-language K-Score block off an artifact's manifest.
  // Looks up the manifest via src/artifact.js (or registry.js) when
  // available; falls back to an honest "no_manifest_found" envelope when
  // the artifact isn't registered.
  app.get('/v1/lingual/manifest/:artifact_id', async (req, res) => {
    if (!req.tenant_record) {
      return res.status(401).json({ ok: false, error: 'auth_required' });
    }
    try {
      const artifact_id = String((req.params && req.params.artifact_id) || '').slice(0, 256);
      if (!artifact_id) {
        return res.status(400).json({
          ok: false,
          error: 'artifact_id_required',
          version: lingualManifest.LINGUAL_MANIFEST_VERSION,
        });
      }

      // Try the registry first — production wires artifact metadata
      // through registry.findByCid / registry.lookup.
      let manifest = null;
      try {
        const registry = await import('./registry.js');
        if (registry && typeof registry.findArtifact === 'function') {
          const r = await registry.findArtifact({
            tenant_id: req.tenant_record.id,
            artifact_id,
          });
          if (r && r.manifest) manifest = r.manifest;
        } else if (registry && typeof registry.lookup === 'function') {
          const r = await registry.lookup(artifact_id);
          if (r && r.manifest) manifest = r.manifest;
        }
      } catch (_) { /* fall through to honest envelope */ }

      if (!manifest) {
        return res.status(404).json({
          ok: false,
          error: 'no_manifest_found',
          artifact_id,
          hint: 'no manifest registered for this artifact_id under your tenant',
          version: lingualManifest.LINGUAL_MANIFEST_VERSION,
        });
      }

      const env = lingualManifest.readPerLangKScores(manifest);
      return res.status(200).json({
        artifact_id,
        ...env,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'lingual_manifest_error',
        detail: String((e && e.message) || e),
        version: lingualManifest.LINGUAL_MANIFEST_VERSION,
      });
    }
  });
}

export default {
  registerLingualRoutes,
  mountLingualRoutes,
};
