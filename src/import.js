// W740 — kolm import: GGUF / safetensors / ONNX -> not_kolm_compiled manifest.
//
// Purpose
// -------
// kolm `export` (A26-era) takes a compiled .kolm artifact and emits a native
// runtime binary (gguf / mlx / onnx / safetensors / executorch / tensorrt /
// coreml). W740 is the SYMMETRIC counterpart: it takes a runtime binary that
// was NOT produced by kolm and emits a stub manifest tagged
// `not_kolm_compiled: true` so the model can ride through the rest of the
// stack (catalog, inspect, signature) without ever being silently treated as
// a kolm-compiled artifact.
//
// Honesty contract (W740-2)
// -------------------------
// Every wrapped manifest carries `not_kolm_compiled: true`. There is no
// K-Score, no holdout, no production-ready verdict. The buyer can use kolm
// CLI / inspect / signature flows immediately, but to actually claim the
// model is kolm-compiled they have to run it through `kolm distill` again.
//
// Design choices
// --------------
//   * Python parsers live in apps/import/{gguf,safetensors,onnx}.py — stdlib
//     ONLY. Heavy parsers (onnx pip, gguf 1.0 tensor walk) are out of scope.
//   * Node side never tries to parse the binary directly; it spawns python3
//     and consumes the JSON envelope on stdout. Missing python3 surfaces a
//     loud {ok:false, error:"python3_missing"} envelope — never silently
//     fakes a parse.
//   * Format detection is by file magic / suffix sniff (NOT mime type). We
//     read the first 16 bytes and compare against known signatures:
//       - GGUF:        magic "GGUF" at offset 0
//       - safetensors: 8-byte u64 header_size (LE) at offset 0 in plausible
//                      range (1..2^30) + JSON byte 0x7b at offset 8
//       - ONNX:        protobuf tag byte 0x08, 0x12, or 0x3a at offset 0
//     Anything else → format:"unknown" with a hint to pass --format.
//
// Test surface
// ------------
// tests/wave740-import.test.js pins the version stamp, detection bytes,
// envelope shape, manifest honesty flag, sha256-hex shape, and CLI dispatcher
// wire-up. The auth-gated /v1/import/{inspect,wrap} routes are exercised via
// the buildRouter() + provisionAnonTenant pattern used by W738.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IMPORT_VERSION = 'w740-v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the apps/import directory once; the spec scripts live alongside
// apps/export. CLI tests and the router both call back to this module so we
// keep the path resolution in one place.
function _appsImportDir() {
  // src/ is sibling to apps/ — go up one then into apps/import.
  return path.resolve(__dirname, '..', 'apps', 'import');
}

// =============================================================================
// detectFormat — sniff first 16 bytes
// =============================================================================

/**
 * Return one of 'gguf' | 'safetensors' | 'onnx' | 'unknown' for `filePath`.
 *
 * The function NEVER throws — a missing file or unreadable header returns
 * 'unknown' so callers can produce an honest envelope on top.
 *
 * Detection rules:
 *   - first 4 bytes === ascii "GGUF" -> 'gguf'
 *   - first 8 bytes parse as LE u64 in [1..2^30) AND byte 8 === '{' -> 'safetensors'
 *   - first byte in {0x08, 0x12, 0x3a} AND file size > 64 bytes -> 'onnx'
 *   - else 'unknown'
 */
export function detectFormat(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return 'unknown';
  }
  try {
    const buf = Buffer.alloc(16);
    const bytes = fs.readSync(fd, buf, 0, 16, 0);
    if (bytes < 4) return 'unknown';
    // GGUF
    if (buf[0] === 0x47 && buf[1] === 0x47 && buf[2] === 0x55 && buf[3] === 0x46) {
      return 'gguf';
    }
    // safetensors: 8-byte u64 LE header length followed by JSON '{'
    if (bytes >= 9) {
      const headerSize = buf.readBigUInt64LE(0);
      const sz = Number(headerSize);
      if (sz >= 1 && sz <= (1 << 30) && buf[8] === 0x7b /* '{' */) {
        return 'safetensors';
      }
    }
    // ONNX protobuf tag bytes
    if (buf[0] === 0x08 || buf[0] === 0x12 || buf[0] === 0x3a) {
      // Try to avoid false positives on tiny files (the safetensors path above
      // already filtered out the JSON '{' edge case).
      const stat = fs.fstatSync(fd);
      if (stat.size > 64) return 'onnx';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    try { fs.closeSync(fd); } catch {} // deliberate: cleanup
  }
}

// =============================================================================
// parseImportMetadata — spawn the matching python3 parser
// =============================================================================

function _resolvePython() {
  // Mirror src/tune.js: try `python3` first because that's what apps/import/*.py
  // shebang declares, then `python`. Honest envelope on neither found.
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Spawn the matching python3 parser for the file at `filePath`.
 * Returns the JSON envelope emitted by the parser, or an honest error
 * envelope if python3 is missing / file is missing / format is unknown.
 *
 * Options:
 *   format: 'gguf' | 'safetensors' | 'onnx'  — bypass detectFormat()
 *   pythonPath: override the python3 binary (mainly for tests)
 */
export async function parseImportMetadata(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    return {
      ok: false,
      error: 'missing_field',
      field: 'path',
      version: IMPORT_VERSION,
    };
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      ok: false,
      error: 'file_not_found',
      path: abs,
      hint: 'pass an absolute path or a path relative to cwd',
      version: IMPORT_VERSION,
    };
  }
  const format = (opts && opts.format) || detectFormat(abs);
  if (format === 'unknown') {
    return {
      ok: false,
      error: 'unknown_format',
      path: abs,
      hint: 'expected GGUF (magic "GGUF"), safetensors (u64 header_size + JSON), or ONNX (protobuf). Pass --format to override.',
      version: IMPORT_VERSION,
    };
  }
  const python = (opts && opts.pythonPath) || _resolvePython();
  if (!python) {
    return {
      ok: false,
      error: 'python3_missing',
      hint: 'install python 3.10+ and re-run; only stdlib is required',
      version: IMPORT_VERSION,
    };
  }
  const scriptPath = path.join(_appsImportDir(), `${format}.py`);
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      error: 'import_script_missing',
      path: scriptPath,
      hint: 'reinstall the kolm CLI — apps/import/<format>.py must ship alongside src/import.js',
      version: IMPORT_VERSION,
    };
  }
  const out = spawnSync(python, [scriptPath, abs], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) {
    return {
      ok: false,
      error: 'import_parser_spawn_failed',
      detail: String(out.error.message || out.error),
      version: IMPORT_VERSION,
    };
  }
  const stdout = (out.stdout || '').trim();
  let envelope = null;
  try {
    // The Python scripts emit a single line of JSON.
    envelope = stdout ? JSON.parse(stdout) : null;
  } catch (e) {
    return {
      ok: false,
      error: 'import_parser_bad_json',
      detail: String((e && e.message) || e),
      stdout_head: stdout.slice(0, 400),
      version: IMPORT_VERSION,
    };
  }
  if (!envelope || typeof envelope !== 'object') {
    return {
      ok: false,
      error: 'import_parser_no_envelope',
      stderr_head: String(out.stderr || '').slice(0, 400),
      exit_code: out.status,
      version: IMPORT_VERSION,
    };
  }
  // Decorate the envelope with the IMPORT_VERSION stamp for the wrapper
  // contract; the Python side intentionally omits it so the parsers stay
  // version-agnostic.
  envelope.version = IMPORT_VERSION;
  return envelope;
}

// =============================================================================
// wrapAsKolmManifest — produce the not_kolm_compiled partial manifest
// =============================================================================

/**
 * Wrap a parsed-metadata envelope as a partial kolm manifest.
 * The result is W740-2 honest:
 *   - not_kolm_compiled: true
 *   - manifest_version: 'w740-v1'
 *   - k_score: null
 *   - holdout: null
 *   - source_sha256, source_format, source_path, imported_at
 *
 * If the input envelope is ok:false, we still emit a wrap with
 * `not_kolm_compiled: true` and surface the original error block under
 * `source_metadata_error` so downstream tools can decide what to do.
 */
export function wrapAsKolmManifest(metadata, opts = {}) {
  const now = (opts && opts.now) || new Date().toISOString();
  if (!metadata || typeof metadata !== 'object') {
    return {
      ok: false,
      error: 'wrap_requires_metadata',
      hint: 'pass the envelope returned by parseImportMetadata()',
      version: IMPORT_VERSION,
    };
  }
  const sourceSha = typeof metadata.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(metadata.sha256)
    ? metadata.sha256.toLowerCase()
    : null;
  const sourcePath = typeof metadata.source_path === 'string' ? metadata.source_path : null;
  const sourceFormat = typeof metadata.format === 'string' ? metadata.format : null;
  // Manifest id: deterministic. sha256(source_sha256 + format + 'w740-v1').
  // If we have no source_sha (because metadata.ok was false) we fall back to
  // a random id so two failed wraps don't collide.
  let manifestId;
  if (sourceSha && sourceFormat) {
    manifestId = crypto.createHash('sha256')
      .update(`${sourceSha}:${sourceFormat}:${IMPORT_VERSION}`)
      .digest('hex');
  } else {
    manifestId = 'unbound-' + crypto.randomBytes(8).toString('hex');
  }
  const manifest = {
    ok: !!metadata.ok,
    manifest_version: IMPORT_VERSION,
    manifest_id: manifestId,
    not_kolm_compiled: true,
    k_score: null,
    holdout: null,
    source_format: sourceFormat,
    source_sha256: sourceSha,
    source_path: sourcePath,
    source_size_bytes: typeof metadata.size_bytes === 'number' ? metadata.size_bytes : null,
    source_params_b: typeof metadata.params_b === 'number' ? metadata.params_b : null,
    source_quant: typeof metadata.quant === 'string' ? metadata.quant : null,
    source_metadata_keys: Array.isArray(metadata.raw_metadata_keys) ? metadata.raw_metadata_keys.slice(0, 256) : [],
    imported_at: now,
    version: IMPORT_VERSION,
  };
  if (metadata.ok === false) {
    manifest.source_metadata_error = {
      error: metadata.error || 'parse_failed',
      hint: metadata.hint || null,
    };
  }
  if (metadata.partial === true) {
    manifest.source_metadata_partial = true;
    manifest.source_metadata_partial_hint = metadata.hint || null;
  }
  return manifest;
}

// =============================================================================
// describeFormats — for `kolm import doctor`
// =============================================================================

export function describeFormats() {
  const dir = _appsImportDir();
  const formats = ['gguf', 'safetensors', 'onnx'];
  const detail = {};
  for (const f of formats) {
    const sp = path.join(dir, `${f}.py`);
    detail[f] = {
      script_path: sp,
      script_present: fs.existsSync(sp),
    };
  }
  return {
    formats,
    detail,
    python: _resolvePython(),
    apps_import_dir: dir,
    version: IMPORT_VERSION,
  };
}
