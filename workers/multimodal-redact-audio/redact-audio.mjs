#!/usr/bin/env node
// workers/multimodal-redact-audio/redact-audio.mjs
//
// W464 — isolated kolm multimodal AUDIO voiceprint scrub worker.
//
// Closes the audit P1 Multimodal cluster open item: "audio-side
// voiceprint scrub". W454 already ships an audio-to-text path (whisper
// transcription + privacy-membrane text redaction). W462 ships pixel-
// space image redaction. W464 ships the THIRD media-side primitive:
// voiceprint anonymization on the raw audio.
//
// The threat model: leaked audio of a customer / patient / suspect whose
// VOICE itself is identifying — even after the transcript text is
// redacted, a voiceprint match against a public sample re-identifies the
// speaker. W464 anonymizes the voiceprint (pitch + formant + prosody
// scramble) while preserving content. Combined with W454 transcript
// scrub, you get "what was said" and "who said it" both severed.
//
// HEAVY-DEPS BOUNDARY (per standing directive: "Heavy ML deps must live
// in an isolated worker/package/script"). The real anonymizer is a
// Python tool (pyannote.audio + torch + speaker embedding models). It
// lives OUTSIDE this Node worker. The worker is a thin shell that
// spawns the external command. Root kolm install does NOT pull pyannote
// or torch.
//
// HONESTY CONTRACT: when no external redactor is wired the worker
// returns {ok:false, install_hint, redacted_audio:null}. It NEVER
// silently claims it scrubbed a voiceprint it could not modify. This is
// the load-bearing invariant for the "no softened claims" directive in
// the multimodal cluster.
//
// PIPELINE
//   1. Resolve the audio source to bytes (--path <file> or --uri
//      <file:sha256.ext> via media-store).
//   2. Locate the external voiceprint redactor:
//        $VOICEPRINT_REDACT_CMD       (env override, e.g. a test stub)
//        pyannote-audio-redact        (on PATH)
//        python3 ~/.kolm/scripts/voiceprint-redact.py  (user-installed)
//      The first one found wins. Doctor mode reports which is wired.
//   3. Spawn the redactor with --input <wav> --output <wav>
//      [--strength <0..1>]. The redactor MUST emit one JSON line on
//      stdout summarizing what it did.
//   4. Read the redacted audio bytes back and either write to
//      --output <path> or emit base64 inline in the envelope.
//
// MODES
//   --doctor                print toolchain readiness, exit 0.
//   --path <file>           local audio file path (wav/flac/mp3).
//   --uri <file:sha256.ext> media-store-resolved uri.
//   --output <path>         write redacted audio to disk (else inline b64).
//   --strength <0..1>       anonymization strength (default 0.7).
//   --max-bytes <N>         cap upstream bytes (default 50 MiB).
//   --json                  emit a single JSON envelope (default).
//
// OUTPUT ENVELOPE (always JSON, one line, on stdout)
//   {
//     ok:                    bool,
//     kind:                  'audio',
//     media_uri:             <uri> | null,
//     redactor:              'pyannote-audio-redact' | '<env-override>' | null,
//     strength:              <0..1>,
//     duration_ms:           <int> | null,
//     output_path:           <path> | null,
//     output_b64:            <base64> | null,
//     redacted_audio_sha256: '...' | null,
//     install_hint?:         <string>     // present iff no redactor wired
//   }
//
// EXIT CODES
//   0  ok (anonymization applied; redactor honored the contract)
//   2  bad args
//   3  no voiceprint redactor installed (install_hint set, redacted_audio=null)
//   4  audio not found / could not load
//   5  redactor crashed / did not emit envelope
//   6  encode/write failed
//
// Tests inject a Node-based stub via VOICEPRINT_REDACT_CMD so the
// honesty AND the working-path can both be exercised without pyannote
// on disk.

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
    redactor: null,
    redacted_audio_sha256: null,
    output_path: null,
    output_b64: null,
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
    if (k === '--doctor')          { a.doctor = true; }
    else if (k === '--path')       { a.path = v; i++; }
    else if (k === '--uri')        { a.uri = v; i++; }
    else if (k === '--output')     { a.output = v; i++; }
    else if (k === '--strength')   { a.strength = parseFloat(v); i++; }
    else if (k === '--max-bytes')  { a.max_bytes = parseInt(v, 10); i++; }
    else if (k === '--json')       { a.json = true; }
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
  const found = locateRedactor();

  const py = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  const ff = whichSync(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  // Spec follows the W462 doctor convention so the
  // kolm-multimodal-redact-*-worker-doctor envelope shape stays uniform.
  const r = {
    spec: 'kolm-multimodal-redact-audio-worker-doctor',
    version: '0.1.0',
    wave: 'W464',
    kind: 'audio-redact-doctor',
    runtime: {
      // python3 + ffmpeg are informational — a non-Python custom
      // redactor wired via VOICEPRINT_REDACT_CMD is still valid.
      python3: { path: py, ok: !!py },
      ffmpeg: { path: ff, ok: !!ff },
    },
    detectors: {
      voiceprint: found
        ? { ok: true, name: found.name, source: found.source }
        : { ok: false, name: null, source: null, install_hint:
            'no voiceprint redactor wired. install one of: ' +
            '(a) pip install pyannote.audio + drop a wrapper named pyannote-audio-redact on PATH; ' +
            '(b) set $VOICEPRINT_REDACT_CMD to an executable accepting --input <wav> --output <wav> [--strength 0..1]; ' +
            '(c) drop a script at ~/.kolm/scripts/voiceprint-redact.py invoked via python3.' },
    },
    env: {
      node: process.version,
      platform: process.platform,
      home: os.homedir(),
    },
    install_hint: null,
    ready: !!found,
    ok: true,
  };

  if (!found) {
    r.ok = false;
    r.install_hint = r.detectors.voiceprint.install_hint;
  }
  return r;
}

// ---------- main ----------

async function main(a) {
  if (!a.path && !a.uri) {
    return {
      ok: false,
      kind: 'audio',
      error: 'bad_args: --path or --uri is required',
      _exit_code: 2,
      redactor: null,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  // Resolve input bytes.
  let inputPath = a.path || null;
  let inputBuf  = null;
  let mediaUri  = a.uri || null;
  const maxBytes = Number.isFinite(a.max_bytes) ? a.max_bytes : 50 * 1024 * 1024;

  if (inputPath) {
    if (!fs.existsSync(inputPath)) {
      return {
        ok: false,
        kind: 'audio',
        error: 'audio_not_found: ' + inputPath,
        _exit_code: 4,
        redactor: null,
        redacted_audio_sha256: null,
        output_path: null,
        output_b64: null,
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
          kind: 'audio',
          media_uri: mediaUri,
          error: 'audio_not_found: ' + mediaUri,
          _exit_code: 4,
          redactor: null,
          redacted_audio_sha256: null,
          output_path: null,
          output_b64: null,
        };
      }
      inputBuf = Buffer.from(bytes);
      // Write to a temp file for the redactor.
      inputPath = path.join(os.tmpdir(), 'kolm-w464-in-' + crypto.randomBytes(6).toString('hex') + '.wav');
      fs.writeFileSync(inputPath, inputBuf);
    } catch (e) {
      return {
        ok: false,
        kind: 'audio',
        media_uri: mediaUri,
        error: 'media_resolve_failed: ' + String(e.message || e),
        _exit_code: 4,
        redactor: null,
        redacted_audio_sha256: null,
        output_path: null,
        output_b64: null,
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
      redactor: null,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  // Locate the redactor.
  const found = locateRedactor();
  if (!found) {
    const d = await doctor();
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      error: 'no_detector_installed',
      install_hint: d.install_hint,
      _exit_code: 3,
      redactor: null,
      strength: Number.isFinite(a.strength) ? a.strength : 0.7,
      redacted_audio: null,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  // Spawn the redactor.
  const outPath = a.output || path.join(os.tmpdir(), 'kolm-w464-out-' + crypto.randomBytes(6).toString('hex') + '.wav');
  const strength = Number.isFinite(a.strength) ? a.strength : 0.7;
  const cargs = ['--input', inputPath, '--output', outPath, '--strength', String(strength)];

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
      kind: 'audio',
      media_uri: mediaUri,
      redactor: found.name,
      strength,
      error: 'redactor_spawn_failed: ' + String(e.message || e),
      _exit_code: 5,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  // Parse the redactor's JSON envelope.
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
      redactor: found.name,
      strength,
      error: 'redactor_failed',
      exit_code: res.status,
      stderr: String(res.stderr || '').slice(0, 500),
      _exit_code: 5,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  // Read the redacted audio back.
  if (!fs.existsSync(outPath)) {
    return {
      ok: false,
      kind: 'audio',
      media_uri: mediaUri,
      redactor: found.name,
      strength,
      error: 'redactor_did_not_write_output: ' + outPath,
      _exit_code: 6,
      redacted_audio_sha256: null,
      output_path: null,
      output_b64: null,
    };
  }

  const redactedBuf = fs.readFileSync(outPath);
  const sha = crypto.createHash('sha256').update(redactedBuf).digest('hex');

  const env = {
    ok: true,
    kind: 'audio',
    media_uri: mediaUri,
    redactor: found.name,
    strength,
    duration_ms: (inner && typeof inner.duration_ms === 'number') ? inner.duration_ms : null,
    output_path: a.output ? outPath : null,
    output_b64: a.output ? null : redactedBuf.toString('base64'),
    redacted_audio_sha256: sha,
    bytes_in: inputBuf ? inputBuf.length : null,
    bytes_out: redactedBuf.length,
    redactor_envelope: inner,
  };
  return env;
}

// ---------- redactor location ----------

function locateRedactor() {
  // 1. VOICEPRINT_REDACT_CMD env override — accepts a single command
  //    (no args) or a JSON array of [cmd, ...args].
  const ovr = process.env.VOICEPRINT_REDACT_CMD;
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
    // Probe-only: if the resolved cmd does not exist, fall through. We
    // do not return a stub redactor for a non-existent override.
    const resolved = whichSync(cmd);
    const exists = resolved || (fs.existsSync(cmd) && fs.statSync(cmd).isFile());
    if (exists) {
      return { name: 'env_override:' + (resolved || cmd), source: 'env', cmd: resolved || cmd, args: cargs };
    }
  }

  // 2. pyannote-audio-redact on PATH.
  const py = whichSync(process.platform === 'win32' ? 'pyannote-audio-redact.exe' : 'pyannote-audio-redact');
  if (py) {
    return { name: 'pyannote-audio-redact', source: 'path', cmd: py, args: [] };
  }

  // 3. ~/.kolm/scripts/voiceprint-redact.py invoked via python3.
  const script = path.join(os.homedir(), '.kolm', 'scripts', 'voiceprint-redact.py');
  const py3 = whichSync(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (py3 && fs.existsSync(script)) {
    return { name: 'voiceprint-redact.py', source: 'home', cmd: py3, args: [script] };
  }

  return null;
}

function whichSync(name) {
  if (!name) return null;
  // Absolute or relative path with separator — return as-is if it exists.
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
