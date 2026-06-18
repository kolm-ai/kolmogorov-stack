// src/marketplace-payouts.js
//
// W825-6 - Revenue share for the W825 Artifact Marketplace MVP.
//
// W737 already shipped computeRoyalty() in src/marketplace.js with the same
// 70/30 split - this module is the W825 MVP cron-stub variant that aggregates
// ledger rows out of the event-store and emits an audit row per publisher
// payout cycle. The math is identical (publisher 70 / platform 30) so the
// public contract pinned in /docs/marketplace/publish.html stays consistent.
//
// NO REAL STRIPE PAYOUT IS WIRED. payoutCycle() is honestly labelled as a
// FORECAST surface (W825 brief: "surface as forecast"). The audit row
// includes `dispatched: false` so a CI gate can confirm no real money moved.
//
// Hard-coded split - never read from runtime config.
export const PUBLISHER_SHARE = 0.70;
export const PLATFORM_SHARE  = 0.30;
export const MARKETPLACE_PAYOUTS_VERSION = 'w825-payouts-v1';
export const MARKETPLACE_PAYOUTS_CONTRACT_VERSION = 'w708-v1';
export const MARKETPLACE_REVENUE_PROVIDER = 'kolm_marketplace_revenue';
export const MARKETPLACE_REVENUE_NAMESPACE = 'kolm_marketplace';
export const MARKETPLACE_PAYOUTS_LIMITS = Object.freeze({
  MAX_ID_CHARS: 128,
  MAX_FEEDBACK_CHARS: 2048,
  MAX_EVENTS_PER_CYCLE: 50_000,
  MAX_AUDIT_LOOKBACK: 5_000,
  MAX_REVENUE_MICRO_USD: 9_000_000_000_000_000,
});

import { listEvents, appendEvent } from './event-store.js';
import { listAuditEvents, tryAppendAudit } from './audit.js';
import crypto from 'node:crypto';

// W825-6 - extend AUDIT_OPS in-place. audit.js declares AUDIT_OPS as a
// Object.freeze() but we cannot mutate it; the audit.js layer accepts ANY
// string op via tryAppendAudit so we just thread a stable string. Exporting
// a constant here keeps the op grep-able alongside the W825 module set.
export const AUDIT_OPS = Object.freeze({
  MARKETPLACE_PAYOUT: 'marketplace.payout',
});

// calcPayout(listing, total_revenue_micro_usd): pure accounting.
// Returns {publisher_micro_usd, platform_micro_usd, listing_id, period?}.
//
// Honest rounding: publisher gets floor(0.70 * total); platform gets the
// remainder so publisher+platform == total exactly (no rounding leak).
export function calcPayout(listing, total_revenue_micro_usd) {
  const revenue = normalizeMicroUsd(total_revenue_micro_usd, { allowZero: true, clamp: true });
  const publisher_micro_usd = Math.floor(revenue * PUBLISHER_SHARE);
  const platform_micro_usd = revenue - publisher_micro_usd;
  const listing_id = normalizeId(listing && listing.id, 'listing_id', { allowNull: true });
  const publisher_tenant_id = normalizeId(listing && listing.publisher_tenant_id, 'publisher_tenant_id', { allowNull: true });
  return {
    listing_id,
    publisher_tenant_id,
    revenue_micro_usd: revenue,
    publisher_micro_usd,
    platform_micro_usd,
    split: { publisher: PUBLISHER_SHARE, platform: PLATFORM_SHARE },
    version: MARKETPLACE_PAYOUTS_VERSION,
    contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
  };
}

// payoutCycle(period): reads ledger entries from the event store (provider=
// 'kolm_marketplace_revenue') for the given YYYY-MM period, aggregates per
// publisher, and emits a per-listing payout forecast row to the audit log.
//
// NO Stripe call. NO real money movement. Return shape:
//   {ok:true, period, dispatched:false, rows:[{listing_id, ...calcPayout()}]}
//
// The audit row carries op='marketplace.payout' so external SIEMs can latch
// onto every cycle for compliance.
export async function payoutCycle(period) {
  const periodStr = normalizePeriod(period);
  if (!periodStr.ok) {
    return {
      ok: false,
      error: 'invalid_period',
      period: null,
      dispatched: false,
      rows: [],
      detail: periodStr.error,
      version: MARKETPLACE_PAYOUTS_VERSION,
      contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
    };
  }
  // listEvents is async-safe - call site awaits.
  const rows = await listEvents({
    provider: MARKETPLACE_REVENUE_PROVIDER,
    limit: MARKETPLACE_PAYOUTS_LIMITS.MAX_EVENTS_PER_CYCLE,
    order: 'asc',
  });
  if (rows.length >= MARKETPLACE_PAYOUTS_LIMITS.MAX_EVENTS_PER_CYCLE) {
    return {
      ok: false,
      error: 'payout_event_scan_limit_exceeded',
      period: periodStr.value,
      dispatched: false,
      rows: [],
      max_events: MARKETPLACE_PAYOUTS_LIMITS.MAX_EVENTS_PER_CYCLE,
      version: MARKETPLACE_PAYOUTS_VERSION,
      contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
    };
  }
  // Aggregate revenue per listing_id. The event-schema canonicalizer only
  // preserves named columns, so we encoded {listing_id, micro_usd} into the
  // `feedback` field as JSON (same pattern W737 uses for review payloads).
  const byListing = new Map();
  const skipped = {
    malformed_feedback: 0,
    integrity_mismatch: 0,
    period_mismatch: 0,
    publisher_conflict: 0,
    amount_overflow: 0,
  };
  for (const ev of rows) {
    const parsed = parseRevenueEvent(ev);
    if (!parsed.ok) {
      if (parsed.error === 'integrity_mismatch') skipped.integrity_mismatch += 1;
      else skipped.malformed_feedback += 1;
      continue;
    }
    const payload = parsed.payload;
    // Filter by period (YYYY-MM).
    const at = ev.created_at || '';
    if (periodStr.value && periodStr.value !== '*' && !String(at).startsWith(periodStr.value)) {
      skipped.period_mismatch += 1;
      continue;
    }
    const sum = byListing.get(payload.listing_id) || {
      listing_id: payload.listing_id,
      publisher_tenant_id: payload.publisher_tenant_id || null,
      revenue_micro_usd: 0,
      revenue_event_hashes: [],
      publisher_conflict: false,
    };
    if (sum.publisher_tenant_id !== (payload.publisher_tenant_id || null)) {
      sum.publisher_conflict = true;
      skipped.publisher_conflict += 1;
      byListing.set(payload.listing_id, sum);
      continue;
    }
    const nextRevenue = sum.revenue_micro_usd + payload.micro_usd;
    if (!Number.isSafeInteger(nextRevenue) || nextRevenue > MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD) {
      skipped.amount_overflow += 1;
      continue;
    }
    sum.revenue_micro_usd = nextRevenue;
    sum.revenue_event_hashes.push(payload.revenue_body_sha256 || hashPayload(payload));
    byListing.set(payload.listing_id, sum);
  }
  const payouts = [];
  for (const row of [...byListing.values()].sort((a, b) => String(a.listing_id).localeCompare(String(b.listing_id)))) {
    if (row.publisher_conflict) continue;
    const split = calcPayout(
      { id: row.listing_id, publisher_tenant_id: row.publisher_tenant_id },
      row.revenue_micro_usd,
    );
    split.period = periodStr.value;
    split.dispatched = false;
    split.revenue_event_count = row.revenue_event_hashes.length;
    split.revenue_event_digest = hashPayload(row.revenue_event_hashes);
    split.payout_id = hashPayload({
      period: split.period,
      listing_id: split.listing_id,
      publisher_tenant_id: split.publisher_tenant_id,
      revenue_micro_usd: split.revenue_micro_usd,
      publisher_micro_usd: split.publisher_micro_usd,
      platform_micro_usd: split.platform_micro_usd,
      split: split.split,
      revenue_event_digest: split.revenue_event_digest,
      version: MARKETPLACE_PAYOUTS_VERSION,
    });
    payouts.push(split);
  }
  const cycleDigest = hashPayload(payouts.map((row) => row.payout_id));
  let auditRowsAppended = 0;
  let auditRowsExisting = 0;
  for (const split of payouts) {
    // Emit one audit row per listing payout so the chain can be replayed.
    const tenantId = split.publisher_tenant_id || 'platform';
    if (payoutAuditExists(tenantId, split.payout_id)) {
      auditRowsExisting += 1;
      continue;
    }
    const auditRow = await tryAppendAudit({
      tenant_id: tenantId,
      op: AUDIT_OPS.MARKETPLACE_PAYOUT,
      actor: 'kolm.platform.marketplace.payout-cycle',
      request_id: split.payout_id,
      payload: {
        payout_id: split.payout_id,
        period: split.period,
        listing_id: split.listing_id,
        publisher_tenant_id: split.publisher_tenant_id,
        revenue_micro_usd: split.revenue_micro_usd,
        publisher_micro_usd: split.publisher_micro_usd,
        platform_micro_usd: split.platform_micro_usd,
        publisher_share: PUBLISHER_SHARE,
        platform_share: PLATFORM_SHARE,
        revenue_event_digest: split.revenue_event_digest,
        revenue_event_count: split.revenue_event_count,
        dispatched: false, // W825 brief: NO real Stripe write
        version: MARKETPLACE_PAYOUTS_VERSION,
        contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
      },
    });
    if (!auditRow) {
      return {
        ok: false,
        error: 'audit_write_failed',
        period: periodStr.value,
        dispatched: false,
        rows: [],
        failed_payout_id: split.payout_id,
        version: MARKETPLACE_PAYOUTS_VERSION,
        contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
      };
    }
    auditRowsAppended += 1;
  }
  return {
    ok: true,
    period: periodStr.value,
    dispatched: false,
    rows: payouts,
    listing_count: payouts.length,
    audit_rows_appended: auditRowsAppended,
    audit_rows_existing: auditRowsExisting,
    skipped,
    cycle_digest: cycleDigest,
    forecast_note: 'NO STRIPE PAYOUT WIRED - this is a forecast surface (W825 MVP)',
    version: MARKETPLACE_PAYOUTS_VERSION,
    contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
  };
}

function payoutAuditExists(tenantId, payoutId) {
  const rows = listAuditEvents(tenantId, {
    limit: MARKETPLACE_PAYOUTS_LIMITS.MAX_AUDIT_LOOKBACK,
    op: AUDIT_OPS.MARKETPLACE_PAYOUT,
  });
  return rows.some((row) => row && row.payload && row.payload.payout_id === payoutId);
}

function parseRevenueEvent(ev) {
  if (!ev || typeof ev.feedback !== 'string') return { ok: false, error: 'missing_feedback' };
  if (ev.feedback.length > MARKETPLACE_PAYOUTS_LIMITS.MAX_FEEDBACK_CHARS) {
    return { ok: false, error: 'oversize_feedback' };
  }
  let payload;
  try { payload = JSON.parse(ev.feedback); } catch {
    return { ok: false, error: 'bad_json_feedback' };
  }
  const listing_id = normalizeId(payload && payload.listing_id, 'listing_id', { allowNull: false });
  const publisher_tenant_id = normalizeId(payload && payload.publisher_tenant_id, 'publisher_tenant_id', { allowNull: true });
  const micro_usd = normalizeMicroUsd(payload && payload.micro_usd, { allowZero: false, clamp: false });
  if (!listing_id || micro_usd == null) return { ok: false, error: 'invalid_payload' };
  const basePayload = {
    listing_id,
    publisher_tenant_id,
    micro_usd,
    version: MARKETPLACE_PAYOUTS_VERSION,
    contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
  };
  const expectedHash = hashPayload(basePayload);
  if (payload.revenue_body_sha256 && payload.revenue_body_sha256 !== expectedHash) {
    return { ok: false, error: 'integrity_mismatch' };
  }
  return {
    ok: true,
    payload: {
      ...basePayload,
      revenue_body_sha256: payload.revenue_body_sha256 || expectedHash,
    },
  };
}

function buildRevenuePayload({ listing_id, publisher_tenant_id, micro_usd }) {
  const basePayload = {
    listing_id,
    publisher_tenant_id,
    micro_usd,
    version: MARKETPLACE_PAYOUTS_VERSION,
    contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
  };
  return {
    ...basePayload,
    revenue_body_sha256: hashPayload(basePayload),
  };
}

function normalizePeriod(period) {
  if (period == null || period === '') return { ok: true, value: _currentPeriod() };
  const value = String(period).trim();
  if (value === '*') return { ok: true, value };
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return { ok: true, value };
  return { ok: false, error: 'period must be YYYY-MM or *' };
}

function normalizeId(value, label, { allowNull = false } = {}) {
  if (value == null || value === '') return allowNull ? null : '';
  const out = String(value).trim();
  if (!out && allowNull) return null;
  if (out.length > MARKETPLACE_PAYOUTS_LIMITS.MAX_ID_CHARS) return allowNull ? null : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(out)) return allowNull ? null : '';
  return out;
}

function normalizeMicroUsd(value, { allowZero = false, clamp = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return allowZero ? 0 : null;
  const i = Math.trunc(n);
  if (!Number.isSafeInteger(i)) return allowZero ? 0 : null;
  if (i < 0 || (!allowZero && i <= 0)) return allowZero ? 0 : null;
  if (i > MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD) {
    return clamp ? MARKETPLACE_PAYOUTS_LIMITS.MAX_REVENUE_MICRO_USD : null;
  }
  return i;
}

function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJsonStringify(value[key])).join(',') + '}';
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

function hashRevenueAppendResponse(payload) {
  return hashPayload({
    kind: 'marketplace_revenue_append',
    revenue_body_sha256: payload.revenue_body_sha256,
    dispatched: false,
    version: MARKETPLACE_PAYOUTS_VERSION,
    contract_version: MARKETPLACE_PAYOUTS_CONTRACT_VERSION,
  });
}

// recordRevenue({listing_id, publisher_tenant_id, micro_usd}): convenience
// for the route layer to persist a single ledger entry. The download route
// calls this whenever a paid listing's bytes are streamed. Period attribution
// is implicit (event-store stamps created_at; payoutCycle filters by YYYY-MM).
export async function recordRevenue({ listing_id, publisher_tenant_id, micro_usd }) {
  const normalizedListingId = normalizeId(listing_id, 'listing_id');
  const normalizedPublisherTenantId = normalizeId(publisher_tenant_id, 'publisher_tenant_id', { allowNull: true });
  const normalizedMicroUsd = normalizeMicroUsd(micro_usd, { allowZero: false, clamp: false });
  if (!normalizedListingId || normalizedMicroUsd == null) return null;
  const payload = buildRevenuePayload({
    listing_id: normalizedListingId,
    publisher_tenant_id: normalizedPublisherTenantId,
    micro_usd: normalizedMicroUsd,
  });
  await appendEvent({
    tenant_id: payload.publisher_tenant_id || 'platform',
    namespace: MARKETPLACE_REVENUE_NAMESPACE,
    provider: MARKETPLACE_REVENUE_PROVIDER,
    status: 'ok',
    request_hash: payload.revenue_body_sha256,
    response_hash: hashRevenueAppendResponse(payload),
    feedback: JSON.stringify(payload),
  });
  return payload;
}

function _currentPeriod() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
