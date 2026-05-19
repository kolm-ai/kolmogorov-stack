#!/usr/bin/env node
// workers/media-redact/redact.mjs
//
// W454 — isolated kolm multimodal redaction worker.
//
// Closes the W452 deferred surface: /v1/media/redact returns
// {ok:true, deferred:true, deferral:{kind, worker, hint}} for any
// non-text-extractable mime (image/audio/video/pdf). This worker is the
// `worker` field in that envelope — it extracts the text first, then
// routes the extracted text through the same redactor as the text route.
//
// PIPELINE
//   1. Resolve the media_uri to bytes (via src/media-store.js loadBlob).
//   2. Detect kind (image|audio|video|pdf) from the mime type.
//   3. Extract text via the kind's extractor:
//        image → tesseract.js OCR  (optional dep)
//        pdf   → pdf-parse         (optional dep)
//        audio → whisper-cli       (external binary on PATH)
//        video → ffmpeg + whisper  (external binaries on PATH)
//   4. Apply src/privacy-membrane.js redactWithPolicy to the extracted text.
//   5. Emit a structured result envelope to stdout (JSON, one line).
//
// MODES
//   --doctor                print toolchain readiness and exit.
//   --kind <image|audio|video|pdf>
//   --uri <file:sha256.ext>  resolved via src/media-store.js
//   --mime <type>            optional explicit mime
//   --max-bytes <N>          cap upstream bytes (default 50 MiB)
//   --json                   emit a single JSON envelope (default)
//   --plain                  emit redacted text only (no envelope)
//
// OUTPUT ENVELOPE
//   {
//     ok: bool,
//     kind: <kind>,
//     media_uri: <uri>,
//     extracted_chars: <int>,
//     extractor: <tesseract.js|pdf-parse|whisper-cli|ffmpeg+whisper|null>,
//     redacted: <string>,
//     classes_seen: [<class>],
//     count_by_class: {<class>:<int>},
//     map_hash: 'sha256:...',
//     detector_version: '...',
//     install_hint?: <string>     // present when extractor not installed
//   }
//
// EXIT CODES
//   0  ok
//   2  bad args
//   3  extractor not installed (install_hint in envelope)
//   4  media not found
//   5  extraction failed
//   6  redactor failed
//
// The worker is OPTIONAL — root kolm install does NOT pull tesseract.js
// or pdf-parse. Users opt in by `cd workers/media-redact && npm install`.
// `kolm media doctor` summarizes which extractors are wired.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

// tesseract.js Worker thread re-throws decoder errors via process.nextTick AFTER
// the recognize() promise rejects — that crashes Node with exit 1 unless we trap
// it here. Treat the late throw as extract_failed (exit 5) and emit an honest
// JSON envelope first so JSON-parsing callers get the same shape as the
// synchronous failure path.
let _extractFailedEmitted = false;
process.on('uncaughtException', (err) => {
  const msg = String(err && err.message || err).slice(0, 200);
  try { process.stderr.write('[media-redact] uncaughtException trapped: ' + msg + '\n'); } catch (_) {}
  if (!_extractFailedEmitted) {
    try { process.stdout.write(JSON.stringify({ ok: false, error: 'extract_failed', detail: msg }) + '\n'); } catch (_) {}
  }
  process.exit(5);
});

const args = parseArgs(process.argv.slice(2));

if (args.doctor) {
  const r = await doctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(0);
}

// Validate required args.
if (!args.uri && !args.path) {
  emit({ ok: false, error: 'uri_required', hint: 'pass --uri <file:sha256.ext> or --path <local file>' });
  process.exit(2);
}
const kind = args.kind || sniffKindFromMime(args.mime) || sniffKindFromUri(args.uri || args.path);
if (!kind) {
  emit({ ok: false, error: 'kind_required', hint: 'pass --kind image|audio|video|pdf or include extension in uri' });
  process.exit(2);
}

const MAX_BYTES = Number(args['max-bytes']) || 50 * 1024 * 1024;

let bytes = null;
try {
  bytes = await loadBytes(args);
} catch (e) {
  if (e && e.code === 'ENOENT') {
    emit({ ok: false, error: 'media_not_found', media_uri: args.uri || args.path });
    process.exit(4);
  }
  emit({ ok: false, error: 'media_load_failed', detail: String(e && e.message || e) });
  process.exit(4);
}
if (bytes.byteLength > MAX_BYTES) {
  emit({ ok: false, error: 'oversize', got_bytes: bytes.byteLength, limit_bytes: MAX_BYTES });
  process.exit(2);
}

// Extract text.
let extraction = null;
try {
  extraction = await extractText(kind, bytes, args);
} catch (e) {
  emit({ ok: false, error: 'extract_failed', kind, detail: String(e && e.message || e) });
  process.exit(5);
}
if (!extraction || extraction.ok === false) {
  // Two failure modes: extractor missing (exit 3 + install_hint) vs extractor
  // present but extraction blew up on bad bytes (exit 5 + detail). Differentiate
  // so the caller can tell "install something" from "fix your input".
  if (extraction && extraction.error === 'extract_failed') {
    emit({
      ok: false,
      error: 'extract_failed',
      kind,
      media_uri: args.uri || args.path,
      extractor: extraction.extractor || null,
      detail: extraction.detail || null,
    });
    process.exit(5);
  }
  emit({
    ok: false,
    error: 'extractor_not_installed',
    kind,
    media_uri: args.uri || args.path,
    extractor: extraction && extraction.extractor || null,
    install_hint: (extraction && extraction.install_hint) || installHintForKind(kind),
  });
  process.exit(3);
}

// Redact.
let redaction = null;
try {
  const { redactWithPolicy } = await import(path.join(ROOT, 'src', 'privacy-membrane.js'));
  const r = redactWithPolicy(extraction.text || '');
  const counters = {};
  for (const cls of (r.classes_seen || [])) counters[cls] = (counters[cls] || 0) + 1;
  const mapHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(r.map || {})).digest('hex');
  redaction = {
    redacted: r.redacted_text || r.redacted || '',
    classes_seen: r.classes_seen || [],
    blocked_classes: r.blocked_classes || [],
    count_by_class: counters,
    map_hash: mapHash,
    detector_version: r.detector_version || null,
  };
} catch (e) {
  emit({ ok: false, error: 'redact_failed', detail: String(e && e.message || e) });
  process.exit(6);
}

emit({
  ok: true,
  kind,
  media_uri: args.uri || args.path,
  extractor: extraction.extractor,
  extracted_chars: (extraction.text || '').length,
  ...redaction,
});
process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(obj) {
  if (args.plain && obj && obj.ok && typeof obj.redacted === 'string') {
    process.stdout.write(obj.redacted);
    return;
  }
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doctor' || a === '--json' || a === '--plain') { out[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function sniffKindFromMime(mime) {
  if (!mime) return null;
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  return null;
}

function sniffKindFromUri(uri) {
  if (!uri) return null;
  const ext = path.extname(String(uri)).toLowerCase().replace('.', '');
  if (['png','jpg','jpeg','gif','webp','bmp','tiff'].includes(ext)) return 'image';
  if (['mp3','wav','m4a','ogg','flac','aac'].includes(ext)) return 'audio';
  if (['mp4','mov','mkv','webm','avi'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return null;
}

async function loadBytes(args) {
  if (args.path) {
    return fs.readFileSync(args.path);
  }
  if (args.uri) {
    const ms = await import(path.join(ROOT, 'src', 'media-store.js'));
    return await ms.loadBlob(args.uri);
  }
  throw new Error('no source');
}

async function extractText(kind, bytes, args) {
  if (kind === 'pdf') {
    let mod = null;
    try { mod = await import('pdf-parse'); } catch (_) {
      return { ok: false, extractor: 'pdf-parse', install_hint: installHintForKind(kind) };
    }
    const fn = mod && (mod.default || mod);
    const res = await fn(bytes);
    return { ok: true, extractor: 'pdf-parse', text: String(res && res.text || '') };
  }
  if (kind === 'image') {
    let tess = null;
    try { tess = await import('tesseract.js'); } catch (_) {
      return { ok: false, extractor: 'tesseract.js', install_hint: installHintForKind(kind) };
    }
    const recognize = tess && (tess.recognize || (tess.default && tess.default.recognize));
    if (!recognize) {
      return { ok: false, extractor: 'tesseract.js', install_hint: installHintForKind(kind) };
    }
    try {
      const { data } = await recognize(bytes, args.lang || 'eng');
      return { ok: true, extractor: 'tesseract.js', text: String(data && data.text || '') };
    } catch (e) {
      return { ok: false, extractor: 'tesseract.js', error: 'extract_failed', detail: String(e && e.message || e).slice(0, 200) };
    }
  }
  if (kind === 'audio' || kind === 'video') {
    const whisper = findOnPath(['whisper-cli', 'whisper-cpp', 'whisper']);
    if (!whisper) {
      return { ok: false, extractor: 'whisper-cli', install_hint: installHintForKind(kind) };
    }
    // For video, first extract audio via ffmpeg.
    let audioPath = null;
    let cleanup = null;
    if (kind === 'video') {
      const ffmpeg = findOnPath(['ffmpeg']);
      if (!ffmpeg) {
        return { ok: false, extractor: 'ffmpeg+whisper', install_hint: installHintForKind('video') };
      }
      const tmpVideo = path.join(process.env.TMPDIR || '/tmp', 'kolm-video-' + Date.now() + '.bin');
      const tmpAudio = path.join(process.env.TMPDIR || '/tmp', 'kolm-audio-' + Date.now() + '.wav');
      fs.writeFileSync(tmpVideo, bytes);
      const ff = spawnSync(ffmpeg, ['-y', '-i', tmpVideo, '-vn', '-ar', '16000', '-ac', '1', tmpAudio], { stdio: 'pipe' });
      try { fs.unlinkSync(tmpVideo); } catch (_) {}
      if (ff.status !== 0) {
        return { ok: false, extractor: 'ffmpeg+whisper', install_hint: 'ffmpeg failed: ' + (ff.stderr && ff.stderr.toString().slice(0, 200)) };
      }
      audioPath = tmpAudio;
      cleanup = () => { try { fs.unlinkSync(tmpAudio); } catch (_) {} };
    } else {
      audioPath = path.join(process.env.TMPDIR || '/tmp', 'kolm-audio-' + Date.now() + '.bin');
      fs.writeFileSync(audioPath, bytes);
      cleanup = () => { try { fs.unlinkSync(audioPath); } catch (_) {} };
    }
    // Whisper-cli expects a model file; user can pass --model.
    const wargs = ['-f', audioPath];
    if (args.model) wargs.push('-m', args.model);
    const w = spawnSync(whisper, wargs, { stdio: 'pipe' });
    cleanup();
    if (w.status !== 0) {
      return { ok: false, extractor: 'whisper-cli', install_hint: 'whisper failed: ' + (w.stderr && w.stderr.toString().slice(0, 200)) };
    }
    return { ok: true, extractor: kind === 'video' ? 'ffmpeg+whisper' : 'whisper-cli', text: String(w.stdout || '') };
  }
  throw new Error('unknown kind: ' + kind);
}

function findOnPath(names) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(sep);
  for (const n of names) {
    for (const d of dirs) {
      for (const e of exts) {
        const p = path.join(d, n + e);
        try { if (fs.existsSync(p)) return p; } catch (_) {}
      }
    }
  }
  return null;
}

function installHintForKind(kind) {
  if (kind === 'image') return 'cd workers/media-redact && npm install tesseract.js — WASM OCR, no native deps';
  if (kind === 'pdf')   return 'cd workers/media-redact && npm install pdf-parse — pure JS PDF text extraction';
  if (kind === 'audio') return 'install whisper.cpp (brew install whisper-cpp / apt install whisper) then pass --model <path-to-ggml-model>';
  if (kind === 'video') return 'install ffmpeg AND whisper.cpp (brew install ffmpeg whisper-cpp) then pass --model <path-to-ggml-model>';
  return 'no extractor wired for kind=' + kind;
}

async function doctor() {
  const out = {
    spec: 'kolm-media-redact-worker-doctor',
    version: '0.1.0',
    node_version: process.version,
    extractors: {},
  };
  try { await import('pdf-parse'); out.extractors.pdf = { ok: true, via: 'pdf-parse' }; }
  catch (_) { out.extractors.pdf = { ok: false, install_hint: installHintForKind('pdf') }; }
  try { await import('tesseract.js'); out.extractors.image = { ok: true, via: 'tesseract.js' }; }
  catch (_) { out.extractors.image = { ok: false, install_hint: installHintForKind('image') }; }
  const w = findOnPath(['whisper-cli', 'whisper-cpp', 'whisper']);
  out.extractors.audio = w ? { ok: true, via: w } : { ok: false, install_hint: installHintForKind('audio') };
  const ff = findOnPath(['ffmpeg']);
  out.extractors.video = (w && ff) ? { ok: true, via: 'ffmpeg+' + w } : { ok: false, install_hint: installHintForKind('video') };
  return out;
}
