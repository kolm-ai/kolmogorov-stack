// W368 — local daemon-connector. THE WEDGE.
//
// Usage from the user's POV:
//
//   npm install -g github:kolm-ai/kolm
//   kolm connect start
//   export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
//   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
//   export OPENROUTER_BASE_URL=http://127.0.0.1:8787/v1
//   # ANY existing OpenAI/Anthropic/OpenRouter SDK call gets captured,
//   # redacted, costed, latency-tracked, written to ~/.kolm/events/, and
//   # forwarded upstream with the user's own API key.
//
// This module owns the local proxy. It runs in-process (kolm connect start)
// or detached (kolm connect start --detach). It writes a PID file at
// ~/.kolm/daemon.pid so `kolm connect status|stop` can find it.
//
// The daemon mounts a slim express app with new "direct forwarding" routes
// and a /v1/health snapshot. It does NOT mount the big buildRouter() — the
// connector daemon is a focused local proxy, not the full kolm.ai surface.
// (The same direct-forwarding routes are also added to buildRouter() so the
// cloud deployment supports them, see src/router.js.)
//
// Persistence: every captured round-trip is written via insertCapture() from
// src/capture-store.js. The default driver is the local SQLite store under
// ~/.kolm/events/events.sqlite — durable, queryable, survives reboots.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import express from 'express';

import { PROVIDERS, summarizeProviders } from './provider-registry.js';
import { estimateCost, extractUsage } from './cost-estimator.js';
import { newEvent, hashContent } from './event-schema.js';
import { scan as privacyScan, redact as privacyRedact, reinsert as privacyReinsert } from './privacy-membrane.js';
import { insertCapture, isDurable as captureIsDurable, driverName as captureDriverName, health as captureStoreHealth } from './capture-store.js';
// W409a — event-store is the canonical telemetry plane. Every capture row we
// write to capture-store is ALSO appended here so the lake / opportunity
// engine / dataset workbench / label queue / training planner all see it.
// appendEvent is INSERT OR REPLACE keyed on event_id → idempotent against a
// later bridge call from capture-store.insertCapture for the same row.
import { appendEvent as eventStoreAppend } from './event-store.js';

const DEFAULT_HOME = os.homedir();
const DEFAULT_KOLM_DIR = path.join(DEFAULT_HOME, '.kolm');

function resolveKolmDir(dataDir) {
  return dataDir
    || process.env.KOLM_HOME
    || process.env.KOLM_DATA_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || DEFAULT_HOME, '.kolm');
}

function pidPath(dataDir) { return path.join(resolveKolmDir(dataDir), 'daemon.pid'); }
function configPath(dataDir) { return path.join(resolveKolmDir(dataDir), 'config.json'); }
function eventsDir(dataDir) { return path.join(resolveKolmDir(dataDir), 'events'); }
function rawDir(dataDir) { return path.join(eventsDir(dataDir), 'raw'); }

// W411 — local daemon sentinel tenant_id. Captures from an unauthenticated
// local proxy still carry a tenant so the lake / opportunities / datasets
// path has something queryable. Falls back to 'local:host' if hostname()
// blows up for whatever reason.
const LOCAL_SENTINEL_TENANT = (function () {
  try {
    return 'local:' + ((os.hostname && os.hostname()) || 'host');
  } catch (_e) {
    return 'local:host';
  }
})();

const DAEMON_VERSION = '0.2.6';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

function ensureDirs(dataDir) {
  const base = resolveKolmDir(dataDir);
  for (const d of [base, path.join(base, 'events'), path.join(base, 'events', 'raw')]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadDaemonConfig(dataDir) {
  const fp = configPath(dataDir);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return {}; }
}

function readPidRecord(dataDir) {
  const fp = pidPath(dataDir);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function writePidRecord(rec, dataDir) {
  ensureDirs(dataDir);
  const fp = pidPath(dataDir);
  try {
    fs.writeFileSync(fp, JSON.stringify(rec, null, 2));
    try { fs.chmodSync(fp, 0o600); } catch (_) {} // deliberate: cleanup
    return { ok: true, path: fp };
  } catch (error) {
    return { ok: false, path: fp, error };
  }
}

function removePidRecord(dataDir) {
  try { fs.unlinkSync(pidPath(dataDir)); } catch (_) {} // deliberate: cleanup
}

// Resolve the upstream key the daemon will forward with. Priority:
//   1. Authorization header from the app (Bearer ... or raw key)
//   2. x-upstream-api-key header (legacy)
//   3. Env var (per provider registry)
//   4. Stored config ~/.kolm/config.json upstream_keys.<provider>
export function resolveUpstreamKey(provider, req) {
  const auth = String(req && req.headers && req.headers.authorization || '');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m) return m[1];
    return auth.trim();
  }
  const xKey = String(req && req.headers && req.headers['x-upstream-api-key'] || '');
  if (xKey) return xKey;
  const cfg = PROVIDERS[provider];
  if (cfg && cfg.env_key && process.env[cfg.env_key]) return process.env[cfg.env_key];
  const stored = loadDaemonConfig();
  if (stored && stored.upstream_keys && stored.upstream_keys[provider]) {
    return stored.upstream_keys[provider];
  }
  return null;
}

// W407b — Read privacy policy from ~/.kolm/config.json. Defaults to 'redact'
// (fail-safe: never let raw PII reach the lake unless the user opts in via
// `kolm connect config --set privacy_policy=allow` or KOLM_PRIVACY_POLICY=allow).
function loadPolicy() {
  const cfg = loadDaemonConfig();
  const p = String((cfg && cfg.privacy_policy) || process.env.KOLM_PRIVACY_POLICY || 'redact').toLowerCase();
  if (p === 'redact' || p === 'block' || p === 'allow' || p === 'review_required') return p;
  return 'redact';
}

// W409b — raw opt-in resolver. Returns true ONLY when the operator explicitly
// authorizes raw bytes to land on disk. Two opt-in vectors:
//   1. env KOLM_ALLOW_RAW=true (global, persists across the daemon's lifetime)
//   2. per-request header x-kolm-raw: true (caller-scoped, audit-friendly)
// Anything else (missing, 'false', '0', random string) → fail-closed false.
function isRawAllowed(req) {
  const env = String(process.env.KOLM_ALLOW_RAW || '').toLowerCase();
  if (env === 'true' || env === '1' || env === 'yes') return true;
  const hdr = req && req.headers ? String(req.headers['x-kolm-raw'] || '').toLowerCase() : '';
  if (hdr === 'true' || hdr === '1' || hdr === 'yes') return true;
  return false;
}

// W409b — sidecar raw store. When raw is explicitly authorized, the bytes go to
// ~/.kolm/events/raw/<sha256>.txt and the event row carries a pointer +
// content hash. The lake table itself NEVER stores inline raw text; consumers
// that want the raw payload must read the sidecar file (gated behind the same
// KOLM_ALLOW_RAW boolean at read time).
function isZeroRetentionRequest(req, body = {}) {
  const headers = (req && req.headers) || {};
  const header = String(
    headers['x-kolm-retention']
    || headers['x-kolm-no-store']
    || headers['x-kolm-zero-retention']
    || ''
  ).toLowerCase();
  const meta = body && typeof body === 'object' && body.metadata && typeof body.metadata === 'object'
    ? body.metadata
    : {};
  const bodyRetention = String(
    body.kolm_retention
    || body.retention
    || meta.kolm_retention
    || meta.retention
    || ''
  ).toLowerCase();
  return header === 'none'
    || header === 'no-store'
    || header === 'true'
    || header === '1'
    || bodyRetention === 'none'
    || bodyRetention === 'zero-retention'
    || body.no_store === true
    || meta.no_store === true;
}

function writeRawSidecar(text, kind /* 'prompt'|'response' */) {
  const s = String(text == null ? '' : text);
  if (s.length === 0) return { hash: null, path: null };
  ensureDirs();
  const hash = crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const ext = '.txt';
  const filename = `${hash}_${kind}${ext}`;
  const fp = path.join(rawDir(), filename);
  try {
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, s, 'utf8');
    try { fs.chmodSync(fp, 0o600); } catch (_) {} // deliberate: cleanup
  } catch (_) {} // deliberate: cleanup
  return { hash, path: fp };
}

// Fire an HTTPS request to the upstream. Native node:http(s) so we don't
// inherit the W305 libuv-fetch trap on Windows when the daemon shuts down.
function forwardRaw({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdr = { ...headers };
    if (payload) hdr['content-length'] = Buffer.byteLength(payload).toString();
    const t0 = process.hrtime.bigint();
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: method || 'POST',
      headers: hdr,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
        let json;
        try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw_text: buf, elapsed_us });
      });
    });
    req.setTimeout(120_000, () => { try { req.destroy(new Error('upstream_timeout')); } catch (_) {} }); // deliberate: cleanup
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Extract the "prompt" string from a request body for hashing + redaction.
function extractPromptText(body, provider) {
  if (!body || typeof body !== 'object') return '';
  if (provider === 'anthropic') {
    const sys = typeof body.system === 'string' ? body.system : '';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const turns = msgs.map((m) => {
      if (!m) return '';
      const role = m.role || 'user';
      const c = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((x) => (x && (x.text || x.content)) || '').join('\n')
          : '';
      return role + ': ' + c;
    }).filter(Boolean).join('\n\n');
    return (sys ? 'system: ' + sys + '\n\n' : '') + turns;
  }
  // openai / openrouter
  if (Array.isArray(body.messages)) {
    return body.messages.map((m) => {
      const role = m && m.role || 'user';
      const c = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((x) => (x && (x.text || x.content)) || '').join('\n')
          : '';
      return role + ': ' + c;
    }).join('\n\n');
  }
  if (typeof body.input === 'string') return body.input;
  if (typeof body.prompt === 'string') return body.prompt;
  return '';
}

function extractCompletionText(json, provider) {
  if (!json || typeof json !== 'object') return '';
  if (provider === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    return blocks.map((b) => (b && b.text) || '').join('').trim();
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0] || {};
  const msg = first.message || {};
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((c) => (c && c.text) || '').join('');
  return String(first.text || '');
}

// W409k — fixture mode for the local daemon. When the operator points an SDK
// at the daemon with no upstream key set AND opts into KOLM_CONNECTOR_FIXTURE=1,
// we return a deterministic mock shaped like the upstream's real response so
// integration tests + offline-dev sessions can still exercise the full
// observe→event flow (events are still appended with source_type:'simulated').
function isFixtureMode() {
  const v = String(process.env.KOLM_CONNECTOR_FIXTURE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
function fixtureBody(provider, upstreamPath, body, promptText) {
  const created = Math.floor(Date.now() / 1000);
  const model = String((body && body.model) || 'kolm-fixture-model');
  const echo = String(promptText || '').slice(0, 120);
  if (provider === 'anthropic') {
    return {
      id: 'msg_fixture_' + created.toString(36),
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: `[kolm fixture] ${echo}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 6 },
    };
  }
  if (upstreamPath === '/v1/embeddings') {
    const dim = 8;
    const vec = Array.from({ length: dim }, (_, i) => Math.round(Math.sin(i + 1) * 1000) / 1000);
    return { object: 'list', data: [{ object: 'embedding', index: 0, embedding: vec }], model, usage: { prompt_tokens: 4, total_tokens: 4 } };
  }
  if (upstreamPath === '/v1/audio/transcriptions' || upstreamPath === '/v1/audio/translations') {
    return { text: '[kolm fixture transcription]' };
  }
  if (upstreamPath === '/v1/audio/speech') {
    return { object: 'audio.speech', model, format: (body && body.response_format) || 'mp3', bytes_b64: 'a29sbS1maXh0dXJl' };
  }
  if (upstreamPath === '/v1/moderations') {
    return { id: 'modr_fixture_' + created.toString(36), model, results: [{ flagged: false, categories: {}, category_scores: {} }] };
  }
  if (upstreamPath === '/v1/responses') {
    return {
      id: 'resp_fixture_' + created.toString(36),
      object: 'response',
      created_at: created,
      model,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[kolm fixture] ${echo}` }] }],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    };
  }
  return {
    id: 'chatcmpl_fixture_' + created.toString(36),
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `[kolm fixture] ${echo}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
  };
}

// The HEAVY lifting: read the inbound request, redact, forward upstream,
// extract usage/cost, write the event to the capture store. Returns
// {status, headers, body, event} or {status, body, event:null} on error.
async function proxyOne({ provider, upstreamPath, req }) {
  const pcfg = PROVIDERS[provider];
  if (!pcfg) return { status: 400, body: { error: { type: 'unknown_provider', message: provider } }, event: null };
  const upstreamKey = resolveUpstreamKey(provider, req);
  const fixtureMode = isFixtureMode();
  if (!upstreamKey && !fixtureMode) {
    return {
      status: 401,
      body: {
        error: {
          type: 'missing_upstream_credentials',
          message: `no upstream credentials for ${provider}; set ${pcfg.env_key} in env or run: kolm connect config --set ${provider.toLowerCase()}_api_key=<key>`,
        },
      },
      event: null,
    };
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const zeroRetention = isZeroRetentionRequest(req, body);
  const model = String(body.model || '').slice(0, 128);
  const policy = loadPolicy();
  const rawAllowed = isRawAllowed(req);
  const promptText = extractPromptText(body, provider);
  const scan = privacyScan(promptText);
  // W409b/W550 — surface "noncompliant identifier detected" so the warning is
  // not swallowed. malformed_* classes flow through as normal sensitive_class
  // values AND light up this dedicated tag for dashboards/auditors.
  const noncompliantIds = Array.from(new Set((scan.classes || []).filter((c) => String(c).startsWith('malformed_'))));
  if (policy === 'block' && scan.sensitive && req.headers['x-kolm-privacy-override'] !== 'true') {
    return {
      status: 451,
      body: {
        error: {
          type: 'privacy_blocked',
          classes: scan.classes,
          message: 'sensitive data detected; pass x-kolm-privacy-override: true to allow',
        },
      },
      event: null,
    };
  }
  let forwardBody = body;
  let placeholderMap = null;
  let redactedPromptText = null;
  // W409b — fail-closed: pre-compute the redacted prompt up front whenever
  // sensitive data is present, regardless of policy. The success and error
  // paths both reach for `redactedPromptText`, so a 5xx from upstream can
  // never smuggle raw PII into the lake (the historical bug at the old
  // line 300 where `promptText` was persisted raw on the error path).
  if (scan.sensitive) {
    const r = privacyRedact(promptText);
    redactedPromptText = r.redacted_text || r.redacted || '';
    if (policy === 'redact') {
      placeholderMap = r.map;
      // Best-effort: replace the prompt text everywhere we know how to find it.
      forwardBody = JSON.parse(JSON.stringify(body));
      function swap(str) {
        let s = String(str);
        for (const [ph, val] of Object.entries(placeholderMap)) {
          if (typeof val === 'string' && val.length > 0) s = s.split(val).join(ph);
        }
        return s;
      }
      if (Array.isArray(forwardBody.messages)) {
        for (const m of forwardBody.messages) {
          if (typeof m.content === 'string') m.content = swap(m.content);
          else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part && typeof part.text === 'string') part.text = swap(part.text);
            }
          }
        }
      }
      if (typeof forwardBody.system === 'string') forwardBody.system = swap(forwardBody.system);
      if (typeof forwardBody.input === 'string') forwardBody.input = swap(forwardBody.input);
      if (typeof forwardBody.prompt === 'string') forwardBody.prompt = swap(forwardBody.prompt);
    }
  }
  // W409b — derive the canonical lake-form prompt up front. The default is
  // redacted regardless of policy: only the operator's explicit raw opt-in
  // (KOLM_ALLOW_RAW=true / x-kolm-raw header) lets raw bytes reach the lake
  // table, and even then only if policy=allow. Otherwise the redacted form is
  // the single source of truth.
  function deriveLakePrompt() {
    if (policy === 'allow' && rawAllowed) return promptText;
    if (redactedPromptText != null) return redactedPromptText;
    if (!scan.sensitive) return promptText;
    return privacyRedact(promptText || '').redacted_text || '';
  }
  function deriveLakeResponse(respText) {
    if (policy === 'allow' && rawAllowed) return respText;
    try {
      const rs = privacyRedact(respText || '');
      return rs.redacted_text || rs.redacted || '';
    } catch (_) { return ''; }
  }
  // W409b — sidecar raw persistence (only when explicitly opted in).
  let rawPromptHash = null;
  let rawResponseHash = null;
  let rawPromptPath = null;
  let rawResponsePath = null;
  if (!zeroRetention && rawAllowed && promptText) {
    const sc = writeRawSidecar(promptText, 'prompt');
    rawPromptHash = sc.hash;
    rawPromptPath = sc.path;
  }
  const upstreamUrl = pcfg.upstream.replace(/\/+$/, '') + upstreamPath;
  const headers = { 'content-type': 'application/json' };
  if (pcfg.auth === 'bearer') {
    headers['authorization'] = `Bearer ${upstreamKey}`;
  } else if (pcfg.auth === 'x-api-key') {
    headers['x-api-key'] = upstreamKey;
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
  }
  // OpenRouter helpful headers (referer + title) for ranking.
  if (provider === 'openrouter') {
    headers['http-referer'] = req.headers['http-referer'] || 'https://kolm.ai';
    headers['x-title'] = req.headers['x-title'] || req.headers['x-openrouter-title'] || 'kolm.ai';
    if (req.headers['x-openrouter-title']) headers['x-openrouter-title'] = req.headers['x-openrouter-title'];
    if (req.headers['x-openrouter-categories']) headers['x-openrouter-categories'] = req.headers['x-openrouter-categories'];
  }
  let upstreamResp;
  if (fixtureMode && !upstreamKey) {
    // W409k — local fixture mode: skip the network entirely and return a
    // deterministic mock so tests can exercise the connector surface without
    // configuring real upstream keys. The event still flows through the
    // canonical pipeline tagged source_type:'simulated'.
    upstreamResp = { status: 200, body: fixtureBody(provider, upstreamPath, forwardBody, promptText), headers: {}, elapsed_us: 0 };
  } else try {
    upstreamResp = await forwardRaw({ url: upstreamUrl, method: 'POST', headers, body: forwardBody });
  } catch (e) {
    // W409b — FAIL-CLOSED error path. The old code stuffed raw `promptText`
    // into the observation row when forwardRaw threw; that meant any 5xx
    // from upstream leaked PII to the lake. We now persist the redacted
    // form (via deriveLakePrompt()) on this path, identical to success.
    if (zeroRetention) {
      return {
        status: 502,
        body: { error: { type: 'upstream_error', message: String(e.message || e) } },
        event: null,
        durable: false,
        retention: 'none',
        http_status: 0,
      };
    }
    const lakePromptOnError = deriveLakePrompt();
    const promptRedactedField = scan.sensitive
      ? (redactedPromptText != null ? redactedPromptText : (privacyRedact(promptText).redacted_text || null))
      : null;
    const ev = newEvent({
      tenant_id: LOCAL_SENTINEL_TENANT,
      namespace: 'default',
      provider,
      model,
      upstream_url: upstreamUrl,
      request_hash: hashContent(promptText + '|' + model),
      response_hash: null,
      prompt_redacted: promptRedactedField,
      response_redacted: null,
      latency_ms: 0,
      status: 'error',
      error_type: 'upstream_error',
      sensitive_data_detected: scan.sensitive,
      sensitive_classes: scan.classes,
      redaction_policy: policy,
      source_type: 'real',
      raw_available: rawAllowed && !!rawPromptHash,
      raw_prompt_hash: rawPromptHash,
      raw_response_hash: null,
      noncompliant_identifiers: noncompliantIds,
    });
    let durable = true;
    try {
      await insertCapture(eventToObservationRow(ev, lakePromptOnError, ''));
    } catch (_) { durable = false; }
    // W409a — canonical event-store write (additional to capture-store). The
    // ev built above already carries every canonical field; appendEvent is
    // idempotent (INSERT OR REPLACE) so the bridge inside insertCapture and
    // this explicit append collapse to one row.
    try { await eventStoreAppend(ev); } catch (_) {} // deliberate: cleanup
    return {
      status: 502,
      body: { error: { type: 'upstream_error', message: String(e.message || e) } },
      event: ev,
      durable,
      http_status: 0,
    };
  }
  let respText = extractCompletionText(upstreamResp.body, provider);
  // W407b: if we redacted on the way out, the upstream body contains
  // placeholder strings. We reinsert into the body returned to the caller so
  // their SDK sees the original values, but the lake-visible text stays
  // redacted (placeholders + any echoed-PII rescanned).
  let bodyForCaller = upstreamResp.body;
  if (placeholderMap) {
    try {
      // Deep clone + walk strings, reinserting placeholders -> original values.
      bodyForCaller = JSON.parse(JSON.stringify(upstreamResp.body));
      const walk = (n) => {
        if (n == null) return n;
        if (typeof n === 'string') return privacyReinsert(n, placeholderMap);
        if (Array.isArray(n)) return n.map(walk);
        if (typeof n === 'object') {
          for (const k of Object.keys(n)) n[k] = walk(n[k]);
          return n;
        }
        return n;
      };
      bodyForCaller = walk(bodyForCaller);
    } catch (_) { bodyForCaller = upstreamResp.body; }
  }
  // W409b — sidecar raw response only when opt-in. Off by default.
  if (zeroRetention) {
    return {
      status: upstreamResp.status,
      http_status: upstreamResp.status,
      headers: upstreamResp.headers,
      body: bodyForCaller,
      event: null,
      durable: false,
      retention: 'none',
    };
  }
  if (rawAllowed && respText) {
    const sc = writeRawSidecar(respText, 'response');
    rawResponseHash = sc.hash;
    rawResponsePath = sc.path;
  }
  // Lake form: rescan the response text under the fail-closed default.
  const respTextForLake = deriveLakeResponse(respText);
  const usage = extractUsage(upstreamResp.body, provider);
  const cost = estimateCost({ provider, model, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens });
  const httpStatus = upstreamResp.status;
  let canonStatus = 'ok';
  if (httpStatus === 429) canonStatus = 'rate_limited';
  else if (httpStatus === 408 || httpStatus === 504) canonStatus = 'timeout';
  else if (httpStatus >= 400) canonStatus = 'error';
  // W409b — fail-closed prompt_redacted/response_redacted: always populated
  // when sensitive data was detected, regardless of policy, so the lake row
  // always carries a sanitized version even on the allow path.
  const promptRedactedField = scan.sensitive
    ? (redactedPromptText != null ? redactedPromptText : (privacyRedact(promptText).redacted_text || null))
    : null;
  const responseRedactedField = respText
    ? ((policy === 'allow' && rawAllowed) ? null : (privacyRedact(respText).redacted_text || null))
    : null;
  const ev = newEvent({
    tenant_id: LOCAL_SENTINEL_TENANT,
    namespace: 'default',
    provider,
    model,
    upstream_url: upstreamUrl,
    request_hash: hashContent(promptText + '|' + model),
    response_hash: hashContent(respText),
    prompt_redacted: promptRedactedField,
    response_redacted: responseRedactedField,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    estimated_cost_usd: cost,
    latency_ms: Math.round((upstreamResp.elapsed_us || 0) / 1000),
    status: canonStatus,
    error_type: httpStatus >= 400 ? 'upstream_status_' + httpStatus : null,
    sensitive_data_detected: scan.sensitive,
    sensitive_classes: scan.classes,
    redaction_count: placeholderMap ? Object.keys(placeholderMap).length : 0,
    redaction_policy: policy,
    // W409k — simulated source when the daemon synthesized the response.
    source_type: (fixtureMode && !upstreamKey) ? 'simulated' : 'real',
    raw_available: rawAllowed && (!!rawPromptHash || !!rawResponseHash),
    raw_prompt_hash: rawPromptHash,
    raw_response_hash: rawResponseHash,
    raw_prompt_path: rawPromptPath,
    raw_response_path: rawResponsePath,
    noncompliant_identifiers: noncompliantIds,
  });
  // Persist via the capture store. Failure → still return the upstream result
  // to the app, but mark the event as undurable; this preserves end-user UX
  // (their LLM call succeeded) while making the storage problem visible via
  // x-kolm-event-durable: false header.
  let durable = true;
  // W409b — derive lake-form text via the helpers so policy + raw opt-in are
  // honored uniformly. The raw bytes only land in the sidecar (if at all).
  const lakePrompt = deriveLakePrompt();
  const lakeResponse = respTextForLake;
  try {
    await insertCapture(eventToObservationRow(ev, lakePrompt, lakeResponse));
  } catch (_) {
    durable = false;
  }
  // W409a — canonical event-store write (additional to capture-store). We pass
  // the lake-redacted prompt/response so the event row's prompt_redacted /
  // response_redacted columns carry the post-policy text. Idempotent: same
  // event_id collapses with the bridge fired from insertCapture above.
  try {
    await eventStoreAppend({
      ...ev,
      prompt_redacted: ev.prompt_redacted != null ? ev.prompt_redacted : (lakePrompt || null),
      response_redacted: ev.response_redacted != null ? ev.response_redacted : (lakeResponse || null),
    });
  } catch (_) {} // deliberate: cleanup
  return {
    status: httpStatus,
    http_status: httpStatus,
    headers: upstreamResp.headers,
    body: bodyForCaller,
    event: ev,
    durable,
  };
}

// Adapt the canonical event row to the legacy 'observations' shape used by
// src/capture-store.js insertCapture. Keeps the dashboard + distill paths
// reading the same store.
//
// W409b — every persisted row now carries the redaction_policy + raw_available
// + noncompliant_identifiers tags so a downstream auditor can sweep the lake
// and answer "did any row land here under the wrong policy?" without
// re-running detection.
function eventToObservationRow(ev, promptText, respText) {
  return {
    id: ev.event_id,
    tenant: ev.tenant_id,
    template_hash: ev.request_hash,
    template_preview: String(promptText || '').slice(0, 200),
    model: ev.model,
    prompt: String(promptText || '').slice(0, 8000),
    variable_input: null,
    response: String(respText || '').slice(0, 16000),
    latency_ms: ev.latency_ms,
    latency_us: ev.latency_ms * 1000,
    cost_usd: ev.estimated_cost_usd,
    provider: ev.provider,
    corpus_namespace: ev.workspace_id || 'default',
    status: ev.status,
    sensitive_classes: ev.sensitive_classes,
    redaction_count: ev.redaction_count,
    event_id: ev.event_id,
    created_at: ev.created_at,
    // W409b privacy provenance — persisted alongside every capture row.
    redaction_policy: ev.redaction_policy || 'redact',
    raw_available: ev.raw_available === true,
    raw_prompt_hash: ev.raw_prompt_hash || null,
    raw_response_hash: ev.raw_response_hash || null,
    noncompliant_identifiers: Array.isArray(ev.noncompliant_identifiers) ? ev.noncompliant_identifiers : [],
  };
}

// W393: per-provider reachability probe. Returns
// { network_reachable, authenticated } both booleans, never throws.
// Bounded by REACH_TIMEOUT_MS so a slow/unreachable upstream cannot hang
// /v1/health. `authenticated` requires key_set AND an authenticated GET that
// returns 2xx; with no key it stays false even if DNS resolves.
const REACH_TIMEOUT_MS = 1500;
const PROVIDER_AUTH_PROBE = {
  openai:     { path: '/v1/models',     auth: 'bearer' },
  anthropic:  { path: '/v1/models',     auth: 'x-api-key' },
  openrouter: { path: '/api/v1/models', auth: 'bearer' },
  gemini:     { path: '/v1beta/models', auth: 'key-param' },
};
async function probeProviderReach(id, cfg) {
  const out = { network_reachable: false, authenticated: false };
  let url;
  try { url = new URL(cfg.upstream); } catch (_) { return out; }
  const lib = url.protocol === 'https:' ? https : http;
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  // 1. Plain HEAD probe: DNS + TCP + TLS reach only.
  out.network_reachable = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; try { r.destroy(); } catch (_) {} resolve(false); }, REACH_TIMEOUT_MS); // deliberate: cleanup
    const r = lib.request({
      hostname: url.hostname, port, path: '/', method: 'HEAD', timeout: REACH_TIMEOUT_MS,
    }, (resp) => {
      if (done) return; done = true; clearTimeout(t);
      const code = resp.statusCode || 0;
      // Any HTTP response (including 401/404) means the host is reachable.
      resolve(code >= 200 && code < 600);
      try { resp.resume(); } catch (_) {} // deliberate: cleanup
    });
    r.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(false); });
    r.on('timeout', () => { if (done) return; done = true; clearTimeout(t); try { r.destroy(); } catch (_) {} resolve(false); }); // deliberate: cleanup
    r.end();
  });
  // 2. Authenticated GET: only if a key is set; else stay false.
  const key = process.env[cfg.env_key];
  if (!key) return out;
  const probe = PROVIDER_AUTH_PROBE[id];
  if (!probe || !out.network_reachable) return out;
  const headers = {};
  let probePath = probe.path;
  if (probe.auth === 'bearer') headers['authorization'] = 'Bearer ' + key;
  else if (probe.auth === 'x-api-key') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else if (probe.auth === 'key-param') probePath = probePath + '?key=' + encodeURIComponent(key);
  out.authenticated = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; try { r.destroy(); } catch (_) {} resolve(false); }, REACH_TIMEOUT_MS); // deliberate: cleanup
    const r = lib.request({
      hostname: url.hostname, port, path: probePath, method: 'GET', headers, timeout: REACH_TIMEOUT_MS,
    }, (resp) => {
      if (done) return; done = true; clearTimeout(t);
      const code = resp.statusCode || 0;
      resolve(code >= 200 && code < 300);
      try { resp.resume(); } catch (_) {} // deliberate: cleanup
    });
    r.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(false); });
    r.on('timeout', () => { if (done) return; done = true; clearTimeout(t); try { r.destroy(); } catch (_) {} resolve(false); }); // deliberate: cleanup
    r.end();
  });
  return out;
}

// Build the express app the daemon listens on.
export function buildDaemonApp({ dataDir } = {}) {
  ensureDirs(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  let totalEvents = 0;
  const startedAt = Date.now();

  // Permissive CORS for SDK calls from browser-side apps (when the user
  // points window.OPENAI_BASE_URL at the local daemon).
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Upstream-API-Key',
      'X-Anthropic-API-Key',
      'Anthropic-Version',
      'OpenAI-Beta',
      'HTTP-Referer',
      'X-Title',
      'X-OpenRouter-Title',
      'X-OpenRouter-Categories',
      'X-Kolm-Namespace',
      'X-Kolm-Privacy-Policy',
      'X-Kolm-Raw',
      'X-Kolm-Privacy-Override',
      'X-Kolm-Retention',
      'X-Kolm-No-Store',
      'X-Kolm-Zero-Retention',
    ].join(', '));
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  async function handlePassthrough(provider, upstreamPath, req, res) {
    const out = await proxyOne({ provider, upstreamPath, req });
    if (out.retention === 'none') {
      res.set('x-kolm-retention', 'none');
      res.set('x-kolm-no-store', 'true');
      res.set('x-kolm-event-durable', 'false');
    }
    if (out.event) {
      res.set('x-kolm-event-id', out.event.event_id);
      res.set('x-kolm-provider', out.event.provider || provider);
      res.set('x-kolm-model', String(out.event.model || ''));
      res.set('x-kolm-event-durable', String(out.durable !== false));
      // W409b — surface privacy provenance on the response so SDK callers can
      // assert fail-closed behavior without reading the lake.
      res.set('x-kolm-redaction-policy', String(out.event.redaction_policy || 'redact'));
      res.set('x-kolm-raw-available', String(out.event.raw_available === true));
      // W409k — fixture marker (simulated source) for SDK callers + tests.
      if (out.event.source_type === 'simulated') res.set('x-kolm-fixture', 'true');
      if (Array.isArray(out.event.noncompliant_identifiers) && out.event.noncompliant_identifiers.length) {
        res.set('x-kolm-noncompliant-identifiers', out.event.noncompliant_identifiers.join(','));
      }
      if (out.event.sensitive_data_detected) {
        res.set('x-kolm-sensitive-classes', (out.event.sensitive_classes || []).join(','));
      }
      totalEvents += 1;
    }
    res.status(out.status).json(out.body);
  }

  // OpenAI-compatible direct.
  for (const p of ['/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations']) {
    app.post(p, (req, res) => handlePassthrough('openai', p, req, res));
  }

  // OpenRouter direct + capture alias for SDKs whose base URL is .../v1.
  app.post('/v1/capture/openrouter', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));
  app.post('/v1/capture/openrouter/chat/completions', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));
  app.post('/v1/capture/openrouter/v1/chat/completions', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));
  app.post('/openrouter/v1/chat/completions', (req, res) => handlePassthrough('openrouter', '/v1/chat/completions', req, res));

  // Anthropic direct.
  app.post('/v1/messages', (req, res) => handlePassthrough('anthropic', '/v1/messages', req, res));
  app.post('/anthropic/v1/messages', (req, res) => handlePassthrough('anthropic', '/v1/messages', req, res));

  // Gemini (key passed as ?key= param, not header).
  app.post(/^\/v1beta\/models\/[^/]+:(generate|streamGenerate)Content$/, (req, res) => {
    const upstreamPath = req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    handlePassthrough('gemini', upstreamPath, req, res);
  });

  // /v1/health — daemon snapshot for `kolm connect status|doctor`.
  app.get('/v1/health', async (_req, res) => {
    let storage = path.join(resolveKolmDir(dataDir), 'events', 'events.sqlite');
    let storageHealth = null;
    try { storageHealth = await captureStoreHealth(); } catch (_) {} // deliberate: cleanup
    const providers = summarizeProviders();
    const reach = await Promise.all(Object.entries(PROVIDERS).map(async ([id, cfg]) => {
      const out = await probeProviderReach(id, cfg);
      return [id, out];
    }));
    for (const [id, info] of reach) {
      // W393: replace single upstream_reachable boolean with 4 explicit fields.
      // - configured       : provider is in the daemon's known PROVIDERS list
      // - key_set          : the env var for this provider is populated
      // - network_reachable: HEAD/GET probe to upstream host returned 2xx/3xx
      // - authenticated    : authenticated GET to a real endpoint returned 2xx
      //   (only true when key_set AND probe succeeds with credentials)
      providers[id].configured = true;
      providers[id].key_set = !!providers[id].env_key_set;
      providers[id].network_reachable = !!info.network_reachable;
      providers[id].authenticated = !!info.authenticated;
    }
    res.json({
      ok: true,
      version: DAEMON_VERSION,
      port: res.app.get('kolm:port') || DEFAULT_PORT,
      host: res.app.get('kolm:host') || DEFAULT_HOST,
      pid: process.pid,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      captured_events: totalEvents,
      storage_path: storage,
      storage_driver: captureDriverName(),
      storage_durable: captureIsDurable(),
      storage_health: storageHealth,
      providers,
      policy: loadPolicy(),
    });
  });

  // /health — public lightweight probe, no secrets, matches `kolm health` shape.
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: DAEMON_VERSION, kind: 'connector_daemon' }));

  // W407b — GET /v1/models. OpenAI-shaped {object:'list', data:[...]} listing
  // every model the daemon knows about across all configured providers (read
  // from PROVIDERS[*].cost_per_1k, the declared static lists). Does NOT call
  // any upstream; this is local metadata so SDKs that auto-discover models
  // (langchain, llamaindex, OpenAI client `.models.list()`) get a 200.
  app.get('/v1/models', async (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    const data = [];
    for (const [provId, cfg] of Object.entries(PROVIDERS)) {
      const models = Object.keys((cfg && cfg.cost_per_1k) || {});
      for (const id of models) {
        data.push({
          id,
          object: 'model',
          created,
          owned_by: provId,
        });
        // W409k — Anthropic-compat alias. The hosted server emits prefixed
        // `anthropic:<id>` rows so the Anthropic SDK can list Claude models
        // without colliding with their canonical OpenAI-shaped ids. The
        // daemon must be a SUPERSET of the server surface so SDKs auto-
        // discovering models against the daemon (which dev tunnels expose)
        // see the same ids and don't break on a missing alias.
        if (/^anthropic/i.test(provId)) {
          data.push({
            id: `anthropic:${id}`,
            object: 'model',
            created,
            owned_by: 'anthropic-compat',
            alias_of: id,
          });
        }
      }
    }
    // W409k — also surface FRONTIER_MODELS (the kolm-teacher catalogue) so
    // the daemon's /v1/models is a SUPERSET of the hosted server's. SDKs
    // that auto-discover models via the daemon (dev tunnels, byoc) see the
    // same teacher catalogue as the hosted surface.
    try {
      const reg = await import('./model-registry.js');
      const rows = Array.isArray(reg.FRONTIER_MODELS) ? reg.FRONTIER_MODELS : [];
      for (const row of rows) {
        if (!row || typeof row.id !== 'string') continue;
        data.push({
          id: row.id,
          object: 'model',
          created,
          owned_by: 'kolm-teachers',
          kolm: {
            family: row.family || null,
            params: row.params || null,
            arch: row.arch || null,
            modality: row.modality || null,
            hw_tier: row.hw_tier || null,
            license: row.license || null,
            source_url: row.source_url || null,
          },
        });
        if (typeof row.family === 'string' && /^(claude|anthropic)/i.test(row.family)) {
          data.push({
            id: `anthropic:${row.id}`,
            object: 'model',
            created,
            owned_by: 'anthropic-compat',
            alias_of: row.id,
          });
        }
      }
    } catch (_e) { /* registry import optional */ }
    res.json({ object: 'list', data });
  });

  return { app, getTotal: () => totalEvents };
}

// Start the daemon. Returns {server, port, pid}.
export async function startDaemon({ port, host, dataDir } = {}) {
  // port=0 must round-trip as 0 so the OS picks a free port; only fall back to
  // DEFAULT_PORT when the caller passed undefined/null.
  const portRaw = (port == null) ? (process.env.KOLM_DAEMON_PORT || DEFAULT_PORT) : port;
  const p = parseInt(portRaw, 10);
  const h = host || process.env.KOLM_DAEMON_HOST || DEFAULT_HOST;
  ensureDirs(dataDir);
  const { app } = buildDaemonApp({ dataDir });
  app.set('kolm:port', p);
  app.set('kolm:host', h);
  return await new Promise((resolve, reject) => {
    const server = app.listen(p, h, () => {
      const addr = server.address();
      const actualPort = (typeof addr === 'object' && addr && addr.port) ? addr.port : p;
      const pidWrite = writePidRecord({
        pid: process.pid,
        port: actualPort,
        host: h,
        started_at: new Date().toISOString(),
        version: DAEMON_VERSION,
      }, dataDir);
      resolve({ server, port: actualPort, host: h, pid: process.pid, pid_file: pidWrite.path, pid_file_written: pidWrite.ok });
    });
    server.on('error', reject);
  });
}

// Stop the daemon. Accepts a server instance (in-process) or a PID record.
export async function stopDaemon(target) {
  if (target && typeof target.close === 'function') {
    return await new Promise((resolve) => target.close(() => { removePidRecord(); resolve(true); }));
  }
  const rec = target && target.pid ? target : readPidRecord();
  if (!rec || !rec.pid) {
    removePidRecord();
    return false;
  }
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch (e) {
    if (e && e.code !== 'ESRCH') throw e;
  }
  removePidRecord();
  return true;
}

// Check daemon status — reads PID file + checks if alive.
export function daemonStatus() {
  const rec = readPidRecord();
  if (!rec) return { running: false };
  let alive = false;
  try {
    process.kill(rec.pid, 0);
    alive = true;
  } catch (_) { alive = false; }
  return { running: alive, ...rec, pid_file: pidPath() };
}

export const _internals = {
  KOLM_DIR: DEFAULT_KOLM_DIR,
  PID_PATH: pidPath(),
  CONFIG_PATH: configPath(),
  EVENTS_DIR: eventsDir(),
  RAW_DIR: rawDir(),
  resolveKolmDir,
  pidPath,
  configPath,
  eventsDir,
  rawDir,
  LOCAL_SENTINEL_TENANT,
  proxyOne,
  eventToObservationRow,
  resolveUpstreamKey,
  loadPolicy,
  probeProviderReach,
  isRawAllowed,
  writeRawSidecar,
};
