// W372 runtime policy: per-call decider.
//
// After a user has a .kolm artifact in place, every inbound request runs
// through the policy ladder:
//
//   request → privacy_check → cache → local_artifact → cheaper_model → frontier
//
// Each policy is an ordered list of rung names. The decider walks rungs in
// order, the first rung that "owns" the call returns a {action, target}
// and the rest are skipped. The result is written to a decisions JSONL
// (~/.kolm/runtime/decisions.jsonl) so `kolm runtime decisions` and
// `kolm runtime stats` can compute replacement-rate + dollars saved.
//
// Storage layout under ~/.kolm/runtime/:
//   policy.json          : current policy + tunables
//   cache/<sha>.json     : keyed by sha256(model + body) with TTL
//   decisions.jsonl      : one decision per row (append-only)
//   installed/local/...  : runtime install cache (managed by device-install.js)
//
// Decision execution is intentionally narrow: we always return a Promise
// that resolves to {result, action, latency_ms, cost_usd, event_id,
// decision_chain}. Failures inside one rung do NOT abort the decision;
// the rung is logged as a SKIP reason and the next rung gets a chance.
//
// Privacy block is the one hard exit. If scan() + policy().default === 'block'
// would route an outgoing request through a redactor that does not exist,
// we refuse the call rather than ship a half-redacted body upstream.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { scan, policy as privacyPolicy, redact } from './privacy-membrane.js';
import { newEvent } from './event-schema.js';
import {
  enforceTokenBudget,
  estimateTokens,
  semanticFingerprint,
  semanticSimilarity,
} from './optimization.js';

// Lazy imports: event-store + cost-estimator + llm-call + artifact-runner
// are all heavy modules. We only require them when a rung actually fires
// so a `getPolicy()` call from the CLI does not pull in the SQLite driver.
async function _eventStore()  { return import('./event-store.js'); }
async function _costEstimator() { return import('./cost-estimator.js'); }
async function _llmCall()     { return import('./llm-call.js'); }
async function _artifactRunner() { return import('./artifact-runner.js'); }
async function _bundleRunner() { return import('./bundle-runner.js'); }

export const POLICIES = Object.freeze({
  local_first:     ['token_budget', 'privacy_check', 'cache', 'semantic_cache', 'local_artifact', 'cheaper_model', 'frontier'],
  frontier_first:  ['token_budget', 'privacy_check', 'frontier'],
  cost_optimized:  ['token_budget', 'privacy_check', 'cache', 'semantic_cache', 'local_artifact', 'cheaper_model', 'frontier'],
  privacy_only:    ['token_budget', 'privacy_check', 'local_artifact', 'cache'],
});

export const DEFAULT_POLICY = {
  name: 'local_first',
  cache_ttl_s: 3600,
  local_confidence_threshold: 0.85,
  cheaper_model: 'gpt-4o-mini',
  frontier_model: 'gpt-4o',
  // Honest upstream-cost guess used to compute saved_usd when a local rung
  // wins. Caller can override per-request via context.frontier_cost_usd.
  frontier_cost_usd: 0.012,
  cheaper_cost_usd: 0.0012,
  max_input_tokens: 8192,
  max_output_tokens: 1024,
  token_budget_action: 'compress',
  prompt_compression_enabled: true,
  semantic_cache_enabled: true,
  semantic_cache_threshold: 0.86,
  semantic_cache_ttl_s: 3600,
};

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _runtimeDir() {
  const base = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  return path.join(base, 'runtime');
}
function _ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function _policyPath()    { return path.join(_ensureDir(_runtimeDir()), 'policy.json'); }
function _cacheDir()      { return _ensureDir(path.join(_runtimeDir(), 'cache')); }
function _semanticCachePath() { return path.join(_ensureDir(_runtimeDir()), 'semantic-cache.jsonl'); }
function _decisionsPath() { return path.join(_ensureDir(_runtimeDir()), 'decisions.jsonl'); }
function _installedDir()  { return _ensureDir(path.join(_runtimeDir(), 'installed', 'local')); }

export function getPolicy() {
  const p = _policyPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_POLICY };
  try {
    const merged = { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    if (!POLICIES[merged.name]) merged.name = 'local_first';
    return merged;
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function setPolicy(updates = {}) {
  const cur = getPolicy();
  const next = { ...cur, ...updates };
  if (!POLICIES[next.name]) {
    const err = new Error(`unknown policy: ${next.name}. choose: ${Object.keys(POLICIES).join(', ')}`);
    err.code = 'POLICY_UNKNOWN';
    throw err;
  }
  fs.writeFileSync(_policyPath(), JSON.stringify(next, null, 2));
  return next;
}

// request hashing for cache + decision tracing

function _hashRequest(req) {
  const body = typeof req?.body === 'string' ? req.body : JSON.stringify(req?.body ?? '');
  const model = String(req?.model || '');
  const intent = String(req?.intent || '');
  return crypto.createHash('sha256').update(model + '\n' + intent + '\n' + body, 'utf8').digest('hex');
}

function _shortId(prefix = 'evt_') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

// cache rung

function _readCache(hash, ttl_s) {
  const f = path.join(_cacheDir(), hash + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ageMs = Date.now() - (row.ts || 0);
    if (ageMs / 1000 > ttl_s) return null;
    return row;
  } catch { return null; }
}

function _writeCache(hash, response) {
  const f = path.join(_cacheDir(), hash + '.json');
  const row = { ts: Date.now(), response };
  try { fs.writeFileSync(f, JSON.stringify(row)); } catch {} // deliberate: cleanup
}

function _semanticCacheRows() {
  const f = _semanticCachePath();
  if (!fs.existsSync(f)) return [];
  const rows = [];
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {} // deliberate: cleanup
    }
  } catch {} // deliberate: cleanup
  return rows.slice(-500);
}

function _readSemanticCache(request, pol) {
  if (!pol.semantic_cache_enabled) return null;
  const ttl = Number(pol.semantic_cache_ttl_s || pol.cache_ttl_s || 3600);
  const threshold = Number(pol.semantic_cache_threshold || 0.86);
  const fp = semanticFingerprint(request?.body ?? request?.input ?? request);
  const model = String(request?.model || '');
  const intent = String(request?.intent || '');
  let best = null;
  const now = Date.now();
  for (const row of _semanticCacheRows()) {
    if (!row || !Array.isArray(row.tokens) || !row.response) continue;
    if (model && row.model && row.model !== model) continue;
    if (intent && row.intent && row.intent !== intent) continue;
    if (ttl && row.ts && (now - row.ts) / 1000 > ttl) continue;
    const similarity = semanticSimilarity(fp.tokens, row.tokens);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { ...row, similarity, fingerprint: fp.hash };
    }
  }
  return best;
}

function _writeSemanticCache(request, response, meta = {}) {
  const fp = semanticFingerprint(request?.body ?? request?.input ?? request);
  if (!fp.tokens.length) return;
  const row = {
    ts: Date.now(),
    request_hash: _hashRequest(request),
    model: String(request?.model || ''),
    intent: String(request?.intent || ''),
    fingerprint: fp.hash,
    tokens: fp.tokens.slice(0, 512),
    token_count: fp.token_count,
    response,
    meta,
  };
  try { fs.appendFileSync(_semanticCachePath(), JSON.stringify(row) + '\n', 'utf8'); } catch {} // deliberate: cleanup
}

function _prepareRequestForPolicy(request, pol) {
  const maxTokens = Number(pol.max_input_tokens || 0);
  if (!maxTokens) {
    return {
      request,
      budget: { action: 'pass', original_tokens: estimateTokens(request?.body ?? request?.input ?? request), final_tokens: estimateTokens(request?.body ?? request?.input ?? request), compressed: false },
    };
  }
  const source = request?.body ?? request?.input ?? request;
  const budget = enforceTokenBudget(source, {
    maxTokens,
    action: pol.prompt_compression_enabled === false ? 'reject' : (pol.token_budget_action || 'compress'),
  });
  if (!budget.ok) return { request, budget };
  if (budget.input === source) return { request, budget };
  const next = { ...request };
  if (Object.prototype.hasOwnProperty.call(next, 'body')) next.body = budget.input;
  else if (Object.prototype.hasOwnProperty.call(next, 'input')) next.input = budget.input;
  else return { request: budget.input, budget };
  return { request: next, budget };
}

// local-artifact discovery

function _artifactsDir() {
  return path.join(_home(), '.kolm', 'artifacts');
}

// Returns a list of installed artifacts whose manifest.intent overlaps the
// requested intent. The actual intent matching is intentionally simple:
// substring match on `intent` and the artifact's `intent`, `description`,
// or `name`. Real semantic routing is a follow-on; the contract here is
// "any artifact tagged for this kind of work is considered eligible".
function _findMatchingArtifacts(intent) {
  const dir = _artifactsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.kolm'));
  const out = [];
  for (const f of files) {
    out.push({ name: f, path: path.join(dir, f) });
  }
  // Also include the runtime-install cache (kolm runtime install ...)
  const inst = _installedDir();
  if (fs.existsSync(inst)) {
    for (const f of fs.readdirSync(inst)) {
      const sub = path.join(inst, f);
      try {
        const stat = fs.statSync(sub);
        if (stat.isDirectory()) {
          // Look for .kolm under that subdir.
          for (const g of fs.readdirSync(sub)) {
            if (g.endsWith('.kolm')) out.push({ name: g, path: path.join(sub, g), installed: true });
          }
        } else if (sub.endsWith('.kolm')) {
          out.push({ name: f, path: sub, installed: true });
        }
      } catch {} // deliberate: cleanup
    }
  }
  // No intent filter when none supplied: caller (decide) picks the first
  // that succeeds. If an intent string is given we still return all and
  // let the runner score; the manifest doesn't (yet) ship a canonical
  // intent field for every artifact.
  return out;
}

// Run an artifact via the W367 bundle path when possible, falling back to
// the recipe runner. Either path returns {output, confidence}.
async function _tryArtifact(artifactPath, request) {
  const input = request?.body ?? request?.input ?? '';
  // First try the portable bundle (W367); works on any Node host.
  try {
    const { runArtifactViaBundle } = await _bundleRunner();
    const r = await runArtifactViaBundle(artifactPath, input, {});
    return {
      ok: true,
      output: r.output,
      confidence: _scoreConfidence(r.output),
      recipe_id: r.recipe_id || null,
      latency_us: r.latency_us || 0,
    };
  } catch (bundleErr) { // deliberate: cleanup
    // Fall through to the in-process recipe runner.
  }
  try {
    const { runArtifact } = await _artifactRunner();
    const r = await runArtifact(artifactPath, input, {});
    return {
      ok: true,
      output: r.output,
      confidence: _scoreConfidence(r.output, r.k_score),
      recipe_id: r.recipe_id || null,
      latency_us: r.latency_us || 0,
    };
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code || 'ARTIFACT_FAILED' };
  }
}

function _scoreConfidence(output, k_score) {
  // If the recipe self-reported confidence in its output use that.
  if (output && typeof output === 'object') {
    if (typeof output.confidence === 'number') return output.confidence;
    if (output.skipped === true) return 0;
  }
  if (typeof k_score === 'number') return k_score;
  // Default: the artifact produced something non-empty -> 0.9 confidence
  // (we can't do better without an evaluator inline).
  if (output == null) return 0;
  if (typeof output === 'string' && output.length === 0) return 0;
  return 0.9;
}

// LLM rungs

async function _callModel(modelOverride, request) {
  const { callLLM, isConfigured } = await _llmCall();
  if (!isConfigured()) {
    return { ok: false, reason: 'llm_not_configured' };
  }
  const prior = process.env.KOLM_LLM_MODEL;
  if (modelOverride) process.env.KOLM_LLM_MODEL = modelOverride;
  try {
    const user = typeof request?.body === 'string' ? request.body : JSON.stringify(request?.body ?? '');
    const r = await callLLM({ user });
    return { ok: true, output: r.text, raw: r.raw };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    if (prior == null) delete process.env.KOLM_LLM_MODEL;
    else process.env.KOLM_LLM_MODEL = prior;
  }
}

// core decide / applyPolicy

export async function decide(request = {}, context = {}) {
  const pol = getPolicy();
  const policyName = context.policyName || pol.name;
  const rungs = POLICIES[policyName] || POLICIES.local_first;
  const decision_chain = [];
  let workingRequest = request;
  let tokenBudget = null;

  for (const rung of rungs) {
    if (rung === 'token_budget') {
      const prepared = _prepareRequestForPolicy(workingRequest, pol);
      workingRequest = prepared.request;
      tokenBudget = prepared.budget;
      if (!prepared.budget.ok) {
        decision_chain.push({
          rung,
          status: 'block',
          original_tokens: prepared.budget.original_tokens,
          final_tokens: prepared.budget.final_tokens,
          max_input_tokens: Number(pol.max_input_tokens || 0),
        });
        return {
          action: 'blocked',
          target: null,
          confidence: 1,
          reason: prepared.budget.reason || 'token_budget_exceeded',
          decision_chain,
          token_budget: prepared.budget,
          effective_request: workingRequest,
        };
      }
      decision_chain.push({
        rung,
        status: prepared.budget.compressed ? 'compressed' : 'pass',
        original_tokens: prepared.budget.original_tokens,
        final_tokens: prepared.budget.final_tokens,
        max_input_tokens: Number(pol.max_input_tokens || 0),
      });
      continue;
    }

    if (rung === 'privacy_check') {
      const body = typeof workingRequest.body === 'string' ? workingRequest.body : JSON.stringify(workingRequest.body || '');
      const findings = scan(body);
      const p = privacyPolicy();
      if (findings.sensitive && p.default === 'block') {
        decision_chain.push({ rung, status: 'block', findings: findings.classes });
        return { action: 'blocked', target: null, confidence: 1, reason: 'privacy_block', decision_chain, sensitive_classes: findings.classes, token_budget: tokenBudget, effective_request: workingRequest };
      }
      decision_chain.push({ rung, status: 'pass', findings: findings.classes });
      continue;
    }

    if (rung === 'cache') {
      const hash = _hashRequest(workingRequest);
      const hit = _readCache(hash, pol.cache_ttl_s);
      if (hit) {
        decision_chain.push({ rung, status: 'hit', hash });
        return { action: 'cache_hit', target: hash, confidence: 1, reason: 'cache_within_ttl', decision_chain, cached: hit.response, token_budget: tokenBudget, effective_request: workingRequest };
      }
      decision_chain.push({ rung, status: 'miss', hash });
      continue;
    }

    if (rung === 'semantic_cache') {
      const hit = _readSemanticCache(workingRequest, pol);
      if (hit) {
        decision_chain.push({ rung, status: 'hit', similarity: hit.similarity, request_hash: hit.request_hash });
        return {
          action: 'semantic_cache_hit',
          target: hit.request_hash,
          confidence: hit.similarity,
          reason: `semantic_similarity_${hit.similarity}`,
          decision_chain,
          cached: hit.response,
          semantic_cache: { similarity: hit.similarity, request_hash: hit.request_hash, fingerprint: hit.fingerprint },
          token_budget: tokenBudget,
          effective_request: workingRequest,
        };
      }
      decision_chain.push({ rung, status: pol.semantic_cache_enabled ? 'miss' : 'disabled' });
      continue;
    }

    if (rung === 'local_artifact') {
      const arts = _findMatchingArtifacts(workingRequest.intent || '');
      if (arts.length === 0) {
        decision_chain.push({ rung, status: 'no_artifacts' });
        continue;
      }
      // Try each artifact; first one whose confidence clears the gate wins.
      for (const a of arts) {
        const r = await _tryArtifact(a.path, workingRequest);
        if (r.ok && r.confidence >= pol.local_confidence_threshold) {
          decision_chain.push({ rung, status: 'served', target: a.name, confidence: r.confidence });
          return {
            action: 'local_artifact',
            target: a.name,
            confidence: r.confidence,
            reason: `confidence_${r.confidence.toFixed(2)}>=${pol.local_confidence_threshold}`,
            decision_chain,
            artifact_path: a.path,
            local_output: r.output,
            recipe_id: r.recipe_id,
            token_budget: tokenBudget,
            effective_request: workingRequest,
          };
        }
      }
      decision_chain.push({ rung, status: 'below_threshold', threshold: pol.local_confidence_threshold });
      continue;
    }

    if (rung === 'cheaper_model') {
      decision_chain.push({ rung, status: 'selected', model: pol.cheaper_model });
      return {
        action: 'cheaper_model',
        target: pol.cheaper_model,
        confidence: 0.7,
        reason: 'no_local_match_route_cheaper',
        decision_chain,
        token_budget: tokenBudget,
        effective_request: workingRequest,
      };
    }

    if (rung === 'frontier' || rung === 'frontier_model') {
      decision_chain.push({ rung, status: 'selected', model: pol.frontier_model });
      return {
        action: 'frontier_model',
        target: pol.frontier_model,
        confidence: 0.9,
        reason: 'frontier_fallback',
        decision_chain,
        token_budget: tokenBudget,
        effective_request: workingRequest,
      };
    }
  }

  // No rung claimed the request: punt to frontier.
  decision_chain.push({ rung: 'fallback', status: 'frontier' });
  return {
    action: 'frontier_model',
    target: pol.frontier_model,
    confidence: 0.9,
    reason: 'no_rung_owned_request',
    decision_chain,
    token_budget: tokenBudget,
    effective_request: workingRequest,
  };
}

export async function applyPolicy(request = {}, { policyName, opts = {} } = {}) {
  const pol = getPolicy();
  const effectivePolicy = policyName || pol.name;
  const t0 = Date.now();
  const d = await decide(request, { policyName: effectivePolicy });
  const effectiveRequest = d.effective_request || request;
  const event_id = _shortId('evt_');
  let result = null;
  let cost_usd = 0;
  let saved_usd = 0;

  if (d.action === 'blocked') {
    result = { blocked: true, reason: d.reason || 'privacy_block', classes: d.sensitive_classes || [] };
  } else if (d.action === 'cache_hit' || d.action === 'semantic_cache_hit') {
    result = d.cached;
  } else if (d.action === 'local_artifact') {
    result = d.local_output;
    saved_usd = opts.frontier_cost_usd != null ? Number(opts.frontier_cost_usd) : Number(pol.frontier_cost_usd || 0);
  } else if (d.action === 'cheaper_model') {
    const r = await _callModel(pol.cheaper_model, effectiveRequest);
    result = r.ok ? r.output : { error: r.reason };
    try {
      const { estimateCost } = await _costEstimator();
      cost_usd = estimateCost({
        provider: process.env.KOLM_LLM_PROVIDER || 'openai',
        model: pol.cheaper_model,
        prompt_tokens: r.raw?.usage?.prompt_tokens || 0,
        completion_tokens: r.raw?.usage?.completion_tokens || 0,
      });
    } catch {} // deliberate: cleanup
    saved_usd = Math.max(0, Number(pol.frontier_cost_usd || 0) - cost_usd);
    // Write to cache so future identical calls go free.
    if (r.ok) {
      _writeCache(_hashRequest(effectiveRequest), result);
      _writeSemanticCache(effectiveRequest, result, { action: d.action, target: d.target });
    }
  } else if (d.action === 'frontier_model') {
    const r = await _callModel(pol.frontier_model, effectiveRequest);
    result = r.ok ? r.output : { error: r.reason };
    try {
      const { estimateCost } = await _costEstimator();
      cost_usd = estimateCost({
        provider: process.env.KOLM_LLM_PROVIDER || 'openai',
        model: pol.frontier_model,
        prompt_tokens: r.raw?.usage?.prompt_tokens || 0,
        completion_tokens: r.raw?.usage?.completion_tokens || 0,
      });
    } catch {} // deliberate: cleanup
    if (r.ok) {
      _writeCache(_hashRequest(effectiveRequest), result);
      _writeSemanticCache(effectiveRequest, result, { action: d.action, target: d.target });
    }
  }

  const latency_ms = Date.now() - t0;

  // Persist a decision row + capture event. Failures in either are non-fatal.
  const decisionRow = {
    event_id,
    timestamp: new Date().toISOString(),
    action: d.action,
    target: d.target,
    confidence: d.confidence,
    latency_ms,
    cost_usd,
    saved_usd,
    decision_chain: d.decision_chain,
    request_hash: _hashRequest(request),
    effective_request_hash: _hashRequest(effectiveRequest),
    policy: effectivePolicy,
    token_budget: d.token_budget || null,
    semantic_cache: d.semantic_cache || null,
  };
  try {
    fs.appendFileSync(_decisionsPath(), JSON.stringify(decisionRow) + '\n', 'utf8');
  } catch {} // deliberate: cleanup
  try {
    const { appendEvent } = await _eventStore();
    await appendEvent(newEvent({
      event_id,
      provider: 'kolm-runtime',
      model: d.target || effectivePolicy,
      request_hash: decisionRow.effective_request_hash,
      estimated_cost_usd: cost_usd,
      latency_ms,
      cache_hit: d.action === 'cache_hit' || d.action === 'semantic_cache_hit',
      status: d.action === 'blocked' ? 'blocked' : 'ok',
    }));
  } catch {} // deliberate: cleanup

  return {
    result,
    action: d.action,
    target: d.target,
    latency_ms,
    cost_usd,
    saved_usd,
    event_id,
    decision_chain: d.decision_chain,
    token_budget: d.token_budget || null,
    semantic_cache: d.semantic_cache || null,
  };
}

export function recentDecisions({ n = 50 } = {}) {
  const f = _decisionsPath();
  if (!fs.existsSync(f)) return [];
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  const rows = [];
  for (const l of lines.slice(-n)) {
    try { rows.push(JSON.parse(l)); } catch {} // deliberate: cleanup
  }
  return rows.reverse();
}

// stats over the last `since` (ms or shorthand: 1h, 24h, 7d).
function _parseSince(s) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(\d+)([smhd])?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || 'd';
  return n * ({ s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[unit] || 86400_000);
}

export function replacementStats({ since } = {}) {
  const f = _decisionsPath();
  const out = {
    total_decisions: 0,
    by_action: { cache_hit: 0, semantic_cache_hit: 0, local_artifact: 0, cheaper_model: 0, frontier_model: 0, blocked: 0 },
    replacement_rate: 0,
    savings_usd: 0,
    spent_usd: 0,
    window_ms: _parseSince(since),
  };
  if (!fs.existsSync(f)) return out;
  const cutoff = since ? Date.now() - out.window_ms : 0;
  const txt = fs.readFileSync(f, 'utf8');
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    let row;
    try { row = JSON.parse(l); } catch { continue; }
    if (cutoff && new Date(row.timestamp).getTime() < cutoff) continue;
    out.total_decisions += 1;
    if (out.by_action[row.action] == null) out.by_action[row.action] = 0;
    out.by_action[row.action] += 1;
    out.savings_usd += Number(row.saved_usd || 0);
    out.spent_usd += Number(row.cost_usd || 0);
  }
  const replaced = out.by_action.cache_hit + out.by_action.semantic_cache_hit + out.by_action.local_artifact + out.by_action.cheaper_model;
  out.replacement_rate = out.total_decisions ? Number((replaced / out.total_decisions).toFixed(3)) : 0;
  out.savings_usd = Number(out.savings_usd.toFixed(4));
  out.spent_usd = Number(out.spent_usd.toFixed(4));
  return out;
}

// Helpers exposed for tests / install path
export function _internals() {
  return { hashRequest: _hashRequest, runtimeDir: _runtimeDir, cacheDir: _cacheDir, semanticCachePath: _semanticCachePath, installedDir: _installedDir, decisionsPath: _decisionsPath, policyPath: _policyPath };
}

export default {
  POLICIES,
  DEFAULT_POLICY,
  decide,
  applyPolicy,
  getPolicy,
  setPolicy,
  recentDecisions,
  replacementStats,
  _internals,
};
