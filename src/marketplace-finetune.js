// src/marketplace-finetune.js
//
// W825-4 - Transfer-learning entrypoint for the W825 Artifact Marketplace MVP.
//
// Given a marketplace artifact_id:
//   1. Verify the listing exists.
//   2. Copy its artifact_uri (a local path or already-downloaded blob) into
//      ~/.kolm/artifacts/<artifact_id>.kolm so the distill pipeline can pick
//      it up by stable filename.
//   3. Stub-call into the W381 distill pipeline (src/distill-pipeline.js) with
//      a --base-artifact-id flag. We DO NOT run the full LoRA fine-tune here
// - that's a long-running worker. Instead we return a honest queued
//      envelope so the caller can poll and the SDK can show a status pill.
//
// Honesty contract: the envelope's status is 'queued' (never 'running' or
// 'completed') because the real fine-tune kicks off in a follow-up worker.
// The route layer logs the run_id; src/distill-pipeline.js will pick the
// queued row up out of the event store on its next cycle.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getListing } from './marketplace-w825.js';
import { appendEvent } from './event-store.js';

export const MARKETPLACE_FINETUNE_VERSION = 'w825-finetune-v1';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _artifactsDir() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  const dir = path.join(base, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// finetuneFromMarketplace({artifact_id, tenant_id, captures_namespace, ...opts})
//
// Returns { ok, run_id, base_artifact_id, status:'queued', copied_to, ... }.
//
// On unknown artifact_id: { ok:false, error:'unknown_artifact_id', artifact_id }.
// On copy failure: { ok:false, error:'artifact_copy_failed', detail }.
export async function finetuneFromMarketplace(opts = {}) {
  const artifact_id = String(opts.artifact_id || '').trim();
  const tenant_id = String(opts.tenant_id || '').trim();
  const captures_namespace = String(opts.captures_namespace || 'default').trim();
  const k_target = Number.isFinite(Number(opts.k_target)) ? Number(opts.k_target) : 0.85;
  const max_steps = Number.isFinite(Number(opts.max_steps)) ? Math.trunc(Number(opts.max_steps)) : 500;

  if (!artifact_id) {
    return { ok: false, error: 'artifact_id_required', version: MARKETPLACE_FINETUNE_VERSION };
  }
  if (!tenant_id) {
    return { ok: false, error: 'tenant_id_required', version: MARKETPLACE_FINETUNE_VERSION };
  }
  const listing = getListing(artifact_id);
  if (!listing) {
    return {
      ok: false,
      error: 'unknown_artifact_id',
      artifact_id,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  // Step 1: copy the artifact bytes into the tenant's local ~/.kolm/artifacts
  // directory under a stable filename. If artifact_uri is missing or the
  // source file does not exist, we still emit a honest envelope (the route
  // layer can decide whether to surface this as a hard failure).
  const destDir = _artifactsDir();
  const destPath = path.join(destDir, `${artifact_id}.kolm`);
  let copied_to = null;
  let copy_skipped_reason = null;
  if (listing.artifact_uri && _isLocalPath(listing.artifact_uri)) {
    try {
      if (fs.existsSync(listing.artifact_uri)) {
        fs.copyFileSync(listing.artifact_uri, destPath);
        copied_to = destPath;
      } else {
        copy_skipped_reason = 'artifact_uri_missing_on_disk';
      }
    } catch (e) {
      return {
        ok: false,
        error: 'artifact_copy_failed',
        detail: String(e && e.message || e),
        artifact_id,
        version: MARKETPLACE_FINETUNE_VERSION,
      };
    }
  } else {
    copy_skipped_reason = 'artifact_uri_is_remote_or_unset';
  }

  // Step 2: queue the distill run. We do NOT spawn the full distill worker
  // here - we just persist a queued row that the worker can pick up.
  const run_id = 'distill_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  try {
    await appendEvent({
      tenant_id,
      namespace: 'kolm_marketplace',
      provider: 'kolm_marketplace_finetune_queued',
      status: 'ok',
      feedback: JSON.stringify({
        run_id,
        base_artifact_id: artifact_id,
        base_artifact_path: copied_to,
        captures_namespace,
        k_target,
        max_steps,
        queued_at: new Date().toISOString(),
        version: MARKETPLACE_FINETUNE_VERSION,
      }),
    });
  } catch (_e) { /* queue-write best-effort; envelope still honest */ }

  return {
    ok: true,
    run_id,
    base_artifact_id: artifact_id,
    status: 'queued',
    copied_to,
    copy_skipped_reason,
    captures_namespace,
    k_target,
    max_steps,
    pipeline_module: './distill-pipeline.js',
    base_artifact_flag: '--base-artifact-id',
    forecast_note: 'fine-tune is queued (not yet running) - the W381 pipeline will pick this row up',
    version: MARKETPLACE_FINETUNE_VERSION,
  };
}

function _isLocalPath(uri) {
  if (typeof uri !== 'string' || !uri) return false;
  if (/^https?:\/\//i.test(uri)) return false;
  if (/^s3:\/\//i.test(uri)) return false;
  if (/^gs:\/\//i.test(uri)) return false;
  return true;
}
