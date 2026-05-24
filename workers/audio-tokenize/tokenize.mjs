#!/usr/bin/env node
// workers/audio-tokenize/tokenize.mjs
//
// W772b - isolated kolm audio tokenizer worker (Whisper mel + BPE).
//
// W772 (commit deb83fb) shipped the audio capture + bake-off + trainer
// SCAFFOLDING. The trainer apps/trainer/audio_distill.py is stdlib-only
// --dry-run and never actually tokenizes audio into mel-spectrograms or
// Whisper BPE tokens.
//
// W772b closes that gap. It ships REAL tokenization as an OPT-IN worker
// using the W462 (workers/multimodal-redact-image) + W464 (workers/
// multimodal-redact-audio) pattern: heavy ML deps live in an isolated
// worker, the root kolm install stays light, and the envelope is honest
// when deps are missing.
//
// THREAT MODEL: the previous audio_distill.py --dry-run path returned
// trainer_not_invoked:true + audio_captures_total:N but had no way to
// turn a captured wav/mp3 into actual model-consumable tensors. W772b
// closes that — given an audio file we surface mel-spectrogram patch
// hashes + the BPE token-id sample so the trainer can verify that the
// audio it captured will round-trip through whisper-large-v3 cleanly.
//
// PIPELINE
//   1. Resolve the audio source bytes (--path <file> or --uri <file:
//      sha256.ext> resolved through src/media-store.js).
//   2. Hash the raw audio bytes (sha256) for the envelope.
//   3. Locate an external tokenizer command (priority chain):
//        $KOLM_AUDIO_TOKENIZE_CMD       (env override, JSON-array allowed)
//        kolm-audio-tokenize            (on PATH)
//        python3 ~/.kolm/scripts/audio-tokenize.py  (user-installed)
//      First one found wins. Doctor mode reports which is wired.
//   4. Spawn the tokenizer with the resolved path + flags. The tokenizer
//      MUST emit one JSON line on stdout summarising what it did.
//   5. Merge the tokenizer envelope with our outer envelope so we have
//      a stable shape regardless of which backend computed the features.
//
// MODES
//   --doctor                 print toolchain readiness, exit 0.
//   --path <audio>           local audio file path (wav/flac/mp3/ogg/m4a).
//   --uri <file:sha256.ext>  media-store-resolved uri.
//   --model <name>           Whisper model id. Default openai/whisper-large-v3.
//   --max-bytes <N>          cap upstream bytes (default 50 MiB).
//   --with-mel               emit mel-spectrogram patch hash. Default true.
//   --with-text-tokens       emit text-side BPE token ids. Default true.
//   --json                   emit a single JSON envelope (default).
//
// OUTPUT ENVELOPE (always JSON, one line, on stdout)
//   {
//     ok:                 bool,
//     kind:               'audio',
//     media_uri:          <uri> | null,
//     tokenizer:          'openai/whisper-large-v3' | '<env-override>' | null,
//     model:              <string> | null,
//     duration_ms:        <int> | null,
//     mel_frame_count:    <int> | null,   // e.g. 1500 for 30s @ 50ms hop
//     mel_feature_dim:    <int> | null,   // 80 for whisper-large-v3
//     mel_sha256:         <hex> | null,
//     text_token_count:   <int> | null,   // BPE token count from transcript
//     text_token_sample:  [<int>, ...] | null,  // first N=8 ids for verification
//     text_sha256:        <hex> | null,
//     audio_sha256:       <hex> | null,
//     install_hint?:      <string>        // present iff no tokenizer wired
//   }
//
// EXIT CODES
//   0  ok (tokenizer ran + envelope is populated)
//   2  bad args
//   3  no tokenizer installed (install_hint set, mel_frame_count=null,
//      text_token_count=null)
//   4  audio not found / could not load
//   5  tokenizer crashed / did not emit envelope
//
// Tests inject a Node-based stub via $KOLM_AUDIO_TOKENIZE_CMD so both
// the honesty path (no tokenizer wired) AND the working path (stub
// returns canned envelope) can be exercised without transformers/torch
// installed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

const DEFAULT_MODEL = 'openai/whisper-large-v3';
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const TEXT_TOKEN_SAMPLE_N = 8;

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  const r = await doctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}

try {
  const env = await main(args);
  process.stdout.write(JSON.stringify(env) + '\n');
  process.exit(envExitCode(env));
} catch (e) {
  const fail = {
    ok: false,
    kind: 'audio',
    error: String(e && e.message || e),
    error_stage: e && e._stage || 'unknown',
    tokenizer: null,
    model: null,
    duration_ms: null,
    mel_frame_count: null,
    mel_feature_dim: null,
    mel_sha256: null,
    text_token_count: null,
    text_token_sample: null,
    text_sha256: null,
    audio_sha256: null,
  };
  process.stdout.write(JSON.stringify(fail) + '\n');
  process.exit(e && e._exit || 5);
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const a = {
    doctor: false,
    json: true,
    with_mel: true,
    with_text_tokens: true,
    model: DEFAULT_MODEL,
    max_bytes: DEFAULT_MAX_BYTES,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--doctor')                  { a.doctor = true; }
    else if (k === '--path')               { a.path = v; i++; }
    else if (k === '--uri')                { a.uri = v; i++; }
    else if (k === '--model')              { a.model = v || DEFAULT_MODEL; i++; }
    else if (k === '--max-bytes')          { a.max_bytes = parseInt(v, 10) || DEFAULT_MAX_BYTES; i++; }
    else if (k === '--with-mel')           { a.with_mel = true; }
    else if (k === '--without-mel')        { a.with_mel = false; }
    else if (k === '--with-text-tokens')   { a.with_text_tokens = true; }
    else if (k === '--without-text-tokens'){ a.with_text_tokens = false; }
    else if (k === '--json')               { a.json = true; }
  }
  return a;
}

function envExitCode(env) {
  if (env.ok) return 0;
  if (env._exit_code) return env._exit_code;
  if (env.error === 'no_detector_installed') return 3;
  if (env.install_hint) return 3;
  return 5;
}

// ---------- doctor ----------

async function doctor() {
  const found = locateTokenizer();

  const py = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  const pyDeps = py ? probePythonDeps(py) : {
    transformers: false,
    torch: false,
    librosa: false,
    soundfile: false,
  };

  const r = {
    spec: 'kolm-audio-tokenize-worker-doctor',
    version: '0.1.0',
    wave: 'W772b',
    kind: 'audio-tokenize-doctor',
    default_model: DEFAULT_MODEL,
    runtime: {
      python3: { path: py, ok: !!py },
    },
    python_deps: {
      transformers: pyDeps.transformers,
      torch: pyDeps.torch,
      librosa: pyDeps.librosa,
      soundfile: pyDeps.soundfile,
    },
    tokenizer: found
      ? { ok: true, name: found.name, source: found.source }
      : { ok: false, name: null, source: null, install_hint:
          'no audio tokenizer wired. install one of: ' +
          '(a) pip install transformers torch librosa soundfile + drop a wrapper named kolm-audio-tokenize on PATH; ' +
          '(b) set $KOLM_AUDIO_TOKENIZE_CMD to an executable accepting --path <audio> [--model NAME] [--with-mel] [--with-text-tokens] and emitting the W772b JSON envelope; ' +
          '(c) drop a script at ~/.kolm/scripts/audio-tokenize.py invoked via python3.' },
    env: {
      node: process.version,
      platform: process.platform,
      home: os.homedir(),
      env_override: process.env.KOLM_AUDIO_TOKENIZE_CMD ? 'set' : null,
    },
    install_hint: null,
    ready: !!found,
    ok: true,
  };

  if (!found) {
    r.ok = false;
    r.install_hint = r.tokenizer.install_hint;
  }
  return r;
}

function probePythonDeps(py) {
  const out = { transformers: false, torch: false, librosa: false, soundfile: false };
  for (const mod of Object.keys(out)) {
    try {
      const res = spawnSync(py, ['-c', `import ${mod}`], { stdio: 'pipe', timeout: 5000 });
      out[mod] = res.status === 0;
    } catch (_) {
      out[mod] = false;
    }
  }
  return out;
}

// ---------- main ----------

async function main(a) {
  if (!a.path && !a.uri) {
    return {
      ok: false,
      kind: 'audio',
      error: 'bad_args: --path or --uri is required',
      _exit_code: 2,
      tokenizer: null,
      model: a.model || null,
      duration_ms: null,
      mel_frame_count: null,
      mel_feature_dim: null,
      mel_sha256: null,
      text_token_count: null,
      text_token_sample: null,
      text_sha256: null,
      audio_sha256: null,
    };
  }

  // Resolve input bytes.
  let inputPath = a.path || null;
  let inputBuf  = null;
  let mediaUri  = a.uri || null;
  const maxBytes = Number.isFinite(a.max_bytes) ? a.max_bytes : DEFAULT_MAX_BYTES;

  if (inputPath) {
    if (!fs.existsSync(inputPath)) {
      return {
        ok: false,
        kind: 'audio',
        media_uri: null,
        error: 'audio_not_found: ' + inputPath,
        _exit_code: 4,
        tokenizer: null,
        model: a.model || null,
        duration_ms: null,
        mel_frame_count: null,
        mel_feature_dim: null,
        mel_sha256: null,
        text_token_count: null,
        text_token_sample: null,
        text_sha256: null,
        audio_sha256: null,
      };
    }
    inputBuf = fs.readFileSync(inputPath);
  } else if (mediaUri) {
    try {
      const ms = await import(path.resolve(ROOT, 'src', 'media-store.js'));
      const bytes = await ms.resolveMediaBytes(mediaUri, { max_bytes: maxBytes });
      if (!bytes || !bytes.length) {
        return {
          ok: false,
          kind: 'audio',
          media_uri: mediaUri,
          error: 'audio_not_found: ' + mediaUri,
          _exit_code: 4,
          tokenizer: null,
          model: a.model || null,
          duration_ms: null,
          mel_frame_count: null,
          mel_feature_dim: null,
          mel_sha256: null,
          text_token_count: null,
          text_token_sample: null,
          text_sha256: null,
          audio_sha256: null,
        };
      }
      inputBuf = Buffer.from(bytes);
      inputPath = path.join(os.tmpdir(),
        'kolm-w772b-in-' + crypto.randomBytes(6).toString('hex') + '.wav');
      fs.writeFileSync(inputPath, inputBuf);
    } catch (e) {
      return {
        ok: false,
        kind: 'audio',
        media_uri: mediaUri,
        error: 'media_resolve_failed: ' + String(e.message || e),
        _exit_code: 4,
        tokenizer: null,
        model: a.model || null,
        duration_ms: null,
        mel_frame_count: null,
        mel_feature_dim: null,
        mel_sha256: null,
        text_token_count: null,
        text_token_sample: null,
        text_sha256: null,
        audio_sha256: null,
      };
    }
  }

  if (inputBuf && inputBuf.length > maxBytes) {
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      error: 'audio_too_large: ' + inputBuf.length + ' > ' + maxBytes,
      _exit_code: 2,
      tokenizer: null,
      model: a.model || null,
      duration_ms: null,
      mel_frame_count: null,
      mel_feature_dim: null,
      mel_sha256: null,
      text_token_count: null,
      text_token_sample: null,
      text_sha256: null,
      audio_sha256: null,
    };
  }

  const audio_sha256 = inputBuf
    ? crypto.createHash('sha256').update(inputBuf).digest('hex')
    : null;

  // Locate the tokenizer.
  const found = locateTokenizer();
  if (!found) {
    const d = await doctor();
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      error: 'no_detector_installed',
      install_hint: d.install_hint || 'install python3 + transformers + torch + librosa + soundfile, OR set $KOLM_AUDIO_TOKENIZE_CMD to a binary that emits the W772b JSON envelope',
      _exit_code: 3,
      tokenizer: null,
      model: a.model || null,
      duration_ms: null,
      mel_frame_count: null,
      mel_feature_dim: null,
      mel_sha256: null,
      text_token_count: null,
      text_token_sample: null,
      text_sha256: null,
      audio_sha256,
    };
  }

  // Build the tokenizer command args.
  const cargs = ['--path', inputPath, '--model', String(a.model || DEFAULT_MODEL)];
  if (a.with_mel)         cargs.push('--with-mel');
  if (a.with_text_tokens) cargs.push('--with-text-tokens');
  if (Number.isFinite(maxBytes)) cargs.push('--max-bytes', String(maxBytes));
  cargs.push('--json');

  let res;
  try {
    res = spawnSync(found.cmd, [...found.args, ...cargs], {
      stdio: 'pipe',
      timeout: 10 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      tokenizer: found.name,
      model: a.model || null,
      error: 'tokenizer_spawn_failed: ' + String(e.message || e),
      _exit_code: 5,
      duration_ms: null,
      mel_frame_count: null,
      mel_feature_dim: null,
      mel_sha256: null,
      text_token_count: null,
      text_token_sample: null,
      text_sha256: null,
      audio_sha256,
    };
  }

  // Parse the tokenizer's JSON envelope (last non-empty line on stdout).
  let inner = null;
  try {
    const tail = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
    inner = JSON.parse(tail);
  } catch (_) {
    inner = null;
  }

  if (res.status !== 0 || !inner) {
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      tokenizer: found.name,
      model: a.model || null,
      error: 'tokenizer_failed',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      _exit_code: 5,
      duration_ms: null,
      mel_frame_count: null,
      mel_feature_dim: null,
      mel_sha256: null,
      text_token_count: null,
      text_token_sample: null,
      text_sha256: null,
      audio_sha256,
    };
  }

  // Merge the inner envelope with our outer envelope. Inner fields win
  // for the numeric tokenizer outputs (mel_frame_count, text_token_count,
  // etc) - the worker shell only stamps audio_sha256 + identity.
  const env = {
    ok: inner.ok !== false,
    kind: 'audio',
    media_uri: mediaUri,
    tokenizer: typeof inner.tokenizer === 'string' && inner.tokenizer
      ? inner.tokenizer
      : found.name,
    model: typeof inner.model === 'string' ? inner.model : (a.model || DEFAULT_MODEL),
    duration_ms: numOrNull(inner.duration_ms),
    mel_frame_count: a.with_mel ? numOrNull(inner.mel_frame_count) : null,
    mel_feature_dim: a.with_mel ? numOrNull(inner.mel_feature_dim) : null,
    mel_sha256: a.with_mel ? hexOrNull(inner.mel_sha256) : null,
    text_token_count: a.with_text_tokens ? numOrNull(inner.text_token_count) : null,
    text_token_sample: a.with_text_tokens ? sampleOrNull(inner.text_token_sample) : null,
    text_sha256: a.with_text_tokens ? hexOrNull(inner.text_sha256) : null,
    audio_sha256: hexOrNull(inner.audio_sha256) || audio_sha256,
    bytes_in: inputBuf ? inputBuf.length : null,
    tokenizer_envelope: inner,
  };
  return env;
}

// ---------- tokenizer location ----------

function locateTokenizer() {
  // 1. $KOLM_AUDIO_TOKENIZE_CMD env override.
  const ovr = process.env.KOLM_AUDIO_TOKENIZE_CMD;
  if (ovr && ovr.length > 0) {
    let cmd = ovr;
    let cargs = [];
    if (ovr.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(ovr);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cmd = parsed[0];
          cargs = parsed.slice(1).map(String);
        }
      } catch (_) { /* fall through */ }
    }
    const resolved = whichSync(cmd);
    const exists = resolved || (fs.existsSync(cmd) && fs.statSync(cmd).isFile());
    if (exists) {
      return {
        name: 'env_override:' + (resolved || cmd),
        source: 'env',
        cmd: resolved || cmd,
        args: cargs,
      };
    }
  }

  // 2. kolm-audio-tokenize on PATH.
  const cli = whichSync(process.platform === 'win32'
    ? 'kolm-audio-tokenize.exe'
    : 'kolm-audio-tokenize');
  if (cli) {
    return { name: 'kolm-audio-tokenize', source: 'path', cmd: cli, args: [] };
  }

  // 3. ~/.kolm/scripts/audio-tokenize.py invoked via python3.
  const script = path.join(os.homedir(), '.kolm', 'scripts', 'audio-tokenize.py');
  const py3 = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (py3 && fs.existsSync(script)) {
    return { name: 'audio-tokenize.py', source: 'home', cmd: py3, args: [script] };
  }

  return null;
}

function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try {
      if (fs.existsSync(name) && fs.statSync(name).isFile()) return name;
    } catch (_) {}
    return null;
  }
  const PATH = process.env.PATH || '';
  const SEP  = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  for (const dir of PATH.split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch (_) {}
    }
  }
  return null;
}

// ---------- shape coercion helpers ----------

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function hexOrNull(v) {
  if (typeof v !== 'string') return null;
  return /^[a-f0-9]{8,128}$/i.test(v) ? v.toLowerCase() : null;
}

function sampleOrNull(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v.slice(0, TEXT_TOKEN_SAMPLE_N)) {
    const n = numOrNull(x);
    if (n != null) out.push(Math.trunc(n));
  }
  return out.length > 0 ? out : null;
}
