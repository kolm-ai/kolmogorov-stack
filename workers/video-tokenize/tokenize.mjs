#!/usr/bin/env node
// workers/video-tokenize/tokenize.mjs
//
// W773b - Isolated kolm video frame-patch tokenizer worker.
//
// Closes the W773 trainer-side gap: apps/trainer/video_distill.py is
// stdout-only --dry-run and never actually tokenizes video frames into
// Video-ViT / LLaVA-NeXT-Video patch tokens. W773b ships the real
// tokenizer as an opt-in worker mirroring the W462 (multimodal-redact-
// image) + W464 (multimodal-redact-audio) + W772b (audio-tokenize)
// pattern: heavy ML deps live in a Python script the worker spawns;
// root install stays light; honest install_hint envelope when deps
// missing.
//
// PIPELINE
//   1. Resolve the video source to a local path (--path <file> or
//      --uri <file:sha256.ext> via media-store).
//   2. Locate the external video tokenizer:
//        $KOLM_VIDEO_TOKENIZE_CMD     (env override; JSON array allowed)
//        kolm-video-tokenize          (on PATH)
//        python3 ~/.kolm/scripts/video-tokenize.py
//      The first one found wins. Doctor mode reports which is wired.
//   3. Spawn the tokenizer with the contract args. The tokenizer MUST
//      emit ONE JSON line on stdout summarizing what it did.
//   4. Forward that envelope verbatim with W773b metadata enriched.
//
// MODES
//   --doctor                       print toolchain readiness, exit 0.
//   --path <file>                  local video file (mp4/webm/mov/mkv).
//   --uri <file:sha256.ext>        media-store-resolved uri.
//   --model <name>                 default llava-hf/LLaVA-NeXT-Video-7B-hf.
//   --sampling-strategy <S>        uniform|adaptive|keyframe|dense (default uniform).
//   --num-frames <N>               default 8, hard-capped at 32 (OOM/budget guard).
//   --max-bytes <N>                default 1 GiB (matches W773 video-capture cap).
//   --json                         emit JSON envelope (default).
//
// OUTPUT ENVELOPE (always JSON, one line, on stdout)
//   {
//     ok:                    bool,
//     kind:                  'video',
//     media_uri:             <uri> | null,
//     tokenizer:             'llava-hf/LLaVA-NeXT-Video-7B-hf' | <env-override> | null,
//     model:                 <string> | null,
//     duration_ms:           <int> | null,
//     fps:                   <number> | null,
//     sampled_frame_count:   <int> | null,
//     patch_tokens_per_frame:<int> | null,
//     total_patch_tokens:    <int> | null,
//     patch_token_dim:       <int> | null,
//     sampling_strategy:     <string>,
//     video_sha256:          <hex> | null,
//     frames_sha256:         <hex> | null,
//     install_hint?:         <string>          // present iff no tokenizer wired
//   }
//
// EXIT CODES
//   0  ok (tokenization succeeded; tokenizer honored the contract)
//   2  bad args
//   3  no tokenizer installed (install_hint set, sampled_frame_count=null, total_patch_tokens=null)
//   4  video not found / could not load
//   5  tokenizer crashed / did not emit envelope
//   6  frame sampling failed
//
// HEAVY-DEPS BOUNDARY (per standing directive: "Heavy ML deps must live
// in an isolated worker/package/script"). The real tokenizer is a Python
// tool (transformers + torch + decord/av + Pillow + a frontier video-
// vision-encoder). It lives OUTSIDE this Node worker. The worker is a
// thin shell that spawns the external command. Root kolm install does
// NOT pull transformers, torch, decord, av, or Pillow.
//
// HONESTY CONTRACT: when no external tokenizer is wired the worker
// returns {ok:false, install_hint, sampled_frame_count:null,
// total_patch_tokens:null}. It NEVER silently claims it tokenized a
// video it could not load. This is the load-bearing invariant for the
// W773b "no softened claims" directive in the multimodal cluster.
//
// SAMPLING STRATEGIES (match src/frame-sampler.js SAMPLING_STRATEGIES):
//   uniform   - evenly spaced over duration (default; deterministic).
//   adaptive  - start uniform, densify around high-motion regions.
//   keyframe  - extract I-frames per container GOP metadata.
//   dense     - sample every Nth frame (closest to fps_target).
// Tests inject a Node-based stub via KOLM_VIDEO_TOKENIZE_CMD so the
// honesty AND the working-path can both be exercised without
// transformers/torch on disk.

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

// HARD CAP - mirror of the trainer/test budget so a single tokenize call
// never emits more than ~4600 LLaVA patch tokens (32 frames * 144) or
// ~8200 InternVL2 (32 * 256). Bigger jobs MUST chunk.
const NUM_FRAMES_CAP = 32;

// Closed enum mirror of src/frame-sampler.js SAMPLING_STRATEGIES + the
// W773b-specific 'dense' addition. The Node-side validates strategy
// against this list before spawning Python (cheap rejection).
const SAMPLING_STRATEGIES = ['uniform', 'adaptive', 'keyframe', 'dense'];

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
    kind: 'video',
    error: String(e && e.message || e),
    error_stage: e && e._stage || 'unknown',
    tokenizer: null,
    model: null,
    sampled_frame_count: null,
    total_patch_tokens: null,
    patch_tokens_per_frame: null,
    patch_token_dim: null,
    sampling_strategy: args.sampling_strategy || 'uniform',
    video_sha256: null,
    frames_sha256: null,
  };
  process.stdout.write(JSON.stringify(fail) + '\n');
  process.exit(e && e._exit || 5);
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const a = { doctor: false, json: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--doctor')                  { a.doctor = true; }
    else if (k === '--path')               { a.path = v; i++; }
    else if (k === '--uri')                { a.uri = v; i++; }
    else if (k === '--model')              { a.model = v; i++; }
    else if (k === '--sampling-strategy')  { a.sampling_strategy = v; i++; }
    else if (k === '--num-frames')         { a.num_frames = parseInt(v, 10); i++; }
    else if (k === '--max-bytes')          { a.max_bytes = parseInt(v, 10); i++; }
    else if (k === '--json')               { a.json = true; }
  }
  return a;
}

function envExitCode(env) {
  if (env.ok) return 0;
  if (env._exit_code) return env._exit_code;
  if (env.install_hint) return 3;
  return 5;
}

// ---------- doctor ----------

async function doctor() {
  const found = locateTokenizer();

  const py = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');

  // Python deps we care about. Empty if Python is missing.
  const pyDeps = py
    ? probePyDeps(py, ['transformers', 'torch', 'decord', 'av', 'PIL'])
    : { transformers: false, torch: false, decord: false, av: false, PIL: false };

  // Spec follows the W464/W772b doctor convention so the
  // kolm-*-tokenize-worker-doctor envelope shape stays uniform.
  const r = {
    spec: 'kolm-video-tokenize-worker-doctor',
    version: '0.1.0',
    wave: 'W773b',
    kind: 'video-tokenize-doctor',
    runtime: {
      python3: { path: py, ok: !!py },
    },
    py_deps: {
      // Probed individually so the operator sees WHICH dep is missing,
      // not just "missing" in aggregate. decord OR av suffices for the
      // video decode path; we mark either as ok for ready.
      transformers: { ok: pyDeps.transformers },
      torch:        { ok: pyDeps.torch },
      decord:       { ok: pyDeps.decord },
      av:           { ok: pyDeps.av },
      PIL:          { ok: pyDeps.PIL },
    },
    tokenizers: {
      video: found
        ? { ok: true, name: found.name, source: found.source }
        : { ok: false, name: null, source: null, install_hint:
            'no video tokenizer wired. install one of: ' +
            '(a) pip install transformers torch decord Pillow + drop a wrapper named kolm-video-tokenize on PATH; ' +
            '(b) set $KOLM_VIDEO_TOKENIZE_CMD to an executable accepting --path <video> [--model NAME] [--sampling-strategy STRAT] [--num-frames N] and emitting the W773b JSON envelope on stdout; ' +
            '(c) drop a script at ~/.kolm/scripts/video-tokenize.py invoked via python3.' },
    },
    env: {
      node: process.version,
      platform: process.platform,
      home: os.homedir(),
    },
    sampling_strategies: SAMPLING_STRATEGIES.slice(),
    num_frames_cap: NUM_FRAMES_CAP,
    install_hint: null,
    ready: !!found,
    ok: true,
  };

  if (!found) {
    r.ok = false;
    r.install_hint = r.tokenizers.video.install_hint;
  }
  return r;
}

function probePyDeps(pyBin, deps) {
  const out = {};
  // One subprocess - cheap. We import every dep and emit a JSON map of
  // module -> ok. Wrapped in try so a single missing import doesn't
  // crash the whole probe.
  const script = [
    'import json, sys',
    'out = {}',
    ...deps.map((d) =>
      `\ntry:\n    __import__(${JSON.stringify(d)})\n    out[${JSON.stringify(d)}] = True\nexcept Exception:\n    out[${JSON.stringify(d)}] = False`
    ),
    'sys.stdout.write(json.dumps(out))',
  ].join('\n');
  try {
    const r = spawnSync(pyBin, ['-c', script], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && r.stdout) {
      const parsed = JSON.parse(r.stdout);
      for (const d of deps) out[d] = !!parsed[d];
      return out;
    }
  } catch (_) { /* fall through */ }
  for (const d of deps) out[d] = false;
  return out;
}

// ---------- main ----------

async function main(a) {
  if (!a.path && !a.uri) {
    return {
      ok: false,
      kind: 'video',
      error: 'bad_args: --path or --uri is required',
      _exit_code: 2,
      tokenizer: null,
      model: null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: a.sampling_strategy || 'uniform',
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // Validate sampling strategy cheap - reject bogus before spawning.
  const requestedStrategy = a.sampling_strategy || 'uniform';
  if (!SAMPLING_STRATEGIES.includes(requestedStrategy)) {
    return {
      ok: false,
      kind: 'video',
      error: 'invalid_sampling_strategy',
      hint: 'sampling_strategy must be one of ' + JSON.stringify(SAMPLING_STRATEGIES) +
            '; got ' + JSON.stringify(requestedStrategy),
      supported: SAMPLING_STRATEGIES.slice(),
      _exit_code: 2,
      tokenizer: null,
      model: null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // Resolve num_frames with hard cap. Bigger callers MUST chunk.
  let numFrames = Number.isFinite(a.num_frames) && a.num_frames > 0 ? a.num_frames : 8;
  if (numFrames > NUM_FRAMES_CAP) numFrames = NUM_FRAMES_CAP;

  // Resolve input bytes / path.
  let inputPath = a.path || null;
  let inputBuf  = null;
  let mediaUri  = a.uri || null;
  const maxBytes = Number.isFinite(a.max_bytes) ? a.max_bytes : 1024 * 1024 * 1024;

  if (inputPath) {
    if (!fs.existsSync(inputPath)) {
      return {
        ok: false,
        kind: 'video',
        error: 'video_not_found: ' + inputPath,
        _exit_code: 4,
        tokenizer: null,
        model: null,
        sampled_frame_count: null,
        total_patch_tokens: null,
        patch_tokens_per_frame: null,
        patch_token_dim: null,
        sampling_strategy: requestedStrategy,
        video_sha256: null,
        frames_sha256: null,
      };
    }
    inputBuf = fs.readFileSync(inputPath);
  } else if (mediaUri) {
    // Resolve via media-store. We do this dynamically so the worker
    // does not hard-require the root project at install time.
    try {
      const ms = await import(path.resolve(ROOT, 'src', 'media-store.js'));
      const bytes = await ms.resolveMediaBytes(mediaUri, { max_bytes: maxBytes });
      if (!bytes || !bytes.length) {
        return {
          ok: false,
          kind: 'video',
          media_uri: mediaUri,
          error: 'video_not_found: ' + mediaUri,
          _exit_code: 4,
          tokenizer: null,
          model: null,
          sampled_frame_count: null,
          total_patch_tokens: null,
          patch_tokens_per_frame: null,
          patch_token_dim: null,
          sampling_strategy: requestedStrategy,
          video_sha256: null,
          frames_sha256: null,
        };
      }
      inputBuf = Buffer.from(bytes);
      // Write to a temp file for the tokenizer.
      inputPath = path.join(os.tmpdir(), 'kolm-w773b-in-' + crypto.randomBytes(6).toString('hex') + '.mp4');
      fs.writeFileSync(inputPath, inputBuf);
    } catch (e) {
      return {
        ok: false,
        kind: 'video',
        media_uri: mediaUri,
        error: 'media_resolve_failed: ' + String(e.message || e),
        _exit_code: 4,
        tokenizer: null,
        model: null,
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

  if (inputBuf && inputBuf.length > maxBytes) {
    return {
      ok: false,
      kind: 'video',
      media_uri: mediaUri,
      error: 'video_too_large: ' + inputBuf.length + ' > ' + maxBytes,
      _exit_code: 2,
      tokenizer: null,
      model: null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: null,
      frames_sha256: null,
    };
  }

  // Locate the tokenizer.
  const found = locateTokenizer();
  if (!found) {
    const d = await doctor();
    return {
      ok: false,
      kind: 'video',
      media_uri: mediaUri,
      error: 'no_detector_installed',
      install_hint: d.install_hint,
      _exit_code: 3,
      tokenizer: null,
      model: a.model || null,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: inputBuf ? sha256(inputBuf) : null,
      frames_sha256: null,
    };
  }

  // Spawn the tokenizer.
  const modelName = a.model || 'llava-hf/LLaVA-NeXT-Video-7B-hf';
  const cargs = [
    '--path', inputPath,
    '--model', modelName,
    '--sampling-strategy', requestedStrategy,
    '--num-frames', String(numFrames),
    '--max-bytes', String(maxBytes),
  ];

  let res;
  try {
    res = spawnSync(found.cmd, [...found.args, ...cargs], {
      stdio: 'pipe',
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'video',
      media_uri: mediaUri,
      tokenizer: found.name,
      model: modelName,
      error: 'tokenizer_spawn_failed: ' + String(e.message || e),
      _exit_code: 5,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: inputBuf ? sha256(inputBuf) : null,
      frames_sha256: null,
    };
  }

  // Parse the tokenizer's JSON envelope (last non-empty stdout line).
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
      kind: 'video',
      media_uri: mediaUri,
      tokenizer: found.name,
      model: modelName,
      error: 'tokenizer_failed',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      _exit_code: 5,
      sampled_frame_count: null,
      total_patch_tokens: null,
      patch_tokens_per_frame: null,
      patch_token_dim: null,
      sampling_strategy: requestedStrategy,
      video_sha256: inputBuf ? sha256(inputBuf) : null,
      frames_sha256: null,
    };
  }

  // Enrich the inner envelope with W773b metadata. The tokenizer is the
  // source of truth for counts/hashes; we never invent numbers it didn't
  // emit. If the tokenizer returned a count, surface it; otherwise null.
  const env = {
    ok: !!inner.ok,
    kind: 'video',
    media_uri: mediaUri,
    tokenizer: inner.tokenizer || found.name,
    model: inner.model || modelName,
    duration_ms: (inner && typeof inner.duration_ms === 'number') ? inner.duration_ms : null,
    fps: (inner && typeof inner.fps === 'number') ? inner.fps : null,
    sampled_frame_count: (inner && Number.isFinite(inner.sampled_frame_count)) ? inner.sampled_frame_count : null,
    patch_tokens_per_frame: (inner && Number.isFinite(inner.patch_tokens_per_frame)) ? inner.patch_tokens_per_frame : null,
    total_patch_tokens: (inner && Number.isFinite(inner.total_patch_tokens))
      ? inner.total_patch_tokens
      : ((Number.isFinite(inner.sampled_frame_count) && Number.isFinite(inner.patch_tokens_per_frame))
          ? inner.sampled_frame_count * inner.patch_tokens_per_frame
          : null),
    patch_token_dim: (inner && Number.isFinite(inner.patch_token_dim)) ? inner.patch_token_dim : null,
    sampling_strategy: inner.sampling_strategy || requestedStrategy,
    video_sha256: inner.video_sha256 || (inputBuf ? sha256(inputBuf) : null),
    frames_sha256: inner.frames_sha256 || null,
    bytes_in: inputBuf ? inputBuf.length : null,
    num_frames_requested: numFrames,
    num_frames_cap: NUM_FRAMES_CAP,
    tokenizer_envelope: inner,
  };
  return env;
}

// ---------- tokenizer location ----------

function locateTokenizer() {
  // 1. KOLM_VIDEO_TOKENIZE_CMD env override - accepts a single command
  //    (no args) or a JSON array of [cmd, ...args].
  const ovr = process.env.KOLM_VIDEO_TOKENIZE_CMD;
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
    // Probe-only: if the resolved cmd does not exist, fall through.
    // We do NOT return a stub tokenizer for a non-existent override.
    const resolved = whichSync(cmd);
    const exists = resolved || (safeExists(cmd) && safeIsFile(cmd));
    if (exists) {
      return { name: 'env_override:' + (resolved || cmd), source: 'env', cmd: resolved || cmd, args: cargs };
    }
  }

  // 2. kolm-video-tokenize on PATH.
  const onPath = whichSync(process.platform === 'win32' ? 'kolm-video-tokenize.exe' : 'kolm-video-tokenize');
  if (onPath) {
    return { name: 'kolm-video-tokenize', source: 'path', cmd: onPath, args: [] };
  }

  // 3. ~/.kolm/scripts/video-tokenize.py invoked via python3.
  const script = path.join(os.homedir(), '.kolm', 'scripts', 'video-tokenize.py');
  const py3 = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (py3 && safeExists(script)) {
    return { name: 'video-tokenize.py', source: 'home', cmd: py3, args: [script] };
  }

  return null;
}

function whichSync(name) {
  if (!name) return null;
  // Absolute or relative path with separator - return as-is if it exists.
  if (name.includes('/') || name.includes('\\')) {
    try {
      if (fs.existsSync(name) && fs.statSync(name).isFile()) return name;
    } catch (_) {} // deliberate: cleanup
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
      } catch (_) {} // deliberate: cleanup
    }
  }
  return null;
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function safeIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
