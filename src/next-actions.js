// W910 Track C2 - Proactive next-actions engine.
//
// Given a tenant, compute a ranked list of action cards for the
// /account/overview dashboard. Each card carries enough metadata for a CTA
// button + a dismiss link that snoozes the card for 14 days. The shape is
// intentionally narrow: the UI does not branch on action type, it just
// renders {type, priority, title, body, cta_label, cta_href, dismiss_key}.
//
// Seven types, impact-ranked (1 = highest):
//   1. readiness   - namespace threshold met; suggest compile
//   2. drift       - K-Score regression vs deployed
//   3. stale       - artifact > 90d old, 200+ captures since last compile
//   4. idle        - no captures in N days
//   5. cost        - spend trending high vs forecast
//   6. security    - missing PII redaction on sensitive captures
//   7. fallbacks   - fallback rate > threshold
//
// Snooze: dismiss writes a row to the snoozes table; compute() filters
// out keys still under their `until_ts`. Dismissal is per (tenant, key)
// so the same key in a different tenant is independent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { find, findOne, insert, update } from './store.js';

const SNOOZE_TABLE = 'next_action_snoozes';
const DEFAULT_SNOOZE_DAYS = 14;

// Thresholds tuned for the launch-month UX. Keep these constants so tests
// can mirror them without re-importing magic numbers.
export const READINESS_MIN_CAPTURES = 100;
export const DRIFT_KSCORE_DROP = 0.03;          // 3 absolute K-score points
export const STALE_ARTIFACT_DAYS = 90;
export const STALE_CAPTURE_DELTA = 200;
export const IDLE_NO_CAPTURE_DAYS = 14;
export const COST_BURN_RATIO = 1.25;            // actual / forecast > 1.25
export const FALLBACK_RATE_THRESHOLD = 0.10;    // 10% fallbacks

export const ACTION_PRIORITIES = {
  readiness: 1,
  drift: 2,
  stale: 3,
  idle: 4,
  cost: 5,
  security: 6,
  fallbacks: 7,
};

function nowMs() { return Date.now(); }

// Read snooze rows once per compute() and use a Set lookup.
function activeSnoozes(tenant) {
  const now = nowMs();
  const all = find(SNOOZE_TABLE, (r) => r && r.tenant === tenant);
  const live = new Set();
  for (const row of all) {
    if (!row || !row.dismiss_key) continue;
    const until = typeof row.until_ts === 'number' ? row.until_ts : Date.parse(row.until_ts || '');
    if (Number.isFinite(until) && until > now) live.add(row.dismiss_key);
  }
  return live;
}

export function snooze(tenant, dismissKey, days = DEFAULT_SNOOZE_DAYS) {
  if (!tenant) throw new Error('tenant required');
  if (!dismissKey) throw new Error('dismiss_key required');
  const until = nowMs() + Math.max(1, Math.min(365, Number(days) || DEFAULT_SNOOZE_DAYS)) * 86400_000;
  const existing = findOne(SNOOZE_TABLE, (r) => r && r.tenant === tenant && r.dismiss_key === dismissKey);
  const row = {
    tenant,
    dismiss_key: String(dismissKey),
    until_ts: until,
    snoozed_at: new Date().toISOString(),
  };
  if (existing) {
    update(SNOOZE_TABLE, (r) => r && r.tenant === tenant && r.dismiss_key === dismissKey, row);
  } else {
    insert(SNOOZE_TABLE, row);
  }
  // W910 - also mirror to data/snoozes.jsonl per spec, append-only log so
  // an operator can replay snoozes if the DB is reset.
  try { appendSnoozeJsonl(row); } catch { /* best-effort */ }
  return row;
}

function snoozesJsonlPath() {
  const base = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/data' : path.resolve('data'));
  try {
    fs.mkdirSync(base, { recursive: true });
    const probe = path.join(base, '.kolm-next-actions-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return path.join(base, 'snoozes.jsonl');
  } catch {
    // Fallback to tmp dir (matches store.js behavior).
    const fallback = path.join(os.tmpdir(), 'kolm-data');
    fs.mkdirSync(fallback, { recursive: true });
    return path.join(fallback, 'snoozes.jsonl');
  }
}

function appendSnoozeJsonl(row) {
  const p = snoozesJsonlPath();
  fs.appendFileSync(p, JSON.stringify(row) + '\n');
}

// =====================================================================
// Action builders. Each returns either null (no action) or an action
// card. Keep them pure-ish - they accept a snapshot object so the
// caller (and tests) can stub state without monkey-patching the store.
// =====================================================================

function buildReadiness(snapshot) {
  const out = [];
  for (const ns of snapshot.namespaces || []) {
    const captures = Number(ns.captures || 0);
    if (captures < READINESS_MIN_CAPTURES) continue;
    if (ns.last_compiled_at && (nowMs() - Date.parse(ns.last_compiled_at)) < STALE_ARTIFACT_DAYS * 86400_000 && captures - (ns.captures_at_last_compile || 0) < STALE_CAPTURE_DELTA) {
      continue; // recently compiled and not much new data
    }
    out.push({
      type: 'readiness',
      priority: ACTION_PRIORITIES.readiness,
      title: `${ns.namespace} is ready to compile`,
      body: `${captures.toLocaleString()} captures in namespace ${ns.namespace}. You have enough data to distill a specialist.`,
      cta_label: 'Compile',
      cta_href: `/account/create-model?namespace=${encodeURIComponent(ns.namespace)}`,
      params: { namespace: ns.namespace, captures },
      dismiss_key: `readiness:${ns.namespace}`,
    });
  }
  return out;
}

function buildDrift(snapshot) {
  const out = [];
  for (const a of snapshot.artifacts || []) {
    const deployed = Number(a.deployed_kscore || 0);
    const current = Number(a.current_kscore || 0);
    if (deployed <= 0 || current <= 0) continue;
    const drop = deployed - current;
    if (drop < DRIFT_KSCORE_DROP) continue;
    out.push({
      type: 'drift',
      priority: ACTION_PRIORITIES.drift,
      title: `${a.artifact_id} K-Score dropped ${drop.toFixed(2)}`,
      body: `Deployed ${deployed.toFixed(2)} -> current ${current.toFixed(2)}. Recompile against fresh captures to recover.`,
      cta_label: 'Recompile',
      cta_href: `/account/create-model?artifact=${encodeURIComponent(a.artifact_id)}`,
      params: { artifact_id: a.artifact_id, deployed, current, drop },
      dismiss_key: `drift:${a.artifact_id}`,
    });
  }
  return out;
}

function buildStale(snapshot) {
  const out = [];
  const nowTs = nowMs();
  for (const a of snapshot.artifacts || []) {
    if (!a.compiled_at) continue;
    const ageDays = (nowTs - Date.parse(a.compiled_at)) / 86400_000;
    if (ageDays < STALE_ARTIFACT_DAYS) continue;
    const newCaptures = Number(a.captures_since_compile || 0);
    if (newCaptures < STALE_CAPTURE_DELTA) continue;
    out.push({
      type: 'stale',
      priority: ACTION_PRIORITIES.stale,
      title: `${a.artifact_id} is ${Math.floor(ageDays)} days old`,
      body: `${newCaptures.toLocaleString()} new captures since last compile. Refresh the artifact to keep behavior current.`,
      cta_label: 'Recompile',
      cta_href: `/account/create-model?artifact=${encodeURIComponent(a.artifact_id)}`,
      params: { artifact_id: a.artifact_id, age_days: Math.floor(ageDays), new_captures: newCaptures },
      dismiss_key: `stale:${a.artifact_id}`,
    });
  }
  return out;
}

function buildIdle(snapshot) {
  const out = [];
  if (!snapshot.last_capture_at) {
    // Brand-new tenant - skip; the empty-state already nudges them.
    return out;
  }
  const days = (nowMs() - Date.parse(snapshot.last_capture_at)) / 86400_000;
  if (days < IDLE_NO_CAPTURE_DAYS) return out;
  out.push({
    type: 'idle',
    priority: ACTION_PRIORITIES.idle,
    title: `No captures in ${Math.floor(days)} days`,
    body: `Your last capture was ${Math.floor(days)} days ago. If your traffic shifted, point your SDK at the capture proxy to keep distilling.`,
    cta_label: 'Open connectors',
    cta_href: '/account/connectors',
    params: { days: Math.floor(days) },
    dismiss_key: 'idle:global',
  });
  return out;
}

function buildCost(snapshot) {
  const out = [];
  const actual = Number(snapshot.spend_30d_usd || 0);
  const forecast = Number(snapshot.spend_forecast_usd || 0);
  if (forecast <= 0 || actual <= 0) return out;
  const ratio = actual / forecast;
  if (ratio < COST_BURN_RATIO) return out;
  out.push({
    type: 'cost',
    priority: ACTION_PRIORITIES.cost,
    title: `Spend trending ${Math.round((ratio - 1) * 100)}% over forecast`,
    body: `$${actual.toFixed(2)} this period vs $${forecast.toFixed(2)} forecast. Review routing weights or move repeated workflows to a specialist.`,
    cta_label: 'Open opportunities',
    cta_href: '/account/opportunities',
    params: { actual, forecast, ratio },
    dismiss_key: 'cost:burn',
  });
  return out;
}

function buildSecurity(snapshot) {
  const out = [];
  const flagged = Number(snapshot.unredacted_pii_captures || 0);
  if (flagged <= 0) return out;
  out.push({
    type: 'security',
    priority: ACTION_PRIORITIES.security,
    title: `${flagged.toLocaleString()} captures detected sensitive content without redaction`,
    body: `Turn on the PII membrane so future captures land redacted. The flagged captures stay quarantined until you review them.`,
    cta_label: 'Review privacy events',
    cta_href: '/account/privacy-events',
    params: { flagged },
    dismiss_key: 'security:pii',
  });
  return out;
}

function buildFallbacks(snapshot) {
  const out = [];
  for (const ns of snapshot.namespaces || []) {
    const total = Number(ns.routed_calls || 0);
    const fallbacks = Number(ns.fallbacks || 0);
    if (total < 50) continue; // not enough signal
    const rate = fallbacks / total;
    if (rate < FALLBACK_RATE_THRESHOLD) continue;
    out.push({
      type: 'fallbacks',
      priority: ACTION_PRIORITIES.fallbacks,
      title: `${(rate * 100).toFixed(1)}% fallback rate in ${ns.namespace}`,
      body: `${fallbacks} of ${total} calls fell back to the frontier teacher. Lower the gate, retrain, or widen the specialist's scope.`,
      cta_label: 'Inspect drift',
      cta_href: `/account/drift?namespace=${encodeURIComponent(ns.namespace)}`,
      params: { namespace: ns.namespace, rate, total, fallbacks },
      dismiss_key: `fallbacks:${ns.namespace}`,
    });
  }
  return out;
}

const BUILDERS = [buildReadiness, buildDrift, buildStale, buildIdle, buildCost, buildSecurity, buildFallbacks];

// Default snapshot loader. Pulls from the same tables the rest of the
// router uses. Kept resilient - any read miss returns an empty default
// so the engine never throws on a fresh-signup tenant.
function loadSnapshot(tenant) {
  const namespaces = [];
  const artifacts = [];
  let lastCaptureAt = null;
  let spend30d = 0;
  let spendForecast = 0;
  let unredacted = 0;

  try {
    const nsRows = find('namespaces', (r) => r && r.tenant === tenant);
    for (const ns of nsRows) namespaces.push({
      namespace: ns.namespace,
      captures: ns.captures || 0,
      routed_calls: ns.routed_calls || 0,
      fallbacks: ns.fallbacks || 0,
      last_compiled_at: ns.last_compiled_at || null,
      captures_at_last_compile: ns.captures_at_last_compile || 0,
    });
  } catch { /* table missing */ }

  try {
    const artRows = find('specialists', (r) => r && r.tenant === tenant);
    for (const a of artRows) artifacts.push({
      artifact_id: a.artifact_id || a.id,
      deployed_kscore: a.deployed_kscore || a.kscore || 0,
      current_kscore: a.current_kscore || a.kscore || 0,
      compiled_at: a.compiled_at || a.created_at || null,
      captures_since_compile: a.captures_since_compile || 0,
    });
  } catch { /* table missing */ }

  try {
    const acct = findOne('tenants', (r) => r && r.tenant === tenant) || {};
    lastCaptureAt = acct.last_capture_at || null;
    spend30d = Number(acct.spend_30d_usd || 0);
    spendForecast = Number(acct.spend_forecast_usd || 0);
    unredacted = Number(acct.unredacted_pii_captures || 0);
  } catch { /* table missing */ }

  return { namespaces, artifacts, last_capture_at: lastCaptureAt, spend_30d_usd: spend30d, spend_forecast_usd: spendForecast, unredacted_pii_captures: unredacted };
}

// =====================================================================
// Public API
// =====================================================================

export function compute(tenant, opts = {}) {
  if (!tenant) throw new Error('tenant required');
  const snapshot = opts.snapshot || loadSnapshot(tenant);
  const snoozes = activeSnoozes(tenant);
  const actions = [];
  for (const build of BUILDERS) {
    for (const a of build(snapshot)) {
      if (snoozes.has(a.dismiss_key)) continue;
      actions.push(a);
    }
  }
  // Stable ordering: priority asc, then alphabetical title.
  actions.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 5)));
  return actions.slice(0, limit);
}

export function _BUILDERS() { return BUILDERS.slice(); }
export function _snoozesJsonlPath() { return snoozesJsonlPath(); }
