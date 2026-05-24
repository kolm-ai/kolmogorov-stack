// W821 [T2] — HTTP routes for the pipeline orchestrator.
//
// We export a SINGLE registerPipelineRoutes(router, deps) function that bolts
// the W821 endpoints onto an existing express.Router(). This module-side
// pattern keeps the diff to src/router.js to a single line so parallel wave
// agents editing router.js (WC14 + WC07) don't trip on a merge conflict.
//
// deps: optional dependency-injection hook for tests. Recognised keys:
//   authMiddleware  - if absent, registerPipelineRoutes falls back to a
//                     no-op middleware (test mode) BUT writes a clear hint
//                     into req.tenant_record so the orchestrator still has a
//                     tenant scope. Production callers wire the real
//                     authMiddleware from src/auth.js (see router.js).
//   runtime         - object with `runArtifact(path, input)` for orchestrate().
//                     If absent, the run endpoint returns honest
//                     `runtime_unavailable` envelopes.
//
// Routes:
//   GET    /v1/pipelines               list (tenant-scoped)
//   POST   /v1/pipelines               create
//   GET    /v1/pipelines/:id           show
//   DELETE /v1/pipelines/:id           delete
//   POST   /v1/pipelines/:id/run       orchestrate
//   GET    /v1/pipelines/:id/kscore    weighted K-Score
//
// All routes are tenant-scoped: writes set tenant_id from req.tenant_record.id
// and reads filter the same way. Without an auth middleware, tenant_id falls
// through as the literal string 'anonymous' so local-daemon callers still
// work but the tenant fence is structurally present.

import {
  PIPELINE_ORCHESTRATOR_VERSION,
  PIPELINE_STATES,
  parsePipelineYaml,
  validatePipeline,
  orchestrate,
  computePipelineKScore,
  listPipelines,
  getPipeline,
  createPipeline,
  deletePipeline,
  recordPipelineRun,
} from './pipeline-orchestrator.js';

// Fallback runtime: returns honest "no runtime wired" envelopes so the run
// endpoint exists + responds with a sensible error rather than crashing.
const _fallbackRuntime = {
  runArtifact: async (artifactPath /* , input */) => ({
    ok: false,
    error: 'runtime_unavailable',
    hint: 'pass {runtime} to registerPipelineRoutes to enable artifact execution',
    artifact_path: artifactPath,
  }),
};

function _tenantId(req) {
  if (req && req.tenant_record && req.tenant_record.id) return req.tenant_record.id;
  if (req && req.tenant_id) return req.tenant_id;
  return 'anonymous';
}

// derive_route_frequencies — walks the event-store for kind='pipeline_run'
// events under this pipeline_id + tenant, returns {intent_or_default: count}.
// Used by the /kscore endpoint. Dynamic import so the routes load in
// environments without event-store (we just return {} -> no_eval_data).
async function _routeFrequencies(pipeline_id, tenant_id) {
  try {
    const { listEvents } = await import('./event-store.js');
    const events = await listEvents({
      tenant_id,
      workflow_id: pipeline_id,
      limit: 5000,
    });
    const out = {};
    for (const e of events || []) {
      const extra = (e && e.json_extra) ? e.json_extra : (e && e.kind ? e : null);
      if (!extra || extra.kind !== 'pipeline_run') continue;
      const key = extra.intent || (extra.route_index != null ? `route_${extra.route_index}` : 'default');
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  } catch {
    return {};
  }
}

export function registerPipelineRoutes(router, deps = {}) {
  if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
    throw new Error('registerPipelineRoutes: router with .get/.post/.delete required');
  }
  const auth = (typeof deps.authMiddleware === 'function')
    ? deps.authMiddleware
    : (req, _res, next) => { next(); }; // test-mode no-op; tenant resolves to 'anonymous'
  const runtime = deps.runtime || _fallbackRuntime;

  // ── GET /v1/pipelines ──────────────────────────────────────────────────────
  router.get('/v1/pipelines', auth, (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const rows = listPipelines({ tenant_id });
      return res.json({
        ok: true,
        version: PIPELINE_ORCHESTRATOR_VERSION,
        tenant_id,
        count: rows.length,
        pipelines: rows,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipelines_list_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });

  // ── POST /v1/pipelines ─────────────────────────────────────────────────────
  // Body: { name: string, yaml: string }
  router.post('/v1/pipelines', auth, (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const body = req.body || {};
      const result = createPipeline({
        name: body.name,
        yaml: body.yaml,
        tenant_id,
      });
      if (!result.ok) {
        return res.status(400).json({
          ...result,
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      return res.status(201).json({
        ok: true,
        version: PIPELINE_ORCHESTRATOR_VERSION,
        pipeline: result,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipeline_create_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });

  // ── GET /v1/pipelines/:id ──────────────────────────────────────────────────
  router.get('/v1/pipelines/:id', auth, (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const id = req.params.id;
      const row = getPipeline(id, { tenant_id });
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: 'pipeline_not_found',
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      return res.json({
        ok: true,
        version: PIPELINE_ORCHESTRATOR_VERSION,
        pipeline: row,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipeline_show_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });

  // ── DELETE /v1/pipelines/:id ───────────────────────────────────────────────
  router.delete('/v1/pipelines/:id', auth, (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const id = req.params.id;
      const result = deletePipeline(id, { tenant_id });
      if (!result.ok) {
        return res.status(404).json({
          ...result,
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      return res.json({
        ok: true,
        deleted_id: id,
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipeline_delete_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });

  // ── POST /v1/pipelines/:id/run ─────────────────────────────────────────────
  // Body: { input: any }
  router.post('/v1/pipelines/:id/run', auth, async (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const id = req.params.id;
      const row = getPipeline(id, { tenant_id });
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: 'pipeline_not_found',
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      if (row.parse_error) {
        return res.status(400).json({
          ok: false,
          error: 'pipeline_parse_error',
          detail: row.parse_error,
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      const body = req.body || {};
      const result = await orchestrate({
        pipeline: row.parsed,
        input: body.input,
        runtime,
      });
      // Best-effort run-history persistence (don't crash a run on append failure).
      try {
        await recordPipelineRun({
          pipeline_id: id,
          tenant_id,
          namespace: 'pipeline_runs',
          result,
        });
      } catch {}
      const status = result.ok ? 200 : (result.state === PIPELINE_STATES.PARTIAL ? 207 : 400);
      return res.status(status).json({
        ok: result.ok,
        version: PIPELINE_ORCHESTRATOR_VERSION,
        pipeline_id: id,
        result,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipeline_run_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });

  // ── GET /v1/pipelines/:id/kscore ───────────────────────────────────────────
  router.get('/v1/pipelines/:id/kscore', auth, async (req, res) => {
    try {
      const tenant_id = _tenantId(req);
      const id = req.params.id;
      const row = getPipeline(id, { tenant_id });
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: 'pipeline_not_found',
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      if (row.parse_error || !row.parsed) {
        return res.status(400).json({
          ok: false,
          error: 'pipeline_parse_error',
          detail: row.parse_error || 'parsed pipeline unavailable',
          version: PIPELINE_ORCHESTRATOR_VERSION,
        });
      }
      const route_frequencies = await _routeFrequencies(id, tenant_id);
      // eval_set is supplied via ?eval_set=<base64-json> (small) or pulled
      // from an eval-set store in a future wave. For now, accept the query-
      // string form so the UI can demo without a separate eval persister.
      let eval_set = {};
      const raw = req.query && req.query.eval_set;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          if (parsed && typeof parsed === 'object') eval_set = parsed;
        } catch {
          // honest: bad eval_set query param -> 400.
          return res.status(400).json({
            ok: false,
            error: 'eval_set_query_invalid',
            hint: 'pass base64-encoded JSON: {intent:{k_score,n_eval}}',
            version: PIPELINE_ORCHESTRATOR_VERSION,
          });
        }
      }
      const result = computePipelineKScore({
        pipeline: row.parsed,
        eval_set,
        route_frequencies,
      });
      return res.json({
        ok: !!result.ok,
        version: PIPELINE_ORCHESTRATOR_VERSION,
        pipeline_id: id,
        kscore: result,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'pipeline_kscore_failed',
        detail: (e && e.message) || String(e),
        version: PIPELINE_ORCHESTRATOR_VERSION,
      });
    }
  });
}

export default { registerPipelineRoutes };
