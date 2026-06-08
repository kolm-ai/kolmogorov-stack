// W888-P - AssistantClient: shared client for kolm-assistant-1.5b.
// Three-layer fallback: local GGUF -> api.kolm.ai/v1/assistant/chat -> gateway frontier.
// Shims (localShim/apiShim/gatewayShim) short-circuit fetch+spawn in tests.
// Consumers: cmdChat / cmdAssistantNlOneShot (P), /v1/assistant/chat (Q),
// docs search (R), homepage widget (S). Capture is best-effort; never fails turn.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const KOLM_DIR = path.join(HOME, '.kolm');
const DEFAULT_GGUF = path.join(KOLM_DIR, 'models', 'kolm-assistant-1.5b.gguf');
const DEFAULT_LLAMA_CLI = path.join(
  KOLM_DIR,
  'bin',
  process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli'
);
const DEFAULT_API_BASE = 'https://api.kolm.ai';
const DEFAULT_GATEWAY_URL = 'https://kolm.ai';
const DEFAULT_PASSPORT_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  'build',
  'kolm-assistant-1.5b',
  'compile-passport.json'
);

// Hardcoded budget guardrails. perTurnCapUsd defaults to $0.01 per the W888-P
// directive but is overridable per-instance.
const DEFAULT_PER_TURN_CAP_USD = 0.01;

// Rough cost tables for the cap check. The gateway returns true cost in the
// response envelope when available; we use the table only as a pre-flight
// estimate guard so the cap can reject before dispatch.
const COST_TABLE = {
  'claude-haiku-4-5':  { in_per_1k: 0.00025, out_per_1k: 0.00125 },
  'claude-sonnet-4-5': { in_per_1k: 0.003,   out_per_1k: 0.015 },
  'gpt-4o-mini':       { in_per_1k: 0.00015, out_per_1k: 0.0006 },
};

function nowMs() { return Date.now(); }

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function passportHashFromDisk(passportPath) {
  try {
    if (!fs.existsSync(passportPath)) return null;
    const buf = fs.readFileSync(passportPath);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    return h.slice(0, 16); // short hash matches /v1/verify/:cid display
  } catch { return null; }
}

function genTurnId() {
  return 'turn_' + crypto.randomBytes(8).toString('hex');
}

function estimateTokens(text) {
  // ~4 chars per token rough estimate (good enough for the cap check; the
  // real cost comes from the gateway response envelope).
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function estimateCostUsd(model, promptText, maxTokens) {
  const c = COST_TABLE[model] || COST_TABLE['claude-haiku-4-5'];
  const inTok = estimateTokens(promptText);
  const outTok = Math.max(1, Math.floor(maxTokens || 512));
  return (inTok / 1000) * c.in_per_1k + (outTok / 1000) * c.out_per_1k;
}

// Try-local helper. Resolves to { ok, response?, latency_ms, reason? }.
// On any error, returns { ok:false, reason: '...' } so the caller falls through.
async function tryLocal(opts) {
  const t0 = nowMs();
  if (opts.localShim) {
    try {
      const res = await opts.localShim(opts);
      return {
        ok: true,
        response: String(res && res.response != null ? res.response : ''),
        first_token_ms: (res && res.first_token_ms) || (nowMs() - t0),
        latency_ms: nowMs() - t0,
      };
    } catch (e) {
      return { ok: false, latency_ms: nowMs() - t0, reason: 'local_shim_threw:' + e.message };
    }
  }
  if (!fs.existsSync(opts.localGgufPath)) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'gguf_not_installed', install_hint: 'kolm doctor - run with --fix to install the local assistant' };
  }
  if (!fs.existsSync(opts.llamaCliPath)) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'llama_cli_not_installed', install_hint: 'see kolm doctor' };
  }
  // Real path. We do not actually wire llama.cpp in this wave; W888-O ships the
  // artifact, but the local runner install lands later. Spawn the binary and
  // collect stdout; on any timeout or non-zero exit, fall through.
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const sysPrompt = opts.system ? `[SYSTEM]\n${opts.system}\n[/SYSTEM]\n` : '';
    const promptFull = sysPrompt + (opts.prompt || '');
    const child = spawn(opts.llamaCliPath, [
      '-m', opts.localGgufPath,
      '-p', promptFull,
      '-n', String(opts.max_tokens || 512),
      '--no-display-prompt',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {} // deliberate: cleanup
    }, 5000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, latency_ms: nowMs() - t0, reason: 'llama_cli_spawn_failed:' + e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, latency_ms: nowMs() - t0, reason: 'llama_cli_timeout_5s' });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, latency_ms: nowMs() - t0, reason: 'llama_cli_exit_' + code + (stderr ? ':' + stderr.slice(0, 200) : '') });
        return;
      }
      resolve({
        ok: true,
        response: stdout.trim(),
        first_token_ms: nowMs() - t0,
        latency_ms: nowMs() - t0,
      });
    });
  });
}

async function tryApi(opts) {
  const t0 = nowMs();
  const url = `${(opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, '')}/v1/assistant/chat`;
  if (opts.apiShim) {
    try {
      const res = await opts.apiShim({ url, prompt: opts.prompt, system: opts.system, max_tokens: opts.max_tokens, apiKey: opts.apiKey });
      // Caller MUST return { ok, response?, status?, reason? } - we honor it.
      return {
        ok: !!res.ok,
        response: String(res && res.response != null ? res.response : ''),
        latency_ms: nowMs() - t0,
        first_token_ms: (res && res.first_token_ms) || (nowMs() - t0),
        reason: res.reason,
        status: res.status,
      };
    } catch (e) {
      return { ok: false, latency_ms: nowMs() - t0, reason: 'api_shim_threw:' + e.message };
    }
  }
  if (!opts.apiKey) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'no_api_key' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + opts.apiKey,
      },
      body: JSON.stringify({ prompt: opts.prompt, system: opts.system, max_tokens: opts.max_tokens || 512 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    const j = safeJsonParse(text);
    if (r.status === 404 && j && j.error === 'not_yet_routed') {
      return { ok: false, latency_ms: nowMs() - t0, status: 404, reason: 'not_yet_routed' };
    }
    if (!r.ok) {
      return { ok: false, latency_ms: nowMs() - t0, status: r.status, reason: 'api_http_' + r.status };
    }
    const response = (j && (j.response || j.completion || j.text)) || '';
    return {
      ok: true,
      response: String(response),
      latency_ms: nowMs() - t0,
      first_token_ms: nowMs() - t0,
      status: r.status,
    };
  } catch (e) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'api_fetch_failed:' + e.message };
  }
}

async function tryGateway(opts) {
  const t0 = nowMs();
  const model = opts.gatewayModel || 'claude-haiku-4-5';
  const estimated = estimateCostUsd(model, opts.prompt, opts.max_tokens);
  const cap = opts.perTurnCapUsd != null ? opts.perTurnCapUsd : DEFAULT_PER_TURN_CAP_USD;
  if (estimated > cap) {
    return {
      ok: false,
      latency_ms: nowMs() - t0,
      reason: 'budget_exceeded',
      estimated_cost_usd: estimated,
      cap_usd: cap,
    };
  }
  const url = `${(opts.gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/$/, '')}/v1/gateway/dispatch`;
  if (opts.gatewayShim) {
    try {
      const res = await opts.gatewayShim({ url, prompt: opts.prompt, system: opts.system, max_tokens: opts.max_tokens, model, apiKey: opts.apiKey });
      const cost = (res && res.cost_usd != null) ? res.cost_usd : estimated;
      if (cost > cap) {
        return {
          ok: false, latency_ms: nowMs() - t0, reason: 'budget_exceeded',
          estimated_cost_usd: cost, cap_usd: cap,
        };
      }
      return {
        ok: !!res.ok,
        response: String(res && res.response != null ? res.response : ''),
        latency_ms: nowMs() - t0,
        first_token_ms: (res && res.first_token_ms) || (nowMs() - t0),
        cost_usd: cost,
        reason: res.reason,
        status: res.status,
      };
    } catch (e) {
      return { ok: false, latency_ms: nowMs() - t0, reason: 'gateway_shim_threw:' + e.message };
    }
  }
  if (!opts.apiKey) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'no_api_key' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + opts.apiKey,
      },
      body: JSON.stringify({
        prompt: opts.prompt,
        system: opts.system,
        max_tokens: opts.max_tokens || 512,
        model,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    const j = safeJsonParse(text);
    if (!r.ok) {
      return { ok: false, latency_ms: nowMs() - t0, status: r.status, reason: 'gateway_http_' + r.status };
    }
    const response = (j && (j.response || j.completion || j.text)) || '';
    const cost = (j && j.cost_usd != null) ? j.cost_usd : estimated;
    if (cost > cap) {
      return {
        ok: false, latency_ms: nowMs() - t0, reason: 'budget_exceeded',
        estimated_cost_usd: cost, cap_usd: cap,
      };
    }
    return {
      ok: true,
      response: String(response),
      latency_ms: nowMs() - t0,
      first_token_ms: nowMs() - t0,
      cost_usd: cost,
      status: r.status,
    };
  } catch (e) {
    return { ok: false, latency_ms: nowMs() - t0, reason: 'gateway_fetch_failed:' + e.message };
  }
}

export class AssistantClient {
  constructor(opts = {}) {
    this.localGgufPath = opts.localGgufPath || DEFAULT_GGUF;
    this.llamaCliPath = opts.llamaCliPath || process.env.KOLM_LLAMA_CLI || DEFAULT_LLAMA_CLI;
    this.apiBase = opts.apiBase || DEFAULT_API_BASE;
    this.apiKey = opts.apiKey || process.env.KOLM_API_KEY || '';
    this.gatewayUrl = opts.gatewayUrl || DEFAULT_GATEWAY_URL;
    this.perTurnCapUsd = opts.perTurnCapUsd != null ? opts.perTurnCapUsd : DEFAULT_PER_TURN_CAP_USD;
    this.gatewayModel = opts.gatewayModel || 'claude-haiku-4-5';
    this.passportPath = opts.passportPath || DEFAULT_PASSPORT_PATH;
    this.capturer = typeof opts.capturer === 'function' ? opts.capturer : null;
    // Shims (test injection). When set, real fetch + spawn never runs for that layer.
    this.localShim = opts.localShim || null;
    this.apiShim = opts.apiShim || null;
    this.gatewayShim = opts.gatewayShim || null;
    // Capture toggle (REPL :capture off|on flips this).
    this.captureEnabled = opts.captureEnabled !== false;
  }

  // Probe all three layers and report their readiness. No real request goes
  // out - we only check presence + shim availability.
  async health() {
    const localGgufPresent = !!(this.localShim || fs.existsSync(this.localGgufPath));
    const llamaCliPresent = !!(this.localShim || fs.existsSync(this.llamaCliPath));
    return {
      local: {
        ok: !!(this.localShim || (localGgufPresent && llamaCliPresent)),
        gguf_present: localGgufPresent,
        cli_present: llamaCliPresent,
        path: this.localGgufPath,
      },
      api: {
        ok: !!(this.apiShim || this.apiKey),
        base: this.apiBase,
        has_key: !!this.apiKey,
      },
      gateway: {
        ok: !!(this.gatewayShim || this.apiKey),
        url: this.gatewayUrl,
        per_turn_cap_usd: this.perTurnCapUsd,
      },
    };
  }

  // Main entry. prompt is the user message; opts can override system + max_tokens
  // + capture_namespace + turn_id. Returns the envelope documented in the wave header.
  async ask(prompt, opts = {}) {
    const t0 = nowMs();
    const turn_id = opts.turn_id || genTurnId();
    const max_tokens = opts.max_tokens || 512;
    const system = opts.system || '';
    const capture_namespace = opts.capture_namespace || 'assistant';
    const passport_hash = passportHashFromDisk(this.passportPath);
    const fallback_chain = [];
    const layerOpts = {
      prompt, system, max_tokens,
      localGgufPath: this.localGgufPath,
      llamaCliPath: this.llamaCliPath,
      apiBase: this.apiBase,
      apiKey: this.apiKey,
      gatewayUrl: this.gatewayUrl,
      gatewayModel: this.gatewayModel,
      perTurnCapUsd: this.perTurnCapUsd,
      localShim: this.localShim,
      apiShim: this.apiShim,
      gatewayShim: this.gatewayShim,
    };
    // Layer 1: local.
    const local = await tryLocal(layerOpts);
    fallback_chain.push({ layer: 'local', ok: !!local.ok, latency_ms: local.latency_ms, reason: local.reason });
    if (local.ok && local.response) {
      const envelope = {
        ok: true,
        response: local.response,
        source: 'local',
        cost_usd: 0,
        first_token_ms: local.first_token_ms || local.latency_ms,
        total_ms: nowMs() - t0,
        passport_hash,
        turn_id,
        fallback_chain,
      };
      await this._capture(capture_namespace, envelope, prompt);
      return envelope;
    }
    // Layer 2: api.
    const api = await tryApi(layerOpts);
    fallback_chain.push({ layer: 'api', ok: !!api.ok, latency_ms: api.latency_ms, reason: api.reason });
    if (api.ok && api.response) {
      const envelope = {
        ok: true,
        response: api.response,
        source: 'api',
        cost_usd: 0,
        first_token_ms: api.first_token_ms || api.latency_ms,
        total_ms: nowMs() - t0,
        passport_hash,
        turn_id,
        fallback_chain,
      };
      await this._capture(capture_namespace, envelope, prompt);
      return envelope;
    }
    // Layer 3: gateway.
    const gw = await tryGateway(layerOpts);
    fallback_chain.push({
      layer: 'gateway',
      ok: !!gw.ok,
      latency_ms: gw.latency_ms,
      reason: gw.reason,
      cost_usd: gw.cost_usd,
      estimated_cost_usd: gw.estimated_cost_usd,
      cap_usd: gw.cap_usd,
    });
    if (gw.ok && gw.response) {
      const envelope = {
        ok: true,
        response: gw.response,
        source: 'gateway',
        cost_usd: gw.cost_usd != null ? gw.cost_usd : 0,
        first_token_ms: gw.first_token_ms || gw.latency_ms,
        total_ms: nowMs() - t0,
        passport_hash,
        turn_id,
        fallback_chain,
      };
      await this._capture(capture_namespace, envelope, prompt);
      return envelope;
    }
    // All three failed. If gateway specifically rejected on budget, surface
    // the budget_exceeded error so callers can distinguish from transport errors.
    const errEnvelope = {
      ok: false,
      response: '',
      source: 'error',
      cost_usd: 0,
      first_token_ms: 0,
      total_ms: nowMs() - t0,
      passport_hash,
      turn_id,
      fallback_chain,
      error: gw.reason === 'budget_exceeded' ? 'budget_exceeded' : 'all_layers_failed',
    };
    await this._capture(capture_namespace, errEnvelope, prompt);
    return errEnvelope;
  }

  // Internal: append the turn to the capture lake via injected capturer.
  // Best-effort; never throws.
  async _capture(namespace, envelope, prompt) {
    if (!this.captureEnabled) return;
    if (!this.capturer) return;
    try {
      await this.capturer({
        event: 'assistant_turn',
        namespace,
        turn_id: envelope.turn_id,
        prompt,
        response: envelope.response,
        source: envelope.source,
        cost_usd: envelope.cost_usd,
        passport_hash: envelope.passport_hash,
        total_ms: envelope.total_ms,
        ok: envelope.ok,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      // Swallow - capture failure must not fail the turn.
      if (process.env.KOLM_DEBUG) {
         
        console.error('[assistant-client] capture failed:', e.message);
      }
    }
  }

  // Toggle capture on/off for the lifetime of this client instance. Called
  // by the REPL ":capture off" / ":capture on" commands.
  setCaptureEnabled(flag) {
    this.captureEnabled = !!flag;
  }
}

// Convenience factory - most call sites just want a default-configured
// client; pass overrides only when injecting test shims.
export function newAssistantClient(opts = {}) {
  return new AssistantClient(opts);
}

// Helper consumed by cmdAssistantNlOneShot: extract every backticked
// `kolm <verb> [...args]` mention from a response and classify against
// the verb registry. Returns { commands: [{ raw, verb, known }], unknown_count }.
export function extractKolmCommands(responseText, knownVerbs) {
  const known = new Set(Array.isArray(knownVerbs) ? knownVerbs : []);
  const out = [];
  const re = /`(kolm\s+[^`]+)`/g;
  let m;
  const txt = String(responseText || '');
  while ((m = re.exec(txt)) !== null) {
    const raw = m[1].trim().replace(/\s+/g, ' ');
    const parts = raw.split(/\s+/);
    const verb = parts[1] || '';
    out.push({ raw, verb, known: known.has(verb) });
  }
  return {
    commands: out,
    unknown_count: out.filter(c => !c.known).length,
  };
}

export default AssistantClient;
