// src/lingual-routes-gated.js
//
// HTTP mount for the sensitive-data-aware GATED synthesis pipeline
// (src/synthesize-gated.js). Kept in a SEPARATE module from lingual-routes.js
// so the diff stays disjoint and the existing /v1/lingual/synthesize route is
// untouched (that legacy route is redirected through the gate in a later
// sequenced step; this one is the net-new, privacy-gated surface).
//
// Route: POST /v1/lingual/synthesize/gated
//   - auth-gated via req.tenant_record (401 on missing tenant)
//   - returns the tenant-fenced gated-synthesis envelope
//   - sensitive corpus + hosted teacher + no local generator -> 422 fail-closed
//     (the never-to-hyperscaler boundary), NOT a hosted fallback.
//
// The mount itself is ENV-GATED at the router call site (registerGatedLingualSynthRoute)
// so it never changes existing route behavior unless KOLM_GATED_SYNTH=1 (or the
// operator opts in). The handler is real; the gate only controls exposure.

import { gatedSynthesize, SYNTHESIZE_GATED_VERSION } from './synthesize-gated.js';

export function registerGatedLingualSynthRoute(app) {
  if (!app || typeof app.post !== 'function') return;

  app.post('/v1/lingual/synthesize/gated', async (req, res) => {
    if (!req.tenant_record) {
      return res.status(401).json({
        ok: false,
        error: 'auth_required',
        version: SYNTHESIZE_GATED_VERSION,
      });
    }
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const env = await gatedSynthesize({
        tenant: req.tenant_record.id,
        namespace: body.namespace,
        target_lang: body.target_lang,
        count: body.count,
        teacher: body.teacher,
        slug: body.slug,
        seeds: body.seeds,
        opts: {
          source_captures: body.source_captures,
          maxScan: body.maxScan,
          allowSampledClean: body.allowSampledClean,
          localRedactMode: body.localRedactMode,
          localTransport: body.localTransport,
          model: body.model,
          // write defaults OFF on the HTTP surface: synthesis preview must not
          // persist. Callers explicitly opt in with body.write === true.
          write: body.write === true,
        },
      });

      if (env && env.ok === false) {
        // Map the load-bearing fail-closed boundary to 422 so clients can
        // distinguish "you must configure a local generator" from a 400 shape
        // error or a 500.
        if (env.error === 'sensitive_corpus_requires_local_generator'
            || env.error === 'local_synthesis_failed') {
          return res.status(422).json(env);
        }
        return res.status(400).json(env);
      }
      return res.status(200).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'gated_synthesis_error',
        detail: String((e && e.message) || e),
        version: SYNTHESIZE_GATED_VERSION,
      });
    }
  });
}

export default { registerGatedLingualSynthRoute };
