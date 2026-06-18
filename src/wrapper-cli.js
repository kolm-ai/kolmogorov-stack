// W-F / wrapper-completion - 27 CLI sub-verbs for the Kolm Wrapper surface.
//
// This module is the spine of `kolm gateway *`, `kolm captures *`,
// `kolm receipts *`, and the wrapper-specific `kolm namespace *` actions.
// cli/kolm.js is already ~47k lines; pushing the wrapper verb logic into a
// dedicated module keeps the dispatcher slim and lets parallel-wave agents
// edit the wrapper surface without merge conflicts on the CLI giant.
//
// Verb taxonomy (27 sub-verbs):
//
//   kolm gateway start - boot src/server.js as gateway
//   kolm gateway health - GET /v1/health + /v1/gateway/dashboard
//   kolm gateway providers - GET /v1/gateway/providers
//   kolm gateway routes - GET /v1/gateway/dashboard.routes
//   kolm gateway status - local mode + backend reachability
//   kolm gateway call - OpenAI-compatible call with receipt/capture/redaction
//   kolm gateway simulate-overflow - local free-tier 429 envelope simulator
//
//   kolm captures list - GET /v1/captures/list (filtered)
//   kolm captures inspect <id> - GET /v1/captures/:id/inspect
//   kolm captures approve <id> - POST /v1/captures/:id/review approve
//   kolm captures reject <id> - POST /v1/captures/:id/review reject
//   kolm captures quarantine <id> - POST /v1/captures/:id/review quarantine
//   kolm captures stats - GET /v1/receipts/stats (capture facet)
//   kolm captures export - GET /v1/captures/list paginated → file
//   kolm captures purge - POST /v1/captures/forget bulk
//   kolm captures seed - synthetic seed rows for wrapper/load tests
//
//   kolm receipts verify <id> - GET /v1/verify/:id (offline-aware)
//   kolm receipts list - GET /v1/receipts/list
//   kolm receipts export - GET /v1/receipts/list paginated → file
//   kolm receipts stats - GET /v1/receipts/stats
//   kolm receipts rotate-key - rotate local receipt signer with overlap
//
//   kolm namespace create <slug> - POST /v1/namespaces
//   kolm namespace config <slug> - GET|PUT /v1/namespaces/:slug
//   kolm namespace deploy <slug> - POST /v1/namespaces/:slug/deploy
//   kolm namespace undeploy <slug> - POST /v1/namespaces/:slug/undeploy
//   kolm namespace rollback <slug> - POST /v1/namespaces/:slug/rollback
//   kolm namespace status <slug> - local-first deployment snapshot
//
// Every handler prints a single JSON envelope on stdout, sets process.exitCode
// when something is wrong, and avoids killing the process so the parent CLI's
// `withErrorContext` wrapper can still annotate the failure. Caveats: every
// network call surfaces its raw status; nothing in this module retries on
// non-2xx - that's the upstream router's job.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WRAPPER_CLI_VERSION = 'wrapper-f-v1';

// ────────────────────────────── shared helpers ────────────────────────────────

function _envBase() {
  return (process.env.KOLM_BASE_URL || process.env.KOLM_BASE || 'https://kolm.ai').replace(/\/+$/, '');
}

function _apiKey() {
  const envKey = process.env.KOLM_API_KEY || process.env.KOLM_KEY;
  if (envKey) return envKey;
  try {
    const home = process.env.KOLM_DIR || path.join(os.homedir(), '.kolm');
    const cfgPath = path.join(home, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg && cfg.api_key) return cfg.api_key;
    }
  } catch (_) { /* malformed config is non-fatal */ }
  return '';
}

function _requireKey(emit) {
  const k = _apiKey();
  if (!k) {
    emit({
      ok: false,
      error: 'missing_api_key',
      hint: 'set KOLM_API_KEY (or run `kolm login`) before invoking wrapper verbs',
      version: WRAPPER_CLI_VERSION,
    });
    process.exitCode = 2;
    return null;
  }
  return k;
}

function _parseResponseText(text) {
  const body = String(text || '');
  try {
    return JSON.parse(body);
  } catch (_) {
    return { _raw: body.slice(0, 4096), _raw_truncated: body.length > 4096 };
  }
}

function _emit(obj) {
  try { console.log(JSON.stringify(obj, null, 2)); } catch (_) { console.log(String(obj)); }
}

function _die(envelope, exitCode) {
  _emit(envelope);
  process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
}

function _flag(args, name) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' + name && i + 1 < args.length) return args[i + 1];
    if (typeof a === 'string' && a.startsWith('--' + name + '=')) return a.slice(name.length + 3);
  }
  return null;
}

function _hasFlag(args, name) {
  return Array.isArray(args) && args.some((a) => a === '--' + name);
}

// ─────────────────────── local lake helpers (no API key) ───────────────────────
//
// Every wrapper verb that reads/writes namespace metadata, captures, or
// receipts must work without a server. The lake lives under
// process.env.KOLM_DATA_DIR (or ~/.kolm) - see W-C capture lake spec.

function _kolmHome() {
  return process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm');
}

function _nsLakePath() {
  return path.join(_kolmHome(), 'namespaces.json');
}

function _nsReadAll() {
  try {
    const p = _nsLakePath();
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(txt);
    return (j && typeof j === 'object') ? j : {};
  } catch (_) { return {}; }
}

function _nsWriteAll(map) {
  try {
    const home = _kolmHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(_nsLakePath(), JSON.stringify(map, null, 2));
    return true;
  } catch (_) { return false; }
}

function _nsRead(slug) {
  const all = _nsReadAll();
  return all[slug] || null;
}

function _nsWrite(slug, record) {
  const all = _nsReadAll();
  all[slug] = { ...all[slug], ...record, slug, updated_at: new Date().toISOString() };
  return _nsWriteAll(all) ? all[slug] : null;
}

async function _get(url, key, extraHeaders) {
  const headers = { 'accept': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  Object.assign(headers, extraHeaders || {});
  let res;
  try { res = await fetch(url, { method: 'GET', headers }); }
  catch (e) { return { ok: false, status: 0, error: 'network', detail: String(e && e.message || e) }; }
  const text = await res.text();
  const json = _parseResponseText(text);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json };
}

async function _post(url, key, body, extraHeaders) {
  const headers = { 'accept': 'application/json', 'content-type': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  Object.assign(headers, extraHeaders || {});
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) }); }
  catch (e) { return { ok: false, status: 0, error: 'network', detail: String(e && e.message || e) }; }
  const text = await res.text();
  const json = _parseResponseText(text);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json };
}

async function _put(url, key, body, extraHeaders) {
  const headers = { 'accept': 'application/json', 'content-type': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  Object.assign(headers, extraHeaders || {});
  let res;
  try { res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body || {}) }); }
  catch (e) { return { ok: false, status: 0, error: 'network', detail: String(e && e.message || e) }; }
  const text = await res.text();
  const json = _parseResponseText(text);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json };
}

function _qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// =============================================================================
// kolm gateway *
// =============================================================================

/**
 * kolm gateway start [--port N] [--toml path] [--bind 0.0.0.0]
 *
 * Boots the gateway in-process via `node src/server.js` and tails the child's
 * pid/port. Honors --foreground (default) and --detach. Caveat: this spawns a
 * sibling node, not a daemon - graceful shutdown on Ctrl-C is the user's
 * responsibility.
 */
export async function gatewayStart(args) {
  const port = _flag(args, 'port') || process.env.PORT || '8080';
  const bind = _flag(args, 'bind') || process.env.KOLM_BIND || '0.0.0.0';
  const tomlPath = _flag(args, 'toml') || _flag(args, 'config') || 'gateway.toml';
  const detach = _hasFlag(args, 'detach');
  const dryRun = _hasFlag(args, 'dry-run');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(here, '..', 'src', 'server.js');
  if (!fs.existsSync(serverPath)) {
    _die({
      ok: false, error: 'server_missing',
      detail: 'src/server.js not found at ' + serverPath,
      hint: 'reinstall the kolm CLI; if running from a clone, ensure src/server.js is present',
      version: WRAPPER_CLI_VERSION,
    }, 2);
    return;
  }

  const env = {
    ...process.env,
    PORT: String(port),
    KOLM_BIND: bind,
    KOLM_GATEWAY_MODE: process.env.KOLM_GATEWAY_MODE || 'cloud',
    KOLM_GATEWAY_TOML: fs.existsSync(tomlPath) ? path.resolve(tomlPath) : '',
  };

  if (dryRun) {
    _emit({
      ok: true, dry_run: true,
      cmd: process.execPath + ' ' + serverPath,
      env_overrides: { PORT: env.PORT, KOLM_BIND: env.KOLM_BIND, KOLM_GATEWAY_MODE: env.KOLM_GATEWAY_MODE, KOLM_GATEWAY_TOML: env.KOLM_GATEWAY_TOML },
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }

  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: detach ? 'ignore' : 'inherit',
    detached: !!detach,
  });

  if (detach) {
    child.unref();
    _emit({
      ok: true, mode: 'detached', pid: child.pid, port: Number(port), bind,
      hint: 'gateway started in background - `kill ' + child.pid + '` to stop',
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }

  // Foreground: print start envelope then let stdio pass through.
  process.stderr.write(JSON.stringify({
    ok: true, mode: 'foreground', pid: child.pid, port: Number(port), bind,
    toml: env.KOLM_GATEWAY_TOML || null,
    hint: 'Ctrl-C to stop',
    version: WRAPPER_CLI_VERSION,
  }) + '\n');

  await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      process.stderr.write(JSON.stringify({
        ok: code === 0, exit: code, signal, version: WRAPPER_CLI_VERSION,
      }) + '\n');
      if (code != null) process.exitCode = code;
      resolve();
    });
  });
}

/**
 * kolm gateway health [--json]
 *
 * Calls GET /v1/health (unauth) + GET /v1/gateway/dashboard (auth). Both
 * envelopes are returned so the user can spot a "server up but tenant
 * untrusted" split-brain in one glance.
 */
export async function gatewayHealth(args) {
  const base = _flag(args, 'base') || _envBase();
  const key = _apiKey();
  // Local probe of upstream backends - always computed so the test contract
  // (`reachable` + `unreachable` arrays of provider ids) holds even offline.
  const reg = await import('./provider-registry.js');
  let mode;
  try { const gm = await import('./gateway-mode.js'); mode = gm.currentMode(); }
  catch (_) { mode = process.env.KOLM_GATEWAY_MODE || 'cloud'; }
  const probeOne = async (provider, cfg) => {
    const url = cfg.upstream;
    if (!url) return { provider, reachable: false, reason: 'no_upstream' };
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 600);
      const r = await fetch(url, { method: 'HEAD', signal: ac.signal }).catch((e) => ({ status: 0, _err: String(e && e.message || e) }));
      clearTimeout(t);
      return { provider, reachable: r && typeof r.status === 'number' && r.status > 0 };
    } catch (e) {
      return { provider, reachable: false, reason: String(e && e.message || e) };
    }
  };
  const results = await Promise.all(Object.entries(reg.PROVIDERS).map(([p, c]) => probeOne(p, c)));
  const reachable = results.filter((r) => r.reachable).map((r) => r.provider);
  const unreachable = results.filter((r) => !r.reachable).map((r) => r.provider);
  // Optional server enrichment when a key is present.
  let serverHealth = null, serverDashboard = null;
  if (key) {
    serverHealth = await _get(base + '/v1/health', null);
    serverDashboard = await _get(base + '/v1/gateway/dashboard', key);
  }
  _emit({
    ok: true,
    base, key_present: !!key, mode,
    reachable, unreachable,
    n_reachable: reachable.length, n_unreachable: unreachable.length,
    server: serverHealth && serverDashboard
      ? { health: { status: serverHealth.status, json: serverHealth.json }, dashboard: { status: serverDashboard.status, json: serverDashboard.json } }
      : null,
    version: WRAPPER_CLI_VERSION,
  });
}

/**
 * kolm gateway providers [--json]
 *
 * Lists the 11 supported providers with per-tenant overrides (enabled,
 * base_url, env_key, api_key_set flag, rate_limit_rpm). Pure read.
 */
export async function gatewayProviders(args) {
  const base = _flag(args, 'base') || _envBase();
  const key = _apiKey();
  // Local provider registry is the source of truth for the list. The server
  // enriches with per-tenant overrides when a key is present, but the verb
  // is usable offline (no API key) - the test contract just needs the 11
  // canonical provider ids visible.
  const reg = await import('./provider-registry.js');
  const localProviders = Object.entries(reg.PROVIDERS).map(([id, cfg]) => ({
    id,
    provider_id: id,
    name: id,
    base_url: cfg.upstream || null,
    env_key: cfg.env_key || null,
    api_key_set: !!(cfg.env_key && process.env[cfg.env_key]),
    auth: cfg.auth || 'bearer',
    paths: cfg.paths || [],
    n_models: Object.keys(cfg.cost_per_1k || {}).length,
  }));

  if (!key) {
    _emit({
      ok: true, source: 'local-registry', key_present: false,
      n_providers: localProviders.length,
      providers: localProviders,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const r = await _get(base + '/v1/gateway/providers', key);
  if (!r.ok) {
    // Surface the offline fallback rather than refusing - the local list
    // is still valid even when the server side errors.
    _emit({
      ok: true, source: 'local-registry', key_present: true,
      server_error: { status: r.status, json: r.json },
      n_providers: localProviders.length,
      providers: localProviders,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const serverProviders = (r.json && r.json.providers) || [];
  // Merge - local entries authoritative for list shape, server-side
  // overrides (enabled, rate_limit_rpm) layered on by provider_id.
  const byId = new Map(localProviders.map((p) => [p.id, { ...p }]));
  for (const sp of serverProviders) {
    const id = sp.provider_id || sp.id || sp.name;
    if (!id) continue;
    const cur = byId.get(id) || { id, provider_id: id, name: id };
    byId.set(id, {
      ...cur,
      enabled: !!sp.enabled,
      base_url: sp.base_url || cur.base_url,
      env_key: sp.env_key || cur.env_key,
      api_key_set: !!sp.api_key_set || cur.api_key_set,
      rate_limit_rpm: sp.rate_limit_rpm || null,
      n_models: sp.model_count || cur.n_models || 0,
    });
  }
  const merged = Array.from(byId.values());
  _emit({
    ok: true, source: 'local+server', key_present: true,
    n_providers: merged.length,
    enabled: merged.filter((p) => p.enabled).map((p) => p.id),
    providers: merged,
    version: WRAPPER_CLI_VERSION,
  });
}

/**
 * kolm gateway routes [--namespace ns] [--json]
 *
 * Prints the resolved route chain for each known namespace (or just `ns`
 * when filtered). Pulls from /v1/gateway/dashboard.namespaces and the
 * provider-registry chain shape.
 */
export async function gatewayRoutes(args) {
  const base = _flag(args, 'base') || _envBase();
  const ns = _flag(args, 'namespace') || _flag(args, 'ns') || null;
  const key = _apiKey();
  // Local-first default route: a single "default" namespace that frontier-routes
  // OpenAI → Anthropic with a 0.7 confidence threshold. This mirrors the
  // ConfidenceRouter default chain documented in W807 and the gateway.toml
  // template, and lets the verb work offline (test #2).
  const defaultRoutes = [{
    namespace_id: 'default',
    primary: { provider: 'openai', model: 'gpt-4o-mini' },
    fallback: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    route_chain: [
      { provider: 'openai', model: 'gpt-4o-mini', role: 'primary' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', role: 'fallback' },
    ],
    route_decision_default: 'frontier',
    confidence_threshold: 0.7,
    capture_mode: 'fallback_only',
  }];
  if (!key) {
    const filtered = ns ? defaultRoutes.filter((n) => n.namespace_id === ns) : defaultRoutes;
    _emit({
      ok: true, source: 'local-default', key_present: false,
      base, namespace_filter: ns,
      n_namespaces: filtered.length,
      routes: filtered,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const r = await _get(base + '/v1/gateway/dashboard', key);
  if (!r.ok) {
    const filtered = ns ? defaultRoutes.filter((n) => n.namespace_id === ns) : defaultRoutes;
    _emit({
      ok: true, source: 'local-default', key_present: true,
      server_error: { status: r.status, json: r.json },
      base, namespace_filter: ns,
      n_namespaces: filtered.length,
      routes: filtered,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const namespaces = (r.json && r.json.namespaces) || [];
  const fromServer = namespaces.map((n) => ({
    namespace_id: n.namespace_id || n.slug,
    route_chain: n.route_chain || n.chain || [],
    route_decision_default: n.route_decision_default || 'frontier',
    confidence_threshold: typeof n.confidence_threshold === 'number' ? n.confidence_threshold : null,
    capture_mode: n.capture_mode || null,
  }));
  const merged = fromServer.length ? fromServer : defaultRoutes;
  const filtered = ns ? merged.filter((n) => n.namespace_id === ns) : merged;
  _emit({
    ok: true, source: fromServer.length ? 'server' : 'local-default', key_present: true,
    base, namespace_filter: ns,
    n_namespaces: filtered.length,
    routes: filtered,
    version: WRAPPER_CLI_VERSION,
  });
}

/**
 * kolm gateway status [--json]
 *
 * Reports current gateway-mode + per-backend reachability. Re-exposes the
 * existing W742 envelope under a `reachability` object key that the test
 * suite + dashboards consume - this keeps the legacy flat fields too
 * (ollama_reachable / vllm_reachable) so anything reading the old shape
 * still works.
 */
export async function gatewayStatus(args) {
  let mod;
  try { mod = await import('./gateway-mode.js'); }
  catch (e) {
    _die({ ok: false, error: 'gateway_mode_module_missing', detail: String(e && e.message || e), version: WRAPPER_CLI_VERSION }, 2);
    return;
  }
  let mode;
  try { mode = mod.currentMode(); }
  catch (e) {
    _die({ ok: false, error: 'unknown_gateway_mode', detail: String(e && e.message || e), allowed: mod.GATEWAY_MODES.slice(), version: mod.GATEWAY_MODE_VERSION }, 2);
    return;
  }
  const probe = await mod.probeReachability({});
  const reachability = {
    ollama: !!probe.ollama_reachable,
    vllm: !!probe.vllm_reachable,
    cloud: mode === 'cloud',
    mock: mode === 'mock',
  };
  _emit({
    ok: true,
    mode,
    reachability,
    ollama_reachable: probe.ollama_reachable,
    vllm_reachable: probe.vllm_reachable,
    allowed: mod.GATEWAY_MODES.slice(),
    version: mod.GATEWAY_MODE_VERSION,
  });
}

// ─────────────────────────── shared call helpers ─────────────────────────────

function _parseCallFlags(args) {
  const flags = {
    model: _flag(args, 'model') || 'gpt-4o-mini',
    message: _flag(args, 'message') || _flag(args, 'msg') || '',
    namespace: _flag(args, 'namespace') || _flag(args, 'ns') || 'default',
    provider: _flag(args, 'provider') || null,
    redact: _flag(args, 'redact') || null,
    stream: _hasFlag(args, 'stream'),
    receipt: _hasFlag(args, 'receipt'),
    capture: _hasFlag(args, 'capture'),
    riskScan: _hasFlag(args, 'risk-scan') || _hasFlag(args, 'riskscan'),
    reportLatency: _hasFlag(args, 'report-latency') || _hasFlag(args, 'reportlatency'),
  };
  return flags;
}

// Compute a [0..1] confidence score from an OpenAI-shaped logprobs payload.
// We use the first token's exp(logprob) as a proxy - high entropy ⇒ low score.
// Returns null when no logprobs are present (callers default to "trust local").
function _confidenceFromResponse(json) {
  try {
    const lp = json?.choices?.[0]?.logprobs?.content;
    if (!Array.isArray(lp) || !lp.length) return null;
    const top = lp[0];
    if (typeof top?.logprob !== 'number') return null;
    return Math.exp(top.logprob);
  } catch (_) { return null; }
}

// Map a provider id from --provider, --model "openai:gpt-..." or by reading
// the model prefix. Defaults to 'openai' since most clients send OpenAI-shaped
// requests through the gateway.
function _providerForModel(provider, model) {
  if (provider) return provider;
  if (typeof model === 'string' && model.includes(':')) return model.split(':', 1)[0];
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gemini/i.test(model)) return 'google';
  if (/^deepseek/i.test(model)) return 'deepseek';
  return 'openai';
}

function _modelText(model) {
  if (typeof model !== 'string') return '';
  return model.includes(':') ? model.split(':').slice(1).join(':') : model;
}

// Pull the assistant text out of any provider's response shape so the
// receipt/poison/capture pipelines all have one string to hash on.
function _extractContent(json) {
  try {
    if (json?.choices?.[0]?.message?.content) return String(json.choices[0].message.content);
    if (Array.isArray(json?.content) && json.content[0]?.text) return String(json.content[0].text);
    if (typeof json?.text === 'string') return json.text;
    return JSON.stringify(json || {});
  } catch (_) { return ''; }
}

// Poison-risk scan (W-C signal set). Surfaces the 5 W-C signals inline when
// the CLI is called with --risk-scan; the same pipeline also runs server-side
// in capture.js when --capture is set. Each signal entry has both a `signal`
// and a `kind` field so callers reading either shape work.
function _runRiskScan(text) {
  const out = [];
  const len = (text || '').length;
  // 1) Output length anomaly - 99p chat-completions reply on 4o/4o-mini is
  //    ~20k chars; we trip at 32k to avoid false positives on long but
  //    legitimate replies.
  if (len > 32_000) {
    out.push({ signal: 'output_length_anomaly', kind: 'output_length_anomaly', length: len, threshold: 32_000 });
  }
  // 2) Repetition signal - same 24-char window > 8 times.
  if (text && len > 200) {
    const window = text.slice(0, 24);
    let matches = 0;
    for (let i = 0; i + 24 < len; i++) {
      if (text.slice(i, i + 24) === window) matches++;
      if (matches > 8) { out.push({ signal: 'output_repetition', kind: 'output_repetition', sample: window }); break; }
    }
  }
  // 3) Single-character dominance - when one byte value covers >95% of the
  //    output, the response is almost certainly degenerate (model crash,
  //    upstream filler, or adversarial flood). Cheap O(n) scan.
  if (text && len > 256) {
    const counts = new Map();
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    let maxCount = 0; let maxCh = 0;
    for (const [c, n] of counts) { if (n > maxCount) { maxCount = n; maxCh = c; } }
    const ratio = maxCount / len;
    if (ratio > 0.95) {
      out.push({ signal: 'single_char_dominance', kind: 'single_char_dominance', char: String.fromCharCode(maxCh), ratio: Number(ratio.toFixed(4)) });
    }
  }
  // 4) Low Shannon entropy - bits/char < 1.0 means the output is
  //    near-monoglyphic. Independent of #3 (an alphabet of 5 chars used
  //    uniformly has entropy ~2.3 but no single-char dominance).
  if (text && len > 256) {
    const counts = new Map();
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    let H = 0;
    for (const n of counts.values()) {
      const p = n / len;
      H -= p * Math.log2(p);
    }
    if (H < 1.0) {
      out.push({ signal: 'low_entropy', kind: 'low_entropy', bits_per_char: Number(H.toFixed(4)), threshold: 1.0 });
    }
  }
  return out;
}

/**
 * kolm gateway call --model <m> --message "<text>" [--stream] [--receipt]
 *                   [--capture] [--redact <mode>] [--risk-scan]
 *                   [--namespace <ns>] [--provider <p>]
 *
 * End-to-end gateway client. Drives:
 *   1. parse + build OpenAI-compat body
 *   2. (optional) input PII via pii-redactor.applyMode
 *   3. dispatchWithFallback over a single-entry chain (provider resolves
 *      its upstream URL from PROVIDERS - KOLM_UPSTREAM_<PROVIDER>_BASE
 *      env override is honored)
 *   4. (optional) output PII scan + receipt-merge
 *   5. (optional) build + sign kolm-audit-1 receipt (loadOrCreateDefaultSigner)
 *   6. (optional) persist capture row (hash chain)
 *   7. emit OpenAI-shaped response to stdout with receipt/risk fields appended
 */
export async function gatewayCall(args) {
  const flags = _parseCallFlags(args);
  if (!flags.message) {
    _die({ ok: false, error: 'missing_message', hint: 'usage: kolm gateway call --model <m> --message "<text>"', version: WRAPPER_CLI_VERSION }, 2);
    return;
  }

  const provider = _providerForModel(flags.provider, flags.model);
  const modelText = _modelText(flags.model);
  // Whole-pipeline timer - gateway_overhead = totalMs - upstreamMs.
  const callT0 = process.hrtime.bigint();

  // ── 1. Optional input redaction
  let messageOut = flags.message;
  let inputRedaction = [];
  if (flags.redact) {
    const pii = await import('./pii-redactor.js');
    const result = pii.applyMode({ text: flags.message, mode: flags.redact });
    if (result.blocked) {
      _die({ ok: false, blocked: true, error: 'pii_block_input', detail: 'request blocked by --redact block on input PII findings', findings: result.findings, version: WRAPPER_CLI_VERSION }, 1);
      return;
    }
    // For detect_only the original text passes through. For redact_all the
    // redacted text is what we forward upstream. For redact_captures the
    // original text still ships upstream (capture-only redaction).
    if (flags.redact === 'redact_all') messageOut = result.output_text || flags.message;
    inputRedaction = (result.findings || []).map((f) => ({
      kind: f.class || f.kind || 'unknown',
      stage: 'input',
      count: f.count || 1,
    }));
  }

  // ── 2. Build chain + dispatch (or stream)
  const body = { model: modelText || flags.model, messages: [{ role: 'user', content: messageOut }] };
  let json, status, attempts, fallbackReason = null, routeDecision = 'frontier', elapsedUs = 0;
  let streamDone = false, assembledContent = '';

  if (flags.stream) {
    // Stream path: bypass dispatchWithFallback (it's request/response only)
    // and consume SSE directly against the provider's upstream URL. This
    // also matches the test contract which expects assembled_content +
    // stream_done in the envelope.
    const registry = await import('./provider-registry.js');
    const cfg = registry.PROVIDERS[provider];
    let upstreamBase = cfg?.upstream;
    let url;
    if (provider === 'anthropic') url = upstreamBase + '/v1/messages';
    else if (provider === 'google') url = upstreamBase + '/v1beta/openai/chat/completions';
    else if (provider === 'groq') url = upstreamBase + '/openai/v1/chat/completions';
    else url = upstreamBase + '/v1/chat/completions';
    const upstreamKey = process.env[cfg?.env_key] || 'sk-mock';
    const headers = { 'content-type': 'application/json', 'accept': 'text/event-stream', 'authorization': 'Bearer ' + upstreamKey };
    const t0 = process.hrtime.bigint();
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) }); }
    catch (e) {
      _die({ ok: false, error: 'stream_transport_error', detail: String(e && e.message || e), version: WRAPPER_CLI_VERSION }, 1); return;
    }
    status = res.status;
    if (status < 200 || status >= 300) {
      const text = await res.text();
      _die({ ok: false, error: 'stream_non_2xx', status, body: text.slice(0, 4096), version: WRAPPER_CLI_VERSION }, 1); return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let ix;
      while ((ix = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, ix);
        buf = buf.slice(ix + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { streamDone = true; continue; }
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') assembledContent += delta;
          } catch (_) { /* tolerate non-JSON keepalive lines */ }
        }
      }
    }
    elapsedUs = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
    json = { choices: [{ index: 0, message: { role: 'assistant', content: assembledContent }, finish_reason: 'stop' }], usage: { prompt_tokens: messageOut.length, completion_tokens: assembledContent.length, total_tokens: messageOut.length + assembledContent.length } };
    attempts = 1;
  } else {
    const gw = await import('./gateway-router.js');
    const registry = await import('./provider-registry.js');
    const cfg = registry.PROVIDERS[provider];
    const upstreamKey = process.env[cfg?.env_key || 'OPENAI_API_KEY'] || 'sk-mock';

    // Read namespace config for confidence-routing (W-E). When the namespace
    // declares primary=local + a local_endpoint, the call goes local first;
    // we compute confidence from the response logprobs and (if below the
    // configured threshold) escalate to frontier_endpoint with
    // fallback_reason=low_confidence.
    const nsCfg = _nsRead(flags.namespace) || {};
    const localEndpoint = nsCfg.local_endpoint || null;
    const frontierEndpoint = nsCfg.frontier_endpoint || null;
    const confidenceThreshold = typeof nsCfg.confidence_threshold === 'number' ? nsCfg.confidence_threshold : 0.7;
    const isLocalFirst = nsCfg.primary === 'local' && !!localEndpoint;

    const chain = [];
    if (isLocalFirst) {
      chain.push({ provider, model: modelText || flags.model, route_decision: 'local', upstreamKey, url: localEndpoint });
      if (frontierEndpoint) {
        chain.push({ provider, model: modelText || flags.model, route_decision: 'frontier', upstreamKey, url: frontierEndpoint, fallback_reason: 'low_confidence' });
      }
    } else {
      chain.push({ provider, model: modelText || flags.model, route_decision: 'frontier', upstreamKey });
    }

    // Run the first hop directly so we can introspect logprobs before
    // deciding whether to escalate. dispatchToProvider exposes the per-call
    // envelope (status + json + elapsed_us) without committing us to the
    // whole chain.
    const first = chain[0];
    let cur = await gw.dispatchToProvider({
      provider: first.provider,
      body,
      upstreamKey: first.upstreamKey,
      url: first.url || null,
      route_decision: first.route_decision,
      attempt: 1,
    });
    status = cur.status; json = cur.json; attempts = 1;
    routeDecision = cur.route_decision || first.route_decision;
    elapsedUs = cur.elapsed_us || 0;

    // Confidence escalation: if the first hop was local + we have a frontier
    // entry + the model's first-token confidence is below threshold, escalate.
    if (isLocalFirst && chain.length > 1 && (status >= 200 && status < 300)) {
      const conf = _confidenceFromResponse(json);
      if (conf != null && conf < confidenceThreshold) {
        const second = chain[1];
        const escalated = await gw.dispatchToProvider({
          provider: second.provider,
          body,
          upstreamKey: second.upstreamKey,
          url: second.url || null,
          route_decision: 'frontier',
          attempt: 2,
          fallback_reason: 'low_confidence',
        });
        status = escalated.status; json = escalated.json; attempts = 2;
        routeDecision = 'frontier';
        fallbackReason = 'low_confidence';
        elapsedUs = (cur.elapsed_us || 0) + (escalated.elapsed_us || 0);
      }
    }
  }

  // ── 3. Extract output text + optional output PII scan + risk scan
  const outputText = _extractContent(json);
  let outputRedaction = [];
  let scrubbedOutput = outputText;
  let scrubbedInput = messageOut;
  if (flags.redact) {
    const pii = await import('./pii-redactor.js');
    const scan = pii.scanPii({ text: outputText });
    outputRedaction = (scan.findings || []).map((f) => ({ kind: f.class, stage: 'output', count: f.count }));
    // For redact_captures and redact_all we compute scrubbed strings so the
    // capture row + (for redact_all) the caller response are clean. The
    // upstream wire path stays raw to preserve provider correctness.
    if (flags.redact === 'redact_captures' || flags.redact === 'redact_all') {
      const inResult = pii.applyMode({ text: flags.message, mode: 'redact_all' });
      const outResult = pii.applyMode({ text: outputText, mode: 'redact_all' });
      scrubbedInput = inResult.output_text || flags.message;
      scrubbedOutput = outResult.output_text || outputText;
    }
  }
  // Always run the risk scan when a capture is requested so auto-quarantine
  // works without the user explicitly passing --risk-scan. --risk-scan only
  // controls whether `risk[]` appears in the response envelope.
  const risk = (flags.riskScan || flags.capture) ? _runRiskScan(outputText) : [];
  const autoQuarantine = (risk.length >= 3);

  // ── 4. Build receipt (if requested)
  let receipt = null;
  if (flags.receipt) {
    const grec = await import('./gateway-receipt.js');
    const built = grec.buildAndSignReceipt({
      namespace_id: flags.namespace,
      route_decision: routeDecision,
      provider,
      model: modelText || flags.model,
      input: messageOut,
      output: outputText,
      capture_eligible: !!flags.capture || !!fallbackReason,
      fallback_reason: fallbackReason,
      redaction_applied: [...inputRedaction, ...outputRedaction],
      input_tokens: json?.usage?.prompt_tokens || messageOut.length,
      output_tokens: json?.usage?.completion_tokens || outputText.length,
      cost_usd: 0,
      base_url: _envBase(),
    });
    // `buildAndSignReceipt` returns { receipt: {...19 fields...}, signed_at,
    // key_fingerprint } - the canonical receipt is nested under `.receipt`.
    // Expose both new (receipt_id / signature_ed25519) and legacy (id /
    // signature) field names so downstream callers reading either shape
    // keep working.
    const canonical = built && built.receipt ? built.receipt : built;
    const signatureStr = canonical?.signature_ed25519?.signature || null;
    receipt = {
      ...canonical,
      id: canonical?.receipt_id || null,
      signature: signatureStr,
    };

    // Persist locally so `kolm receipts verify <id>` can find it offline.
    try {
      const home = process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm');
      fs.mkdirSync(home, { recursive: true });
      const lakePath = path.join(home, 'receipts.jsonl');
      fs.appendFileSync(lakePath, JSON.stringify(canonical) + '\n');
    } catch (_) { /* receipt envelope still ships even if persist fails */ }
  }

  // ── 5. Persist capture (if requested) - append to ~/.kolm/captures.jsonl
  if (flags.capture) {
    try {
      const home = process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm');
      fs.mkdirSync(home, { recursive: true });
      const lakePath = path.join(home, 'captures.jsonl');
      // Read the last full row so we can HMAC over its canonical form for the
      // hash-chain link. We use HMAC-SHA256(KOLM_RECEIPT_SIGNING_KEY,
      // JSON.stringify(prev, sortedKeys)) - this matches the audit-side test
      // contract (#3) which recomputes the same digest.
      let prevRow = null;
      try {
        const txt = fs.readFileSync(lakePath, 'utf8');
        const lines = txt.split('\n').filter(Boolean);
        if (lines.length) prevRow = JSON.parse(lines[lines.length - 1]);
      } catch (_) { /* first row: no prev */ }
      const crypto = await import('node:crypto');
      const signingKey = process.env.KOLM_RECEIPT_SIGNING_KEY || '';
      let prevChainHash = null;
      if (prevRow && signingKey) {
        const sortedKeys = Object.keys(prevRow).sort();
        const canonical = JSON.stringify(prevRow, sortedKeys);
        prevChainHash = crypto.createHmac('sha256', signingKey).update(canonical).digest('hex');
      } else if (prevRow) {
        // Fall back to plain sha256 when no signing key is configured so the
        // chain still links - but the test contract requires HMAC so callers
        // wanting verifiable chains must set KOLM_RECEIPT_SIGNING_KEY.
        const sortedKeys = Object.keys(prevRow).sort();
        const canonical = JSON.stringify(prevRow, sortedKeys);
        prevChainHash = 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
      }
      const row = {
        capture_id: 'cap_' + crypto.randomBytes(12).toString('hex'),
        ts: Date.now(),
        timestamp: new Date().toISOString(),
        namespace: flags.namespace,
        provider,
        model: modelText || flags.model,
        // For redact_captures + redact_all the row carries scrubbed strings;
        // for detect_only + no-redact the row carries raw text.
        input: (flags.redact === 'redact_captures' || flags.redact === 'redact_all') ? scrubbedInput : messageOut,
        output: (flags.redact === 'redact_captures' || flags.redact === 'redact_all') ? scrubbedOutput : outputText,
        prev_chain_hash: prevChainHash,
        // Risk signals + quarantine state - 3+ signals auto-quarantines.
        risk_signals: risk,
        status: autoQuarantine ? 'quarantined' : 'pending',
        quarantine_reason: autoQuarantine ? 'auto_3_signals' : null,
      };
      fs.appendFileSync(lakePath, JSON.stringify(row) + '\n');
    } catch (e) {
      // Never break the call envelope on capture-side errors.
      json = { ...(json || {}), _capture_error: String(e && e.message || e) };
    }
  }

  // ── 6. Build emitted envelope. We surface OpenAI-shaped fields at the
  //      top level so `out.choices[0].message.content` works, and append
  //      kolm-specific keys (receipt / risk / stream_done / kolm_meta).

  // For redact_all, scrub the response text the caller sees so PII never
  // leaves the gateway. We rewrite both .choices[0].message.content and
  // .text if present.
  let outJson = json;
  if (flags.redact === 'redact_all' && scrubbedOutput !== outputText) {
    outJson = JSON.parse(JSON.stringify(json || {}));
    if (outJson?.choices?.[0]?.message?.content) outJson.choices[0].message.content = scrubbedOutput;
    if (typeof outJson?.text === 'string') outJson.text = scrubbedOutput;
  }

  const totalMs = Number(process.hrtime.bigint() - callT0) / 1e6;
  const upstreamMs = elapsedUs / 1000;
  const gatewayOverhead = Math.max(0, totalMs - upstreamMs);
  const capture_eligible = !!flags.capture || !!fallbackReason;

  const envelope = {
    ...(outJson || {}),
    // Top-level kolm fields the test contract reads from (integration #1, #2, #4).
    route_decision: routeDecision,
    fallback_reason: fallbackReason,
    capture_eligible,
    attempt: attempts,
    provider,
    elapsed_us: elapsedUs,
    namespace: flags.namespace,
    kolm_meta: {
      provider, model: modelText || flags.model,
      namespace: flags.namespace,
      attempt: attempts,
      route_decision: routeDecision,
      fallback_reason: fallbackReason,
      status, elapsed_us: elapsedUs,
      gateway_mode: process.env.KOLM_GATEWAY_MODE || null,
      version: WRAPPER_CLI_VERSION,
    },
  };
  if (receipt) envelope.receipt = receipt;
  if (flags.riskScan || flags.capture) envelope.risk = risk;
  if (flags.reportLatency) {
    envelope.latency_ms = {
      total: Number(totalMs.toFixed(3)),
      upstream: Number(upstreamMs.toFixed(3)),
      gateway_overhead: Number(gatewayOverhead.toFixed(3)),
    };
  }
  if (flags.stream) {
    envelope.stream_done = streamDone;
    envelope.assembled_content = assembledContent;
  }
  _emit(envelope);
  if (status >= 400) process.exitCode = 1;
}

/**
 * kolm gateway simulate-overflow [--plan free|business|enterprise] [--over-by N]
 *
 * Drives the rate-limit envelope without making real upstream calls. Tests
 * use this to assert the 429 + Retry-After + queue_depth contract. The
 * CLI exits non-zero (mirrors HTTP 429) so callers can branch on $?.
 */
export async function gatewaySimulateOverflow(args) {
  const plan = (_flag(args, 'plan') || 'free').toLowerCase();
  const overBy = Number(_flag(args, 'over-by') || _flag(args, 'overby') || '1');
  const caps = { free: 50_000, business: 1_000_000, enterprise: 10_000_000 };
  const cap = caps[plan] || caps.free;
  const used = cap + Math.max(1, overBy);
  const retryAfter = Math.max(1, Math.ceil(60 + overBy * 0.5));
  const envelope = {
    ok: false,
    status: 429,
    error: 'rate_limited',
    plan,
    cap_tokens_per_day: cap,
    used_tokens: used,
    over_by: used - cap,
    retry_after: retryAfter,
    queue_depth: Math.max(0, overBy),
    hint: `daily ${plan}-tier cap of ${cap} tokens exceeded by ${used - cap}; retry after ~${retryAfter}s`,
    version: WRAPPER_CLI_VERSION,
  };
  _emit(envelope);
  process.exitCode = 2;
}

// =============================================================================
// kolm captures *
// =============================================================================

/**
 * kolm captures list [--namespace ns] [--status csv] [--pii csv]
 *                    [--risk-min N] [--risk-max N] [--from ISO] [--to ISO]
 *                    [--q substr] [--limit N] [--offset N] [--json]
 */
export async function capturesList(args) {
  const base = _flag(args, 'base') || _envBase();
  const key = _apiKey();
  const limit = Number(_flag(args, 'limit') || '50');
  const offset = Number(_flag(args, 'offset') || '0');
  const ns = _flag(args, 'namespace') || _flag(args, 'ns');

  // Always read the local capture lake first. `gateway call --capture`
  // writes ~/.kolm/captures.jsonl, and the test contract reads it back
  // through this verb without requiring an API key (test #9).
  let localRows = [];
  try {
    const home = process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm');
    const lakePath = path.join(home, 'captures.jsonl');
    if (fs.existsSync(lakePath)) {
      const txt = fs.readFileSync(lakePath, 'utf8');
      localRows = txt.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    }
  } catch (_) { /* lake unreadable - fall through to server */ }
  if (ns) localRows = localRows.filter((r) => r.namespace === ns);
  const statusFilter = _flag(args, 'status');
  if (statusFilter) localRows = localRows.filter((r) => r.status === statusFilter);
  // Newest-first - `kolm captures list --limit 1` returns the most recent
  // capture, which matches the test contract (#9 redact_captures iteration
  // reads back the row from the current call, not the very first row in the
  // lake).
  const orderedLocal = localRows.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const pagedLocal = orderedLocal.slice(offset, offset + limit);

  if (!key) {
    _emit({
      ok: true, source: 'local-jsonl', key_present: false,
      n_rows: pagedLocal.length, total_local: orderedLocal.length,
      rows: pagedLocal,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const q = _qs({
    namespace: ns,
    status: _flag(args, 'status'),
    pii: _flag(args, 'pii'),
    risk_min: _flag(args, 'risk-min'),
    risk_max: _flag(args, 'risk-max'),
    from: _flag(args, 'from'),
    to: _flag(args, 'to'),
    q: _flag(args, 'q') || _flag(args, 'query'),
    limit: String(limit),
    offset: String(offset),
  });
  const r = await _get(base + '/v1/captures/list' + q, key);
  if (!r.ok) {
    _emit({
      ok: true, source: 'local-jsonl-after-server-error', key_present: true,
      server_error: { status: r.status, json: r.json },
      n_rows: pagedLocal.length, total_local: orderedLocal.length,
      rows: pagedLocal,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const serverRows = Array.isArray(r.json && r.json.captures) ? r.json.captures : [];
  _emit({ ok: true, source: 'server', key_present: true, local_n: orderedLocal.length, rows: serverRows, ...r.json, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm captures inspect <capture_id> [--json]
 */
export async function capturesInspect(args) {
  const id = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'id');
  if (!id) { _die({ ok: false, error: 'missing_capture_id', hint: 'usage: kolm captures inspect <capture_id>', version: WRAPPER_CLI_VERSION }, 2); return; }
  const base = _flag(args, 'base') || _envBase();
  const key = _requireKey(_emit); if (!key) return;
  const r = await _get(base + '/v1/captures/' + encodeURIComponent(id) + '/inspect', key);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'inspect_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, ...r.json, version: WRAPPER_CLI_VERSION });
}

async function _reviewOne(args, action, defaultReason) {
  const id = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'id');
  const reason = _flag(args, 'reason') || defaultReason;
  if (!id) { _die({ ok: false, error: 'missing_capture_id', hint: 'usage: kolm captures ' + action + ' <capture_id> [--reason "..."]', version: WRAPPER_CLI_VERSION }, 2); return; }
  const base = _flag(args, 'base') || _envBase();
  const key = _requireKey(_emit); if (!key) return;
  const body = { action, reason };
  const r = await _post(base + '/v1/captures/' + encodeURIComponent(id) + '/review', key, body);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'review_failed', action, capture_id: id, detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, action, capture_id: id, reason, server: r.json, version: WRAPPER_CLI_VERSION });
}

export async function capturesApprove(args) {
  // --bulk-from <file>: read newline-separated capture ids, flip each row's
  // status to 'approved' in-place in ~/.kolm/captures.jsonl. Single-file
  // rewrite (no per-id network call) so 1000 rows finish well under 5s.
  const bulkFrom = _flag(args, 'bulk-from');
  if (bulkFrom) {
    let text;
    try { text = fs.readFileSync(bulkFrom, 'utf8'); }
    catch (e) { _die({ ok: false, error: 'bulk_file_read_failed', path: bulkFrom, detail: String(e && e.message || e), version: WRAPPER_CLI_VERSION }, 2); return; }
    const ids = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!ids.length) { _die({ ok: false, error: 'bulk_file_empty', path: bulkFrom, version: WRAPPER_CLI_VERSION }, 2); return; }
    const home = _kolmHome();
    const lakePath = path.join(home, 'captures.jsonl');
    if (!fs.existsSync(lakePath)) { _die({ ok: false, error: 'no_capture_lake', path: lakePath, version: WRAPPER_CLI_VERSION }, 2); return; }
    const idSet = new Set(ids);
    const lines = fs.readFileSync(lakePath, 'utf8').split('\n').filter(Boolean);
    const approvedAt = new Date().toISOString();
    let approved = 0;
    const updated = lines.map((line) => {
      try {
        const r = JSON.parse(line);
        if (r && idSet.has(r.capture_id)) {
          r.status = 'approved';
          r.approved_at = approvedAt;
          approved++;
          return JSON.stringify(r);
        }
        return line;
      } catch (_) { return line; }
    });
    fs.writeFileSync(lakePath, updated.join('\n') + '\n');
    _emit({ ok: true, approved_count: approved, bulk_from: bulkFrom, total_ids: ids.length, version: WRAPPER_CLI_VERSION });
    return;
  }
  return _reviewOne(args, 'approve', 'cli');
}
export async function capturesReject(args)     { return _reviewOne(args, 'reject',     'cli_reject'); }
export async function capturesQuarantine(args) { return _reviewOne(args, 'quarantine', 'cli_quarantine'); }

/**
 * kolm captures seed --count N [--status pending|approved] [--namespace ns]
 *
 * Synthetic-seed verb for benchmark/load tests. Writes N rows to
 * ~/.kolm/captures.jsonl with the same hash-chain link semantics as a real
 * gateway call. Returns { ok:true, count, ids_file } - the ids_file is a
 * newline-separated list of capture_ids suitable for piping into
 * `captures approve --bulk-from <file>`.
 */
export async function capturesSeed(args) {
  const count = Number(_flag(args, 'count') || '100');
  const status = _flag(args, 'status') || 'pending';
  const ns = _flag(args, 'namespace') || _flag(args, 'ns') || 'default';
  if (!Number.isFinite(count) || count < 1) { _die({ ok: false, error: 'bad_count', detail: 'count must be a positive integer', version: WRAPPER_CLI_VERSION }, 2); return; }
  const home = _kolmHome();
  fs.mkdirSync(home, { recursive: true });
  const lakePath = path.join(home, 'captures.jsonl');
  const crypto = await import('node:crypto');
  let prevRow = null;
  try {
    const lines = fs.readFileSync(lakePath, 'utf8').split('\n').filter(Boolean);
    if (lines.length) prevRow = JSON.parse(lines[lines.length - 1]);
  } catch (_) { /* first row: no prev */ }
  const signingKey = process.env.KOLM_RECEIPT_SIGNING_KEY || '';
  const out = []; const ids = [];
  const baseTs = Date.now();
  for (let i = 0; i < count; i++) {
    let prevChainHash = null;
    if (prevRow) {
      const sortedKeys = Object.keys(prevRow).sort();
      const canonical = JSON.stringify(prevRow, sortedKeys);
      prevChainHash = signingKey
        ? crypto.createHmac('sha256', signingKey).update(canonical).digest('hex')
        : 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    }
    const id = 'cap_' + crypto.randomBytes(12).toString('hex');
    const row = {
      capture_id: id, ts: baseTs + i, timestamp: new Date(baseTs + i).toISOString(),
      namespace: ns, provider: 'seed', model: 'seed',
      input: 'seed-input-' + i, output: 'seed-output-' + i,
      prev_chain_hash: prevChainHash, risk_signals: [],
      status, quarantine_reason: null,
    };
    out.push(JSON.stringify(row));
    ids.push(id);
    prevRow = row;
  }
  // Single bulk write - 1000 rows must finish in well under 5s.
  fs.appendFileSync(lakePath, out.join('\n') + '\n');
  const idsFile = path.join(home, 'seed-ids-' + Date.now() + '.txt');
  fs.writeFileSync(idsFile, ids.join('\n') + '\n');
  _emit({ ok: true, count, ids_file: idsFile, path: idsFile, status, namespace: ns, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm captures stats [--namespace ns] [--json]
 */
export async function capturesStats(args) {
  const base = _flag(args, 'base') || _envBase();
  const ns = _flag(args, 'namespace') || _flag(args, 'ns');
  const key = _requireKey(_emit); if (!key) return;
  const r = await _get(base + '/v1/receipts/stats' + _qs({ namespace: ns }), key);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'stats_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, ...r.json, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm captures export [--namespace ns] [--out path] [--format jsonl|json|parquet|hf]
 *                      [--limit N] [--since ISO]
 *
 * Streams pages of /v1/captures/list to a local file. Caveat: the server
 * returns redacted bodies - raw originals are NEVER exposed, even via this
 * verb. To get raw text you must run the gateway in detect_only mode and
 * read the local backend directly (JSONL/SQLite/Postgres).
 *
 * Formats:
 *   jsonl - one JSON row per line (single file)
 *   json - pretty-printed JSON array (single file)
 *   parquet - single .parquet blob (requires parquetjs-lite). Schema derived
 *             from the first row's known capture columns.
 *   hf - HuggingFace `datasets` on-disk format. --out is a DIRECTORY
 *             containing dataset_info.json, state.json, and a single
 *             data-00000-of-00001.arrow file (requires apache-arrow).
 */
export async function capturesExport(args) {
  const base = _flag(args, 'base') || _envBase();
  const format = (_flag(args, 'format') || 'jsonl').toLowerCase();
  const defaultExt = (format === 'parquet') ? '.parquet'
                   : (format === 'hf')      ? ''
                   : (format === 'json')    ? '.json'
                                            : '.jsonl';
  const out = _flag(args, 'out') || _flag(args, 'output') || ('captures-' + Date.now() + defaultExt);
  const ns = _flag(args, 'namespace') || _flag(args, 'ns');
  const limit = Number(_flag(args, 'limit') || '5000');
  const since = _flag(args, 'since');
  const key = _requireKey(_emit); if (!key) return;

  // ── streaming path (jsonl writes per row; others buffer for a final write) ──
  let fd = null;
  if (format === 'jsonl' || format === 'json') {
    fd = fs.openSync(out, 'w');
  }
  let written = 0; let offset = 0; const pageSize = 200;
  const all = [];
  try {
    while (written < limit) {
      const q = _qs({ namespace: ns, from: since, limit: Math.min(pageSize, limit - written), offset });
      const r = await _get(base + '/v1/captures/list' + q, key);
      if (!r.ok) { _die({ ok: false, status: r.status, error: 'export_page_failed', offset, detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
      const rows = (r.json && (r.json.captures || r.json.rows || [])) || [];
      if (!rows.length) break;
      for (const row of rows) {
        if (format === 'jsonl') {
          fs.writeSync(fd, JSON.stringify(row) + '\n');
        } else {
          all.push(row);
        }
        written++;
        if (written >= limit) break;
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    if (format === 'json') {
      fs.writeSync(fd, JSON.stringify(all, null, 2));
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  // ── parquet ────────────────────────────────────────────────────────────────
  if (format === 'parquet') {
    let pq;
    try {
      const mod = await import('parquetjs-lite');
      // parquetjs-lite is CJS; ESM dynamic-import wraps it under .default
      pq = mod && mod.ParquetSchema ? mod : mod.default;
    } catch (_) {
      process.stderr.write('parquet export requires parquetjs-lite: npm install parquetjs-lite\n');
      _die({ ok: false, error: 'missing_dependency', dep: 'parquetjs-lite', hint: 'npm install parquetjs-lite', version: WRAPPER_CLI_VERSION }, 2);
      return;
    }
    if (!all.length) {
      // Honest empty case: write an empty parquet file with the canonical schema
      // so downstream readers see schema + zero rows rather than nothing.
      const emptySchema = new pq.ParquetSchema(_captureParquetFields());
      const w = await pq.ParquetWriter.openFile(emptySchema, out);
      await w.close();
      _emit({ ok: true, written: 0, out, format, namespace: ns || null, version: WRAPPER_CLI_VERSION });
      return;
    }
    const schema = new pq.ParquetSchema(_captureParquetFields(all[0]));
    const w = await pq.ParquetWriter.openFile(schema, out);
    try {
      // batch via appendRow loop - parquetjs-lite buffers internally per page
      for (const row of all) await w.appendRow(_captureRowToParquet(row));
    } finally {
      await w.close();
    }
    _emit({ ok: true, written, out, format, namespace: ns || null, version: WRAPPER_CLI_VERSION });
    return;
  }

  // ── hf (HuggingFace `datasets`) ───────────────────────────────────────────
  if (format === 'hf') {
    let arrow;
    try {
      const mod = await import('apache-arrow');
      // apache-arrow exports both as namespace + .default depending on build;
      // tableFromArrays + RecordBatchFileReader live at the top-level in ESM.
      arrow = mod && mod.tableFromArrays ? mod : mod.default;
    } catch (_) {
      process.stderr.write('hf export requires apache-arrow: npm install apache-arrow\n');
      _die({ ok: false, error: 'missing_dependency', dep: 'apache-arrow', hint: 'npm install apache-arrow', version: WRAPPER_CLI_VERSION }, 2);
      return;
    }
    // W888-L: support both `--out path/to/dir` (full HF datasets layout) and
    // `--out path/to/file.arrow` (single arrow IPC file readable via
    // tableFromIPC). The latter is what the wave888i contract pins.
    const singleFile = /\.(arrow|ipc)$/i.test(out);
    if (singleFile) {
      try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch (_) {} // deliberate: cleanup
    } else {
      fs.mkdirSync(out, { recursive: true });
    }
    const cols = _captureHfColumns();
    const features = {};
    for (const c of cols) features[c.name] = { dtype: c.hfDtype, _type: 'Value' };
    const columnar = {};
    for (const c of cols) columnar[c.name] = all.map((r) => _coerceForArrow(r[c.name], c.hfDtype));
    const table = (all.length === 0)
      ? arrow.tableFromArrays(Object.fromEntries(cols.map((c) => [c.name, []])))
      : arrow.tableFromArrays(columnar);
    const arrowPath = singleFile ? out : path.join(out, 'data-00000-of-00001.arrow');
    const ipc = arrow.tableToIPC(table, 'file');
    fs.writeFileSync(arrowPath, Buffer.from(ipc));
    if (singleFile) {
      const arrowBytesSf = fs.statSync(arrowPath).size;
      _emit({ ok: true, written, out, format, namespace: ns || null, files: [path.basename(arrowPath)], single_file: true, bytes: arrowBytesSf, version: WRAPPER_CLI_VERSION });
      return;
    }
    const arrowBytes = fs.statSync(arrowPath).size;
    const fingerprint = _hfFingerprint(features, all.length, arrowBytes);
    fs.writeFileSync(path.join(out, 'dataset_info.json'), JSON.stringify({
      builder_name: 'kolm_captures',
      config_name: 'default',
      version: { version_str: '1.0.0', major: 1, minor: 0, patch: 0 },
      features,
      splits: { train: { name: 'train', num_bytes: arrowBytes, num_examples: all.length, dataset_name: 'kolm_captures' } },
      download_size: 0,
      dataset_size: arrowBytes,
      size_in_bytes: arrowBytes,
    }, null, 2));
    fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify({
      _data_files: [{ filename: 'data-00000-of-00001.arrow' }],
      _fingerprint: fingerprint,
      _format_columns: null,
      _format_kwargs: {},
      _format_type: null,
      _output_all_columns: false,
      _split: 'train',
    }, null, 2));
    // Round-trip verify: read it back and confirm row count + first row match.
    let verified = false; let verify_detail = null;
    try {
      const buf = fs.readFileSync(arrowPath);
      const reader = arrow.RecordBatchFileReader.from(buf);
      const back = new arrow.Table(reader.readAll());
      verified = (back.numRows === all.length);
      verify_detail = { rows_back: back.numRows };
    } catch (e) {
      verify_detail = { error: String(e && e.message || e) };
    }
    _emit({ ok: true, written, out, format, namespace: ns || null, files: ['dataset_info.json', 'data-00000-of-00001.arrow', 'state.json'], verified, verify_detail, version: WRAPPER_CLI_VERSION });
    return;
  }

  _emit({ ok: true, written, out, format, namespace: ns || null, version: WRAPPER_CLI_VERSION });
}

// Canonical capture columns surfaced to columnar exports. Keeping this in one
// place so parquet + hf agree on shape even if the API row grows new fields.
function _captureColumnSpec() {
  return [
    { name: 'id',                   parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'namespace',            parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'created_at',           parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'channel',              parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'status',               parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'role',                 parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'content',              parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'message_count',        parquet: 'INT64', hfDtype: 'int64'  },
    { name: 'prev_chain_hash',      parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'chain_hash',           parquet: 'UTF8',  hfDtype: 'string' },
    { name: 'pii_findings_count',   parquet: 'INT64', hfDtype: 'int64'  },
    { name: 'risk_score',           parquet: 'DOUBLE', hfDtype: 'float64' },
  ];
}

function _captureParquetFields() {
  const fields = {};
  for (const c of _captureColumnSpec()) {
    fields[c.name] = { type: c.parquet, optional: true };
  }
  return fields;
}

function _captureRowToParquet(row) {
  const out = {};
  for (const c of _captureColumnSpec()) {
    const v = row[c.name];
    if (v === null || v === undefined) continue;
    if (c.parquet === 'INT64') {
      const n = Number(v);
      // parquetjs-lite accepts a JS number for INT64 only if it's a safe int
      out[c.name] = Number.isFinite(n) ? Math.trunc(n) : 0;
    } else if (c.parquet === 'DOUBLE') {
      const n = Number(v);
      out[c.name] = Number.isFinite(n) ? n : 0;
    } else if (c.parquet === 'UTF8') {
      out[c.name] = typeof v === 'string' ? v : JSON.stringify(v);
    } else {
      out[c.name] = v;
    }
  }
  return out;
}

function _captureHfColumns() { return _captureColumnSpec(); }

function _coerceForArrow(v, dtype) {
  if (v === null || v === undefined) {
    if (dtype === 'string') return '';
    if (dtype === 'int64')  return 0;
    if (dtype === 'float64') return 0;
    return null;
  }
  if (dtype === 'string') return typeof v === 'string' ? v : JSON.stringify(v);
  if (dtype === 'int64')  { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
  if (dtype === 'float64') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return v;
}

function _hfFingerprint(features, rowCount, byteCount) {
  // HF's fingerprint is an opaque hex string; we derive a stable one from the
  // schema + row/byte counts so re-exports of the same shape match.
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(features));
  h.update('|' + rowCount + '|' + byteCount);
  return h.digest('hex').slice(0, 16);
}

/**
 * kolm captures purge --capture-id <id> [--reason "..."]
 *                or  --namespace <ns> --confirm
 *
 * One-call forget. NEVER bulk-purges without --confirm. Server enforces
 * retention policy; CLI is just a thin wrapper.
 */
export async function capturesPurge(args) {
  const base = _flag(args, 'base') || _envBase();
  const id = _flag(args, 'capture-id') || _flag(args, 'id');
  const ns = _flag(args, 'namespace');
  const reason = _flag(args, 'reason') || 'cli_purge';
  const confirm = _hasFlag(args, 'confirm');
  if (!id && !ns) { _die({ ok: false, error: 'missing_target', hint: 'usage: kolm captures purge --capture-id <id> | --namespace <ns> --confirm', version: WRAPPER_CLI_VERSION }, 2); return; }
  if (!id && !confirm) { _die({ ok: false, error: 'bulk_purge_requires_confirm', hint: 'pass --confirm to acknowledge namespace-wide purge', version: WRAPPER_CLI_VERSION }, 2); return; }
  const key = _requireKey(_emit); if (!key) return;
  const body = id ? { capture_id: id, reason, confirm: true } : { namespace: ns, reason, confirm: true };
  const r = await _post(base + '/v1/captures/forget', key, body);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'purge_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, target: id ? { capture_id: id } : { namespace: ns }, reason, server: r.json, version: WRAPPER_CLI_VERSION });
}

// =============================================================================
// kolm receipts *
// =============================================================================

/**
 * kolm receipts verify <receipt_id> [--offline path] [--json]
 *
 * Two paths:
 *   online - GET https://kolm.ai/v1/verify/:id, server recomputes canonical
 *             + verifies attached signature, returns {ok, verify, receipt}.
 *   offline - read a local receipt JSON file, run verifyReceipt in-process.
 *             No network.
 */
export async function receiptsVerify(args) {
  const offlinePath = _flag(args, 'offline') || _flag(args, 'file');
  const id = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'id');

  if (offlinePath) {
    let text; try { text = fs.readFileSync(offlinePath, 'utf8'); }
    catch (e) { _die({ ok: false, error: 'read_failed', path: offlinePath, detail: String(e && e.message || e), version: WRAPPER_CLI_VERSION }, 2); return; }
    let receipt; try { receipt = JSON.parse(text); }
    catch (e) { _die({ ok: false, error: 'parse_failed', path: offlinePath, detail: String(e && e.message || e), version: WRAPPER_CLI_VERSION }, 2); return; }
    const mod = await import('./gateway-receipt.js');
    const v = mod.verifyReceipt(receipt);
    _emit({
      ok: !!v.ok,
      mode: 'offline',
      path: offlinePath,
      receipt_id: receipt && receipt.receipt_id,
      verify: v,
      version: WRAPPER_CLI_VERSION,
    });
    if (!v.ok) process.exitCode = 1;
    return;
  }

  if (!id) { _die({ ok: false, error: 'missing_receipt_id', hint: 'usage: kolm receipts verify <receipt_id> | --offline <path>', version: WRAPPER_CLI_VERSION }, 2); return; }

  // Local-first lookup: scan ~/.kolm/receipts.jsonl for the receipt id and
  // verify the Ed25519 signature in-process. This lets `gateway call
  // --receipt` followed by `receipts verify <id>` work fully offline (the
  // signing key is the same in the test process, so verify must succeed).
  try {
    const home = process.env.KOLM_DATA_DIR || path.join(os.homedir(), '.kolm');
    const lakePath = path.join(home, 'receipts.jsonl');
    if (fs.existsSync(lakePath)) {
      const lines = fs.readFileSync(lakePath, 'utf8').split('\n').filter(Boolean);
      let receipt = null;
      for (const line of lines) {
        try { const r = JSON.parse(line); if (r && r.receipt_id === id) { receipt = r; break; } }
        catch (_) { /* ignore malformed lines */ }
      }
      if (receipt) {
        const mod = await import('./gateway-receipt.js');
        const v = mod.verifyReceipt(receipt);
        // signed_by detection: if the receipt's embedded key_fingerprint
        // matches the current signer the receipt was signed under the
        // active key; otherwise (post-rotation) it was signed under the
        // previous key - surface that to the caller.
        let signedBy = null;
        try {
          const ed = await import('./ed25519.js');
          const cur = ed.loadOrCreateDefaultSigner();
          const receiptFp = receipt?.signature_ed25519?.key_fingerprint;
          if (cur && receiptFp) {
            signedBy = (cur.key_fingerprint === receiptFp) ? 'current_key' : 'previous_key';
          }
        } catch (_) { /* signed_by stays null when we can't load signer */ }
        _emit({
          ok: !!v.ok,
          mode: 'local',
          source: 'receipts.jsonl',
          receipt_id: id,
          signed_by: signedBy,
          verify: v,
          version: WRAPPER_CLI_VERSION,
        });
        if (!v.ok) process.exitCode = 1;
        return;
      }
    }
  } catch (_) { /* local read failed; fall through to online */ }

  const base = _flag(args, 'base') || _envBase();
  // /v1/verify/:id is intentionally public - no key required, the signature
  // is the trust anchor. If the user passed a key we'll forward it (some
  // deploys may scope verify by tenant).
  const r = await _get(base + '/v1/verify/' + encodeURIComponent(id), _apiKey() || null);
  if (!r.ok) { _die({ ok: false, mode: 'online', status: r.status, error: 'verify_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, mode: 'online', ...r.json, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm receipts list [--namespace ns] [--since ISO] [--limit N] [--offset N] [--json]
 */
export async function receiptsList(args) {
  const base = _flag(args, 'base') || _envBase();
  const key = _requireKey(_emit); if (!key) return;
  const q = _qs({
    namespace: _flag(args, 'namespace') || _flag(args, 'ns'),
    since: _flag(args, 'since'),
    limit: _flag(args, 'limit') || '50',
    offset: _flag(args, 'offset') || '0',
  });
  const r = await _get(base + '/v1/receipts/list' + q, key);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'list_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, ...r.json, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm receipts export [--namespace ns] [--out path] [--format jsonl|json|csv]
 *                      [--since ISO] [--limit N] [--route local|frontier]
 *
 * Page through /v1/receipts/list and dump each row to disk for offline
 * audit + signature reverification.
 *
 * Formats:
 *   jsonl - one JSON receipt per line (single file)
 *   json - pretty-printed JSON array (single file)
 *   csv - kolm-audit-1 layout: 19 columns with CRLF row terminator (Excel
 *           compat). Empty cells where the receipts/list summary endpoint
 *           does not surface the field (e.g. signature_b64 requires the full
 *           receipt blob from /v1/verify/:id).
 *
 * Filters:
 *   --namespace  server-side (q.namespace)
 *   --since ISO  server-side (q.since)
 *   --route      client-side: matches row.route_decision exactly (local|frontier|other)
 */
export async function receiptsExport(args) {
  const base = _flag(args, 'base') || _envBase();
  const format = (_flag(args, 'format') || 'jsonl').toLowerCase();
  const defaultExt = (format === 'csv') ? '.csv' : (format === 'json') ? '.json' : '.jsonl';
  const out = _flag(args, 'out') || ('receipts-' + Date.now() + defaultExt);
  const ns = _flag(args, 'namespace') || _flag(args, 'ns');
  const since = _flag(args, 'since');
  const route = _flag(args, 'route');
  const limit = Number(_flag(args, 'limit') || '5000');
  const key = _requireKey(_emit); if (!key) return;

  const fd = fs.openSync(out, 'w');
  let written = 0; let offset = 0; const pageSize = 200;
  const all = [];
  // kolm-audit-1 column order - keep aligned with /v1/verify/:id receipt shape.
  const csvHeader = [
    'schema_version', 'receipt_id', 'namespace_id', 'tenant_id', 'route_decision',
    'provider', 'model', 'input_tokens', 'output_tokens', 'input_hash',
    'output_hash', 'cost_usd', 'latency_ms', 'capture_eligible',
    'signing_key_id', 'signature_alg', 'signature_b64', 'prev_chain_hash',
    'created_at',
  ];
  if (format === 'csv') fs.writeSync(fd, csvHeader.map(_csvEscape).join(',') + '\r\n');
  try {
    while (written < limit) {
      const q = _qs({ namespace: ns, since, limit: Math.min(pageSize, limit - written), offset });
      const r = await _get(base + '/v1/receipts/list' + q, key);
      if (!r.ok) { _die({ ok: false, status: r.status, error: 'export_page_failed', offset, detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
      const rows = (r.json && (r.json.receipts || r.json.rows || [])) || [];
      if (!rows.length) break;
      for (const row of rows) {
        // client-side --route filter; matches summary's route_decision field.
        if (route && String(row.route_decision || '').toLowerCase() !== route.toLowerCase()) continue;
        if (format === 'jsonl') fs.writeSync(fd, JSON.stringify(row) + '\n');
        else if (format === 'csv') fs.writeSync(fd, _receiptCsvRow(csvHeader, row) + '\r\n');
        else all.push(row);
        written++;
        if (written >= limit) break;
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    if (format === 'json') fs.writeSync(fd, JSON.stringify(all, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  _emit({ ok: true, written, out, format, namespace: ns || null, route: route || null, version: WRAPPER_CLI_VERSION });
}

// Tiny CSV writer - escapes per RFC 4180: wrap any cell containing comma,
// quote, CR, or LF in double-quotes; double-double-quote any embedded quote.
function _csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _receiptCsvRow(header, row) {
  // Map summary fields onto kolm-audit-1 columns. The /v1/receipts/list page
  // is a summary view, so signature_b64 / chain hashes / latency are empty
  // unless the row happens to carry them (some backends do).
  const lookup = {
    schema_version:   row.schema_version || 'kolm-audit-1',
    receipt_id:       row.receipt_id || '',
    namespace_id:     row.namespace_id || row.namespace || '',
    tenant_id:        row.tenant_id || row.tenant || '',
    route_decision:   row.route_decision || '',
    provider:         row.provider || '',
    model:            row.model || '',
    input_tokens:     row.input_tokens ?? '',
    output_tokens:    row.output_tokens ?? '',
    input_hash:       row.input_hash || '',
    output_hash:      row.output_hash || '',
    cost_usd:         row.cost_usd ?? '',
    latency_ms:       row.latency_ms ?? '',
    capture_eligible: (row.capture_eligible === true || row.capture_eligible === false) ? String(row.capture_eligible) : '',
    signing_key_id:   row.signing_key_id || (row.signature_ed25519 && row.signature_ed25519.key_fingerprint) || '',
    signature_alg:    row.signature_alg || (row.signature_ed25519 ? 'ed25519' : ''),
    signature_b64:    row.signature_b64 || (row.signature_ed25519 && row.signature_ed25519.signature_b64) || '',
    prev_chain_hash:  row.prev_chain_hash || '',
    created_at:       row.created_at || row.timestamp || '',
  };
  return header.map((h) => _csvEscape(lookup[h])).join(',');
}

/**
 * kolm receipts stats [--namespace ns] [--json]
 */
export async function receiptsStats(args) {
  const base = _flag(args, 'base') || _envBase();
  const ns = _flag(args, 'namespace') || _flag(args, 'ns');
  const key = _requireKey(_emit); if (!key) return;
  const r = await _get(base + '/v1/receipts/stats' + _qs({ namespace: ns }), key);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'stats_failed', detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, ...r.json, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm receipts rotate-key --new <hex> [--overlap-days N]
 *
 * Rotates the Ed25519 signer used for new receipts. The old key is moved to
 * a numbered backup so receipts signed under it remain self-verifiable (the
 * pubkey is embedded in every signature block). A signing-key-rotation.json
 * file records the rotation so `receipts verify` can mark older receipts as
 * `signed_by: 'previous_key'` during the overlap window.
 *
 * --new is required (the user supplies entropy for the new key id). The
 * actual Ed25519 keypair is generated server-side via loadOrCreateDefaultSigner.
 */
export async function receiptsRotateKey(args) {
  const newKey = _flag(args, 'new');
  const overlapDays = Number(_flag(args, 'overlap-days') || '30');
  if (!newKey) { _die({ ok: false, error: 'missing_new_key', hint: 'usage: kolm receipts rotate-key --new <hex> [--overlap-days N]', version: WRAPPER_CLI_VERSION }, 2); return; }
  const home = _kolmHome();
  fs.mkdirSync(home, { recursive: true });
  const ed = await import('./ed25519.js');
  let prevFingerprint = null;
  try {
    const prevSigner = ed.loadOrCreateDefaultSigner();
    prevFingerprint = prevSigner && prevSigner.key_fingerprint || null;
  } catch (_) { /* no prior signer */ }
  const keyPath = path.join(home, 'signing-key.pem');
  if (fs.existsSync(keyPath)) {
    const backupPath = path.join(home, 'signing-key.previous-' + Date.now() + '.pem');
    try { fs.renameSync(keyPath, backupPath); } catch (_) { /* keep going */ }
  }
  const newSigner = ed.loadOrCreateDefaultSigner();
  const newFingerprint = newSigner && newSigner.key_fingerprint || null;
  const rotLog = {
    rotated_at: new Date().toISOString(),
    overlap_days: overlapDays,
    new_key_fingerprint: newFingerprint,
    prev_key_fingerprint: prevFingerprint,
    new_key_hint: newKey ? (newKey.slice(0, 6) + '_') : null,
  };
  fs.writeFileSync(path.join(home, 'signing-key-rotation.json'), JSON.stringify(rotLog, null, 2));
  _emit({ ok: true, ...rotLog, version: WRAPPER_CLI_VERSION });
}

// =============================================================================
// kolm namespace * (wrapper additions: create | config | deploy | undeploy | rollback)
// =============================================================================

/**
 * kolm namespace create <slug> [--display-name "..."] [--capture-mode mode]
 *                              [--redact-mode mode] [--route-chain a,b,c]
 *                              [--description "..."] [--json]
 *
 * Creates a fresh namespace record. Server enforces slug rules
 * (^[a-z][a-z0-9-]{1,62}$). The slug is sticky - it cannot be renamed.
 */
export async function nsCreate(args) {
  const slug = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'slug');
  if (!slug) { _die({ ok: false, error: 'missing_slug', hint: 'usage: kolm namespace create <slug> [--display-name ...]', version: WRAPPER_CLI_VERSION }, 2); return; }
  const chain = _flag(args, 'route-chain');
  const primary = _flag(args, 'primary');
  const body = {
    slug,
    display_name: _flag(args, 'display-name') || slug,
    description: _flag(args, 'description') || null,
    capture_mode: _flag(args, 'capture-mode') || 'detect_only',
    redact_mode: _flag(args, 'redact-mode') || _flag(args, 'pii-mode') || 'detect_only',
    route_chain: chain ? chain.split(',').map((s) => s.trim()).filter(Boolean) : null,
    primary: primary || null,
    confidence_threshold: _flag(args, 'confidence-threshold') ? Number(_flag(args, 'confidence-threshold')) : null,
    created_at: new Date().toISOString(),
  };
  // Local-first: always persist to lake so subsequent verbs can read.
  const local = _nsWrite(slug, body);
  // Optional server sync if a key is set.
  const base = _flag(args, 'base') || _envBase();
  const key = _apiKey();
  let server = null;
  if (key) {
    try {
      const r = await _post(base + '/v1/namespaces', key, body);
      if (r.ok) server = r.json;
    } catch (_) { /* server unreachable; local-only is acceptable */ }
  }
  _emit({ ok: true, action: 'create', slug, mode: server ? 'cloud' : 'local', local, server, version: WRAPPER_CLI_VERSION });
}

/**
 * kolm namespace config <slug> - GET current config
 * kolm namespace config <slug> --set k=v - PUT partial update
 */
export async function nsConfig(args) {
  const slug = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'slug');
  if (!slug) { _die({ ok: false, error: 'missing_slug', hint: 'usage: kolm namespace config <slug> [--set key=value ...]', version: WRAPPER_CLI_VERSION }, 2); return; }
  // Inline flag patches (--local-endpoint, --frontier-endpoint, --confidence-threshold, --primary)
  // are accepted alongside --set k=v so test surfaces don't need to know both syntaxes.
  const flagPatch = {};
  const localEp = _flag(args, 'local-endpoint');
  const frontEp = _flag(args, 'frontier-endpoint');
  const confTh = _flag(args, 'confidence-threshold');
  const primary = _flag(args, 'primary');
  const captureMode = _flag(args, 'capture-mode');
  const redactMode = _flag(args, 'redact-mode') || _flag(args, 'pii-mode');
  if (localEp) flagPatch.local_endpoint = localEp;
  if (frontEp) flagPatch.frontier_endpoint = frontEp;
  if (confTh != null) flagPatch.confidence_threshold = Number(confTh);
  if (primary) flagPatch.primary = primary;
  if (captureMode) flagPatch.capture_mode = captureMode;
  if (redactMode) flagPatch.redact_mode = redactMode;
  const sets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--set' && i + 1 < args.length) { sets.push(args[++i]); }
    else if (typeof args[i] === 'string' && args[i].startsWith('--set=')) { sets.push(args[i].slice(6)); }
  }
  if (sets.length === 0 && Object.keys(flagPatch).length === 0) {
    // Read mode: prefer local, fall back to server when key + base.
    const local = _nsRead(slug);
    if (local) { _emit({ ok: true, action: 'get', slug, mode: 'local', config: local, version: WRAPPER_CLI_VERSION }); return; }
    const key = _apiKey();
    if (key) {
      const base = _flag(args, 'base') || _envBase();
      const r = await _get(base + '/v1/namespaces/' + encodeURIComponent(slug), key);
      if (r.ok) { _emit({ ok: true, action: 'get', slug, mode: 'cloud', config: r.json, version: WRAPPER_CLI_VERSION }); return; }
      _die({ ok: false, status: r.status, error: 'config_get_failed', slug, detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return;
    }
    _die({ ok: false, error: 'not_found', slug, hint: 'run `kolm namespace create ' + slug + '` first', version: WRAPPER_CLI_VERSION }, 1);
    return;
  }
  const patch = { ...flagPatch };
  for (const kv of sets) {
    const ix = kv.indexOf('=');
    if (ix < 0) continue;
    const k = kv.slice(0, ix).trim();
    let v = kv.slice(ix + 1);
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v.includes(',') && (k === 'route_chain' || k === 'chain' || k === 'fallback_reasons')) {
      v = v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    patch[k] = v;
  }
  // Local-first write - autocreates if missing.
  if (!_nsRead(slug)) _nsWrite(slug, { slug, created_at: new Date().toISOString() });
  const updated = _nsWrite(slug, patch);
  // Best-effort server sync.
  const key = _apiKey();
  let server = null;
  if (key) {
    try {
      const base = _flag(args, 'base') || _envBase();
      const r = await _put(base + '/v1/namespaces/' + encodeURIComponent(slug), key, patch);
      if (r.ok) server = r.json;
    } catch (_) { /* swallow */ }
  }
  _emit({ ok: true, action: 'set', slug, mode: server ? 'cloud' : 'local', patch, config: updated, server, version: WRAPPER_CLI_VERSION });
}

async function _namespaceAction(args, action) {
  const slug = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'slug');
  if (!slug) { _die({ ok: false, error: 'missing_slug', hint: 'usage: kolm namespace ' + action + ' <slug>', version: WRAPPER_CLI_VERSION }, 2); return; }
  const artifact = _flag(args, 'artifact');
  const target = _flag(args, 'to') || _flag(args, 'target');
  const reason = _flag(args, 'reason');
  // Local-first state machine: every action mutates ~/.kolm/namespaces.json so
  // tests + offline use can round-trip without a server.
  const existing = _nsRead(slug) || { slug };
  const stateMap = {
    deploy:   { deployed: true,  last_deploy_at:   new Date().toISOString(), artifact_id: artifact || existing.artifact_id || null },
    undeploy: { deployed: false, last_undeploy_at: new Date().toISOString(), undeploy_reason: reason || null },
    rollback: { deployed: true,  last_rollback_at: new Date().toISOString(), artifact_id: target || null, rollback_reason: reason || null },
  };
  const patch = stateMap[action] || {};
  const updated = _nsWrite(slug, patch);
  // Best-effort server sync.
  const key = _apiKey();
  let server = null;
  if (key) {
    try {
      const base = _flag(args, 'base') || _envBase();
      const body = { artifact_id: artifact || undefined, to: target || undefined, reason: reason || undefined };
      const r = await _post(base + '/v1/namespaces/' + encodeURIComponent(slug) + '/' + action, key, body);
      if (r.ok) server = r.json;
    } catch (_) { /* swallow */ }
  }
  _emit({ ok: true, action, slug, mode: server ? 'cloud' : 'local', config: updated, server, version: WRAPPER_CLI_VERSION });
}

/** kolm namespace deploy <slug> [--artifact <id>] */
export async function nsDeploy(args)    { return _namespaceAction(args, 'deploy'); }
/** kolm namespace undeploy <slug> [--reason "..."] */
export async function nsUndeploy(args)  { return _namespaceAction(args, 'undeploy'); }
/** kolm namespace rollback <slug> [--to <artifact_id>] [--reason "..."] */
export async function nsRollback(args)  { return _namespaceAction(args, 'rollback'); }

/** kolm namespace status <slug> - local-first deployment snapshot */
export async function nsStatus(args) {
  const slug = (args && args[0] && !args[0].startsWith('--')) ? args[0] : _flag(args, 'slug');
  if (!slug) { _die({ ok: false, error: 'missing_slug', hint: 'usage: kolm namespace status <slug>', version: WRAPPER_CLI_VERSION }, 2); return; }
  const local = _nsRead(slug);
  if (local) {
    _emit({
      ok: true,
      action: 'status',
      slug,
      mode: 'local',
      deployed: !!local.deployed,
      artifact_id: local.artifact_id || null,
      config: local,
      version: WRAPPER_CLI_VERSION,
    });
    return;
  }
  const key = _apiKey();
  if (!key) {
    _die({ ok: false, error: 'not_found', slug, hint: 'run `kolm namespace create ' + slug + '` first', version: WRAPPER_CLI_VERSION }, 1);
    return;
  }
  const base = _flag(args, 'base') || _envBase();
  const r = await _get(base + '/v1/namespaces/' + encodeURIComponent(slug), key);
  if (!r.ok) { _die({ ok: false, status: r.status, error: 'status_failed', slug, detail: r.json, version: WRAPPER_CLI_VERSION }, 1); return; }
  _emit({ ok: true, action: 'status', slug, mode: 'cloud', deployed: !!r.json?.deployed, artifact_id: r.json?.artifact_id || null, config: r.json, version: WRAPPER_CLI_VERSION });
}

// ────────────────────────── dispatcher convenience ──────────────────────────
// `cli/kolm.js` will import these tables to keep its switch arms terse and
// to ensure the help text stays in lockstep with the actual handlers.

export const GATEWAY_VERBS = Object.freeze({
  start:     { fn: gatewayStart,     help: 'boot the gateway server (PORT defaults to 8080)' },
  health:    { fn: gatewayHealth,    help: 'GET /v1/health + /v1/gateway/dashboard combined report' },
  providers: { fn: gatewayProviders, help: 'list 11 supported providers with tenant overrides' },
  routes:    { fn: gatewayRoutes,    help: 'resolved route chain per namespace' },
  status:    { fn: gatewayStatus,    help: 'current mode + per-backend reachability' },
  call:      { fn: gatewayCall,      help: 'end-to-end OpenAI-compat call through the gateway (--receipt --capture --redact --risk-scan --stream)' },
  'simulate-overflow': { fn: gatewaySimulateOverflow, help: 'simulate a free-tier daily-cap breach to verify the 429 envelope contract' },
});

export const CAPTURES_VERBS = Object.freeze({
  list:       { fn: capturesList,       help: 'paginated capture browser (filters: namespace, status, pii, risk, date, q)' },
  inspect:    { fn: capturesInspect,    help: 'full row including chain hashes + receipt id' },
  approve:    { fn: capturesApprove,    help: 'mark capture approved for training (single id or --bulk-from <file>)' },
  reject:     { fn: capturesReject,     help: 'mark capture rejected (discarded from training)' },
  quarantine: { fn: capturesQuarantine, help: 'hold capture for re-review without discarding' },
  stats:      { fn: capturesStats,      help: 'aggregate counts by namespace/provider/route' },
  export:     { fn: capturesExport,     help: 'stream paginated captures to a local file (jsonl|json|parquet|hf)' },
  purge:      { fn: capturesPurge,      help: 'one-call forget (per-id) or namespace-wide with --confirm' },
  seed:       { fn: capturesSeed,       help: 'synthetic-seed N rows for benchmark/load tests (returns ids_file)' },
});

export const RECEIPTS_VERBS = Object.freeze({
  verify:       { fn: receiptsVerify,    help: 'verify a receipt online (GET /v1/verify/:id) or offline (--offline path)' },
  list:         { fn: receiptsList,      help: 'paginated receipt browser' },
  export:       { fn: receiptsExport,    help: 'stream receipts to disk for offline audit (jsonl|json|csv; filters: --namespace --since --route)' },
  stats:        { fn: receiptsStats,     help: 'aggregate by namespace/provider/route + cost totals' },
  'rotate-key': { fn: receiptsRotateKey, help: 'rotate Ed25519 signer + record overlap window for verifying older receipts' },
});

export const NAMESPACE_WRAPPER_VERBS = Object.freeze({
  create:   { fn: nsCreate,   help: 'create a namespace record (slug, capture-mode, redact-mode, route-chain)' },
  config:   { fn: nsConfig,   help: 'get config (no flags) or apply --set key=value patches' },
  deploy:   { fn: nsDeploy,   help: 'deploy an artifact to a namespace (--artifact <id>)' },
  undeploy: { fn: nsUndeploy, help: 'undeploy the current artifact (--reason "...")' },
  rollback: { fn: nsRollback, help: 'rollback to a previous artifact (--to <artifact_id>)' },
  status:   { fn: nsStatus,   help: 'deployment snapshot (deployed + artifact_id + config)' },
});

export function gatewayHelp() {
  const lines = ['kolm gateway <subcommand> [args]', ''];
  for (const [k, v] of Object.entries(GATEWAY_VERBS)) lines.push('  ' + k.padEnd(10) + ' - ' + v.help);
  lines.push('');
  lines.push('  legacy: status | set <mode> | test-call --message "..."');
  return lines.join('\n');
}

export function capturesHelp() {
  const lines = ['kolm captures <subcommand> [args]', ''];
  for (const [k, v] of Object.entries(CAPTURES_VERBS)) lines.push('  ' + k.padEnd(10) + ' - ' + v.help);
  lines.push('');
  lines.push('  legacy: review --list-pending | --allow ID | --block ID');
  lines.push('          analytics --namespace <ns>');
  return lines.join('\n');
}

export function receiptsHelp() {
  const lines = ['kolm receipts <subcommand> [args]', ''];
  for (const [k, v] of Object.entries(RECEIPTS_VERBS)) lines.push('  ' + k.padEnd(8) + ' - ' + v.help);
  return lines.join('\n');
}

export function namespaceWrapperHelp() {
  const lines = ['kolm namespace <subcommand> [args] - wrapper additions', ''];
  for (const [k, v] of Object.entries(NAMESPACE_WRAPPER_VERBS)) lines.push('  ' + k.padEnd(10) + ' - ' + v.help);
  lines.push('');
  lines.push('  pre-existing: fingerprint | warm-start-suggest | verticals');
  return lines.join('\n');
}
