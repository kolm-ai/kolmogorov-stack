#!/usr/bin/env node
// workers/vision-tokenize/tokenize.mjs
//
// W771b -- isolated kolm vision tokenizer worker (CLIP / SigLIP patches).
//
// W771 shipped the VLM capture + bake-off + trainer SCAFFOLDING. The
// trainer (apps/trainer/vlm_distill.py) is stdlib-only --dry-run and
// never actually tokenizes images into patch embeddings.
//
// W771b ships the REAL tokenizer as an opt-in worker, modeled exactly
// on the W462 / W464 pattern: heavy ML deps live OUTSIDE Node in an
// opt-in Python process; root kolm install stays light. When the
// Python toolchain or the requested CLIPProcessor model is not on
// disk the worker returns an honest no_detector_installed envelope --
// it NEVER silently invents patch_token_count or claims it tokenized
// pixels it could not see.
//
// PIPELINE
//   1. Resolve the image source to bytes (--path / --uri / --url).
//   2. Compute image_sha256 over the raw bytes.
//   3. Locate the external tokenizer via priority chain:
//        $KOLM_VISION_TOKENIZE_CMD     (env override; JSON array allowed)
//        kolm-vision-tokenize          (on PATH)
//        python3 ~/.kolm/scripts/vision-tokenize.py
//      The first one found wins. --doctor reports which (if any).
//   4. Spawn the tokenizer with --path <img> --model <name> --json. The
//      tokenizer MUST emit one JSON line on stdout summarizing what it
//      produced: {patch_token_count, patch_token_dim, cls_token_present,
//      patches_sha256?}.
//   5. Re-emit a single canonical W771b envelope merging the upstream
//      sha + the tokenizer-reported counts.
//
// MODES
//   --doctor              print toolchain + tokenizer readiness; exit 0.
//   --path <file>         local image (jpg / png / webp / bmp).
//   --uri <file:sha.ext>  media-store-resolved URI.
//   --url <https://...>   remote URL (fetched bytes; subject to --max-bytes).
//   --model <name>        CLIP / SigLIP model id (default openai/clip-vit-large-patch14).
//   --max-bytes <N>       cap upstream bytes (default 50 MiB).
//   --json                emit a single JSON envelope (default).
//
// OUTPUT ENVELOPE (always JSON, one line, on stdout)
//   {
//     ok:                  bool,
//     kind:                'vision',
//     media_uri:           <uri> | null,
//     tokenizer:           'env_override:...' | 'kolm-vision-tokenize' |
//                          'vision-tokenize.py' | null,
//     model:               <string> | null,
//     patch_token_count:   <int> | null,
//     patch_token_dim:     <int> | null,
//     cls_token_present:   <bool> | null,
//     image_sha256:        <hex> | null,
//     patches_sha256:      <hex> | null,
//     install_hint?:       <string>          // present iff no tokenizer wired
//   }
//
// EXIT CODES
//   0  ok (tokenizer ran and emitted a structured envelope).
//   2  bad args.
//   3  no tokenizer installed (install_hint set; patch_token_count=null).
//   4  image not found / could not load.
//   5  tokenizer crashed / did not emit a parseable envelope.
//
// HONESTY CONTRACT: when the tokenizer is missing OR crashes OR returns
// a malformed envelope, this worker returns {ok:false, ...,
// patch_token_count:null}. It NEVER fabricates a token count. This is
// the load-bearing invariant for the "no softened claims" directive in
// the multimodal cluster.

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

const DEFAULT_MODEL = 'openai/clip-vit-large-patch14';
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

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
    kind: 'vision',
    error: String(e && e.message || e),
    tokenizer: null,
    model: null,
    patch_token_count: null,
    patch_token_dim: null,
    cls_token_present: null,
    image_sha256: null,
    patches_sha256: null,
    media_uri: null,
  };
  process.stdout.write(JSON.stringify(fail) + '\n');
  process.exit((e && e._exit) || 5);
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const a = { doctor: false, json: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--doctor')          { a.doctor = true; }
    else if (k === '--path')       { a.path = v; i++; }
    else if (k === '--uri')        { a.uri = v; i++; }
    else if (k === '--url')        { a.url = v; i++; }
    else if (k === '--model')      { a.model = v; i++; }
    else if (k === '--max-bytes')  { a.max_bytes = parseInt(v, 10); i++; }
    else if (k === '--json')       { a.json = true; }
  }
  return a;
}

function envExitCode(env) {
  if (env.ok) return 0;
  if (env._exit_code) return env._exit_code;
  if (env.error === 'no_detector_installed') return 3;
  if (env.error === 'image_not_found' || env.error === 'image_load_failed') return 4;
  if (env.error === 'no_image_source' || env.error === 'oversize') return 2;
  return 5;
}

// ---------- doctor ----------

async function doctor() {
  const found = locateTokenizer();
  const py = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  const script = path.join(os.homedir(), '.kolm', 'scripts', 'vision-tokenize.py');

  // Probe individual Python deps. None of these are required if the
  // tokenizer is wired via $KOLM_VISION_TOKENIZE_CMD as a non-Python
  // binary, but they ARE the documented happy path so we report them.
  const transformers = py ? probePyImport(py, 'transformers') : { ok: false };
  const torchDep     = py ? probePyImport(py, 'torch')        : { ok: false };
  const pilDep       = py ? probePyImport(py, 'PIL')          : { ok: false };

  const r = {
    spec: 'kolm-vision-tokenize-worker-doctor',
    version: '0.1.0',
    wave: 'W771b',
    kind: 'vision-tokenize-doctor',
    env: {
      node: process.version,
      platform: process.platform,
      home: os.homedir(),
      env_override_set: !!process.env.KOLM_VISION_TOKENIZE_CMD,
    },
    runtime: {
      python3: { path: py || null, ok: !!py },
      transformers: transformers,
      torch: torchDep,
      pillow: pilDep,
      home_script: { path: script, ok: fs.existsSync(script) },
    },
    tokenizer: found
      ? { ok: true, name: found.name, source: found.source }
      : { ok: false, name: null, source: null, install_hint:
          'no vision tokenizer wired. install one of: ' +
          '(a) pip install transformers torch Pillow + drop a wrapper on PATH named kolm-vision-tokenize; ' +
          '(b) set $KOLM_VISION_TOKENIZE_CMD to a binary accepting --path <file> --model <name> --json that emits the W771b envelope on stdout; ' +
          '(c) drop a script at ~/.kolm/scripts/vision-tokenize.py invoked via python3.' },
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

function probePyImport(pyBin, mod) {
  try {
    const res = spawnSync(pyBin, ['-c', 'import ' + mod + '; print("ok")'], {
      stdio: 'pipe',
      timeout: 15 * 1000,
      encoding: 'utf8',
    });
    if (res.status === 0 && String(res.stdout || '').includes('ok')) {
      return { ok: true, module: mod };
    }
    return { ok: false, module: mod };
  } catch (_) {
    return { ok: false, module: mod };
  }
}

// ---------- main ----------

async function main(a) {
  if (!a.path && !a.uri && !a.url) {
    return {
      ok: false,
      kind: 'vision',
      error: 'no_image_source',
      hint: 'pass one of --path <file> / --uri <file:sha.ext> / --url <https://...>',
      tokenizer: null,
      model: a.model || DEFAULT_MODEL,
      patch_token_count: null,
      patch_token_dim: null,
      cls_token_present: null,
      image_sha256: null,
      patches_sha256: null,
      media_uri: null,
      _exit_code: 2,
    };
  }

  const maxBytes = Number.isFinite(a.max_bytes) ? a.max_bytes : DEFAULT_MAX_BYTES;
  const model = a.model || DEFAULT_MODEL;
  let mediaUri = a.uri || a.url || a.path || null;

  // Resolve input bytes + a concrete file path for the tokenizer.
  let inputPath = null;
  let inputBuf = null;

  if (a.path) {
    if (!fs.existsSync(a.path)) {
      return {
        ok: false,
        kind: 'vision',
        error: 'image_not_found',
        media_uri: mediaUri,
        tokenizer: null,
        model,
        patch_token_count: null,
        patch_token_dim: null,
        cls_token_present: null,
        image_sha256: null,
        patches_sha256: null,
        _exit_code: 4,
      };
    }
    inputPath = a.path;
    try {
      inputBuf = fs.readFileSync(a.path);
    } catch (e) {
      return {
        ok: false,
        kind: 'vision',
        error: 'image_load_failed',
        detail: String(e.message || e),
        media_uri: mediaUri,
        tokenizer: null,
        model,
        patch_token_count: null,
        patch_token_dim: null,
        cls_token_present: null,
        image_sha256: null,
        patches_sha256: null,
        _exit_code: 4,
      };
    }
  } else if (a.uri) {
    try {
      const ms = await import(path.resolve(ROOT, 'src', 'media-store.js'));
      const fn = ms.resolveMediaBytes || ms.loadBlob;
      if (typeof fn !== 'function') {
        return {
          ok: false,
          kind: 'vision',
          error: 'media_store_unavailable',
          media_uri: mediaUri,
          tokenizer: null,
          model,
          patch_token_count: null,
          patch_token_dim: null,
          cls_token_present: null,
          image_sha256: null,
          patches_sha256: null,
          _exit_code: 4,
        };
      }
      const bytes = await fn(a.uri, { max_bytes: maxBytes });
      if (!bytes || !bytes.length) {
        return {
          ok: false,
          kind: 'vision',
          error: 'image_not_found',
          media_uri: mediaUri,
          tokenizer: null,
          model,
          patch_token_count: null,
          patch_token_dim: null,
          cls_token_present: null,
          image_sha256: null,
          patches_sha256: null,
          _exit_code: 4,
        };
      }
      inputBuf = Buffer.from(bytes);
      inputPath = path.join(os.tmpdir(), 'kolm-w771b-in-' + crypto.randomBytes(6).toString('hex') + '.img');
      fs.writeFileSync(inputPath, inputBuf);
    } catch (e) {
      return {
        ok: false,
        kind: 'vision',
        error: 'image_load_failed',
        detail: String(e.message || e),
        media_uri: mediaUri,
        tokenizer: null,
        model,
        patch_token_count: null,
        patch_token_dim: null,
        cls_token_present: null,
        image_sha256: null,
        patches_sha256: null,
        _exit_code: 4,
      };
    }
  } else if (a.url) {
    try {
      const resp = await fetch(a.url);
      if (!resp.ok) {
        return {
          ok: false,
          kind: 'vision',
          error: 'image_not_found',
          detail: 'http ' + resp.status,
          media_uri: mediaUri,
          tokenizer: null,
          model,
          patch_token_count: null,
          patch_token_dim: null,
          cls_token_present: null,
          image_sha256: null,
          patches_sha256: null,
          _exit_code: 4,
        };
      }
      const ab = await resp.arrayBuffer();
      inputBuf = Buffer.from(ab);
      inputPath = path.join(os.tmpdir(), 'kolm-w771b-in-' + crypto.randomBytes(6).toString('hex') + '.img');
      fs.writeFileSync(inputPath, inputBuf);
    } catch (e) {
      return {
        ok: false,
        kind: 'vision',
        error: 'image_load_failed',
        detail: String(e.message || e),
        media_uri: mediaUri,
        tokenizer: null,
        model,
        patch_token_count: null,
        patch_token_dim: null,
        cls_token_present: null,
        image_sha256: null,
        patches_sha256: null,
        _exit_code: 4,
      };
    }
  }

  if (inputBuf && inputBuf.length > maxBytes) {
    return {
      ok: false,
      kind: 'vision',
      error: 'oversize',
      got_bytes: inputBuf.length,
      limit_bytes: maxBytes,
      media_uri: mediaUri,
      tokenizer: null,
      model,
      patch_token_count: null,
      patch_token_dim: null,
      cls_token_present: null,
      image_sha256: null,
      patches_sha256: null,
      _exit_code: 2,
    };
  }

  const image_sha256 = inputBuf
    ? crypto.createHash('sha256').update(inputBuf).digest('hex')
    : null;

  // Locate the tokenizer.
  const found = locateTokenizer();
  if (!found) {
    const d = await doctor();
    return {
      ok: false,
      kind: 'vision',
      media_uri: mediaUri,
      error: 'no_detector_installed',
      install_hint: d.install_hint,
      tokenizer: null,
      model,
      patch_token_count: null,
      patch_token_dim: null,
      cls_token_present: null,
      image_sha256,
      patches_sha256: null,
      _exit_code: 3,
    };
  }

  // Spawn the tokenizer.
  const cargs = ['--path', inputPath, '--model', model, '--json'];
  let res;
  try {
    res = spawnSync(found.cmd, [...found.args, ...cargs], {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'vision',
      media_uri: mediaUri,
      tokenizer: found.name,
      model,
      error: 'tokenizer_spawn_failed',
      detail: String(e.message || e),
      patch_token_count: null,
      patch_token_dim: null,
      cls_token_present: null,
      image_sha256,
      patches_sha256: null,
      _exit_code: 5,
    };
  }

  // Parse the tokenizer's last-line JSON envelope.
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
      kind: 'vision',
      media_uri: mediaUri,
      tokenizer: found.name,
      model,
      error: 'tokenizer_failed',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      patch_token_count: null,
      patch_token_dim: null,
      cls_token_present: null,
      image_sha256,
      patches_sha256: null,
      _exit_code: 5,
    };
  }

  // Honest envelope: merge upstream sha + tokenizer-reported counts.
  // HONESTY INVARIANT: never fabricate counts. If the tokenizer omitted a
  // field we leave it null in our envelope.
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
  const strOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

  const env = {
    ok: true,
    kind: 'vision',
    media_uri: mediaUri,
    tokenizer: found.name,
    model: strOrNull(inner.model) || model,
    patch_token_count: numOrNull(inner.patch_token_count),
    patch_token_dim: numOrNull(inner.patch_token_dim),
    cls_token_present: boolOrNull(inner.cls_token_present),
    image_sha256,
    patches_sha256: strOrNull(inner.patches_sha256),
    bytes_in: inputBuf ? inputBuf.length : null,
    tokenizer_envelope: inner,
  };
  return env;
}

// ---------- tokenizer location ----------

function locateTokenizer() {
  // 1. KOLM_VISION_TOKENIZE_CMD env override -- accepts a single command
  //    (no args) or a JSON array of [cmd, ...args].
  const ovr = process.env.KOLM_VISION_TOKENIZE_CMD;
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
    const exists = resolved || (safeIsFile(cmd));
    if (exists) {
      return { name: 'env_override:' + (resolved || cmd), source: 'env', cmd: resolved || cmd, args: cargs };
    }
  }

  // 2. kolm-vision-tokenize on PATH.
  const onpath = whichSync(process.platform === 'win32' ? 'kolm-vision-tokenize.exe' : 'kolm-vision-tokenize');
  if (onpath) {
    return { name: 'kolm-vision-tokenize', source: 'path', cmd: onpath, args: [] };
  }

  // 3. ~/.kolm/scripts/vision-tokenize.py invoked via python3.
  const script = path.join(os.homedir(), '.kolm', 'scripts', 'vision-tokenize.py');
  const py3 = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (py3 && fs.existsSync(script)) {
    return { name: 'vision-tokenize.py', source: 'home', cmd: py3, args: [script] };
  }

  return null;
}

function safeIsFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
  catch (_) { return false; }
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
