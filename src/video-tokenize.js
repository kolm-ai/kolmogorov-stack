// W773b - Video tokenizer Node-side shim.
//
// Bridges the Node side to the workers/video-tokenize/tokenize.mjs worker
// which itself spawns an external Python tokenizer (LLaVA-NeXT-Video /
// InternVL2 / Video-ViT) that emits patch-token grids per sampled frame.
// Mirrors src/multimodal-redact-audio's shape (W464) and the W772b audio-
// tokenize shim - heavy ML deps stay OUTSIDE Node, root install stays
// light, honest envelope when deps missing.
//
// HONESTY INVARIANTS:
//   - Worker missing -> {ok:false, error:'no_detector_installed',
//     install_hint, sampled_frame_count:null, total_patch_tokens:null}.
//     NEVER {ok:true} with fabricated counts.
//   - Bad sampling_strategy -> {ok:false, error:'invalid_sampling_strategy',
//     supported}. Closed enum mirror of the worker's SAMPLING_STRATEGIES.
//   - num_frames clamped to NUM_FRAMES_CAP (32) so a runaway caller
//     cannot OOM the host. Cap is observable via num_frames_cap:32 in
//     the envelope.
//   - NEVER throws on malformed input. Always returns an envelope.
//   - W411 defense-in-depth: tenant-scoped persistence is the CALLER's
//     job (this shim is stateless; it returns an envelope).
//
// USAGE
//   import {tokenizeVideo, getVideoTokenizeDoctor, VIDEO_TOKENIZE_VERSION,
//           SAMPLING_STRATEGIES} from './video-tokenize.js';
//
//   const env = await tokenizeVideo({
//     path: '/path/to/clip.mp4',
//     model: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
//     sampling_strategy: 'uniform',
//     num_frames: 8,
//   });

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VIDEO_TOKENIZE_VERSION = 'w773b-v1';

// Closed enum mirror of workers/video-tokenize/tokenize.mjs and of
// src/frame-sampler.js SAMPLING_STRATEGIES. Frozen so a refactor cannot
// silently add a 5th strategy and bypass the worker-side validator. The
// 'dense' strategy is W773b-specific (highest density sampling); the
// other three mirror frame-sampler.js exactly.
export const SAMPLING_STRATEGIES = Object.freeze([
  'uniform',
  'adaptive',
  'keyframe',
  'dense',
]);

const NUM_FRAMES_CAP = 32;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const WORKER_PATH = path.resolve(ROOT, 'workers', 'video-tokenize', 'tokenize.mjs');

// ---------------------------------------------------------------------------
// tokenizeVideo - return the W773b envelope. Always returns; never throws.
//
// opts:
//   path?              local video file path
//   uri?               media-store uri (file:sha256.ext)
//   video_base64?      base64 video data; written to a temp file first
//   model?             default llava-hf/LLaVA-NeXT-Video-7B-hf
//   sampling_strategy? default 'uniform'; must be in SAMPLING_STRATEGIES
//   num_frames?        default 8; capped at NUM_FRAMES_CAP=32
//   max_bytes?         default 1 GiB
//   node_bin?          override node binary (tests inject)
//   worker_path?       override worker path (tests inject)
//   env?               extra env vars (tests inject KOLM_VIDEO_TOKENIZE_CMD)
// ---------------------------------------------------------------------------
export async function tokenizeVideo(opts = {}) {
  // Cheap validation up front. NEVER throw - return honest envelope.
  if (!opts || typeof opts !== 'object') {
    return {
      ok: false,
      kind: 'video',
      error: 'bad_args',
      hint: 'tokenizeVideo requires an options object',
      version: VIDEO_TOKENIZE_VERSION,
      tokenizer: null,
      model: null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: 'uniform',
      video_sha256: null,
      frames_sha256: null,
    };
  }

  const requestedStrategy = opts.sampling_strategy || 'uniform';
  if (!SAMPLING_STRATEGIES.includes(requestedStrategy)) {
    return {
      ok: false,
      kind: 'video',
      error: 'invalid_sampling_strategy',
      hint: 'sampling_strategy must be one of ' + JSON.stringify(SAMPLING_STRATEGIES) +
            '; got ' + JSON.stringify(requestedStrategy),
      supported: Array.from(SAMPLING_STRATEGIES),
      version: VIDEO_TOKENIZE_VERSION,
      tokenizer: null,
      model: opts.model || null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // Resolve video_base64 to a temp file before invoking worker.
  let tempPath = null;
  let resolvedPath = opts.path || null;
  const uri = opts.uri || null;
  if (!resolvedPath && !uri && opts.video_base64) {
    try {
      const buf = Buffer.from(String(opts.video_base64), 'base64');
      tempPath = path.join(os.tmpdir(),
        'kolm-w773b-shim-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + '.mp4');
      fs.writeFileSync(tempPath, buf);
      resolvedPath = tempPath;
    } catch (e) {
      return {
        ok: false,
        kind: 'video',
        error: 'video_base64_decode_failed',
        detail: String(e && e.message || e),
        version: VIDEO_TOKENIZE_VERSION,
        tokenizer: null,
        model: opts.model || null,
        sampled_frame_count: null,
        total_patch_tokens: null,
        patch_tokens_per_frame: null,
        patch_token_dim: null,
        sampling_strategy: requestedStrategy,
        video_sha256: null,
        frames_sha256: null,
      };
    }
  }

  if (!resolvedPath && !uri) {
    return {
      ok: false,
      kind: 'video',
      error: 'bad_args',
      hint: 'tokenizeVideo requires path, uri, or video_base64',
      version: VIDEO_TOKENIZE_VERSION,
      tokenizer: null,
      model: opts.model || null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // num_frames cap is observable.
  let numFrames = Number.isFinite(opts.num_frames) && opts.num_frames > 0 ? opts.num_frames : 8;
  let numFramesCapped = false;
  if (numFrames > NUM_FRAMES_CAP) {
    numFrames = NUM_FRAMES_CAP;
    numFramesCapped = true;
  }

  const cargs = [
    opts.worker_path || WORKER_PATH,
    ...(resolvedPath ? ['--path', resolvedPath] : ['--uri', uri]),
    '--model', opts.model || 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    '--sampling-strategy', requestedStrategy,
    '--num-frames', String(numFrames),
    '--max-bytes', String(Number.isFinite(opts.max_bytes) ? opts.max_bytes : 1024 * 1024 * 1024),
  ];

  let res;
  try {
    res = spawnSync(opts.node_bin || process.execPath, cargs, {
      stdio: 'pipe',
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    });
  } catch (e) {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} } // deliberate: cleanup
    return {
      ok: false,
      kind: 'video',
      error: 'worker_spawn_failed',
      detail: String(e && e.message || e),
      version: VIDEO_TOKENIZE_VERSION,
      tokenizer: null,
      model: opts.model || null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} } // deliberate: cleanup
  }

  // Parse the worker's last non-empty stdout line.
  let env = null;
  try {
    const tail = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    env = JSON.parse(tail);
  } catch (_) {
    env = null;
  }

  if (!env) {
    return {
      ok: false,
      kind: 'video',
      error: 'worker_did_not_emit_envelope',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      version: VIDEO_TOKENIZE_VERSION,
      tokenizer: null,
      model: opts.model || null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // Stamp version + cap observability. NEVER overwrite the worker's
  // ok / counts (those are the source of truth).
  env.version = VIDEO_TOKENIZE_VERSION;
  env.num_frames_cap = NUM_FRAMES_CAP;
  env.num_frames_requested = numFrames;
  env.num_frames_capped = numFramesCapped;
  // Honesty invariant: when the worker returned ok:false with no
  // tokenizer wired, surface the install_hint up.
  if (!env.ok && !env.install_hint && env.error === 'no_detector_installed') {
    env.install_hint = 'install python3 + transformers + torch + decord + Pillow, ' +
      'OR set $KOLM_VIDEO_TOKENIZE_CMD to a binary that emits the W773b JSON envelope';
  }
  // Hard-fence: when no_detector_installed, counts MUST be null
  // (HONESTY). NEVER let a stub leak fake numbers via this path.
  if (env.error === 'no_detector_installed' || env.ok === false && !env.tokenizer) {
    env.sampled_frame_count = null;
    env.total_patch_tokens = null;
  }
  return env;
}

// ---------------------------------------------------------------------------
// getVideoTokenizeDoctor - spawn the worker in --doctor mode and return its
// envelope. NEVER throws.
// ---------------------------------------------------------------------------
export async function getVideoTokenizeDoctor(opts = {}) {
  const node = (opts && opts.node_bin) || process.execPath;
  const workerPath = (opts && opts.worker_path) || WORKER_PATH;
  let res;
  try {
    res = spawnSync(node, [workerPath, '--doctor'], {
      stdio: 'pipe',
      timeout: 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...((opts && opts.env) || {}) },
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'video-tokenize-doctor',
      error: 'doctor_spawn_failed',
      detail: String(e && e.message || e),
      version: VIDEO_TOKENIZE_VERSION,
    };
  }
  try {
    const stdoutText = String(res.stdout || '').trim();
    // Doctor emits a multi-line pretty-printed JSON object; the worker
    // ends it with a newline. We parse the entire stdout as JSON
    // (multi-line is fine) and fall back to last-line only on parse
    // failure for forward-compat.
    let parsed;
    try {
      parsed = JSON.parse(stdoutText);
    } catch (_) {
      const lines = stdoutText.split('\n').filter(Boolean);
      // Reassemble all lines as the doctor is pretty-printed JSON.
      parsed = JSON.parse(lines.join('\n'));
    }
    parsed.version = VIDEO_TOKENIZE_VERSION;
    return parsed;
  } catch (e) {
    return {
      ok: false,
      kind: 'video-tokenize-doctor',
      error: 'doctor_parse_failed',
      detail: String(e && e.message || e),
      stderr: String(res.stderr || '').slice(0, 500),
      version: VIDEO_TOKENIZE_VERSION,
    };
  }
}

export default {
  VIDEO_TOKENIZE_VERSION,
  SAMPLING_STRATEGIES,
  tokenizeVideo,
  getVideoTokenizeDoctor,
};
