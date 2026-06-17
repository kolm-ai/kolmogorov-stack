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
import { getListing, _digestPath } from './marketplace-w825.js';
import { appendEvent } from './event-store.js';

export const MARKETPLACE_FINETUNE_VERSION = 'w650-marketplace-finetune-v2';

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
  const k_target = _clamp(Number.isFinite(Number(opts.k_target)) ? Number(opts.k_target) : 0.85, 0, 1);
  const max_steps = _clamp(
    Number.isFinite(Number(opts.max_steps)) ? Math.trunc(Number(opts.max_steps)) : 500,
    1,
    100000,
  );

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
  // directory under a stable filename. This is the base model for a later
  // worker, so it must fail closed: remote/missing/tampered listings are not
  // queueable fine-tune bases.
  const artifactUri = String(listing.artifact_uri || '').trim();
  if (!artifactUri || !_isLocalPath(artifactUri)) {
    return {
      ok: false,
      error: 'artifact_uri_unavailable_for_finetune',
      reason: !artifactUri ? 'artifact_uri_missing' : 'artifact_uri_remote',
      artifact_id,
      artifact_uri: artifactUri || null,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }
  const sourcePath = path.resolve(artifactUri);
  if (!fs.existsSync(sourcePath)) {
    return {
      ok: false,
      error: 'artifact_uri_missing_on_disk',
      artifact_id,
      artifact_uri: artifactUri,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }
  let sourceStat = null;
  try { sourceStat = fs.statSync(sourcePath); } catch (_e) { sourceStat = null; }
  if (!sourceStat || !sourceStat.isFile()) {
    return {
      ok: false,
      error: 'artifact_uri_not_file',
      artifact_id,
      artifact_uri: artifactUri,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }
  const actualSha256 = _digestPath(sourcePath);
  const expectedSha256 = String(listing.manifest_sha256 || '').trim().toLowerCase();
  if (!actualSha256) {
    return {
      ok: false,
      error: 'artifact_sha256_unreadable',
      artifact_id,
      artifact_uri: artifactUri,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }
  if (expectedSha256 && actualSha256.toLowerCase() !== expectedSha256) {
    return {
      ok: false,
      error: 'artifact_sha256_mismatch',
      artifact_id,
      expected_sha256: expectedSha256,
      actual_sha256: actualSha256,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  const destDir = _artifactsDir();
  const destPath = path.join(destDir, _artifactFilename(artifact_id));
  const resolvedDestDir = path.resolve(destDir);
  const resolvedDestPath = path.resolve(destPath);
  if (!_pathWithinDir(resolvedDestPath, resolvedDestDir)) {
    return {
      ok: false,
      error: 'artifact_destination_escape',
      artifact_id,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }
  let copied_to = null;
  let copied_sha256 = null;
  const tmpPath = path.join(destDir, `.kolm-finetune-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.copyFileSync(sourcePath, tmpPath);
    copied_sha256 = _digestPath(tmpPath);
    if (copied_sha256 !== actualSha256) {
      try { fs.rmSync(tmpPath, { force: true }); } catch (_e) { /* best-effort */ }
      return {
        ok: false,
        error: 'artifact_copy_sha256_mismatch',
        artifact_id,
        expected_sha256: actualSha256,
        actual_sha256: copied_sha256,
        version: MARKETPLACE_FINETUNE_VERSION,
      };
    }
    fs.renameSync(tmpPath, destPath);
    copied_to = destPath;
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_e) { /* best-effort */ }
    return {
      ok: false,
      error: 'artifact_copy_failed',
      detail: String(e && e.message || e),
      artifact_id,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  const copiedStat = fs.statSync(copied_to);
  const copied_bytes = copiedStat.size;

  if (copied_sha256 !== expectedSha256 && expectedSha256) {
    try { fs.rmSync(copied_to, { force: true }); } catch (_e) { /* best-effort */ }
    return {
      ok: false,
      error: 'copied_artifact_sha256_mismatch',
      artifact_id,
      expected_sha256: expectedSha256,
      actual_sha256: copied_sha256,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  if (!copied_to) {
    return {
      ok: false,
      error: 'artifact_copy_missing',
      artifact_id,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  // Step 2: queue the distill run. We do NOT spawn the full distill worker
  // here - we persist a queued row that the worker can pick up.
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
        base_artifact_sha256: copied_sha256,
        base_artifact_bytes: copied_bytes,
        listing_manifest_sha256: listing.manifest_sha256 || null,
        publisher_tenant_id: listing.publisher_tenant_id || null,
        listing_paid: !!listing.paid,
        listing_price_micro_usd: Math.max(0, Math.trunc(Number(listing.price_micro_usd) || 0)),
        captures_namespace,
        k_target,
        max_steps,
        queued_at: new Date().toISOString(),
        version: MARKETPLACE_FINETUNE_VERSION,
      }),
    });
  } catch (e) {
    try { fs.rmSync(copied_to, { force: true }); } catch (_rmErr) { /* best-effort */ }
    return {
      ok: false,
      error: 'queue_write_failed',
      detail: String(e && e.message || e),
      artifact_id,
      version: MARKETPLACE_FINETUNE_VERSION,
    };
  }

  return {
    ok: true,
    run_id,
    base_artifact_id: artifact_id,
    status: 'queued',
    copied_to,
    base_artifact_sha256: copied_sha256,
    base_artifact_bytes: copied_bytes,
    listing_manifest_sha256: listing.manifest_sha256 || null,
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

function _clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function _artifactFilename(artifactId) {
  const raw = String(artifactId || '').trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(raw) && !raw.includes('..')) return `${raw}.kolm`;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'artifact';
  const suffix = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${safe}-${suffix}.kolm`;
}

function _pathWithinDir(candidate, dir) {
  const rel = path.relative(dir, candidate);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
