// W287 - ONNX runtime target for .kolm artifacts.
//
// A .kolm with manifest.runtime_target='onnx' carries an ONNX model file
// inside the zip (path declared by manifest.runtime_target_config.onnx_path).
// Execution requires the `onnxruntime-node` npm package on the host; we do
// NOT take it as a hard root dep (it pulls a large native blob and we want
// the JS path to work on any Node install without it). It is detected via
// dynamic import at call time; missing dep raises a clean
// KOLM_E_ONNX_RUNTIME_MISSING with an install hint.
//
// Input tensor shape:
//   - opts.inputName overrides the input feed name (default: read from
//     manifest.entrypoint.input_schema.name OR fall back to the session's
//     first input name).
//   - opts.dtype overrides the tensor dtype (default: 'float32').
//   - For string-typed schemas, input is wrapped as a 1-element string tensor.
//
// Errors:
//   KOLM_E_TARGET_MISSING - onnx_path missing from manifest or zip
//   KOLM_E_TARGET_INVALID - onnx_path is unsafe or not an .onnx bundle entry
//   KOLM_E_TARGET_TOO_LARGE - ONNX model bytes exceed the configured cap
//   KOLM_E_ONNX_RUNTIME_MISSING - onnxruntime-node not installed
//   KOLM_E_ONNX_RUNTIME - session creation or run threw
//   KOLM_E_RECIPE_TIMEOUT - wall-clock budget exceeded

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { extractEntryToFile } from '../zip-large.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ONNX_MODEL_BYTES_DEFAULT = 8 * 1024 * 1024 * 1024;
const MAX_OUTPUT_ELEMENTS_DEFAULT = 1_000_000;
const _onnxRequire = createRequire(import.meta.url);

function kolmError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function positiveInt(value, fallback, field, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', `${field} must be a positive integer`);
  }
  return Math.min(max, Math.trunc(n));
}

function validateOnnxEntryPath(value) {
  const s = String(value || '').trim();
  if (!s) {
    throw kolmError('KOLM_E_TARGET_MISSING', 'onnx runtime_target requires manifest.runtime_target_config.onnx_path');
  }
  if (s.length > 512 || s.includes('\0') || s.includes('\\')) {
    throw kolmError('KOLM_E_TARGET_INVALID', `unsafe onnx_path=${JSON.stringify(s)}`);
  }
  if (path.posix.isAbsolute(s) || path.win32.isAbsolute(s)) {
    throw kolmError('KOLM_E_TARGET_INVALID', `onnx_path must be a relative bundle entry (got ${s})`);
  }
  const parts = s.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw kolmError('KOLM_E_TARGET_INVALID', `onnx_path contains an unsafe path segment (got ${s})`);
  }
  if (!s.toLowerCase().endsWith('.onnx')) {
    throw kolmError('KOLM_E_TARGET_INVALID', `onnx_path must end in .onnx (got ${s})`);
  }
  return s;
}

function normalizeDtype(dtype) {
  const d = String(dtype || 'float32').toLowerCase();
  if (d === 'float32' || d === 'int64' || d === 'string') return d;
  throw kolmError('KOLM_E_ONNX_RUNTIME', `unsupported ONNX input dtype ${JSON.stringify(dtype)}; supported: float32, int64, string`);
}

function normalizeNumericInput(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'number' || typeof input === 'bigint') return [input];
  if (input && input.data != null) {
    try { return Array.from(input.data); }
    catch { return []; }
  }
  return [];
}

function normalizeShape(shape, dataLen) {
  const dims = shape == null ? [1, dataLen] : shape;
  if (!Array.isArray(dims) || dims.length < 1 || dims.length > 8) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', 'ONNX tensor shape must be an array with 1-8 dimensions');
  }
  const out = dims.map((x) => Number(x));
  if (out.some((x) => !Number.isInteger(x) || x < 1)) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', `ONNX tensor shape must contain positive integer dimensions (got ${JSON.stringify(dims)})`);
  }
  const product = out.reduce((a, b) => a * b, 1);
  if (product !== dataLen) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', `ONNX tensor shape ${JSON.stringify(out)} expects ${product} values, got ${dataLen}`);
  }
  return out;
}

function buildTensor(ort, dtype, input, shape) {
  if (dtype === 'string') {
    const s = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    return new ort.Tensor('string', [s], [1]);
  }
  const arr = normalizeNumericInput(input);
  if (!arr.length) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', 'ONNX numeric input requires a non-empty array, typed array, or number');
  }
  const dims = normalizeShape(shape, arr.length);
  if (dtype === 'int64') {
    let data;
    try { data = new BigInt64Array(arr.map((x) => BigInt(x))); }
    catch (e) { throw kolmError('KOLM_E_ONNX_RUNTIME', `ONNX int64 input contains a non-integer value: ${e.message}`); }
    return new ort.Tensor('int64', data, dims);
  }
  const nums = arr.map((x) => Number(x));
  if (nums.some((x) => !Number.isFinite(x))) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', 'ONNX float32 input contains a non-finite value');
  }
  return new ort.Tensor('float32', new Float32Array(nums), dims);
}

function plainTensor(v, maxOutputElements) {
  const dataLen = v && v.data && typeof v.data.length === 'number' ? v.data.length : 0;
  if (dataLen > maxOutputElements) {
    throw kolmError('KOLM_E_ONNX_RUNTIME', `ONNX output tensor too large: ${dataLen} elements exceeds cap ${maxOutputElements}`);
  }
  const data = Array.from(v?.data || []).map((x) => (typeof x === 'bigint' ? x.toString() : x));
  return {
    dims: Array.isArray(v?.dims) ? v.dims.slice() : [],
    type: v?.type || null,
    data,
  };
}

// Try to load onnxruntime-node. Returns the module or null. Cached so we
// don't repeatedly pay dynamic-import cost across a long-lived process.
let _ortCache;
async function loadOrt(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'ort')) return opts.ort;
  if (typeof opts.loadOrt === 'function') {
    try { return await opts.loadOrt(); }
    catch { return null; }
  }
  if (_ortCache !== undefined) return _ortCache;
  try {
    _ortCache = await import('onnxruntime-node');
    return _ortCache;
  } catch (e) {
    _ortCache = null;
    return null;
  }
}

// Probe: is onnxruntime-node available on this host? Used by runtimeAvailable
// so the binder can surface a clean "npm i -O onnxruntime-node to run" panel.
// Synchronous so the dispatchRuntime probe stays sync; we use the CommonJS
// require.resolve via createRequire under the hood. False positives (module
// resolves but the native .node binding fails to load) are surfaced later by
// runOnnxTarget when the dynamic import actually runs.
export function onnxRuntimeAvailable() {
  try {
    _onnxRequire.resolve('onnxruntime-node');
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'onnxruntime-node not installed. Install with: npm i -O onnxruntime-node (it is an optional peer dep so the JS runtime path works without it).',
    };
  }
}

export function onnxRuntimeConfigAvailable(manifestOrConfig) {
  const cfg = manifestOrConfig?.runtime_target_config || manifestOrConfig || {};
  try {
    validateOnnxEntryPath(cfg.onnx_path);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return onnxRuntimeAvailable();
}

export async function runOnnxTarget(bundle, input, opts = {}) {
  const cfg = bundle?.manifest?.runtime_target_config || {};
  const onnxRel = validateOnnxEntryPath(cfg.onnx_path);
  const onnxBuf = bundle?.entries?.[onnxRel];
  const largeEntry = !onnxBuf && bundle?.large_entries && bundle.large_entries[onnxRel];
  if ((!onnxBuf || !onnxBuf.length) && !largeEntry) {
    throw kolmError('KOLM_E_TARGET_MISSING', `onnx runtime_target references onnx_path=${onnxRel} but that entry is missing from the .kolm bundle`);
  }
  const maxModelBytes = positiveInt(opts.maxModelBytes, MAX_ONNX_MODEL_BYTES_DEFAULT, 'maxModelBytes');
  const declaredBytes = onnxBuf ? onnxBuf.length : Number(largeEntry?.uncompressed_size || 0);
  if (declaredBytes > maxModelBytes) {
    throw kolmError('KOLM_E_TARGET_TOO_LARGE', `onnx model ${onnxRel} is ${declaredBytes} bytes; cap is ${maxModelBytes}`);
  }
  const ort = await loadOrt(opts);
  if (!ort) {
    throw kolmError('KOLM_E_ONNX_RUNTIME_MISSING', 'onnxruntime-node not installed. Install with: npm i -O onnxruntime-node.');
  }
  const timeout = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs', MAX_TIMEOUT_MS);
  const maxOutputElements = positiveInt(opts.maxOutputElements, MAX_OUTPUT_ELEMENTS_DEFAULT, 'maxOutputElements');
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-onnx-'));
  const onnxPath = path.join(workdir, 'model.onnx');
  let onnxSha = null;

  try {
    if (largeEntry) {
      if (!bundle?.artifact_path) {
        throw kolmError('KOLM_E_TARGET_MISSING', `onnx large-entry ${onnxRel} requires bundle.artifact_path for streaming extraction`);
      }
      const ext = await extractEntryToFile(bundle.artifact_path, onnxRel, onnxPath, { computeSha256: true });
      if (!ext.ok) throw kolmError('KOLM_E_TARGET_MISSING', `onnx large-entry extraction failed: ${ext.reason}`);
      if (ext.bytes_written > maxModelBytes) {
        throw kolmError('KOLM_E_TARGET_TOO_LARGE', `onnx model ${onnxRel} is ${ext.bytes_written} bytes; cap is ${maxModelBytes}`);
      }
      onnxSha = ext.sha256;
    } else {
      fs.writeFileSync(onnxPath, onnxBuf);
      onnxSha = crypto.createHash('sha256').update(onnxBuf).digest('hex');
    }
    const t0 = process.hrtime.bigint();

    // Session creation + run wrapped in a timeout race. onnxruntime-node does
    // not expose a per-call deadline; we race the promise against a timer.
    const sessionPromise = (async () => {
      const session = await ort.InferenceSession.create(onnxPath);
      const inputName = opts.inputName
        || bundle?.manifest?.entrypoint?.input_schema?.name
        || session.inputNames?.[0];
      if (!inputName) {
        throw kolmError('KOLM_E_ONNX_RUNTIME', 'unable to derive input tensor name (no opts.inputName, no manifest.entrypoint.input_schema.name, no session.inputNames)');
      }
      const dtype = normalizeDtype(opts.dtype || bundle?.manifest?.entrypoint?.input_schema?.dtype || 'float32');
      const tensor = buildTensor(ort, dtype, input, opts.shape);
      const feeds = { [inputName]: tensor };
      const out = await session.run(feeds);
      // Return all outputs as plain objects (callers know their model).
      const result = {};
      for (const [k, v] of Object.entries(out)) {
        result[k] = plainTensor(v, maxOutputElements);
      }
      return result;
    })();

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(kolmError('KOLM_E_RECIPE_TIMEOUT', `onnx runner exceeded ${timeout}ms`)), timeout);
    });

    let output;
    try {
      output = await Promise.race([sessionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    const us = Number(process.hrtime.bigint() - t0) / 1000;
    return {
      output,
      latency_us: Math.round(us),
      runtime: 'onnx',
      model_sha256: onnxSha,
    };
  } catch (e) {
    if (e.code && /^KOLM_E_/.test(e.code)) throw e;
    throw kolmError('KOLM_E_ONNX_RUNTIME', String(e.message || e));
  } finally {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
}
