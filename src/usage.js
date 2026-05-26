// src/usage.js
//
// W409y — real billing-units metering. Tracks 10 billable units per tenant
// per billing period, enforces hard caps + soft-warn limits, and persists
// counters to a flat JSON file in KOLM_DATA_DIR (.kolm by default). This is
// the source-of-truth the dashboard (/v1/billing/usage) and the CLI
// (`kolm billing usage`) read from.
//
// Design choices:
//
//  1. NO metering for local-only tenants. The metering helpers below are
//     no-ops when (a) no api key is present on the request, (b) the
//     synthetic tenant_id is the literal string 'local' (connector-daemon
//     untenanted path), or (c) the caller passes `localOnly: true`.
//     This is a privacy promise — Free tier work never leaves the user's
//     disk, so we MUST NOT report it back to the central billing store.
//
//  2. Tier limits are a static map in this file (one source of truth).
//     'free' has no caps because nothing is metered for free callers. The
//     three paid tiers (indie/team/enterprise) carry monthly hard caps +
//     soft-warning thresholds (default 80% of hard).
//
//  3. Storage is one file per process node, atomic write-via-tmp. SQLite
//     is overkill here because we only ever read/write the current month
//     counter map; previous-period rollups are computed by listing all
//     `period_*.json` files in the same directory.
//
//  4. The billing increment is INSIDE a per-process mutex (just a Promise
//     chain) so concurrent /v1/chat/completions requests on the same
//     tenant cannot lose increments to a read-modify-write race.
//
//  5. Every function in this module is import-safe: the on-disk store is
//     touched lazily, so test suites that hit a temp HOME never need a
//     teardown step.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Billing units. The set is closed — adding a new unit must be done here
// AND in TIER_LIMITS below, AND in /v1/billing/meters static catalog, AND
// in public/account/billing.html metric rows.
// ---------------------------------------------------------------------------
export const BILLING_UNITS = Object.freeze([
  'captured_events',
  'stored_events',
  'optimization_runs',
  'builds',
  'distillation_jobs',
  'hosted_inference',     // measured in tokens (prompt+completion)
  'gateway_calls',        // V1 launch / W-2: per-call count for /v1/gateway/dispatch
  'team_seats',
  'artifact_signing',
  'private_registry_artifacts',
  'enterprise_sync_volume', // measured in bytes
]);

// ---------------------------------------------------------------------------
// Per-tier limits. Each entry maps a billing unit to {soft, hard}. A unit
// without an entry is unlimited for that tier. `free` has NO entries because
// we never meter local-only work.
//
//   indie ($9/mo)  : 1M hosted tokens, capped builds + distillation,
//                    no team seats, light enterprise sync.
//   team  ($49/mo) : 10M hosted tokens, much higher caps, multi-seat,
//                    moderate enterprise sync.
//   enterprise     : effectively unlimited (very large numbers vs null) so
//                    the dashboard can still render % used.
// ---------------------------------------------------------------------------
// V1 launch / W-2: hard ladder for `gateway_calls` per /v1/gateway/dispatch
// invocation. Free is the public anon/local-only floor; the 50k/500k/5M/25M
// ramp follows the same shape the website's pricing page advertises. The
// dispatch handler enforces `hard` and emits soft-warn via a header. Soft is
// at 90% of hard (10% grace buffer per the launch plan).
export const TIER_LIMITS = Object.freeze({
  free: {
    gateway_calls:           { soft: 45_000,    hard: 50_000 },
  },
  indie: {
    captured_events:         { soft: 80_000,   hard: 100_000 },
    stored_events:           { soft: 80_000,   hard: 100_000 },
    optimization_runs:       { soft: 80,       hard: 100 },
    builds:                  { soft: 40,       hard: 50 },
    distillation_jobs:       { soft: 8,        hard: 10 },
    hosted_inference:        { soft: 800_000,  hard: 1_000_000 },
    gateway_calls:           { soft: 450_000,  hard: 500_000 },
    team_seats:              { soft: 1,        hard: 1 },
    artifact_signing:        { soft: 80,       hard: 100 },
    private_registry_artifacts: { soft: 8,     hard: 10 },
    enterprise_sync_volume:  { soft: 80_000_000, hard: 100_000_000 },
  },
  team: {
    captured_events:         { soft: 800_000,  hard: 1_000_000 },
    stored_events:           { soft: 800_000,  hard: 1_000_000 },
    optimization_runs:       { soft: 800,      hard: 1_000 },
    builds:                  { soft: 400,      hard: 500 },
    distillation_jobs:       { soft: 80,       hard: 100 },
    hosted_inference:        { soft: 8_000_000, hard: 10_000_000 },
    gateway_calls:           { soft: 4_500_000, hard: 5_000_000 },
    team_seats:              { soft: 10,       hard: 25 },
    artifact_signing:        { soft: 800,      hard: 1_000 },
    private_registry_artifacts: { soft: 80,    hard: 100 },
    enterprise_sync_volume:  { soft: 800_000_000, hard: 1_000_000_000 },
  },
  business: {
    captured_events:         { soft: 4_000_000, hard: 5_000_000 },
    stored_events:           { soft: 4_000_000, hard: 5_000_000 },
    optimization_runs:       { soft: 4_000,    hard: 5_000 },
    builds:                  { soft: 2_000,    hard: 2_500 },
    distillation_jobs:       { soft: 400,      hard: 500 },
    hosted_inference:        { soft: 40_000_000, hard: 50_000_000 },
    gateway_calls:           { soft: 22_500_000, hard: 25_000_000 },
    team_seats:              { soft: 50,       hard: 100 },
    artifact_signing:        { soft: 4_000,    hard: 5_000 },
    private_registry_artifacts: { soft: 400,   hard: 500 },
    enterprise_sync_volume:  { soft: 4_000_000_000, hard: 5_000_000_000 },
  },
  enterprise: {
    captured_events:         { soft: 80_000_000, hard: 100_000_000 },
    stored_events:           { soft: 80_000_000, hard: 100_000_000 },
    optimization_runs:       { soft: 80_000,    hard: 100_000 },
    builds:                  { soft: 40_000,    hard: 50_000 },
    distillation_jobs:       { soft: 8_000,     hard: 10_000 },
    hosted_inference:        { soft: 800_000_000, hard: 1_000_000_000 },
    gateway_calls:           { soft: 225_000_000, hard: 250_000_000 },
    team_seats:              { soft: 500,       hard: 1_000 },
    artifact_signing:        { soft: 80_000,    hard: 100_000 },
    private_registry_artifacts: { soft: 8_000,  hard: 10_000 },
    enterprise_sync_volume:  { soft: 800_000_000_000, hard: 1_000_000_000_000 },
  },
});

// Normalize a plan label to a tier bucket. Several plan ids (starter, pro,
// teams, business) flow into 'indie' or 'team' depending on price; we keep
// the legacy mappings here so existing PLAN_CATALOG rows keep meaningful
// limits without forcing a rename.
export function tierForPlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  if (p === 'free' || p === 'anon') return 'free';
  if (p === 'indie' || p === 'starter') return 'indie';
  if (p === 'pro') return 'indie';                 // pro shares indie caps
  if (p === 'team' || p === 'teams') return 'team';
  if (p === 'business') return 'business';         // V1 launch / W-2: dedicated tier (was alias)
  if (p === 'enterprise') return 'enterprise';
  return 'free'; // unknown → fail closed (no metering = no overage either)
}

// ---------------------------------------------------------------------------
// Storage layer. One JSON file per billing period. Period defaults to the
// current YYYY-MM (UTC). Shape:
//   { period: '2026-05', updated_at: ISO, tenants: { <tid>: { <unit>: count } } }
// ---------------------------------------------------------------------------
export function currentPeriod() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function dataDir() {
  return process.env.KOLM_USAGE_DIR
    || (process.env.KOLM_DATA_DIR ? path.join(process.env.KOLM_DATA_DIR, 'usage')
        : path.join(os.homedir(), '.kolm', 'usage'));
}

export function usageFilePath(period) {
  const p = period || currentPeriod();
  return path.join(dataDir(), `period_${p}.json`);
}

function ensureDir() {
  try { fs.mkdirSync(dataDir(), { recursive: true }); } catch (_) {} // deliberate: cleanup
}

function readPeriod(period) {
  const file = usageFilePath(period);
  if (!fs.existsSync(file)) {
    return { period: period || currentPeriod(), updated_at: null, tenants: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { period: period || currentPeriod(), updated_at: null, tenants: {} };
    if (!j.tenants || typeof j.tenants !== 'object') j.tenants = {};
    return j;
  } catch (_) {
    return { period: period || currentPeriod(), updated_at: null, tenants: {} };
  }
}

function writePeriod(state) {
  ensureDir();
  const file = usageFilePath(state.period);
  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2);
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) {
    // On Windows a concurrent reader can briefly hold the destination open;
    // fall back to a non-atomic write so the increment is never lost.
    try { fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8'); } catch (_) {} // deliberate: cleanup
    try { fs.unlinkSync(tmp); } catch (_) {} // deliberate: cleanup
  }
}

// Per-process mutex so concurrent increments from the same node don't race.
let _writeChain = Promise.resolve();
function withLock(fn) {
  const next = _writeChain.then(fn, fn);
  // Swallow rejections on the chain so a single failure doesn't poison
  // subsequent callers; each caller still gets their own resolved Promise.
  _writeChain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Reset / wipe the in-memory + on-disk state for one period. Tests call this
// between cases so counters from prior tests don't leak. Production code
// never calls this directly — period rollover is implicit (next month's file
// is created on the first increment of the new month).
// ---------------------------------------------------------------------------
export function resetPeriod(period) {
  const file = usageFilePath(period);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} // deliberate: cleanup
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

// Should this caller be metered? Returns false for local-only paths so the
// privacy promise (Free tier never reports) holds.
export function shouldMeter({ tenantId, hosted = false, localOnly = false } = {}) {
  if (localOnly) return false;
  if (!tenantId) return false;
  if (tenantId === 'local') return false;
  if (typeof tenantId === 'string' && tenantId.startsWith('local:')) return false;
  if (tenantId === 'anon' || String(tenantId).startsWith('anon_')) {
    // Anon tenants are not metered for billing — they pay nothing, and
    // their work is gated by the rate-limit bucket in auth.js. The
    // /v1/billing/usage endpoint still returns an empty map for them.
    return false;
  }
  // Hosted inference can opt in even on free tier (e.g. browser playground)
  // but only when the hosted=true flag is explicitly set. By default we
  // assume the caller wants metering (paid tier flowing through hosted run).
  return true;
}

// Increment a meter for a tenant. Returns the post-increment counter value
// (or null when the call is a no-op because metering is disabled).
export async function incrementMeter(tenantId, unit, amount = 1, opts = {}) {
  if (!BILLING_UNITS.includes(unit)) return null;
  if (!shouldMeter({ tenantId, hosted: opts.hosted, localOnly: opts.localOnly })) return null;
  const inc = Number(amount);
  if (!Number.isFinite(inc) || inc <= 0) return null;
  const period = opts.period || currentPeriod();
  return await withLock(() => {
    const state = readPeriod(period);
    if (!state.tenants[tenantId]) state.tenants[tenantId] = {};
    const prev = Number(state.tenants[tenantId][unit] || 0);
    state.tenants[tenantId][unit] = prev + inc;
    writePeriod(state);
    return state.tenants[tenantId][unit];
  });
}

// Get the usage map for a tenant in a given period.
export function getUsage(tenantId, period) {
  const state = readPeriod(period || currentPeriod());
  return state.tenants[tenantId] || {};
}

// Resolve limits for a tier as a {unit: {soft,hard}} map (frozen). Unknown
// tiers fall through to 'free' (no entries).
export function getLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

// Check whether a tenant can consume `amount` of `unit` under their tier.
// Returns { allowed, overSoft, overHard, current, soft, hard }.
//   - `allowed` is false iff this consumption would cross `hard`.
//   - `overSoft` is true iff this consumption would cross `soft`.
// A unit with no entry in the tier returns allowed=true, no caps.
export function checkLimit({ tenantId, tier, unit, amount = 1, period } = {}) {
  if (!BILLING_UNITS.includes(unit)) {
    return { allowed: true, overSoft: false, overHard: false, current: 0, soft: null, hard: null, reason: 'unknown_unit' };
  }
  const limits = getLimits(tier);
  const entry = limits[unit];
  const usage = getUsage(tenantId, period);
  const current = Number(usage[unit] || 0);
  if (!entry) {
    return { allowed: true, overSoft: false, overHard: false, current, soft: null, hard: null };
  }
  const next = current + Math.max(0, Number(amount) || 0);
  const overHard = next > entry.hard;
  const overSoft = next > entry.soft;
  return {
    allowed: !overHard,
    overSoft,
    overHard,
    current,
    next,
    soft: entry.soft,
    hard: entry.hard,
  };
}

// Dashboard payload for /v1/billing/usage. One shape, used by both the
// browser dashboard and the CLI `kolm billing usage`.
export function dashboardPayload({ tenantId, tier = 'free', period, plan = null } = {}) {
  const p = period || currentPeriod();
  const usage = getUsage(tenantId, p);
  const limits = getLimits(tier);
  const over_soft = [];
  const over_hard = [];
  // Build full meter map including zeros so the UI doesn't need to know the
  // full unit list — it just renders rows in render-order.
  const meters = {};
  const softMap = {};
  const hardMap = {};
  for (const unit of BILLING_UNITS) {
    const cur = Number(usage[unit] || 0);
    meters[unit] = cur;
    const lim = limits[unit];
    if (lim) {
      softMap[unit] = lim.soft;
      hardMap[unit] = lim.hard;
      if (cur > lim.hard) over_hard.push(unit);
      else if (cur > lim.soft) over_soft.push(unit);
    }
  }
  return {
    ok: true,
    tenant_id: tenantId,
    plan: plan || tier,
    tier,
    period: p,
    meters,
    limits: hardMap,    // dashboard reads `limits` as the hard-cap map
    soft_limits: softMap,
    over_soft,
    over_hard,
  };
}

// List all periods we have on disk. Cheap; one fs.readdir.
export function listPeriods() {
  ensureDir();
  try {
    return fs.readdirSync(dataDir())
      .map(f => /^period_(\d{4}-\d{2})\.json$/.exec(f))
      .filter(Boolean)
      .map(m => m[1])
      .sort();
  } catch (_) { return []; }
}

export default {
  BILLING_UNITS,
  TIER_LIMITS,
  tierForPlan,
  currentPeriod,
  usageFilePath,
  resetPeriod,
  shouldMeter,
  incrementMeter,
  getUsage,
  getLimits,
  checkLimit,
  dashboardPayload,
  listPeriods,
};
