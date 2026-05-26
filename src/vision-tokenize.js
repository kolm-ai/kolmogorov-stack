// src/vision-tokenize.js
//
// W771b -- Node shim for the isolated workers/vision-tokenize worker.
//
// Mirrors the W462 / W464 worker-shim pattern: this module is a thin
// I/O layer that spawns the worker and returns its W771b envelope.
// Tenant-scoped persistence (capture, billing, audit) is the CALLER's
// job (router.js) -- this module does pure I/O.
//
// HONESTY CONTRACT (load-bearing): when the worker reports
// {ok:false, error:'no_detector_installed'} we propagate that envelope
// verbatim with patch_token_count:null. We NEVER fabricate token counts
// or silently downgrade to a sentinel. This is the same invariant W462
// + W464 enforce on the multimodal cluster.
//
// Public surface:
//   VISION_TOKENIZE_VERSION
//   tokenizeImage({ path?, uri?, url?, image_base64?, model?, max_bytes? })
//   getVisionTokenizeDoctor()

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VISION_TOKENIZE_VERSION = 'w771b-v1';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const WORKER_PATH = path.resolve(ROOT, 'workers', 'vision-tokenize', 'tokenize.mjs');

const DEFAULT_MODEL = 'openai/clip-vit-large-patch14';
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const INSTALL_HINT_FALLBACK =
  'install python3 + transformers + torch + Pillow, OR set $KOLM_VISION_TOKENIZE_CMD to a binary that emits the W771b JSON envelope';

// =============================================================================
// tokenizeImage
// =============================================================================
//
// Resolve {path|uri|url|image_base64} into a worker invocation and return the
// canonical W771b envelope:
//
//   {
//     ok, kind:'vision', media_uri,
//     tokenizer, model,
//     patch_token_count, patch_token_dim, cls_token_present,
//     image_sha256, patches_sha256,
//     install_hint?,
//     version: 'w771b-v1',
//   }
//
// NEVER throws on malformed input -- always returns an ok:false envelope.

export async function tokenizeImage(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const model = (typeof o.model === 'string' && o.model.length > 0) ? o.model : DEFAULT_MODEL;
  const max_bytes = Number.isFinite(Number(o.max_bytes)) ? Number(o.max_bytes) : DEFAULT_MAX_BYTES;

  const hasPath  = (typeof o.path === 'string' && o.path.length > 0);
  const hasUri   = (typeof o.uri  === 'string' && o.uri.length  > 0);
  const hasUrl   = (typeof o.url  === 'string' && o.url.length  > 0);
  const hasB64   = (typeof o.image_base64 === 'string' && o.image_base64.length > 0);

  if (!hasPath && !hasUri && !hasUrl && !hasB64) {
    return _honestFailEnvelope({
      error: 'no_image_source',
      hint: 'pass one of {path, uri, url, image_base64}',
      model,
    });
  }

  // base64 -> write a temp file so the worker has a concrete path.
  let tempPath = null;
  let pathToUse = null;
  let uriToUse = null;
  let urlToUse = null;
  let mediaUri = null;

  try {
    if (hasPath) {
      pathToUse = o.path;
      mediaUri = o.path;
      if (!fs.existsSync(pathToUse)) {
        return _honestFailEnvelope({
          error: 'image_not_found',
          media_uri: mediaUri,
          model,
        });
      }
    } else if (hasUri) {
      uriToUse = o.uri;
      mediaUri = o.uri;
    } else if (hasUrl) {
      urlToUse = o.url;
      mediaUri = o.url;
    } else if (hasB64) {
      // Strip a leading data: URL prefix if present.
      let raw = o.image_base64;
      const m = raw.match(/^data:[^;]+;base64,(.+)$/);
      if (m) raw = m[1];
      let buf;
      try {
        buf = Buffer.from(raw, 'base64');
      } catch (_) {
        return _honestFailEnvelope({
          error: 'image_load_failed',
          detail: 'image_base64 not decodable',
          model,
        });
      }
      if (!buf || !buf.length) {
        return _honestFailEnvelope({
          error: 'image_load_failed',
          detail: 'empty base64 payload',
          model,
        });
      }
      if (buf.length > max_bytes) {
        return _honestFailEnvelope({
          error: 'oversize',
          got_bytes: buf.length,
          limit_bytes: max_bytes,
          model,
        });
      }
      tempPath = path.join(
        os.tmpdir(),
        'kolm-w771b-shim-' + crypto.randomBytes(6).toString('hex') + '.img'
      );
      try {
        fs.writeFileSync(tempPath, buf);
      } catch (e) {
        return _honestFailEnvelope({
          error: 'image_load_failed',
          detail: String(e && e.message || e),
          model,
        });
      }
      pathToUse = tempPath;
      mediaUri = 'image_base64:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    }

    if (!fs.existsSync(WORKER_PATH)) {
      return _honestFailEnvelope({
        error: 'worker_missing',
        detail: 'workers/vision-tokenize/tokenize.mjs not found at ' + WORKER_PATH,
        media_uri: mediaUri,
        model,
      });
    }

    const args = [WORKER_PATH];
    if (pathToUse) args.push('--path', pathToUse);
    if (uriToUse)  args.push('--uri',  uriToUse);
    if (urlToUse)  args.push('--url',  urlToUse);
    args.push('--model', model, '--max-bytes', String(max_bytes), '--json');

    let res;
    try {
      res = spawnSync(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env },
      });
    } catch (e) {
      return _honestFailEnvelope({
        error: 'tokenizer_spawn_failed',
        detail: String(e && e.message || e),
        media_uri: mediaUri,
        model,
      });
    }

    let inner = null;
    try {
      const tail = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
      inner = JSON.parse(tail);
    } catch (_) {
      inner = null;
    }

    if (!inner) {
      return _honestFailEnvelope({
        error: 'tokenizer_failed',
        detail: 'worker emitted no parseable envelope',
        exit_code: res.status,
        stderr: String(res.stderr || '').slice(0, 500),
        media_uri: mediaUri,
        model,
      });
    }

    // Stamp the version. Pass-through everything the worker reported.
    inner.version = VISION_TOKENIZE_VERSION;
    if (typeof inner.kind !== 'string') inner.kind = 'vision';
    return inner;
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch (_) {} // deliberate: cleanup
    }
  }
}

// =============================================================================
// getVisionTokenizeDoctor
// =============================================================================
//
// Returns the worker's --doctor envelope, with the W771b version stamped.

export async function getVisionTokenizeDoctor() {
  if (!fs.existsSync(WORKER_PATH)) {
    return {
      ok: false,
      spec: 'kolm-vision-tokenize-worker-doctor',
      version: VISION_TOKENIZE_VERSION,
      error: 'worker_missing',
      detail: 'workers/vision-tokenize/tokenize.mjs not found at ' + WORKER_PATH,
      install_hint: INSTALL_HINT_FALLBACK,
      ready: false,
      tokenizer: { ok: false, name: null, source: null, install_hint: INSTALL_HINT_FALLBACK },
    };
  }
  let res;
  try {
    res = spawnSync(process.execPath, [WORKER_PATH, '--doctor'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    return {
      ok: false,
      spec: 'kolm-vision-tokenize-worker-doctor',
      version: VISION_TOKENIZE_VERSION,
      error: 'doctor_spawn_failed',
      detail: String(e && e.message || e),
      install_hint: INSTALL_HINT_FALLBACK,
      ready: false,
    };
  }
  let env = null;
  try {
    env = JSON.parse(String(res.stdout || '').trim());
  } catch (_) {
    env = null;
  }
  if (!env) {
    return {
      ok: false,
      spec: 'kolm-vision-tokenize-worker-doctor',
      version: VISION_TOKENIZE_VERSION,
      error: 'doctor_failed',
      detail: 'worker emitted no parseable doctor envelope',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      install_hint: INSTALL_HINT_FALLBACK,
      ready: false,
    };
  }
  env.version = VISION_TOKENIZE_VERSION;
  return env;
}

// =============================================================================
// helpers
// =============================================================================

function _honestFailEnvelope(extra) {
  // Build a no_detector_installed-shaped envelope when the failure is
  // "no tokenizer wired". Otherwise just an ok:false envelope with the
  // honest error code. Always stamp version + tokens:null.
  const e = {
    ok: false,
    kind: 'vision',
    tokenizer: null,
    model: (extra && extra.model) || DEFAULT_MODEL,
    patch_token_count: null,
    patch_token_dim: null,
    cls_token_present: null,
    image_sha256: null,
    patches_sha256: null,
    tokens: null,
    version: VISION_TOKENIZE_VERSION,
  };
  if (extra) {
    for (const k of Object.keys(extra)) {
      if (k === 'model') continue;
      e[k] = extra[k];
    }
  }
  // Always include an install_hint when the failure is no-detector-shaped.
  if (e.error === 'no_detector_installed' && !e.install_hint) {
    e.install_hint = INSTALL_HINT_FALLBACK;
  }
  return e;
}
