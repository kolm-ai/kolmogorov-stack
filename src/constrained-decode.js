// W809-2 - Constrained decoding engine integration.
//
// Wraps the workers/constrained/ Python shell that calls outlines (or
// lm-format-enforcer) for JSON-Schema-guided sampling. The heavy ML deps
// stay OUTSIDE Node - the root kolm install pulls ZERO constrained-decoder
// deps. Tenants who want grammar-guided generation install outlines or
// lm-format-enforcer themselves; we surface an honest envelope when neither
// is present rather than silently falling back to unconstrained sampling.
//
// Public surface:
//
//   constrainedDecode({prompt, schema_spec, base_model, sampler_opts}) →
//     {ok, output|null, error|null, decoder, latency_ms}
//
//   doctorConstrainedDecode() → toolchain readiness probe
//
// On a host without outlines AND without lm-format-enforcer, both return:
//
//   {ok:false, error:'no_constrained_decoder',
//    hint:'pip install outlines OR lm-format-enforcer',
//    version:'w809-v1'}
//
// W604 anti-brittleness: doctor returns booleans + the bare detector
// versions; nothing regex'd against free-form messages.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OUTPUT_SCHEMA_VERSION,
  validateOutputSchemaSpec,
  canonicalizeOutputSchemaSpec,
} from './output-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');
const WORKER_SHELL = path.join(ROOT, 'workers', 'constrained', 'constrained.mjs');

// ---------------------------------------------------------------------------
// resolveWorkerCommand - same pattern as src/constrained side of workers/tsac
// + workers/itkv. Tests inject a Node stub via $CONSTRAINED_DECODE_CMD
// (string or JSON array). Default: invoke the workers/constrained/ shell
// which itself wraps the Python script. No silent fallback.
// ---------------------------------------------------------------------------
function resolveWorkerCommand() {
  const ovr = process.env.CONSTRAINED_DECODE_CMD;
  if (ovr && ovr.length > 0) {
    let cmd = ovr;
    let cargs = [];
    if (ovr.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(ovr);
        if (Array.isArray(arr) && arr.length > 0) {
          cmd = String(arr[0]);
          cargs = arr.slice(1).map(String);
        }
      } catch { // deliberate: cleanup
        // fall through: treat as raw string
      }
    }
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
      return { ok: false, error: 'override_binary_not_found', cmd };
    }
    return { ok: true, cmd, args: cargs, source: 'env:CONSTRAINED_DECODE_CMD' };
  }
  if (!fs.existsSync(WORKER_SHELL)) {
    return { ok: false, error: 'worker_shell_missing', cmd: WORKER_SHELL };
  }
  return {
    ok: true,
    cmd: process.execPath,
    args: [WORKER_SHELL],
    source: 'node+workers/constrained',
  };
}

// ---------------------------------------------------------------------------
// constrainedDecode
//
// Args:
//   prompt:        string sent to the decoder
//   schema_spec:   the W809-1 output_schema block (validated here)
//   base_model:    string passthrough to the Python decoder (e.g. 'qwen2.5-7b')
//   sampler_opts:  optional {temperature, max_tokens, ...} forwarded as-is
//
// On success returns {ok:true, output:string, decoder:'outlines'|..., latency_ms}.
// On missing dependency returns {ok:false, error:'no_constrained_decoder',
// hint, version}. On invalid spec returns {ok:false, error:'invalid_spec',
// validation_errors:[...]}.
// ---------------------------------------------------------------------------
export function constrainedDecode({ prompt, schema_spec, base_model, sampler_opts } = {}) {
  const v = validateOutputSchemaSpec(schema_spec);
  if (!v.ok) {
    return {
      ok: false,
      error: 'invalid_spec',
      validation_errors: v.errors,
      version: OUTPUT_SCHEMA_VERSION,
    };
  }
  const canon = canonicalizeOutputSchemaSpec(schema_spec);
  if (canon === null) {
    return {
      ok: false,
      error: 'no_schema_to_constrain',
      hint: 'pass schema_spec with kind in {json,xml,grammar,regex}',
      version: OUTPUT_SCHEMA_VERSION,
    };
  }
  if (typeof prompt !== 'string' || !prompt.length) {
    return {
      ok: false,
      error: 'prompt_required',
      version: OUTPUT_SCHEMA_VERSION,
    };
  }

  const resolved = resolveWorkerCommand();
  if (!resolved.ok) {
    return {
      ok: false,
      error: 'no_constrained_decoder',
      hint: 'pip install outlines OR lm-format-enforcer',
      version: OUTPUT_SCHEMA_VERSION,
      worker_error: resolved.error,
    };
  }

  // Stage the request as a tempfile so quoting/escaping cannot mangle multi-
  // line prompts. Worker --input <path> reads + parses.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-constrained-'));
  const reqPath = path.join(tmpDir, 'request.json');
  const outPath = path.join(tmpDir, 'response.json');
  const request = {
    version: OUTPUT_SCHEMA_VERSION,
    prompt,
    schema_spec: canon,
    base_model: base_model || null,
    sampler_opts: sampler_opts || {},
  };
  try {
    fs.writeFileSync(reqPath, JSON.stringify(request));
  } catch (e) {
    return {
      ok: false,
      error: 'tempfile_write_failed',
      detail: String(e.message || e),
      version: OUTPUT_SCHEMA_VERSION,
    };
  }

  const t0 = Date.now();
  const res = spawnSync(
    resolved.cmd,
    [...resolved.args, '--input', reqPath, '--output', outPath],
    {
      encoding: 'utf8',
      env: process.env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32' && !path.isAbsolute(resolved.cmd),
    },
  );
  const latency_ms = Date.now() - t0;

  // Common honest-envelope mapping: exit 3 → no_constrained_decoder.
  if (res.status === 3) {
    let inner = null;
    try { inner = JSON.parse((res.stdout || '').trim().split('\n').filter(Boolean).pop()); }
    catch { inner = null; }
    return {
      ok: false,
      error: 'no_constrained_decoder',
      hint: (inner && inner.hint) || 'pip install outlines OR lm-format-enforcer',
      version: OUTPUT_SCHEMA_VERSION,
      worker_envelope: inner,
      latency_ms,
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      error: 'decoder_failed',
      exit_code: res.status,
      stderr: (res.stderr || '').slice(0, 4000),
      stdout: (res.stdout || '').slice(0, 1000),
      version: OUTPUT_SCHEMA_VERSION,
      latency_ms,
    };
  }
  // Successful exit: read --output file.
  let envelope = null;
  try {
    envelope = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      error: 'decoder_output_unreadable',
      detail: String(e.message || e),
      version: OUTPUT_SCHEMA_VERSION,
      latency_ms,
    };
  }
  return {
    ok: true,
    output: envelope.output,
    decoder: envelope.decoder || 'unknown',
    version: OUTPUT_SCHEMA_VERSION,
    latency_ms,
  };
}

// ---------------------------------------------------------------------------
// doctorConstrainedDecode
//
// Probes the worker. Returns {ok, ready, decoders:{outlines:?, lmfe:?},
// hint?, version}. `ok:true` means the doctor itself ran; `ready:true` means
// at least one decoder library is installed.
// ---------------------------------------------------------------------------
export function doctorConstrainedDecode() {
  const resolved = resolveWorkerCommand();
  if (!resolved.ok) {
    return {
      ok: false,
      ready: false,
      error: resolved.error,
      hint: 'check workers/constrained/ layout or set $CONSTRAINED_DECODE_CMD',
      version: OUTPUT_SCHEMA_VERSION,
    };
  }
  const res = spawnSync(
    resolved.cmd,
    [...resolved.args, '--doctor'],
    {
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
      shell: process.platform === 'win32' && !path.isAbsolute(resolved.cmd),
    },
  );
  let envelope = null;
  try {
    const out = (res.stdout || '').trim();
    const tail = out.split('\n').filter(Boolean).pop();
    envelope = JSON.parse(tail);
  } catch {
    envelope = null;
  }
  if (!envelope) {
    return {
      ok: false,
      ready: false,
      error: 'doctor_failed',
      exit_code: res.status,
      stderr: (res.stderr || '').slice(0, 4000),
      hint: 'pip install outlines OR lm-format-enforcer',
      version: OUTPUT_SCHEMA_VERSION,
    };
  }
  return {
    ok: true,
    ready: !!envelope.ready,
    decoders: envelope.decoders || {},
    python_ok: !!envelope.python_ok,
    python_version: envelope.python_version || null,
    hint: envelope.ready ? null : 'pip install outlines OR lm-format-enforcer',
    version: OUTPUT_SCHEMA_VERSION,
  };
}

export default {
  constrainedDecode,
  doctorConstrainedDecode,
};
