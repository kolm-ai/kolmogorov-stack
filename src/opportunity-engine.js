// W369 — opportunity engine.
//
// Reads events via src/event-store.js, finds 11 categories of opportunity,
// persists accept/ignore state at ~/.kolm/opportunities.jsonl. All
// detectors are pure functions of the events array — easy to seed in tests.
//
// Opportunity types:
//   1.  cache_candidate            — identical request_hash repeated N+ times
//   2.  cheaper_model_candidate    — strong model used where weak would suffice
//   3.  local_replacement_candidate — template signature repeated 100+ times
//   4.  privacy_leak               — sensitive_data_detected with allow policy
//   5.  prompt_compression         — long prompts with consistent prefix
//   6.  repeated_extraction        — JSON output with consistent schema
//   7.  repeated_classification    — output in small enumerated set
//   8.  log_triage                 — prompts about logs/errors with categorical out
//   9.  routing_policy             — same prompt type to multiple providers
//   10. dataset_ready              — 1000+ events with template clustering
//   11. training_ready             — dataset_ready + holdout-disjoint candidate

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { listEvents } from './event-store.js';
import { clusterRepeatedPrompts } from './lake.js';
import { templateSignature } from './event-schema.js';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _stateDir() {
  const base = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
  fs.mkdirSync(base, { recursive: true });
  return base;
}
function _opportunitiesLog() {
  return path.join(_stateDir(), 'opportunities.jsonl');
}

function _oppId(type, seed) {
  const h = crypto.createHash('sha256').update(type + ':' + seed).digest('hex').slice(0, 12);
  return 'opp_' + h;
}

function _round(n, p = 2) { const m = Math.pow(10, p); return Math.round(n * m) / m; }

// Strong/weak model heuristics — the costliest premium models are obvious
// candidates to demote when responses are short and structured. Names are
// matched substring-insensitive so we catch variant tags (gpt-4o-2024-...).
const STRONG_MODELS = ['gpt-4', 'claude-opus', 'claude-sonnet', 'gpt-5', 'o1', 'o3', 'gemini-1.5-pro', 'gemini-2.0', 'kolm-flagship'];
function _isStrongModel(m) {
  if (!m) return false;
  const s = String(m).toLowerCase();
  return STRONG_MODELS.some(k => s.includes(k));
}

const JSON_OPENER = /^\s*[{[]/;
function _looksLikeJson(s) { return typeof s === 'string' && JSON_OPENER.test(s); }

// findOpportunities({since, namespace, minCallCount, minMonthlySpend, tenant_id})
//
// W419 — `tenant_id` (or `tenant` alias) restricts the opportunity scan to the
// caller's events. Without this guard the engine would surface another
// tenant's optimization opportunities through `/v1/opportunities/*` and via
// `/v1/intent/next` snapshot_summary. Local-only daemon callers leave the
// field unset, in which case behavior matches the pre-W419 default.
export async function findOpportunities(opts = {}) {
  const minCallCount = opts.minCallCount == null ? 50 : opts.minCallCount;
  const minMonthlySpend = opts.minMonthlySpend == null ? 10 : opts.minMonthlySpend;
  const tenant_id = opts.tenant_id || opts.tenant || null;
  const events = await listEvents({
    namespace: opts.namespace,
    tenant_id,
    since: opts.since,
    limit: opts.limit == null ? 10000 : opts.limit,
    order: 'desc',
  });
  const namespace = opts.namespace || (events[0] && events[0].namespace) || 'default';
  const state = _loadState();
  const opps = [];

  // --- 1) cache_candidate ----------------------------------------------------
  const byHash = new Map();
  for (const ev of events) {
    if (!ev.request_hash) continue;
    byHash.set(ev.request_hash, (byHash.get(ev.request_hash) || 0) + 1);
  }
  for (const [hash, count] of byHash.entries()) {
    if (count < Math.max(5, Math.floor(minCallCount / 10))) continue;
    const sample = events.filter(e => e.request_hash === hash);
    const spend = sample.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
    if (spend < 0.001) continue;
    opps.push(_finalize({
      id: _oppId('cache', hash),
      type: 'cache_candidate',
      namespace,
      call_count: count,
      monthly_cost_usd: _round(spend * 30, 2),
      pattern: 'identical request hash ' + hash.slice(0, 8) + '... repeated',
      suggested_action: 'enable_response_cache',
      expected_replacement_rate: 1.0,
      estimated_savings_usd: _round(spend * 30 * 0.95, 2),
      risk: 'low',
      reason: count + ' identical requests in window — same answer every time',
      sample_event_ids: sample.slice(0, 5).map(e => e.event_id),
    }, state));
  }

  // --- 2) cheaper_model_candidate -------------------------------------------
  const strongShort = events.filter(ev =>
    _isStrongModel(ev.model)
    && Number(ev.completion_tokens || 0) < 200
    && !(ev.tool_calls && ev.tool_calls.length)
    && !/```|class |function |def |import /.test(ev.response_redacted || '')
  );
  if (strongShort.length >= Math.floor(minCallCount / 2)) {
    const spend = strongShort.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
    if (spend * 30 >= minMonthlySpend) {
      const modelTallies = {};
      for (const e of strongShort) modelTallies[e.model] = (modelTallies[e.model] || 0) + 1;
      const topModel = Object.entries(modelTallies).sort((a, b) => b[1] - a[1])[0][0];
      opps.push(_finalize({
        id: _oppId('cheaper', topModel + ':' + namespace),
        type: 'cheaper_model_candidate',
        namespace,
        call_count: strongShort.length,
        monthly_cost_usd: _round(spend * 30, 2),
        pattern: topModel + ' for short structured outputs',
        suggested_action: 'route_to_cheaper_model',
        expected_replacement_rate: 0.85,
        estimated_savings_usd: _round(spend * 30 * 0.80, 2),
        risk: 'low',
        reason: strongShort.length + ' calls return <200 tokens with no code/tools — gpt-4o-mini or claude-haiku would suffice',
        sample_event_ids: strongShort.slice(0, 5).map(e => e.event_id),
      }, state));
    }
  }

  // --- 3) local_replacement_candidate ---------------------------------------
  const clusters = await clusterRepeatedPrompts(events);
  for (const c of clusters) {
    if (c.count < Math.max(minCallCount * 2, 100)) continue;
    const sample = events.filter(e => c.sample_event_ids.includes(e.event_id));
    const avgCost = c.avg_cost || 0;
    const monthlySpend = avgCost * c.count * 30;
    if (monthlySpend < minMonthlySpend) continue;
    opps.push(_finalize({
      id: _oppId('local-replace', c.signature),
      type: 'local_replacement_candidate',
      namespace,
      call_count: c.count,
      monthly_cost_usd: _round(monthlySpend, 2),
      pattern: c.normalized.slice(0, 80),
      suggested_action: 'build_local_classifier',
      expected_replacement_rate: 0.78,
      estimated_savings_usd: _round(monthlySpend * 0.85, 2),
      risk: 'medium',
      reason: c.count + ' calls share the same template — local model can replace 78%+',
      sample_event_ids: c.sample_event_ids,
      template_signature: c.signature,
    }, state));
  }

  // --- 4) privacy_leak ------------------------------------------------------
  const leaks = events.filter(ev => ev.sensitive_data_detected && ev.redaction_policy === 'allow');
  if (leaks.length > 0) {
    const classes = new Set();
    for (const e of leaks) for (const c of (e.sensitive_classes || [])) classes.add(c);
    opps.push(_finalize({
      id: _oppId('privacy', namespace),
      type: 'privacy_leak',
      namespace,
      call_count: leaks.length,
      monthly_cost_usd: 0,
      pattern: 'sensitive data sent under allow policy',
      suggested_action: 'flip_to_redact_policy',
      expected_replacement_rate: 1.0,
      estimated_savings_usd: 0,
      risk: 'high',
      reason: leaks.length + ' events containing ' + Array.from(classes).join(', ') + ' left the network with policy=allow',
      sample_event_ids: leaks.slice(0, 5).map(e => e.event_id),
    }, state));
  }

  // --- 5) prompt_compression -----------------------------------------------
  const longPrompts = events.filter(ev => Number(ev.prompt_tokens || 0) > 4000);
  if (longPrompts.length >= Math.floor(minCallCount / 10)) {
    const prefixes = new Map();
    for (const e of longPrompts) {
      const head = (e.prompt_redacted || '').slice(0, 200);
      if (!head) continue;
      prefixes.set(head, (prefixes.get(head) || 0) + 1);
    }
    const top = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= Math.floor(minCallCount / 10)) {
      const sample = longPrompts.filter(e => (e.prompt_redacted || '').slice(0, 200) === top[0]).slice(0, 5);
      const spend = longPrompts.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
      opps.push(_finalize({
        id: _oppId('compress', namespace + ':' + (top[0].slice(0, 16))),
        type: 'prompt_compression',
        namespace,
        call_count: top[1],
        monthly_cost_usd: _round(spend * 30, 2),
        pattern: 'long prompts share prefix: ' + top[0].slice(0, 60),
        suggested_action: 'extract_system_prompt_to_cache',
        expected_replacement_rate: 0.6,
        estimated_savings_usd: _round(spend * 30 * 0.3, 2),
        risk: 'low',
        reason: top[1] + ' prompts >4000 tokens share an identical 200-char prefix — cache it',
        sample_event_ids: sample.map(e => e.event_id),
      }, state));
    }
  }

  // --- 6) repeated_extraction -----------------------------------------------
  const jsonOuts = events.filter(ev => _looksLikeJson(ev.response_redacted));
  if (jsonOuts.length >= Math.floor(minCallCount / 5)) {
    const schemaKeys = new Map();
    for (const e of jsonOuts) {
      try {
        const j = JSON.parse(e.response_redacted);
        const keys = Object.keys(j || {}).slice(0, 20).sort().join(',');
        if (!keys) continue;
        schemaKeys.set(keys, (schemaKeys.get(keys) || 0) + 1);
      } catch {}
    }
    const top = [...schemaKeys.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= Math.floor(minCallCount / 5)) {
      const sample = jsonOuts.slice(0, 5).map(e => e.event_id);
      const spend = jsonOuts.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
      opps.push(_finalize({
        id: _oppId('extract', namespace + ':' + top[0]),
        type: 'repeated_extraction',
        namespace,
        call_count: top[1],
        monthly_cost_usd: _round(spend * 30, 2),
        pattern: 'JSON outputs share schema {' + top[0].slice(0, 60) + '}',
        suggested_action: 'train_extractor_adapter',
        expected_replacement_rate: 0.9,
        estimated_savings_usd: _round(spend * 30 * 0.7, 2),
        risk: 'medium',
        reason: top[1] + ' outputs have identical JSON schema — extractor can replace LLM',
        sample_event_ids: sample,
      }, state));
    }
  }

  // --- 7) repeated_classification -------------------------------------------
  const shortOuts = events.filter(ev => {
    const r = (ev.response_redacted || '').trim();
    return r.length > 0 && r.length < 64 && !/[{[]/.test(r);
  });
  if (shortOuts.length >= Math.floor(minCallCount / 5)) {
    const labels = new Map();
    for (const e of shortOuts) {
      const k = (e.response_redacted || '').trim().toLowerCase();
      labels.set(k, (labels.get(k) || 0) + 1);
    }
    if (labels.size > 0 && labels.size <= 20) {
      const spend = shortOuts.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
      opps.push(_finalize({
        id: _oppId('classify', namespace + ':' + labels.size),
        type: 'repeated_classification',
        namespace,
        call_count: shortOuts.length,
        monthly_cost_usd: _round(spend * 30, 2),
        pattern: 'outputs fall into ' + labels.size + ' fixed labels',
        suggested_action: 'train_local_classifier',
        expected_replacement_rate: 0.92,
        estimated_savings_usd: _round(spend * 30 * 0.85, 2),
        risk: 'low',
        reason: shortOuts.length + ' outputs use a vocab of ' + labels.size + ' labels — distilbert-tier model will match',
        sample_event_ids: shortOuts.slice(0, 5).map(e => e.event_id),
      }, state));
    }
  }

  // --- 8) log_triage --------------------------------------------------------
  const logKey = /\b(error|stack|trace|stderr|exception|warning|fail|panic|segfault)\b/i;
  const logCalls = events.filter(ev => logKey.test(ev.prompt_redacted || ''));
  if (logCalls.length >= Math.floor(minCallCount / 5)) {
    const outLabels = new Set();
    for (const e of logCalls) {
      const r = (e.response_redacted || '').trim().slice(0, 64).toLowerCase();
      if (r) outLabels.add(r);
    }
    if (outLabels.size <= 12 && outLabels.size > 0) {
      const spend = logCalls.reduce((a, e) => a + (Number(e.estimated_cost_usd) || 0), 0);
      opps.push(_finalize({
        id: _oppId('logtriage', namespace),
        type: 'log_triage',
        namespace,
        call_count: logCalls.length,
        monthly_cost_usd: _round(spend * 30, 2),
        pattern: 'log/error prompts with ' + outLabels.size + ' category outputs',
        suggested_action: 'build_log_triage_classifier',
        expected_replacement_rate: 0.83,
        estimated_savings_usd: _round(spend * 30 * 0.78, 2),
        risk: 'low',
        reason: logCalls.length + ' log-prompts fall into ' + outLabels.size + ' categories',
        sample_event_ids: logCalls.slice(0, 5).map(e => e.event_id),
      }, state));
    }
  }

  // --- 9) routing_policy ----------------------------------------------------
  // Same template sig hitting multiple providers — pick the cheapest reliable one.
  for (const c of clusters) {
    if (c.providers.length < 2) continue;
    if (c.count < Math.floor(minCallCount / 5)) continue;
    opps.push(_finalize({
      id: _oppId('route', c.signature),
      type: 'routing_policy',
      namespace,
      call_count: c.count,
      monthly_cost_usd: _round((c.avg_cost || 0) * c.count * 30, 2),
      pattern: c.normalized.slice(0, 80),
      suggested_action: 'route_to_single_provider',
      expected_replacement_rate: 1.0,
      estimated_savings_usd: _round((c.avg_cost || 0) * c.count * 30 * 0.2, 2),
      risk: 'low',
      reason: c.count + ' calls of the same template went to ' + c.providers.join(' / ') + ' — pin to cheapest',
      sample_event_ids: c.sample_event_ids,
      providers: c.providers,
    }, state));
  }

  // --- 10) dataset_ready ----------------------------------------------------
  if (events.length >= 1000 && clusters.length > 0) {
    const topCluster = clusters[0];
    opps.push(_finalize({
      id: _oppId('datasetready', namespace),
      type: 'dataset_ready',
      namespace,
      call_count: events.length,
      monthly_cost_usd: 0,
      pattern: topCluster.normalized.slice(0, 80),
      suggested_action: 'create_dataset_from_namespace',
      expected_replacement_rate: 0.7,
      estimated_savings_usd: 0,
      risk: 'low',
      reason: events.length + ' events with ' + clusters.length + ' clusters — ready to curate into a dataset',
      sample_event_ids: topCluster.sample_event_ids,
    }, state));
  }

  // --- 11) training_ready ---------------------------------------------------
  // We need at least 1000 events AND a candidate holdout split (we just check
  // event_id mod hashes are not all in one bucket, which is essentially
  // always true given random IDs).
  if (events.length >= 1000) {
    const idHash = ev => parseInt(crypto.createHash('sha256').update(String(ev.event_id)).digest('hex').slice(0, 4), 16) % 100;
    const buckets = new Set(events.slice(0, 200).map(idHash));
    if (buckets.size > 5) { // we have id diversity
      opps.push(_finalize({
        id: _oppId('trainingready', namespace),
        type: 'training_ready',
        namespace,
        call_count: events.length,
        monthly_cost_usd: 0,
        pattern: 'namespace has 1000+ events with id-diverse split candidate',
        suggested_action: 'kolm dataset create + kolm pipeline-train',
        expected_replacement_rate: 0.7,
        estimated_savings_usd: 0,
        risk: 'low',
        reason: events.length + ' events; train/holdout split will be disjoint',
        sample_event_ids: events.slice(0, 5).map(e => e.event_id),
      }, state));
    }
  }

  // sort: privacy_leak first (high risk), then by savings desc.
  opps.sort((a, b) => {
    if (a.type === 'privacy_leak' && b.type !== 'privacy_leak') return -1;
    if (b.type === 'privacy_leak' && a.type !== 'privacy_leak') return 1;
    return (b.estimated_savings_usd || 0) - (a.estimated_savings_usd || 0);
  });
  return opps;
}

function _finalize(opp, state) {
  const meta = state.byId[opp.id] || null;
  if (meta) {
    opp.status = meta.status;
    opp.decided_at = meta.decided_at;
    opp.decision_reason = meta.reason || null;
  } else {
    opp.status = 'open';
  }
  // W409m — universal score envelope. Every opportunity carries the same
  // four signals so the UI / CLI / promote endpoint can sort/group without
  // having to special-case by type:
  //   - estimated_savings: USD/month savings the suggestion would unlock
  //   - volume:            call count in the lookback window
  //   - risk:              {low,medium,high} string + numeric weight
  //   - trainability:      0..1 — how viable a local-replacement adapter is.
  // The aggregate `score` is the product of normalized savings * volume *
  // (1-risk_weight) * trainability, scaled to a 0..100 readable range. It's
  // a relative ranker, not a cost forecast.
  const savings = Number(opp.estimated_savings_usd) || 0;
  const volume = Number(opp.call_count) || 0;
  const replacement = Number(opp.expected_replacement_rate) || 0;
  // Per-type baseline trainability — privacy_leak and dataset_ready are not
  // "trainable" in the local-replacement sense; they're routing / policy
  // hints. The remaining types map directly to their replacement rate.
  const baseTrainability = {
    cache_candidate: 0.95,
    cheaper_model_candidate: 0.80,
    local_replacement_candidate: replacement || 0.78,
    privacy_leak: 0.0,
    prompt_compression: 0.6,
    repeated_extraction: 0.9,
    repeated_classification: 0.92,
    log_triage: 0.83,
    routing_policy: 1.0,
    dataset_ready: 0.7,
    training_ready: 0.85,
  };
  opp.trainability = baseTrainability[opp.type] != null ? baseTrainability[opp.type] : 0.5;
  opp.volume = volume;
  opp.estimated_savings = savings;
  // Risk numeric weight: 0=low, 0.5=medium, 1=high.
  const riskWeight = opp.risk === 'high' ? 1 : opp.risk === 'medium' ? 0.5 : 0;
  // privacy_leak is treated as INFINITE business risk to ignore — we want it
  // to surface first, so we score it 100 outright. Other types get the
  // product of normalized signals scaled to 0..100.
  if (opp.type === 'privacy_leak') {
    opp.score = 100;
  } else {
    const normSav = Math.min(1, savings / 1000); // $1000/mo savings = 1.0
    const normVol = Math.min(1, volume / 1000);  // 1000 calls = 1.0
    opp.score = Math.round(
      normSav * 35 + normVol * 25 + (1 - riskWeight) * 15 + opp.trainability * 25,
    );
  }
  return opp;
}

// explainOpportunity(id): pull the persisted record + recompute current
// numbers from the live event stream so users see drift.
export async function explainOpportunity(id, opts = {}) {
  const all = await findOpportunities({ namespace: opts.namespace, since: opts.since, limit: opts.limit });
  const live = all.find(o => o.id === id);
  const state = _loadState();
  const persisted = state.byId[id] || null;
  return {
    id,
    live,
    persisted,
    found: !!live || !!persisted,
  };
}

// W419 — accept/ignore must verify the opportunity id belongs to the calling
// tenant before mutating shared state. Otherwise tenant B could accept/ignore
// tenant A's opportunities by guessing the id (the ids are deterministic per
// request_hash / model). When tenant_id is unset (local-only daemon mode) the
// check is skipped to preserve pre-W419 behavior.
async function _assertOppOwnership(id, tenant_id) {
  if (!tenant_id) return;
  const live = await findOpportunities({ tenant_id, limit: 10000 });
  const owned = live.some(o => o.id === id);
  if (!owned) {
    const err = new Error('opportunity_not_found_for_tenant: ' + id);
    err.code = 'OPPORTUNITY_NOT_FOUND';
    throw err;
  }
}

export async function acceptOpportunity(id, opts = {}) {
  await _assertOppOwnership(id, opts.tenant_id || opts.tenant || null);
  return _writeState(id, 'accepted', opts.reason || null);
}
export async function ignoreOpportunity(id, opts = {}) {
  await _assertOppOwnership(id, opts.tenant_id || opts.tenant || null);
  return _writeState(id, 'ignored', opts.reason || null);
}

// W409m — promoteOpportunity: turn an opportunity into a dataset.
//
// Looks up the live opportunity by id, resolves its namespace, and invokes
// the dataset-workbench createDataset() with from_opportunity provenance.
// Records the promotion (status='promoted', dataset_id) on the same state
// log so future findOpportunities() can show users which opportunities
// already shipped to a dataset.
//
// Imports dataset-workbench lazily to keep the opportunity-engine module a
// pure aggregator that does NOT pull dataset code on the read path (which
// keeps `kolm opportunities` / `kolm optimize list` snappy).
export async function promoteOpportunity(id, opts = {}) {
  if (!id) throw new Error('promoteOpportunity requires an opportunity id');
  // W419 — tenant_id (or alias) restricts the live lookup so a tenant cannot
  // promote another tenant's opportunity into their own dataset namespace.
  const tenant_id = opts.tenant_id || opts.tenant || null;
  // Find the live opportunity so we know its namespace + sample event ids.
  const live = await findOpportunities({
    namespace: opts.namespace,
    tenant_id,
    since: opts.since,
    limit: opts.limit == null ? 10000 : opts.limit,
  });
  const opp = live.find(o => o.id === id);
  if (!opp) {
    // The id might be a synthetic/persisted-only opportunity that no longer
    // shows up in the live recompute (events purged, window moved). We still
    // need a namespace to promote — fall back to a caller-supplied one.
    if (!opts.namespace) {
      const err = new Error('opportunity_not_found_and_no_namespace: ' + id);
      err.code = 'OPPORTUNITY_NOT_FOUND';
      throw err;
    }
  }
  const namespace = (opp && opp.namespace) || opts.namespace;
  if (!namespace) {
    const err = new Error('promoteOpportunity requires a resolvable namespace');
    err.code = 'NAMESPACE_REQUIRED';
    throw err;
  }
  // dataset-workbench.createDataset() reads
  //   state.byId[opts.fromOpportunity].sample_event_ids
  // to restrict the dataset to the events the opportunity actually flagged
  // (otherwise the dataset balloons to every event in the namespace). The
  // default `_writeState()` only persists {id, status, reason} so we have to
  // also stash the sample_event_ids before we hand off to createDataset.
  if (opp && Array.isArray(opp.sample_event_ids) && opp.sample_event_ids.length) {
    _writeStateExtra(id, { sample_event_ids: opp.sample_event_ids.slice() });
  }
  // Lazy import to avoid a cycle (dataset-workbench imports from this file).
  const { createDataset } = await import('./dataset-workbench.js');
  const ds = await createDataset(namespace, {
    fromOpportunity: id,
    train_ratio: opts.train_ratio != null ? opts.train_ratio : 0.8,
    approvedBy: opts.approvedBy || 'opportunity-promote',
    redactionPolicy: opts.redactionPolicy || 'redact',
    sourceType: opts.sourceType || 'real',
    limit: opts.limit,
  });
  // Persist a 'promoted' state row so the engine can render the badge later.
  _writeState(id, 'promoted', 'dataset:' + ds.dataset_id);
  return {
    opportunity_id: id,
    dataset_id: ds.dataset_id,
    namespace,
    train_count: ds.train_count,
    holdout_count: ds.holdout_count,
    source_event_ids: ds.source_event_ids,
    split_signature: ds.split_signature,
    version: ds.version,
    promoted_at: new Date().toISOString(),
  };
}

function _writeState(id, status, reason) {
  const file = _opportunitiesLog();
  const entry = { id, status, reason: reason || null, decided_at: new Date().toISOString() };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// W409m — _writeStateExtra: append a state row that carries additional
// fields (e.g. sample_event_ids) without setting status. The last-write-wins
// reducer in _loadState() will merge the extra keys into byId[id].
function _writeStateExtra(id, extra) {
  const file = _opportunitiesLog();
  const entry = { id, ...extra, recorded_at: new Date().toISOString() };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function _loadState() {
  const file = _opportunitiesLog();
  const byId = {};
  if (!fs.existsSync(file)) return { byId };
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.id) {
        // Merge instead of last-write-wins, so an extra-fields write
        // (_writeStateExtra with sample_event_ids) doesn't clobber a prior
        // status row, and so a later status row keeps prior sample_event_ids.
        byId[e.id] = { ...(byId[e.id] || {}), ...e };
      }
    } catch {}
  }
  return { byId };
}

export function loadOpportunitiesState() { return _loadState(); }
