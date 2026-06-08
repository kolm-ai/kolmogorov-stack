// W743 - kolm migrate: bring Ollama and LM Studio model libraries into kolm.
//
// Purpose
// -------
// W740 introduced `kolm import` for raw runtime binaries (GGUF / safetensors /
// ONNX). W743 is the migration helper: it discovers models that another
// runtime (Ollama / LM Studio) already manages on this machine and wraps each
// one as a partial manifest tagged `not_kolm_compiled: true` so the buyer can
// onboard their existing model library without copying files around.
//
// Honesty contract (W743-2)
// -------------------------
// Migration is local-only. We read filesystem metadata, hash the blobs that
// `kolm import` would have hashed anyway, and emit `wrapAsKolmManifest()` from
// src/import.js. The wrapped manifest inherits `not_kolm_compiled:true` from
// W740 - a migrated model NEVER earns a K-Score from migration alone. To
// claim it is kolm-compiled, the user has to run `kolm distill` on real seeds.
//
// Design choices
// --------------
//   * We REUSE src/import.js (parseImportMetadata + wrapAsKolmManifest). The
//     migration logic only handles discovery; the actual GGUF parse path is
//     identical to `kolm import wrap`. This is intentional: the W740 honesty
//     lock is the contract, and W743 must not invent a parallel one.
//   * Ollama layout: <root>/manifests/registry.ollama.ai/library/<name>/<tag>
//     points at a JSON manifest whose `layers[].digest` (sha256:<hex>) names
//     blobs in <root>/blobs/sha256-<hex>. We pick the layer whose
//     `mediaType` is "application/vnd.ollama.image.model" - that's the GGUF.
//   * LM Studio layout: a publisher/repo/<file>.gguf tree under the cache
//     root. We walk for *.gguf files; LM Studio also stores .json sidecars
//     but those are not needed for the W740 wrap (which only reads the GGUF
//     header).
//   * Path discovery: we never hardcode a single platform path. Each source
//     has a per-platform candidate array plus a `--path` override. The
//     `runMigrationDryRun()` helper exists so the CLI can show what WOULD be
//     migrated without touching the heavy parser path.
//
// Test surface
// ------------
// tests/wave743-migrate.test.js pins the version stamp, default-path arrays,
// honest envelope shape on missing roots, mock-filesystem discovery for both
// sources, wrap-inheritance of not_kolm_compiled:true, and the auth-gated
// /v1/migrate/{discover,wrap} routes via buildRouter() + provisionAnonTenant.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  IMPORT_VERSION,
  parseImportMetadata,
  wrapAsKolmManifest,
} from './import.js';

export const MIGRATE_VERSION = 'w743-v1';

// =============================================================================
// Default per-platform path candidates
// =============================================================================
//
// We expand both `~` and `%USERPROFILE%` / `%LOCALAPPDATA%` at module load
// time so the arrays carry resolved absolute paths the caller can stat
// directly. Missing env vars are skipped (no `undefined/foo` paths leak in).

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _localAppData() {
  // Windows-only; on darwin/linux this is null and the entry is dropped.
  return process.env.LOCALAPPDATA || null;
}

function _join(...parts) {
  if (parts.some((p) => !p)) return null;
  return path.join(...parts);
}

// Ollama default storage. Per docs the linux/mac path is `~/.ollama/models`,
// the windows path is `%USERPROFILE%\.ollama\models`. We surface both for
// every platform so the candidate array is the same regardless of os.platform
// - the caller's existence check decides which one wins.
export const OLLAMA_DEFAULT_PATHS = (function () {
  const home = _home();
  const out = [];
  if (home) {
    out.push(path.join(home, '.ollama', 'models'));
  }
  // Some installs respect $OLLAMA_MODELS; honor it if set.
  if (process.env.OLLAMA_MODELS) {
    out.push(path.resolve(process.env.OLLAMA_MODELS));
  }
  return Array.from(new Set(out));
})();

// LM Studio default storage. LM Studio paths vary across versions; we expose
// the well-known candidates per platform. The caller's existence check picks
// the live one. The `--path` CLI flag overrides this list entirely.
export const LMSTUDIO_DEFAULT_PATHS = (function () {
  const home = _home();
  const lad = _localAppData();
  const out = [];
  // macOS - both legacy "Application Support" and current "Caches" locations.
  if (home) {
    out.push(path.join(home, 'Library', 'Caches', 'lm-studio', 'models'));
    out.push(path.join(home, 'Library', 'Application Support', 'lm-studio', 'models'));
  }
  // Linux + cross-platform `~/.cache/lm-studio/models`.
  if (home) {
    out.push(path.join(home, '.cache', 'lm-studio', 'models'));
  }
  // Windows - current LM Studio default + legacy.
  if (lad) {
    out.push(path.join(lad, 'LM Studio', 'models'));
    out.push(path.join(lad, 'LMStudio', 'models'));
  }
  // Windows `%USERPROFILE%\.cache\lm-studio\models` (cross-platform layout).
  if (home && process.platform === 'win32') {
    out.push(path.join(home, '.cache', 'lm-studio', 'models'));
  }
  // Honor LMSTUDIO_MODELS env if set (mirrors OLLAMA_MODELS pattern).
  if (process.env.LMSTUDIO_MODELS) {
    out.push(path.resolve(process.env.LMSTUDIO_MODELS));
  }
  return Array.from(new Set(out));
})();

// =============================================================================
// _envelope - small helper so every honest-fail shape carries the version stamp
// =============================================================================

function _failEnvelope(error, extra) {
  return Object.assign(
    { ok: false, error, version: MIGRATE_VERSION },
    extra || {}
  );
}

// =============================================================================
// discoverOllamaModels - read <root>/manifests/registry.ollama.ai/library/
// =============================================================================
//
// Layout (Ollama 0.1+):
//   <root>/manifests/registry.ollama.ai/library/<name>/<tag>     ← JSON manifest
//   <root>/blobs/sha256-<64-hex>                                 ← GGUF blob
//
// The manifest JSON has shape:
//   { layers: [{ mediaType, size, digest: "sha256:<hex>" }, ...] }
//
// We pick the layer with `mediaType === "application/vnd.ollama.image.model"`
// (the GGUF). If that mediaType is absent we fall back to the LARGEST layer - 
// older Ollama builds didn't always set the mediaType correctly.
//
// Returns an array of:
//   { name, tag, source_name: "<name>:<tag>", manifest_path, blob_path,
//     size_bytes, digest_hex }
// or `{ok:false, error:'ollama_root_missing', ...}` if the root isn't there.

export function discoverOllamaModels(rootPath) {
  const root = rootPath ? path.resolve(rootPath) : null;
  if (!root || !fs.existsSync(root)) {
    return _failEnvelope('ollama_root_missing', {
      path: root,
      hint: 'expected ~/.ollama/models (linux/mac) or %USERPROFILE%\\.ollama\\models (win); pass --path to override',
    });
  }
  const libDir = path.join(root, 'manifests', 'registry.ollama.ai', 'library');
  if (!fs.existsSync(libDir)) {
    return _failEnvelope('ollama_library_missing', {
      path: libDir,
      hint: 'Ollama writes <root>/manifests/registry.ollama.ai/library/<name>/<tag>; run `ollama pull <model>` first',
    });
  }
  const blobsDir = path.join(root, 'blobs');
  if (!fs.existsSync(blobsDir)) {
    return _failEnvelope('ollama_blobs_missing', {
      path: blobsDir,
      hint: '<root>/blobs/ must exist; the manifest digests point at blobs in this directory',
    });
  }

  const results = [];
  const skipped = [];

  let nameDirs;
  try {
    nameDirs = fs.readdirSync(libDir, { withFileTypes: true });
  } catch (e) {
    return _failEnvelope('ollama_readdir_failed', {
      path: libDir,
      detail: String((e && e.message) || e),
    });
  }

  for (const ne of nameDirs) {
    if (!ne.isDirectory()) continue;
    const name = ne.name;
    const tagDir = path.join(libDir, name);
    let tagFiles;
    try {
      tagFiles = fs.readdirSync(tagDir, { withFileTypes: true });
    } catch {
      skipped.push({ name, reason: 'tag_dir_unreadable' });
      continue;
    }
    for (const te of tagFiles) {
      if (!te.isFile()) continue;
      const tag = te.name;
      const manifestPath = path.join(tagDir, tag);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        skipped.push({
          name,
          tag,
          manifest_path: manifestPath,
          reason: 'manifest_unparseable',
          detail: String((e && e.message) || e),
        });
        continue;
      }
      if (!manifest || !Array.isArray(manifest.layers) || manifest.layers.length === 0) {
        skipped.push({ name, tag, manifest_path: manifestPath, reason: 'no_layers' });
        continue;
      }
      // Pick the model layer.
      let layer = manifest.layers.find(
        (l) => l && typeof l.mediaType === 'string' &&
          l.mediaType === 'application/vnd.ollama.image.model'
      );
      if (!layer) {
        // Fallback: pick the largest layer by size.
        layer = manifest.layers
          .filter((l) => l && typeof l.digest === 'string' && Number.isFinite(l.size))
          .sort((a, b) => (b.size | 0) - (a.size | 0))[0];
      }
      if (!layer || typeof layer.digest !== 'string') {
        skipped.push({ name, tag, manifest_path: manifestPath, reason: 'no_model_layer' });
        continue;
      }
      const digestHex = layer.digest.replace(/^sha256:/, '');
      if (!/^[0-9a-f]{64}$/i.test(digestHex)) {
        skipped.push({ name, tag, manifest_path: manifestPath, reason: 'bad_digest_hex', digest: layer.digest });
        continue;
      }
      const blobPath = path.join(blobsDir, `sha256-${digestHex.toLowerCase()}`);
      const blobExists = fs.existsSync(blobPath);
      if (!blobExists) {
        skipped.push({ name, tag, manifest_path: manifestPath, reason: 'blob_missing', blob_path: blobPath });
        continue;
      }
      let sizeBytes = null;
      try { sizeBytes = fs.statSync(blobPath).size; } catch { sizeBytes = null; }
      results.push({
        name,
        tag,
        source_name: `${name}:${tag}`,
        manifest_path: manifestPath,
        blob_path: blobPath,
        size_bytes: sizeBytes,
        digest_hex: digestHex.toLowerCase(),
      });
    }
  }

  return {
    ok: true,
    source: 'ollama',
    root: root,
    found: results.length,
    models: results,
    skipped,
    version: MIGRATE_VERSION,
  };
}

// =============================================================================
// discoverLmStudioModels - walk <root> for *.gguf files
// =============================================================================
//
// LM Studio writes models in a publisher/repo/<file>.gguf tree (or sometimes
// publisher/repo/<variant>/<file>.gguf). We just walk recursively for *.gguf
// - anything we find is a candidate. Filename gives `name`; the parent
// directory chain gives the publisher/repo context.
//
// Returns:
//   { ok:true, source:'lmstudio', root, found, models:[{name, path, size_bytes, format:'gguf', publisher?, repo?}] }
// or `{ok:false, error:'lmstudio_root_missing', ...}` if the root isn't there.

export function discoverLmStudioModels(rootPath, opts = {}) {
  const root = rootPath ? path.resolve(rootPath) : null;
  const maxFiles = Number.isFinite(opts && opts.max_files) && opts.max_files > 0
    ? Math.min(10000, opts.max_files | 0)
    : 5000;
  if (!root || !fs.existsSync(root)) {
    return _failEnvelope('lmstudio_root_missing', {
      path: root,
      hint: 'expected ~/Library/Caches/lm-studio/models (mac), ~/.cache/lm-studio/models (linux), or %LOCALAPPDATA%\\LM Studio\\models (win); pass --path to override',
    });
  }
  const results = [];
  const skipped = [];

  // BFS with a queue so we don't blow the stack on deep trees. We also cap
  // total visited files so a misconfigured --path doesn't traverse the
  // entire home directory.
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    if (results.length + skipped.length >= maxFiles) break;
    const cur = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: cur, reason: 'readdir_failed', detail: String((e && e.message) || e) });
      continue;
    }
    for (const e of entries) {
      visited++;
      if (visited > maxFiles * 10) break;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        queue.push(p);
      } else if (e.isFile()) {
        if (!/\.gguf$/i.test(e.name)) continue;
        let sz = null;
        try { sz = fs.statSync(p).size; } catch { sz = null; }
        // Derive publisher / repo from the path relative to root.
        const rel = path.relative(root, p);
        const segs = rel.split(/[\\/]/).filter(Boolean);
        // Typical layout: <publisher>/<repo>/<file>.gguf
        const publisher = segs.length >= 3 ? segs[0] : null;
        const repo = segs.length >= 3 ? segs[1] : null;
        results.push({
          name: e.name.replace(/\.gguf$/i, ''),
          path: p,
          size_bytes: sz,
          format: 'gguf',
          publisher,
          repo,
        });
      }
    }
  }
  return {
    ok: true,
    source: 'lmstudio',
    root,
    found: results.length,
    models: results,
    skipped,
    version: MIGRATE_VERSION,
  };
}

// =============================================================================
// migrateOllamaModel - wrap a single Ollama entry via W740 import path
// =============================================================================

export async function migrateOllamaModel(modelEntry, opts = {}) {
  if (!modelEntry || typeof modelEntry !== 'object' || typeof modelEntry.blob_path !== 'string') {
    return _failEnvelope('missing_field', {
      field: 'blob_path',
      hint: 'pass an entry returned by discoverOllamaModels(); must have blob_path',
    });
  }
  const metadata = await parseImportMetadata(modelEntry.blob_path, {
    format: 'gguf',
    pythonPath: opts.pythonPath,
  });
  if (metadata && metadata.ok === false && metadata.error === 'python3_missing') {
    return Object.assign({}, metadata, { source_tool: 'ollama', migrate_version: MIGRATE_VERSION });
  }
  const manifest = wrapAsKolmManifest(metadata, { now: opts.now });
  // Decorate with the source-tool fields so downstream catalog / inspect can
  // surface "imported from Ollama" without having to re-derive it.
  manifest.source_tool = 'ollama';
  manifest.source_name = modelEntry.source_name || `${modelEntry.name || ''}:${modelEntry.tag || ''}`;
  manifest.source_manifest_path = modelEntry.manifest_path || null;
  manifest.source_ollama_digest = modelEntry.digest_hex || null;
  manifest.migrate_version = MIGRATE_VERSION;
  return {
    ok: true,
    manifest,
    source_metadata: metadata,
    source_tool: 'ollama',
    migrate_version: MIGRATE_VERSION,
    version: IMPORT_VERSION,
  };
}

// =============================================================================
// migrateLmStudioModel - wrap a single LM Studio entry via W740 import path
// =============================================================================

export async function migrateLmStudioModel(modelEntry, opts = {}) {
  if (!modelEntry || typeof modelEntry !== 'object' || typeof modelEntry.path !== 'string') {
    return _failEnvelope('missing_field', {
      field: 'path',
      hint: 'pass an entry returned by discoverLmStudioModels(); must have a path',
    });
  }
  const metadata = await parseImportMetadata(modelEntry.path, {
    format: 'gguf',
    pythonPath: opts.pythonPath,
  });
  if (metadata && metadata.ok === false && metadata.error === 'python3_missing') {
    return Object.assign({}, metadata, { source_tool: 'lmstudio', migrate_version: MIGRATE_VERSION });
  }
  const manifest = wrapAsKolmManifest(metadata, { now: opts.now });
  manifest.source_tool = 'lmstudio';
  manifest.source_name = modelEntry.name || null;
  manifest.source_publisher = modelEntry.publisher || null;
  manifest.source_repo = modelEntry.repo || null;
  manifest.migrate_version = MIGRATE_VERSION;
  return {
    ok: true,
    manifest,
    source_metadata: metadata,
    source_tool: 'lmstudio',
    migrate_version: MIGRATE_VERSION,
    version: IMPORT_VERSION,
  };
}

// =============================================================================
// runMigrationDryRun - discovery only, no parse
// =============================================================================

export function runMigrationDryRun(opts) {
  const o = opts || {};
  const source = o.source;
  const limit = Number.isFinite(o.limit) && o.limit > 0 ? Math.min(1000, o.limit | 0) : 25;
  if (source !== 'ollama' && source !== 'lmstudio') {
    return _failEnvelope('invalid_source', {
      source: source || null,
      hint: 'source must be "ollama" or "lmstudio"',
    });
  }
  const rootPath = typeof o.path === 'string' && o.path ? o.path : _firstExistingDefault(source);
  if (!rootPath) {
    return _failEnvelope(source === 'ollama' ? 'ollama_root_missing' : 'lmstudio_root_missing', {
      hint: 'no default path on this platform contains a model directory; pass --path to override',
      candidates: source === 'ollama' ? OLLAMA_DEFAULT_PATHS.slice() : LMSTUDIO_DEFAULT_PATHS.slice(),
    });
  }
  const env = source === 'ollama'
    ? discoverOllamaModels(rootPath)
    : discoverLmStudioModels(rootPath);
  if (env && env.ok === false) return env;
  const models = Array.isArray(env.models) ? env.models : [];
  return {
    ok: true,
    source,
    root: env.root,
    found: models.length,
    sample: models.slice(0, limit),
    skipped: Array.isArray(env.skipped) ? env.skipped.slice(0, limit) : [],
    version: MIGRATE_VERSION,
  };
}

// =============================================================================
// _firstExistingDefault - pick the first per-platform candidate that exists
// =============================================================================

function _firstExistingDefault(source) {
  const candidates = source === 'ollama' ? OLLAMA_DEFAULT_PATHS : LMSTUDIO_DEFAULT_PATHS;
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch { /* skip unreadable */ }
  }
  return null;
}

// =============================================================================
// describeMigrationSources - for `kolm migrate doctor`
// =============================================================================

export function describeMigrationSources() {
  function _summarize(source) {
    const candidates = (source === 'ollama' ? OLLAMA_DEFAULT_PATHS : LMSTUDIO_DEFAULT_PATHS).slice();
    const detail = candidates.map((c) => {
      const present = !!c && fs.existsSync(c);
      let counted = null;
      if (present) {
        try {
          if (source === 'ollama') {
            const env = discoverOllamaModels(c);
            counted = env && env.ok ? env.found : null;
          } else {
            const env = discoverLmStudioModels(c, { max_files: 200 });
            counted = env && env.ok ? env.found : null;
          }
        } catch { counted = null; }
      }
      return { path: c, exists: present, found: counted };
    });
    return {
      candidates,
      detail,
      first_existing: detail.find((d) => d.exists) ? detail.find((d) => d.exists).path : null,
    };
  }
  return {
    ok: true,
    ollama: _summarize('ollama'),
    lmstudio: _summarize('lmstudio'),
    version: MIGRATE_VERSION,
  };
}
