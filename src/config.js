// W888-J - config layer with hierarchy resolver, TOML round-trip, secret
// redaction, env-var binding, and one-shot migration from the legacy
// `~/.kolm/config.json` (W067 era) when a TOML file does not yet exist.
//
// Resolution order (highest wins):
//   1) explicit flag (passed via { flags } in loadConfig)
//   2) environment variable (KOLM_<UPPER_SNAKE>, e.g. KOLM_GATEWAY_DEFAULT_PROVIDER)
//   3) `~/.kolm/config.toml`   (user scope)
//   4) `./kolm.toml`           (project scope, walks up cwd)
//   5) DEFAULTS schema below
//
// SECURITY: any key listed in SECRET_KEYS is redacted when calling
// formatForPrint() / printConfig() / `kolm config list` unless the caller
// explicitly opts in with `--show-secrets`. The redactor returns the first
// 6 + last 4 chars when the value is ≥ 16 chars, otherwise '***'.
//
// TOML PARSER STRATEGY: if `@iarna/toml` is installed (declared in
// package.json deps) we use it. Otherwise we fall back to a minimal in-tree
// parser (parseTomlMinimal / stringifyTomlMinimal) sufficient for the kolm
// config schema (string / number / bool / arrays of strings, sections only
// - no inline tables, no datetimes). This means the module works in a
// fresh clone even before `npm install` runs.
//
// IMPORTANT: existing callers that read `~/.kolm/config.json` keep working.
// loadConfigJsonBackcompat() returns the legacy 2-key shape (base + api_key)
// pulled out of the merged config so cli/kolm.js's `loadConfig()` shim does
// not break during the migration period.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// SCHEMA (informal) - every section + key supported by `kolm config`.
// Keep this in sync with `docs/reference/config-toml.md`.
// ---------------------------------------------------------------------------
export const SCHEMA = {
  account: {
    api_key: { type: 'string', secret: true, description: 'kolm bearer key (ks_...)' },
    plan: { type: 'string', description: 'plan slug surfaced by the server' },
    tenant_id: { type: 'string', description: 'tenant id (tenant_...)' },
  },
  gateway: {
    default_provider: { type: 'string', description: 'primary provider (openai|anthropic|...)' },
    fallback_providers: { type: 'array', description: 'ordered list of fallback provider names' },
    pii_mode: { type: 'string', description: 'off | mask | hash | drop' },
    capture_rate: { type: 'number', description: 'capture sampling rate 0..1' },
  },
  compile: {
    default_target: { type: 'string', description: 'gguf-q4km | onnx | mlx | safetensors' },
    kscore_gate: { type: 'number', description: 'minimum K-Score before promotion' },
    progressive_passes: { type: 'number', description: 'number of distill passes (1..3)' },
    teacher_council: { type: 'array', description: 'teacher model ids' },
  },
  serve: {
    default_port: { type: 'number', description: 'default port for kolm serve' },
    kv_cache: { type: 'string', description: 'shard | static | off' },
    auto_detect: { type: 'boolean', description: 'auto-detect runtime + hardware on serve' },
  },
  cloud: {
    provider: { type: 'string', description: 'runpod | modal | lambda | vast' },
    api_key: { type: 'string', secret: true, description: 'cloud provider API key' },
    default_gpu: { type: 'string', description: 'preferred GPU sku e.g. a100-40gb' },
  },
  storage: {
    type: { type: 'string', description: 'sqlite | postgres | s3' },
    path: { type: 'string', description: 'local artifact / capture path' },
    postgres_url: { type: 'string', secret: true, description: 'postgres dsn (full URL incl password)' },
    s3_bucket: { type: 'string', description: 'S3 bucket name' },
    s3_region: { type: 'string', description: 'S3 region' },
    s3_endpoint: { type: 'string', description: 'S3-compatible endpoint URL (for r2/minio)' },
  },
  devices: {
    ssh_key_default: { type: 'string', description: 'default SSH key path for device deploys' },
  },
  telemetry: {
    enabled: { type: 'boolean', description: 'opt-in anonymized usage pings' },
    endpoint: { type: 'string', description: 'telemetry collector URL' },
  },
};

// Built-in defaults - applied when no higher-priority source has the key.
export const DEFAULTS = {
  account: { api_key: null, plan: null, tenant_id: null },
  gateway: {
    default_provider: 'openai',
    fallback_providers: ['anthropic', 'openai'],
    pii_mode: 'mask',
    capture_rate: 1.0,
  },
  compile: {
    default_target: 'gguf-q4km',
    kscore_gate: 0.85,
    progressive_passes: 1,
    teacher_council: [],
  },
  serve: {
    default_port: 8765,
    kv_cache: 'static',
    auto_detect: true,
  },
  cloud: {
    provider: null,
    api_key: null,
    default_gpu: null,
  },
  storage: {
    type: 'sqlite',
    path: null,
    postgres_url: null,
    s3_bucket: null,
    s3_region: null,
    s3_endpoint: null,
  },
  devices: {
    ssh_key_default: null,
  },
  telemetry: {
    enabled: false,
    endpoint: null,
  },
};

// Flat list of "section.key" pairs that hold a secret. Anything matching
// /api_key$|password|secret|token/i is also redacted via heuristic so a future
// schema addition that forgets `secret: true` still does not leak.
export const SECRET_KEYS = new Set();
for (const [section, keys] of Object.entries(SCHEMA)) {
  for (const [key, spec] of Object.entries(keys)) {
    if (spec.secret) SECRET_KEYS.add(`${section}.${key}`);
  }
}

const SECRET_KEY_HEURISTIC = /(_key|password|secret|token|dsn|connection_string)$/i;

export function isSecretKey(dottedKey) {
  if (SECRET_KEYS.has(dottedKey)) return true;
  const tail = dottedKey.split('.').pop() || '';
  return SECRET_KEY_HEURISTIC.test(tail);
}

export function redactValue(value) {
  if (value == null) return null;
  const s = String(value);
  if (s.length >= 16) return s.slice(0, 6) + '...' + s.slice(-4);
  if (s.length === 0) return '';
  return '***';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
export const USER_TOML_PATH = path.join(KOLM_DIR, 'config.toml');
export const USER_JSON_LEGACY_PATH = path.join(KOLM_DIR, 'config.json');
export const PROJECT_TOML_FILENAME = 'kolm.toml';

function ensureUserDir() {
  try { fs.mkdirSync(KOLM_DIR, { recursive: true }); } catch (_) { /* fs may be read-only in some test sandboxes */ }
}

// Walk up from cwd looking for a project kolm.toml. Stops at filesystem root
// or homedir (whichever is hit first - never read another user's homedir).
export function findProjectToml(cwd) {
  let dir = cwd || process.cwd();
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, PROJECT_TOML_FILENAME);
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (parent === HOME) return null;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TOML I/O
// ---------------------------------------------------------------------------
async function loadTomlParser() {
  // Try @iarna/toml first (declared dep). Catch ERR_MODULE_NOT_FOUND so we
  // gracefully fall back to the minimal parser when deps are not installed.
  try {
    const mod = await import('@iarna/toml');
    return {
      parse: mod.parse || mod.default?.parse,
      stringify: mod.stringify || mod.default?.stringify,
    };
  } catch (_) {
    return { parse: parseTomlMinimal, stringify: stringifyTomlMinimal };
  }
}

// Minimal TOML parser sufficient for the kolm config schema. Handles:
//   - comments (`# ...`), blank lines
//   - section headers `[section]` (one level deep only)
//   - bare keys + string / number / bool / array-of-string values
//   - quoted strings with simple escape (\n \t \\ \" \r)
// Does NOT handle: inline tables `{ a = 1 }`, multi-line strings, datetimes,
// nested sections `[a.b]`. We do not use those in the kolm schema.
export function parseTomlMinimal(text) {
  const out = {};
  let section = out;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_\-]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (!out[name] || typeof out[name] !== 'object') out[name] = {};
      section = out[name];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip trailing inline comment when value isn't a quoted string.
    if (!val.startsWith('"') && !val.startsWith("'") && !val.startsWith('[')) {
      const hash = val.indexOf('#');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (!key || !/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(key)) continue;
    section[key] = parseTomlValue(val);
  }
  return out;
}

function parseTomlValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const parts = splitTopLevelCommas(inner);
    return parts.map(parseTomlValue);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // Bare string fallback (legal in our minimal grammar).
  return v;
}

function splitTopLevelCommas(s) {
  const out = [];
  let cur = '';
  let inStr = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim().length) out.push(cur.trim());
  return out;
}

export function stringifyTomlMinimal(obj) {
  const lines = [];
  lines.push('# kolm config - generated by src/config.js');
  lines.push('# edit with: kolm config edit  (or `kolm config set <key> <value>`)');
  lines.push('');
  const sections = Object.keys(obj || {}).sort();
  for (const section of sections) {
    const body = obj[section];
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    lines.push(`[${section}]`);
    const keys = Object.keys(body).sort();
    for (const k of keys) {
      const v = body[k];
      if (v === undefined) continue;
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatTomlValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return '[' + v.map(formatTomlValue).join(', ') + ']';
  }
  if (typeof v === 'string') {
    return '"' + v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r') + '"';
  }
  // Objects flatten poorly - collapse to string. Should never happen for the
  // current schema, but a future caller that writes a sub-table by accident
  // gets a readable error rather than corrupt TOML.
  return '"' + JSON.stringify(v).replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Merge + hierarchy
// ---------------------------------------------------------------------------
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// In-place merge of src into dst. Only merges sections present in src.
// Arrays in src REPLACE the entry in dst (config does not concatenate lists).
function mergeInto(dst, src) {
  if (!src || typeof src !== 'object') return dst;
  for (const [section, body] of Object.entries(src)) {
    if (body == null) continue;
    if (typeof body !== 'object' || Array.isArray(body)) {
      dst[section] = body;
      continue;
    }
    if (!dst[section] || typeof dst[section] !== 'object') dst[section] = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      dst[section][k] = v;
    }
  }
  return dst;
}

// Env-var binding pattern:
//   gateway.default_provider  <->  KOLM_GATEWAY_DEFAULT_PROVIDER
//   storage.s3_endpoint       <->  KOLM_STORAGE_S3_ENDPOINT
// Only env vars matching the SCHEMA section names are picked up - anything
// else (KOLM_API_KEY, KOLM_BASE_URL legacy names) is left alone here and
// handled by their dedicated entries below for backwards compatibility.
export function envToDotted(envKey) {
  if (!envKey || !envKey.startsWith('KOLM_')) return null;
  const tail = envKey.slice(5).toLowerCase();
  for (const section of Object.keys(SCHEMA)) {
    if (tail.startsWith(section + '_')) {
      const key = tail.slice(section.length + 1);
      if (key && key in SCHEMA[section]) {
        return `${section}.${key}`;
      }
    }
  }
  return null;
}

export function dottedToEnv(dotted) {
  return 'KOLM_' + dotted.toUpperCase().replace(/\./g, '_');
}

function readEnvOverlay(env) {
  const overlay = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null || v === '') continue;
    const dotted = envToDotted(k);
    if (!dotted) continue;
    const [section, key] = dotted.split('.');
    if (!overlay[section]) overlay[section] = {};
    overlay[section][key] = coerceForKey(section, key, v);
  }
  // Legacy env-var bindings (preserve W067 behavior for KOLM_API_KEY +
  // KOLM_BASE / KOLM_BASE_URL). These are the names existing CLI loaders
  // already check; we mirror them into the new account section.
  if (env && env.KOLM_API_KEY) {
    overlay.account = overlay.account || {};
    overlay.account.api_key = env.KOLM_API_KEY;
  }
  return overlay;
}

function coerceForKey(section, key, raw) {
  const spec = SCHEMA[section] && SCHEMA[section][key];
  if (!spec) return raw;
  switch (spec.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean': {
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
      return Boolean(raw);
    }
    case 'array': {
      if (Array.isArray(raw)) return raw;
      return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    }
    case 'string':
    default:
      return String(raw);
  }
}

function readFlagsOverlay(flags) {
  if (!flags || typeof flags !== 'object') return {};
  const overlay = {};
  for (const [k, v] of Object.entries(flags)) {
    if (v == null) continue;
    if (!k.includes('.')) continue; // flags must be dotted to overlay config
    const [section, key] = k.split('.');
    if (!SCHEMA[section] || !SCHEMA[section][key]) continue;
    if (!overlay[section]) overlay[section] = {};
    overlay[section][key] = coerceForKey(section, key, v);
  }
  return overlay;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------
// W067 legacy shape: { base: 'https://...', api_key: 'ks_...' }. We map
// these into the new sections. Migration is one-shot - runs only when the
// TOML file does NOT exist AND the JSON file DOES. The JSON file is left
// in place so older CLI versions running concurrently keep reading it.
export function migrateLegacyJsonToToml() {
  try {
    if (fs.existsSync(USER_TOML_PATH)) return { migrated: false, reason: 'toml_exists' };
    if (!fs.existsSync(USER_JSON_LEGACY_PATH)) return { migrated: false, reason: 'no_legacy' };
    const raw = fs.readFileSync(USER_JSON_LEGACY_PATH, 'utf-8');
    let legacy;
    try { legacy = JSON.parse(raw); } catch (_) { return { migrated: false, reason: 'legacy_unparseable' }; }
    const tree = {
      account: {},
    };
    if (legacy && typeof legacy === 'object') {
      if (legacy.api_key) tree.account.api_key = legacy.api_key;
      if (legacy.base) {
        // base used to live at the top of the JSON; we keep reading it from
        // env (KOLM_BASE) at runtime and from the legacy file as a fallback
        // so we don't need a TOML home for it in the new schema. Stored as a
        // comment-only entry so the source file is self-documenting.
      }
    }
    ensureUserDir();
    const text = stringifyTomlMinimal(tree)
      + (legacy && legacy.base
          ? `\n# migrated from ${USER_JSON_LEGACY_PATH}: base = ${JSON.stringify(legacy.base)}\n`
          : '');
    fs.writeFileSync(USER_TOML_PATH, text);
    try { fs.chmodSync(USER_TOML_PATH, 0o600); } catch (_) { /* windows */ }
    return { migrated: true, from: USER_JSON_LEGACY_PATH, to: USER_TOML_PATH };
  } catch (e) {
    return { migrated: false, reason: 'error', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// loadConfig - hierarchy-resolved merged config + per-key source attribution.
// Returns { ...mergedTree, _sources: { 'section.key': 'default|project|user|env|flag' } }.
// `_sources` is non-enumerable on the returned object so JSON.stringify of
// a config tree round-trips cleanly.
export async function loadConfig({ flags = {}, env = process.env, cwd = process.cwd() } = {}) {
  ensureUserDir();
  migrateLegacyJsonToToml();
  const parser = await loadTomlParser();

  const merged = deepClone(DEFAULTS);
  const sources = {};
  // Seed sources with default for every defined key.
  for (const [section, body] of Object.entries(DEFAULTS)) {
    for (const k of Object.keys(body)) sources[`${section}.${k}`] = 'default';
  }

  // Project TOML (lower priority than user file per the directive).
  const projectPath = findProjectToml(cwd);
  if (projectPath) {
    try {
      const raw = fs.readFileSync(projectPath, 'utf-8');
      const parsed = parser.parse(raw) || {};
      mergeInto(merged, parsed);
      stampSources(parsed, 'project', sources);
    } catch (_) { /* malformed project toml is non-fatal */ }
  }

  // User TOML.
  if (fs.existsSync(USER_TOML_PATH)) {
    try {
      const raw = fs.readFileSync(USER_TOML_PATH, 'utf-8');
      const parsed = parser.parse(raw) || {};
      mergeInto(merged, parsed);
      stampSources(parsed, 'user', sources);
    } catch (_) { /* malformed user toml is non-fatal */ }
  }

  // Env overlay.
  const envOverlay = readEnvOverlay(env);
  mergeInto(merged, envOverlay);
  stampSources(envOverlay, 'env', sources);

  // Flag overlay (highest precedence).
  const flagOverlay = readFlagsOverlay(flags);
  mergeInto(merged, flagOverlay);
  stampSources(flagOverlay, 'flag', sources);

  Object.defineProperty(merged, '_sources', {
    value: sources,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return merged;
}

function stampSources(tree, label, sources) {
  for (const [section, body] of Object.entries(tree || {})) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const k of Object.keys(body)) {
      sources[`${section}.${k}`] = label;
    }
  }
}

// loadConfigSync - synchronous variant used by cli/kolm.js's existing
// loadConfig() shim. Uses the minimal parser only (so we never block on
// dynamic import of @iarna/toml during boot). Does NOT apply flag overlay
// (CLI flags are not parsed at module load time).
export function loadConfigSync({ env = process.env, cwd = process.cwd() } = {}) {
  ensureUserDir();
  migrateLegacyJsonToToml();
  const merged = deepClone(DEFAULTS);
  const sources = {};
  for (const [section, body] of Object.entries(DEFAULTS)) {
    for (const k of Object.keys(body)) sources[`${section}.${k}`] = 'default';
  }
  const projectPath = findProjectToml(cwd);
  if (projectPath) {
    try {
      const raw = fs.readFileSync(projectPath, 'utf-8');
      const parsed = parseTomlMinimal(raw) || {};
      mergeInto(merged, parsed);
      stampSources(parsed, 'project', sources);
    } catch (_) { /* ignore */ }
  }
  if (fs.existsSync(USER_TOML_PATH)) {
    try {
      const raw = fs.readFileSync(USER_TOML_PATH, 'utf-8');
      const parsed = parseTomlMinimal(raw) || {};
      mergeInto(merged, parsed);
      stampSources(parsed, 'user', sources);
    } catch (_) { /* ignore */ }
  }
  const envOverlay = readEnvOverlay(env);
  mergeInto(merged, envOverlay);
  stampSources(envOverlay, 'env', sources);
  Object.defineProperty(merged, '_sources', {
    value: sources,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return merged;
}

// saveConfig - writes one dotted key to the TOML at the requested scope.
// Reads the existing scope file first, sets the key, writes back. Returns
// `{ ok, scope, path, key, value }`.
export async function saveConfig(dottedKey, value, { scope = 'user', cwd = process.cwd() } = {}) {
  const [section, key] = String(dottedKey || '').split('.');
  if (!section || !key) throw new Error('saveConfig: key must be "section.key"');
  if (!SCHEMA[section] || !SCHEMA[section][key]) throw new Error(`saveConfig: unknown key ${dottedKey}`);
  const coerced = coerceForKey(section, key, value);
  const parser = await loadTomlParser();

  const filePath = scope === 'project'
    ? path.join(cwd, PROJECT_TOML_FILENAME)
    : USER_TOML_PATH;

  let tree = {};
  if (fs.existsSync(filePath)) {
    try {
      tree = parser.parse(fs.readFileSync(filePath, 'utf-8')) || {};
    } catch (_) { tree = {}; }
  }
  if (!tree[section] || typeof tree[section] !== 'object') tree[section] = {};
  tree[section][key] = coerced;

  if (scope !== 'project') ensureUserDir();
  fs.writeFileSync(filePath, parser.stringify(tree));
  if (scope !== 'project') {
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* windows */ }
  }
  return { ok: true, scope, path: filePath, key: dottedKey, value: coerced };
}

// unsetConfig - removes a key from the scope file. Returns ok:false with
// reason 'not_set' if the key did not exist (idempotent - never throws on
// missing).
export async function unsetConfig(dottedKey, { scope = 'user', cwd = process.cwd() } = {}) {
  const [section, key] = String(dottedKey || '').split('.');
  if (!section || !key) throw new Error('unsetConfig: key must be "section.key"');
  const parser = await loadTomlParser();
  const filePath = scope === 'project'
    ? path.join(cwd, PROJECT_TOML_FILENAME)
    : USER_TOML_PATH;
  if (!fs.existsSync(filePath)) return { ok: false, scope, path: filePath, reason: 'no_file' };
  let tree;
  try { tree = parser.parse(fs.readFileSync(filePath, 'utf-8')) || {}; }
  catch (_) { return { ok: false, scope, path: filePath, reason: 'unparseable' }; }
  if (!tree[section] || !(key in tree[section])) {
    return { ok: false, scope, path: filePath, key: dottedKey, reason: 'not_set' };
  }
  delete tree[section][key];
  if (Object.keys(tree[section]).length === 0) delete tree[section];
  fs.writeFileSync(filePath, parser.stringify(tree));
  return { ok: true, scope, path: filePath, key: dottedKey };
}

// getConfigValue - flat lookup honoring hierarchy. Returns { value, source }.
export async function getConfigValue(dottedKey, opts = {}) {
  const merged = await loadConfig(opts);
  const [section, key] = String(dottedKey || '').split('.');
  if (!section || !key) return { value: undefined, source: null };
  const value = merged[section] ? merged[section][key] : undefined;
  const source = merged._sources[dottedKey] || null;
  return { value, source };
}

// flattenConfig - returns array of { key, value, source, secret } for `list`.
export function flattenConfig(merged) {
  const out = [];
  const sources = merged._sources || {};
  for (const section of Object.keys(merged).sort()) {
    const body = merged[section];
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const k of Object.keys(body).sort()) {
      const dotted = `${section}.${k}`;
      out.push({
        key: dotted,
        value: body[k],
        source: sources[dotted] || 'default',
        secret: isSecretKey(dotted),
      });
    }
  }
  return out;
}

// Back-compat helper for the cli/kolm.js shim. Returns the legacy 2-key
// shape pulled from the merged config + env overrides so existing call sites
// that read `c.base` / `c.api_key` keep working without modification.
export function loadConfigJsonBackcompat({ env = process.env, cwd = process.cwd() } = {}) {
  const merged = loadConfigSync({ env, cwd });
  const base = env.KOLM_BASE || env.KOLM_BASE_URL || _legacyBaseFromFile() || 'https://kolm.ai';
  const api_key = merged.account?.api_key || env.KOLM_API_KEY || null;
  return { base, api_key, _merged: merged };
}

function _legacyBaseFromFile() {
  try {
    if (!fs.existsSync(USER_JSON_LEGACY_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(USER_JSON_LEGACY_PATH, 'utf-8'));
    return raw && raw.base ? raw.base : null;
  } catch (_) { return null; }
}
