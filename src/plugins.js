// W784 — Plugin architecture (third-party quantization / runtime / capture / eval).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 729-735):
//   [W784-1] Custom quantization methods plug into the forge
//   [W784-2] Custom runtime adapters plug into `kolm run`
//   [W784-3] Custom capture processors plug into gateway
//   [W784-4] Custom eval metrics plug into bakeoff
//   [W784-5] Plugin marketplace + doc /docs/plugins.html
//
// Design choices:
//
//   1. ONE unified contract — every plugin is a directory under
//      ~/.kolm/plugins/<name>/ with a plugin.json manifest and an
//      entry script. Four `kinds` (quantization / runtime / capture-processor
//      / eval-metric) discriminate dispatch; we don't fork the contract per
//      kind. Lessons from W454/W462/W464 (separate worker packages with
//      similar surface): one loader + one validator + one disk layout.
//
//   2. Tenant-scoped under ~/.kolm/plugins. Tenants on a shared host get
//      plugins.dir overridden via KOLM_PLUGINS_DIR — tests use this to
//      isolate fixtures (mirrors W783 test pattern).
//
//   3. Honest envelopes only — loadPlugins returns
//      {ok, kind, plugins:[], errors:[]} where errors is per-plugin
//      (no_manifest / bad_manifest / unknown_kind / bad_entry). Never throws
//      on a single malformed plugin; surfaces the error and keeps loading
//      the rest. Only fatal-throws from PluginError on registerPlugin
//      validation (caller asked us to do exactly one thing).
//
//   4. Plugin entry script is NOT executed during load. loadPlugins returns
//      manifests + entry_path so callers can lazy-import on demand. This
//      keeps the gateway boot path cheap and avoids running third-party
//      code at import-time.
//
//   5. NO marketplace network calls in this module. The /docs/plugins.html
//      page is the marketplace surface; this loader only reads the local
//      directory. A future wave can add a federated catalog.
//
// Public surface:
//   - PLUGIN_VERSION
//   - PLUGIN_KINDS (frozen)
//   - PLUGIN_DEFAULTS (frozen)
//   - PluginError (extends Error)
//   - pluginsDir() — resolves the on-disk root (KOLM_PLUGINS_DIR or ~/.kolm/plugins)
//   - listPlugins() — directory listing {ok, plugins:[{name,kind,version,...}]}
//   - loadPlugins({kind}) — filtered by kind
//   - registerPlugin({manifest_path}) — validates + copies into pluginsDir
//   - readManifest(path) — single-shot manifest read+validate

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PLUGIN_VERSION = 'w784-v1';

// Closed set. Frozen so a refactor cannot quietly add a new kind without
// bumping the version stamp. The four kinds map 1:1 to the four W784
// surface hook points:
//   quantization     -> workers/quantize/scripts/quantize.py (forge)
//   runtime          -> src/router.js /v1/run (kolm run)
//   capture-processor-> src/capture.js (gateway)
//   eval-metric      -> src/bakeoff.js (bakeoff)
export const PLUGIN_KINDS = Object.freeze([
  'quantization',
  'runtime',
  'capture-processor',
  'eval-metric',
]);

// Manifest fields required for a valid plugin. Closed set — a manifest with
// extra fields is fine (forward compat), but missing required field => reject.
const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'kinds', 'entry']);

// Regex for plugin name (lowercase, alphanumeric, hyphen). Prevents path
// traversal via name="../etc/passwd" and keeps the on-disk layout sane.
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

// Manifest filename. Capital-M intentional — matches npm "package.json"
// convention but kolm-namespaced so a plugin can also be an npm package.
const MANIFEST_FILE = 'plugin.json';

// Read cap on plugin entries per kind. Defensive against a runaway
// ~/.kolm/plugins symlink farm.
const MAX_PLUGINS_PER_LOAD = 1000;

export const PLUGIN_DEFAULTS = Object.freeze({
  PLUGIN_KINDS,
  REQUIRED_FIELDS,
  MANIFEST_FILE,
  MAX_PLUGINS_PER_LOAD,
});

// =============================================================================
// PluginError — single error class so callers can `catch (e) { if (e instanceof
// PluginError) ... }`. Carries .code so envelopes can stamp a machine-readable
// reason.
// =============================================================================
export class PluginError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'PluginError';
    this.code = code || 'plugin_error';
    if (detail) this.detail = detail;
  }
}

// =============================================================================
// pluginsDir() — resolves the on-disk plugin root. Override via
// KOLM_PLUGINS_DIR (tests use this); otherwise ~/.kolm/plugins per W411 /
// W783 convention (HOME or USERPROFILE).
// =============================================================================
export function pluginsDir() {
  if (process.env.KOLM_PLUGINS_DIR) return process.env.KOLM_PLUGINS_DIR;
  const home = process.env.KOLM_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.kolm') : null)
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.kolm') : null)
    || path.join(os.homedir(), '.kolm');
  return path.join(home, 'plugins');
}

function _ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {
    // best-effort; downstream readers handle ENOENT honestly
  }
}

// =============================================================================
// readManifest(manifest_path) — single-shot read + validate. Returns
// {ok:true, manifest} or {ok:false, error, detail}. Never throws.
// =============================================================================
export function readManifest(manifest_path) {
  if (!manifest_path) {
    return { ok: false, error: 'no_manifest_path', version: PLUGIN_VERSION };
  }
  let raw;
  try {
    raw = fs.readFileSync(manifest_path, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_unreadable',
      detail: String((e && e.message) || e),
      version: PLUGIN_VERSION,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_invalid_json',
      detail: String((e && e.message) || e),
      version: PLUGIN_VERSION,
    };
  }
  // Required fields.
  for (const f of REQUIRED_FIELDS) {
    if (parsed[f] == null) {
      return {
        ok: false,
        error: 'missing_field',
        detail: 'required field missing: ' + f,
        version: PLUGIN_VERSION,
      };
    }
  }
  // name shape.
  if (typeof parsed.name !== 'string' || !NAME_RE.test(parsed.name)) {
    return {
      ok: false,
      error: 'bad_name',
      detail: 'name must match ' + NAME_RE.toString(),
      version: PLUGIN_VERSION,
    };
  }
  // version shape — relaxed semver-ish; we don't reject 0.0.1-alpha+sha.
  if (typeof parsed.version !== 'string' || !parsed.version) {
    return {
      ok: false,
      error: 'bad_version',
      detail: 'version must be a non-empty string',
      version: PLUGIN_VERSION,
    };
  }
  // kinds is an array of allowed kinds. We let a plugin claim multiple kinds
  // (e.g. a benchmark suite that ships both an eval-metric and a capture-
  // processor) since the contract is uniform.
  if (!Array.isArray(parsed.kinds) || parsed.kinds.length === 0) {
    return {
      ok: false,
      error: 'bad_kinds',
      detail: 'kinds must be a non-empty array',
      version: PLUGIN_VERSION,
    };
  }
  for (const k of parsed.kinds) {
    if (!PLUGIN_KINDS.includes(k)) {
      return {
        ok: false,
        error: 'unknown_kind',
        detail: 'unknown plugin kind: ' + k,
        supported: PLUGIN_KINDS,
        version: PLUGIN_VERSION,
      };
    }
  }
  // entry shape.
  if (typeof parsed.entry !== 'string' || !parsed.entry) {
    return {
      ok: false,
      error: 'bad_entry',
      detail: 'entry must be a non-empty string',
      version: PLUGIN_VERSION,
    };
  }
  // Path-traversal defense — entry must be a relative path under the
  // plugin dir, not an absolute path or `../`.
  if (path.isAbsolute(parsed.entry) || parsed.entry.includes('..')) {
    return {
      ok: false,
      error: 'bad_entry_path',
      detail: 'entry must be a relative path under the plugin dir',
      version: PLUGIN_VERSION,
    };
  }
  return { ok: true, manifest: parsed, version: PLUGIN_VERSION };
}

function _safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function _enrichPluginEntry(plugin_dir, manifest) {
  const entry_path = path.join(plugin_dir, manifest.entry);
  // We do NOT require entry_path to exist at load time — a half-installed
  // plugin should surface the missing file via the entry_exists flag, not
  // by silently filtering it out (caller decides what to do).
  let entry_exists = false;
  try {
    entry_exists = fs.statSync(entry_path).isFile();
  } catch (_) {}
  return {
    name: manifest.name,
    version: manifest.version,
    kinds: Array.isArray(manifest.kinds) ? manifest.kinds.slice() : [],
    description: typeof manifest.description === 'string' ? manifest.description : '',
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : '',
    author: typeof manifest.author === 'string' ? manifest.author : '',
    entry: manifest.entry,
    entry_path,
    entry_exists,
    plugin_dir,
    manifest,
  };
}

// =============================================================================
// listPlugins() — directory listing. Returns {ok, dir, total, plugins:[],
// errors:[]}. Plugins is the success set; errors is the per-entry failure set
// (typed by readManifest's error codes). Never throws.
// =============================================================================
export function listPlugins() {
  const dir = pluginsDir();
  _ensureDir(dir);
  const entries = _safeReaddir(dir);
  const plugins = [];
  const errors = [];
  let count = 0;
  for (const ent of entries) {
    if (count >= MAX_PLUGINS_PER_LOAD) break;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (ent.name.startsWith('.')) continue;
    const plugin_dir = path.join(dir, ent.name);
    const manifest_path = path.join(plugin_dir, MANIFEST_FILE);
    let exists = false;
    try { exists = fs.statSync(manifest_path).isFile(); } catch (_) {}
    if (!exists) {
      errors.push({
        plugin: ent.name,
        error: 'no_manifest',
        detail: 'plugin.json not found in ' + plugin_dir,
      });
      continue;
    }
    const r = readManifest(manifest_path);
    if (!r.ok) {
      errors.push({ plugin: ent.name, error: r.error, detail: r.detail || '' });
      continue;
    }
    plugins.push(_enrichPluginEntry(plugin_dir, r.manifest));
    count += 1;
  }
  return {
    ok: true,
    dir,
    total: plugins.length,
    plugins,
    errors,
    version: PLUGIN_VERSION,
  };
}

// =============================================================================
// loadPlugins({kind}) — filtered by kind. The hook points (forge / runtime /
// capture / bakeoff) call this with their kind and iterate plugins.
//
// Envelope:
//   {ok, kind, total, plugins:[{name,entry_path,manifest,...}], errors:[]}
//
// Honest envelopes:
//   - {ok:false, error:'invalid_kind', supported:[...]} on bad kind
//   - {ok:true, total:0, plugins:[]} on empty (NOT an error; common case)
// =============================================================================
export function loadPlugins(opts) {
  const o = opts || {};
  const kind = (typeof o.kind === 'string' && o.kind) ? o.kind : null;
  if (kind && !PLUGIN_KINDS.includes(kind)) {
    return {
      ok: false,
      error: 'invalid_kind',
      hint: 'kind must be one of ' + PLUGIN_KINDS.join(','),
      supported: PLUGIN_KINDS,
      version: PLUGIN_VERSION,
    };
  }
  const all = listPlugins();
  const filtered = kind
    ? all.plugins.filter((p) => Array.isArray(p.kinds) && p.kinds.includes(kind))
    : all.plugins.slice();
  return {
    ok: true,
    kind,
    total: filtered.length,
    plugins: filtered,
    errors: all.errors,
    dir: all.dir,
    version: PLUGIN_VERSION,
  };
}

function _copyDirSync(src, dst) {
  _ensureDir(dst);
  for (const ent of _safeReaddir(src)) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      _copyDirSync(s, d);
    } else if (ent.isFile()) {
      try { fs.copyFileSync(s, d); } catch (_) {}
    }
  }
}

// =============================================================================
// registerPlugin({manifest_path}) — validates the manifest, then copies the
// containing directory into ~/.kolm/plugins/<name>/. Throws PluginError on
// validation failure (caller asked us to do exactly one thing — we tell them
// loudly if we can't).
//
// Why copy not symlink: Windows symlinks require admin or developer mode,
// and we want this to JustWork™ on all three OSes. The copy is one-shot at
// register time; subsequent loads read from the dest.
//
// Returns: {ok:true, name, kind:[], plugin_dir, manifest}
// =============================================================================
export function registerPlugin(opts) {
  const o = opts || {};
  const manifest_path = typeof o.manifest_path === 'string' ? o.manifest_path : null;
  if (!manifest_path) {
    throw new PluginError(
      'manifest_path required',
      'no_manifest_path'
    );
  }
  const r = readManifest(manifest_path);
  if (!r.ok) {
    throw new PluginError(
      'invalid manifest: ' + (r.error || 'unknown'),
      r.error || 'invalid_manifest',
      r.detail || ''
    );
  }
  const manifest = r.manifest;
  const src_dir = path.dirname(manifest_path);
  // Ensure the entry file exists at the SOURCE before we copy — half-installed
  // plugins should fail loud at registration, not at load.
  const src_entry = path.join(src_dir, manifest.entry);
  let entryOk = false;
  try { entryOk = fs.statSync(src_entry).isFile(); } catch (_) {}
  if (!entryOk) {
    throw new PluginError(
      'entry file missing at source: ' + src_entry,
      'entry_missing',
      src_entry
    );
  }
  const dst_root = pluginsDir();
  _ensureDir(dst_root);
  const dst_dir = path.join(dst_root, manifest.name);
  // Refuse to overwrite an existing plugin of a different version unless
  // KOLM_PLUGIN_OVERWRITE=1. Idempotent re-registration of the same version
  // is allowed (caller may be retrying).
  let prior;
  try {
    const priorManifestPath = path.join(dst_dir, MANIFEST_FILE);
    if (fs.statSync(priorManifestPath).isFile()) {
      const pr = readManifest(priorManifestPath);
      if (pr.ok) prior = pr.manifest;
    }
  } catch (_) {}
  if (prior && prior.version !== manifest.version && process.env.KOLM_PLUGIN_OVERWRITE !== '1') {
    throw new PluginError(
      'plugin ' + manifest.name + ' already installed at version ' + prior.version
        + ' (incoming: ' + manifest.version + '); set KOLM_PLUGIN_OVERWRITE=1 to replace',
      'version_conflict',
      { installed: prior.version, incoming: manifest.version }
    );
  }
  _copyDirSync(src_dir, dst_dir);
  return {
    ok: true,
    name: manifest.name,
    kinds: Array.isArray(manifest.kinds) ? manifest.kinds.slice() : [],
    version_installed: manifest.version,
    plugin_dir: dst_dir,
    manifest,
    plugin_version: PLUGIN_VERSION,
  };
}

// =============================================================================
// getPlugin(name) — single-plugin lookup. Returns honest 404 envelope when
// missing instead of throwing.
// =============================================================================
export function getPlugin(name) {
  if (!name || typeof name !== 'string') {
    return {
      ok: false,
      error: 'name_required',
      version: PLUGIN_VERSION,
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: 'bad_name',
      hint: 'name must match ' + NAME_RE.toString(),
      version: PLUGIN_VERSION,
    };
  }
  const dir = pluginsDir();
  const plugin_dir = path.join(dir, name);
  const manifest_path = path.join(plugin_dir, MANIFEST_FILE);
  let exists = false;
  try { exists = fs.statSync(manifest_path).isFile(); } catch (_) {}
  if (!exists) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no plugin named ' + name + ' under ' + dir,
      version: PLUGIN_VERSION,
    };
  }
  const r = readManifest(manifest_path);
  if (!r.ok) {
    return {
      ok: false,
      error: r.error,
      detail: r.detail || '',
      version: PLUGIN_VERSION,
    };
  }
  const entry = _enrichPluginEntry(plugin_dir, r.manifest);
  return {
    ok: true,
    plugin: entry,
    version: PLUGIN_VERSION,
  };
}

// =============================================================================
// Surface hook helpers — thin wrappers around loadPlugins so the four surface
// integration points all use the same import. Each is a no-op "extension
// point" stub: callers iterate the returned plugins and dispatch to the
// entry script on demand. We deliberately do NOT execute the entry here —
// see design note (4) at the top of this file.
//
//   forgeQuantizationPlugins() — workers/quantize calls this to discover
//                                 third-party quant methods
//   runtimeAdapterPlugins()    — src/router.js /v1/run calls this to
//                                 discover third-party runtimes
//   captureProcessorPlugins()  — src/capture.js calls this to discover
//                                 capture transformers
//   bakeoffMetricPlugins()     — src/bakeoff.js calls this to discover
//                                 custom eval metrics
// =============================================================================
export function forgeQuantizationPlugins() {
  return loadPlugins({ kind: 'quantization' });
}
export function runtimeAdapterPlugins() {
  return loadPlugins({ kind: 'runtime' });
}
export function captureProcessorPlugins() {
  return loadPlugins({ kind: 'capture-processor' });
}
export function bakeoffMetricPlugins() {
  return loadPlugins({ kind: 'eval-metric' });
}

export default {
  PLUGIN_VERSION,
  PLUGIN_KINDS,
  PLUGIN_DEFAULTS,
  PluginError,
  pluginsDir,
  readManifest,
  listPlugins,
  loadPlugins,
  registerPlugin,
  getPlugin,
  forgeQuantizationPlugins,
  runtimeAdapterPlugins,
  captureProcessorPlugins,
  bakeoffMetricPlugins,
};
