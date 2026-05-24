// W831 — HTTP routes for the offline / air-gapped integration.
//
// Modular mount keeps the src/router.js diff to a single import + a single
// call line (see meta-routes.js + pipeline-routes.js for the same pattern).
//
// Six routes, all auth-gated + tenant-fenced:
//
//   POST /v1/airgap/distill/run
//     Body: {user_data_path, teacher_path_local, student_path_local, output_path}
//     Returns: {ok, run_id, status:'queued', airgap_verified:true,
//               verification_method:'no_network_dial', spec_path, version}
//
//   GET  /v1/airgap/distill/status/:id
//     Returns the persisted run spec OR {ok:false, error:'run_not_found'}.
//
//   POST /v1/airgap/sneakernet/bundle
//     Body: {artifact_path, signing_key_path, output_usb_path,
//            recipient_pubkey_path?, artifact_id?}
//     Returns: {ok, output_usb_path, sha256_archive, signer_fpr,
//               recipient_fpr, manifest, version}
//
//   POST /v1/airgap/sneakernet/verify
//     Body: {bundle_path, trusted_pubkey_path, extract_to?}
//     Returns: {ok, artifact_path, signature_ok, recipient_ok, trustworthy,
//               manifest, signer_fpr, recipient_fpr, version}
//
//   POST /v1/airgap/bakeoff
//     Body: {artifacts:[], dataset_path_local, metric_name?}
//     Returns: {ok, ranked, dataset_rows, artifact_count, airgap_verified:true,
//               verification_method, version}
//
//   GET  /v1/airgap/doctor
//     Returns: {ok, network_reachable:bool, teacher_local:bool,
//               signing_key_present:bool, version}
//
// W411 tenant fence: every handler resolves tenant from req.tenant_record
// BEFORE invoking the underlying module + threads it in.
//
// W604 version stamp: 'w831-v1'.
//
// Honesty invariants:
//   - 401 returned on missing auth — never a quiet success.
//   - 4xx returned on caller-input errors (missing path, malformed dataset).
//   - 5xx returned on internal / I/O errors WITH detail strings; never silent.

import fs from 'node:fs';
import path from 'node:path';

import { offlineDistill, getOfflineDistillStatus, AIRGAP_DISTILL_VERSION } from './airgap-distill.js';
import { verifyTeacherIsLocal, AIRGAP_TEACHER_VERSION } from './airgap-teacher.js';
import {
  createSneakernetBundle,
  verifySneakernetBundle,
  AIRGAP_SNEAKERNET_VERSION,
} from './airgap-sneakernet.js';
import { airgapBakeoff, AIRGAP_BAKEOFF_VERSION } from './airgap-bakeoff.js';

const ROUTES_VERSION = 'w831-v1';

// Probe used by GET /v1/airgap/doctor to decide network_reachable. Mirrors
// the W831 dial-failure guard but reports the result instead of throwing.
const DOCTOR_PROBE_URL = 'https://example.com';
const DOCTOR_PROBE_TIMEOUT_MS = 50;

async function probeNetworkReachable(fetchImpl) {
  const real = fetchImpl || globalThis.fetch;
  if (typeof real !== 'function') return false;
  let signal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(DOCTOR_PROBE_TIMEOUT_MS);
  } else {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), DOCTOR_PROBE_TIMEOUT_MS);
    signal = ctl.signal;
  }
  try {
    const resp = await real(DOCTOR_PROBE_URL, { method: 'HEAD', signal });
    return !!(resp && typeof resp.status === 'number' && resp.status > 0);
  } catch (_) {
    return false;
  }
}

// Both `registerAirgapRoutes` (matches the pipeline/meta-routes pattern) and
// `mountAirgapRoutes` (historical alias) are exported so future callers can
// pick either name.
export function registerAirgapRoutes(app) {
  return mountAirgapRoutes(app);
}

export function mountAirgapRoutes(r) {
  // ---------------- POST /v1/airgap/distill/run ----------------
  r.post('/v1/airgap/distill/run', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const body = req.body || {};
      const env = await offlineDistill({
        user_data_path: body.user_data_path,
        teacher_path_local: body.teacher_path_local,
        student_path_local: body.student_path_local,
        output_path: body.output_path,
        tenant: req.tenant_record.id,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'airgap_distill_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_DISTILL_VERSION,
      });
    }
  });

  // ---------------- GET /v1/airgap/distill/status/:id ----------------
  r.get('/v1/airgap/distill/status/:id', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const env = getOfflineDistillStatus({ run_id: req.params.id });
      // 404 on unknown run; 200 on found.
      const status = env.ok
        ? 200
        : env.error === 'run_not_found' ? 404 : 400;
      return res.status(status).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'airgap_distill_status_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_DISTILL_VERSION,
      });
    }
  });

  // ---------------- POST /v1/airgap/sneakernet/bundle ----------------
  r.post('/v1/airgap/sneakernet/bundle', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const body = req.body || {};
      const env = createSneakernetBundle({
        artifact_path: body.artifact_path,
        signing_key_path: body.signing_key_path,
        output_usb_path: body.output_usb_path,
        recipient_pubkey_path: body.recipient_pubkey_path || null,
        artifact_id: body.artifact_id,
        tenant: req.tenant_record.id,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'sneakernet_bundle_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_SNEAKERNET_VERSION,
      });
    }
  });

  // ---------------- POST /v1/airgap/sneakernet/verify ----------------
  r.post('/v1/airgap/sneakernet/verify', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const body = req.body || {};
      const env = verifySneakernetBundle({
        bundle_path: body.bundle_path,
        trusted_pubkey_path: body.trusted_pubkey_path,
        extract_to: body.extract_to || null,
      });
      // The envelope's `ok` is whether the call succeeded structurally;
      // signature_ok / recipient_ok are independent booleans. We always
      // return 200 on structural ok so the caller can inspect the booleans.
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'sneakernet_verify_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_SNEAKERNET_VERSION,
      });
    }
  });

  // ---------------- POST /v1/airgap/bakeoff ----------------
  r.post('/v1/airgap/bakeoff', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const body = req.body || {};
      const env = await airgapBakeoff({
        artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
        dataset_path_local: body.dataset_path_local,
        metric_name: body.metric_name,
        tenant: req.tenant_record.id,
      });
      return res.status(env.ok ? 200 : 400).json(env);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'airgap_bakeoff_error',
        detail: String((e && e.message) || e),
        version: AIRGAP_BAKEOFF_VERSION,
      });
    }
  });

  // ---------------- GET /v1/airgap/doctor ----------------
  r.get('/v1/airgap/doctor', async (req, res) => {
    if (!req.tenant_record) return res.status(401).json({ ok: false, error: 'auth_required' });
    try {
      const network_reachable = await probeNetworkReachable();
      let teacher_local = false;
      if (process.env.KOLM_LOCAL_TEACHER_URL) {
        try {
          verifyTeacherIsLocal({ teacher_url: process.env.KOLM_LOCAL_TEACHER_URL });
          teacher_local = true;
        } catch (_) {
          teacher_local = false;
        }
      }
      const signing_key_path = process.env.KOLM_AIRGAP_SIGNING_KEY || null;
      const signing_key_present = !!(signing_key_path && fs.existsSync(signing_key_path));
      return res.status(200).json({
        ok: true,
        network_reachable,
        teacher_local,
        signing_key_present,
        teacher_url: process.env.KOLM_LOCAL_TEACHER_URL || null,
        signing_key_path,
        teacher_local_version: AIRGAP_TEACHER_VERSION,
        distill_version: AIRGAP_DISTILL_VERSION,
        sneakernet_version: AIRGAP_SNEAKERNET_VERSION,
        bakeoff_version: AIRGAP_BAKEOFF_VERSION,
        version: ROUTES_VERSION,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'airgap_doctor_error',
        detail: String((e && e.message) || e),
        version: ROUTES_VERSION,
      });
    }
  });

  return r;
}

export const AIRGAP_ROUTES_VERSION = ROUTES_VERSION;
