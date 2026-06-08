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

import { listEvents, appendEvent } from './event-store.js';
import { AUDIT_OPS as _AUDIT_OPS, tryAppendAudit } from './audit.js';

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
  const revenue = Math.max(0, Math.trunc(Number(total_revenue_micro_usd) || 0));
  const publisher_micro_usd = Math.floor(revenue * PUBLISHER_SHARE);
  const platform_micro_usd = revenue - publisher_micro_usd;
  return {
    listing_id: listing && listing.id ? String(listing.id) : null,
    publisher_tenant_id: listing && listing.publisher_tenant_id ? String(listing.publisher_tenant_id) : null,
    revenue_micro_usd: revenue,
    publisher_micro_usd,
    platform_micro_usd,
    split: { publisher: PUBLISHER_SHARE, platform: PLATFORM_SHARE },
    version: MARKETPLACE_PAYOUTS_VERSION,
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
  const periodStr = String(period || _currentPeriod());
  // listEvents is async-safe - call site awaits.
  const rows = await listEvents({ provider: 'kolm_marketplace_revenue', limit: 0 });
  // Aggregate revenue per listing_id. The event-schema canonicalizer only
  // preserves named columns, so we encoded {listing_id, micro_usd} into the
  // `feedback` field as JSON (same pattern W737 uses for review payloads).
  const byListing = new Map();
  for (const ev of rows) {
    if (!ev || typeof ev.feedback !== 'string') continue;
    let payload = null;
    try { payload = JSON.parse(ev.feedback); } catch { continue; }
    if (!payload || !payload.listing_id) continue;
    // Filter by period (YYYY-MM).
    const at = ev.created_at || '';
    if (periodStr && periodStr !== '*' && !String(at).startsWith(periodStr)) continue;
    const sum = byListing.get(payload.listing_id) || {
      listing_id: payload.listing_id,
      publisher_tenant_id: payload.publisher_tenant_id || null,
      revenue_micro_usd: 0,
    };
    sum.revenue_micro_usd += Math.max(0, Math.trunc(Number(payload.micro_usd) || 0));
    byListing.set(payload.listing_id, sum);
  }
  const payouts = [];
  for (const row of byListing.values()) {
    const split = calcPayout(
      { id: row.listing_id, publisher_tenant_id: row.publisher_tenant_id },
      row.revenue_micro_usd,
    );
    payouts.push(split);
    // Emit one audit row per listing payout so the chain can be replayed.
    try {
      await tryAppendAudit({
        tenant_id: row.publisher_tenant_id || 'platform',
        op: AUDIT_OPS.MARKETPLACE_PAYOUT,
        actor: 'kolm.platform.marketplace.payout-cycle',
        target: row.listing_id,
        attributes: {
          period: periodStr,
          revenue_micro_usd: split.revenue_micro_usd,
          publisher_micro_usd: split.publisher_micro_usd,
          platform_micro_usd: split.platform_micro_usd,
          publisher_share: PUBLISHER_SHARE,
          platform_share: PLATFORM_SHARE,
          dispatched: false, // W825 brief: NO real Stripe write
          version: MARKETPLACE_PAYOUTS_VERSION,
        },
      });
    } catch (_e) { /* audit best-effort; never fail the cycle on chain write */ }
  }
  return {
    ok: true,
    period: periodStr,
    dispatched: false,
    rows: payouts,
    listing_count: payouts.length,
    forecast_note: 'NO STRIPE PAYOUT WIRED - this is a forecast surface (W825 MVP)',
    version: MARKETPLACE_PAYOUTS_VERSION,
  };
}

// recordRevenue({listing_id, publisher_tenant_id, micro_usd}): convenience
// for the route layer to persist a single ledger entry. The download route
// calls this whenever a paid listing's bytes are streamed. Period attribution
// is implicit (event-store stamps created_at; payoutCycle filters by YYYY-MM).
export async function recordRevenue({ listing_id, publisher_tenant_id, micro_usd }) {
  const payload = {
    listing_id: String(listing_id || ''),
    publisher_tenant_id: publisher_tenant_id ? String(publisher_tenant_id) : null,
    micro_usd: Math.max(0, Math.trunc(Number(micro_usd) || 0)),
  };
  if (!payload.listing_id || payload.micro_usd <= 0) return null;
  await appendEvent({
    tenant_id: payload.publisher_tenant_id || 'platform',
    namespace: 'kolm_marketplace',
    provider: 'kolm_marketplace_revenue',
    status: 'ok',
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
