// W772b - audio tokenizer Node shim.
//
// Wraps workers/audio-tokenize/tokenize.mjs (the W462/W464-style isolated
// worker) so the rest of the codebase (router, CLI, trainer harness) can
// reach the WhisperProcessor mel-spectrogram + BPE token extraction
// pipeline without each call site re-spawning the worker by hand.
//
// HONESTY CONTRACT (matches the worker):
//   * When no tokenizer command is wired (no $KOLM_AUDIO_TOKENIZE_CMD,
//     no `kolm-audio-tokenize` on PATH, no ~/.kolm/scripts/audio-
//     tokenize.py), the envelope is
//       { ok:false, error:'no_detector_installed', install_hint,
//         mel_frame_count:null, text_token_count:null, ... }
//     and we NEVER fabricate a mel/BPE shape.
//
//   * NEVER throws on malformed input - returns ok:false envelope.
//
//   * W411 defense-in-depth: tenant-scoped persistence is the CALLER's
//     job (router/CLI). The shim is a pure function over the worker.
//
// Public surface:
//
//   AUDIO_TOKENIZE_VERSION
//   tokenizeAudio({path?, uri?, model?, max_bytes?, with_mel?,
//                  with_text_tokens?})
//   getAudioTokenizeDoctor()

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AUDIO_TOKENIZE_VERSION = 'w772b-v1';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const WORKER_PATH = path.resolve(__dirname, '..', 'workers', 'audio-tokenize', 'tokenize.mjs');

const DEFAULT_INSTALL_HINT =
  'install python3 + transformers + torch + librosa + soundfile, OR set ' +
  '$KOLM_AUDIO_TOKENIZE_CMD to a binary that emits the W772b JSON envelope';

// ----- empty/no-detector envelope (shared by callers) -----

function noDetectorEnvelope(opts) {
  return {
    ok: false,
    kind: 'audio',
    error: 'no_detector_installed',
    install_hint: DEFAULT_INSTALL_HINT,
    tokenizer: null,
    model: (opts && opts.model) || null,
    media_uri: (opts && opts.uri) || null,
    duration_ms: null,
    mel_frame_count: null,
    mel_feature_dim: null,
    mel_sha256: null,
    text_token_count: null,
    text_token_sample: null,
    text_sha256: null,
    audio_sha256: null,
    version: AUDIO_TOKENIZE_VERSION,
  };
}

function badArgsEnvelope(err, opts) {
  return {
    ok: false,
    kind: 'audio',
    error: 'bad_args',
    detail: String(err || ''),
    tokenizer: null,
    model: (opts && opts.model) || null,
    media_uri: (opts && opts.uri) || null,
    duration_ms: null,
    mel_frame_count: null,
    mel_feature_dim: null,
    mel_sha256: null,
    text_token_count: null,
    text_token_sample: null,
    text_sha256: null,
    audio_sha256: null,
    version: AUDIO_TOKENIZE_VERSION,
  };
}

function workerCrashEnvelope(detail, opts) {
  return {
    ok: false,
    kind: 'audio',
    error: 'worker_no_output',
    detail: String(detail || ''),
    tokenizer: null,
    model: (opts && opts.model) || null,
    media_uri: (opts && opts.uri) || null,
    duration_ms: null,
    mel_frame_count: null,
    mel_feature_dim: null,
    mel_sha256: null,
    text_token_count: null,
    text_token_sample: null,
    text_sha256: null,
    audio_sha256: null,
    version: AUDIO_TOKENIZE_VERSION,
  };
}

// =============================================================================
// tokenizeAudio
// =============================================================================

/**
 * Tokenize an audio file via the W772b worker.
 *
 * Args (opts):
 *   path?            - local audio file path (wav/flac/mp3/ogg/m4a).
 *   uri?             - media-store-resolved file:<sha256>.<ext> URI.
 *   audio_base64?    - base64-encoded audio body. We write it to a temp
 *                      file and pass the temp path to the worker.
 *   model?           - Whisper model id (default openai/whisper-large-v3).
 *   max_bytes?       - upstream byte cap (default 50 MiB).
 *   with_mel?        - emit mel-spectrogram patch hash (default true).
 *   with_text_tokens?- emit text-side BPE token ids (default true).
 *
 * Returns the W772b envelope (see worker for shape). NEVER throws.
 */
export async function tokenizeAudio(opts) {
  const a = opts || {};

  if (!a.path && !a.uri && !a.audio_base64) {
    return {
      ...badArgsEnvelope('path|uri|audio_base64 is required', a),
      error: 'no_audio_source',
    };
  }

  // If audio_base64 is provided, materialize it on disk so the worker
  // can read it. We do NOT keep the bytes in memory beyond this — once
  // the worker has run we delete the temp file.
  let tmpPath = null;
  let workerArgs = ['--json'];
  try {
    if (a.path) {
      if (!fs.existsSync(String(a.path))) {
        return {
          ...badArgsEnvelope('audio not found: ' + a.path, a),
          error: 'audio_not_found',
        };
      }
      workerArgs.push('--path', String(a.path));
    } else if (a.audio_base64) {
      const crypto = await import('node:crypto');
      const os = await import('node:os');
      const buf = Buffer.from(String(a.audio_base64), 'base64');
      tmpPath = path.join(os.tmpdir(),
        'kolm-w772b-shim-' + crypto.randomBytes(6).toString('hex') + '.wav');
      fs.writeFileSync(tmpPath, buf);
      workerArgs.push('--path', tmpPath);
    } else if (a.uri) {
      workerArgs.push('--uri', String(a.uri));
    }

    workerArgs.push('--model', String(a.model || 'openai/whisper-large-v3'));
    if (Number.isFinite(Number(a.max_bytes))) {
      workerArgs.push('--max-bytes', String(Number(a.max_bytes)));
    }
    if (a.with_mel !== false)           workerArgs.push('--with-mel');
    if (a.with_text_tokens !== false)   workerArgs.push('--with-text-tokens');

    const res = spawnSync(process.execPath, [WORKER_PATH, ...workerArgs], {
      stdio: 'pipe',
      timeout: 10 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env },
    });

    let env = null;
    try {
      const tail = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
      env = JSON.parse(tail);
    } catch (_) {
      env = null;
    }

    if (!env || typeof env !== 'object') {
      return {
        ...workerCrashEnvelope(
          'worker exit=' + res.status + ' stderr=' +
            String(res.stderr || '').slice(0, 200),
          a),
      };
    }

    // Always stamp our version on the way out so downstream callers can
    // pin against the shim, not the worker (which is replaceable).
    env.version = AUDIO_TOKENIZE_VERSION;
    return env;
  } catch (e) {
    return workerCrashEnvelope(String(e && e.message || e), a);
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch (_) {} // deliberate: cleanup
    }
  }
}

// =============================================================================
// getAudioTokenizeDoctor
// =============================================================================

/**
 * Return the W772b worker doctor envelope.
 *
 * NEVER throws. On worker crash returns an honest envelope with the same
 * shape but ok:false + error:'worker_no_output'.
 */
export async function getAudioTokenizeDoctor() {
  try {
    const res = spawnSync(process.execPath, [WORKER_PATH, '--doctor'], {
      stdio: 'pipe',
      timeout: 30 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    });
    let env = null;
    try {
      env = JSON.parse(String(res.stdout || '').trim());
    } catch (_) {
      env = null;
    }
    if (!env) {
      return {
        ok: false,
        spec: 'kolm-audio-tokenize-worker-doctor',
        version: AUDIO_TOKENIZE_VERSION,
        error: 'worker_no_output',
        stderr: String(res.stderr || '').slice(0, 400),
        ready: false,
        tokenizer: { ok: false, name: null, source: null },
      };
    }
    env.version = AUDIO_TOKENIZE_VERSION;
    return env;
  } catch (e) {
    return {
      ok: false,
      spec: 'kolm-audio-tokenize-worker-doctor',
      version: AUDIO_TOKENIZE_VERSION,
      error: 'doctor_spawn_failed',
      detail: String(e && e.message || e),
      ready: false,
      tokenizer: { ok: false, name: null, source: null },
    };
  }
}

export default {
  AUDIO_TOKENIZE_VERSION,
  tokenizeAudio,
  getAudioTokenizeDoctor,
};
