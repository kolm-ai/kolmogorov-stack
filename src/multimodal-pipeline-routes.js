// src/multimodal-pipeline-routes.js
//
// W829 — Multimodal capture pipeline HTTP routes.
//
// Mounts as a single one-line call from src/router.js to keep the diff
// minimal (parallel agents are editing router.js in other waves; every
// extra line touched is a potential merge conflict).
//
// Routes (all auth-required, tenant-scoped via req.tenant_record.id):
//
//   POST /v1/captures/multimodal       — record one image/audio/tool-use row
//   POST /v1/captures/multi-turn       — append one multi-turn conversation row
//   POST /v1/vlm-distill/run           — enqueue a VLM distillation job
//   GET  /v1/vlm-distill/runs          — list jobs for the calling tenant
//
// Honesty contract:
//   - Every route returns an honest envelope. The W829-3 vlmDistillRun
//     surface returns ok:true + real_run:false + missing_env when the
//     teacher API key is absent — never silently "succeeds."
//   - Tenant fence is enforced from req.tenant_record.id; never read from
//     the request body.

import {
  recordMultimodalCapture,
  recordMultiTurnCapture,
  hashPayload,
  W829_VERSION,
  MULTIMODAL_KINDS,
} from './captures.js';

import {
  vlmDistillRun,
  vlmDistillList,
  VLM_DISTILL_VERSION,
  SUPPORTED_TEACHERS,
} from './vlm-distill.js';

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
      version: W829_VERSION,
    });
    return null;
  }
  return trec;
}

export function registerMultimodalPipelineRoutes(app) {
  // POST /v1/captures/multimodal — image / audio / tool_use / multi_turn row.
  //
  // Body shape:
  //   { namespace, kind, payload, hash?, redaction_receipt? }
  // If hash is omitted we compute one from the canonical payload so the
  // caller can be lazy. kind MUST be in MULTIMODAL_KINDS.
  app.post('/v1/captures/multimodal', async (req, res) => {
    const trec = _authOrReject(req, res); if (!trec) return;
    const body = req.body || {};
    try {
      const hash = body.hash || hashPayload(body.payload || {});
      const env = recordMultimodalCapture({
        tenant: trec.id,
        namespace: body.namespace,
        kind: body.kind,
        payload: body.payload || {},
        hash,
        redaction_receipt: body.redaction_receipt || null,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'multimodal_capture_error',
        detail: String((e && e.message) || e),
        version: W829_VERSION,
      });
    }
  });

  // POST /v1/captures/multi-turn — append a multi-turn conversation row.
  //
  // Body shape:
  //   { namespace, conversation_id, conversation:[{role,content,tool_calls?,timestamp}], parent_message_id? }
  app.post('/v1/captures/multi-turn', async (req, res) => {
    const trec = _authOrReject(req, res); if (!trec) return;
    const body = req.body || {};
    try {
      const env = recordMultiTurnCapture({
        tenant: trec.id,
        namespace: body.namespace,
        conversation: body.conversation,
        conversation_id: body.conversation_id,
        parent_message_id: body.parent_message_id || null,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'multi_turn_capture_error',
        detail: String((e && e.message) || e),
        version: W829_VERSION,
      });
    }
  });

  // POST /v1/vlm-distill/run — enqueue a VLM distillation job.
  //
  // Body shape:
  //   { teacher, student_model, dataset_captures } — see src/vlm-distill.js
  // When KOLM_VLM_TEACHER_API_KEY is unset the response envelope still has
  // ok:true (because the job was enqueued honestly) but real_run:false +
  // missing_env:'KOLM_VLM_TEACHER_API_KEY' so the caller knows nothing was
  // actually trained.
  app.post('/v1/vlm-distill/run', async (req, res) => {
    const trec = _authOrReject(req, res); if (!trec) return;
    const body = req.body || {};
    try {
      const env = vlmDistillRun({
        teacher: body.teacher,
        student_model: body.student_model,
        dataset_captures: body.dataset_captures,
        tenant: trec.id,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'vlm_distill_run_error',
        detail: String((e && e.message) || e),
        version: VLM_DISTILL_VERSION,
      });
    }
  });

  // GET /v1/vlm-distill/runs — list jobs for the calling tenant.
  app.get('/v1/vlm-distill/runs', async (req, res) => {
    const trec = _authOrReject(req, res); if (!trec) return;
    try {
      const env = vlmDistillList({ tenant: trec.id });
      // List endpoint is also informational: when no jobs exist the
      // envelope is { ok:true, runs:[] } NOT a 404.
      return res.status(200).json({
        ...env,
        supported_teachers: SUPPORTED_TEACHERS,
        supported_kinds: MULTIMODAL_KINDS,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'vlm_distill_list_error',
        detail: String((e && e.message) || e),
        version: VLM_DISTILL_VERSION,
      });
    }
  });
}
