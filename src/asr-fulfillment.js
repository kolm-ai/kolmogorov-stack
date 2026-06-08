// src/asr-fulfillment.js
//
// The fulfillment core for the paid Agent Security-Review tiers. ONE place that
// the Stripe webhook (src/router.js) and the audit routes (src/audit-routes.js)
// both call, so the paid loop has a single tested implementation and router.js
// never has to import audit-routes.js.
//
// Responsibilities:
//   * fulfillReportPurchase  - $750 one-time: flip a stored watermarked scan
//                              into an unwatermarked tier:'report' envelope
//                              (resignAsTier - no re-run), mint a public slug,
//                              mark the row paid. Idempotent on webhook retries.
//   * activateSubscription / setSubscriptionStatus - Continuous lifecycle on the
//                              new asr_subscriptions table; the subscription
//                              carries a STABLE public slug so its Trust link is
//                              always-current.
//   * runDueReattestations / forceReattest - re-run the deterministic audit on
//                              the subscription's source logs, re-sign, and point
//                              the stable slug at the fresh report. Claim-then-run
//                              so a double tick never double-signs.
//   * resolveTrust           - resolve a public slug (audit OR subscription) to
//                              the envelope the public /v1/trust/:slug route serves.
//
// All writes are tenant-fenced exactly like the existing agent_audits rows.

import crypto from 'node:crypto';
import { id as storeId, insert, update, find, findOne, findByField, withTransaction } from './store.js';
import { runAudit } from './audit-orchestrator.js';
import { buildAndSignReport, resignAsTier } from './attestation-report-builder.js';

const AUDITS = 'agent_audits';
export const SUBSCRIPTIONS = 'asr_subscriptions';
export const PACKAGES = 'asr_packages';

// Weekly cadence as a fixed interval. The tick is external + idempotent, so an
// interval-from-claim model is more robust here than wall-clock cron alignment
// (a restarted container never misses or double-fires a calendar slot).
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function mintSlug() {
  return crypto.randomBytes(12).toString('hex'); // 24 hex chars, fits [A-Za-z0-9_-]{1,64}
}
function newAuditId() {
  return 'audses_' + crypto.randomBytes(10).toString('hex');
}
function verifyUrl() {
  const base = (process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
  return `${base}/verify`;
}
function nowIso() { return new Date().toISOString(); }
function plusWeekIso() { return new Date(Date.now() + WEEK_MS).toISOString(); }

// ---------------------------------------------------------------------------
// $750 one-time: upgrade a paid audit row to an unwatermarked report + slug.
// Idempotent: a webhook retry on an already-fulfilled row returns it unchanged.
// ---------------------------------------------------------------------------
export function fulfillReportPurchase({ audit_id, stripe_session_id, signer } = {}) {
  if (!audit_id) return { ok: false, reason: 'no_audit_id' };
  return withTransaction(() => {
    const row = findOne(AUDITS, (r) => r && r.id === audit_id);
    if (!row) return { ok: false, reason: 'audit_not_found' };
    if (row.paid === true && row.public_slug) {
      return { ok: true, already: true, row };
    }
    let upgraded = row.report;
    let pendingResign = false;
    if (row.report) {
      // Sign immediately with the supplied signer (the webhook loads it). If the
      // signer is momentarily unavailable, mark paid + flag report_pending_resign
      // so the scheduler sweep re-signs within one tick (no permanent watermark).
      try { upgraded = resignAsTier(row.report, 'report', signer); }
      catch { upgraded = row.report; pendingResign = true; }
    }
    const slug = row.public_slug || mintSlug();
    const ts = nowIso();
    update(AUDITS, (r) => r.id === audit_id, {
      paid: true, paid_at: ts, tier: 'report', public: true, public_slug: slug,
      report: upgraded, report_pending_resign: pendingResign,
      stripe_session_id: stripe_session_id || row.stripe_session_id || null,
      updated_at: ts,
    });
    // Post-write read-back: confirm the write actually landed (catches a silent
    // ephemeral-store failure). If not, signal retryable so the caller can have
    // Stripe re-deliver rather than silently lose the purchase.
    const fresh = findOne(AUDITS, (r) => r.id === audit_id);
    if (!fresh || fresh.paid !== true || !fresh.public_slug) {
      return { ok: false, reason: 'write_unconfirmed', retryable: true };
    }
    return { ok: true, row: fresh, pending_resign: pendingResign };
  });
}

// Re-sign any paid reports that were marked paid while the signer was momentarily
// unavailable (report_pending_resign). Called from the scheduler sweep so a $750
// buyer's report self-heals to unwatermarked within one tick. Idempotent.
export function resignPendingReports({ signer, limit = 50 } = {}) {
  const pending = find(AUDITS, (r) => r && r.report_pending_resign === true && r.paid === true && r.report)
    .slice(0, Math.max(1, limit));
  let fixed = 0;
  for (const row of pending) {
    try {
      const upgraded = resignAsTier(row.report, 'report', signer);
      update(AUDITS, (r) => r.id === row.id, { report: upgraded, report_pending_resign: false, updated_at: nowIso() });
      fixed++;
    } catch { /* still no signer; retry next tick */ }
  }
  return { ok: true, pending: pending.length, fixed };
}

// ---------------------------------------------------------------------------
// $15k Full Readiness (and any future tenant-bound package): grant a durable
// entitlement row in asr_packages. Unlike fulfillReportPurchase this is NOT
// bound to a single audit - it is a tenant-level grant the review engagement
// runs against. Idempotent on (tenant, product) so a webhook retry (or a second
// purchase before the first cleared) never double-grants. Tenant-fenced: the
// row is only ever keyed to the purchasing tenant. Post-write read-back like
// fulfillReportPurchase so a silent ephemeral-store failure surfaces as
// retryable rather than a lost purchase.
// ---------------------------------------------------------------------------
export function fulfillPackagePurchase({ tenant_id, product, stripe_session_id } = {}) {
  if (!tenant_id || !product) return { ok: false, reason: 'missing_fields' };
  return withTransaction(() => {
    // Tenant-fenced idempotency: an existing ACTIVE grant for this exact
    // (tenant, product) means the purchase is already fulfilled. The tenant_id
    // predicate guarantees a forged/reused session can never read or mutate
    // another tenant's entitlement.
    const existing = findOne(PACKAGES, (p) => p && p.tenant_id === tenant_id && p.product === product && p.status === 'active');
    if (existing) {
      // Backfill the session id if this is the first webhook to carry it, but
      // still report `already` so no confirmation side-effect re-fires.
      if (stripe_session_id && !existing.stripe_session_id) {
        update(PACKAGES, (p) => p.id === existing.id, { stripe_session_id, updated_at: nowIso() });
      }
      return { ok: true, already: true, pkg: findOne(PACKAGES, (p) => p.id === existing.id) };
    }
    const ts = nowIso();
    const row = {
      id: storeId('asrpkg'),
      tenant_id,
      product,
      status: 'active',
      purchased_at: ts,
      stripe_session_id: stripe_session_id || null,
      created_at: ts,
      updated_at: ts,
    };
    insert(PACKAGES, row);
    const fresh = findOne(PACKAGES, (p) => p.id === row.id);
    if (!fresh || fresh.status !== 'active') {
      return { ok: false, reason: 'write_unconfirmed', retryable: true };
    }
    return { ok: true, pkg: fresh };
  });
}

// ---------------------------------------------------------------------------
// Continuous: activate (or re-activate) a subscription. Idempotent on the Stripe
// subscription id (or, lacking one, on tenant+product). Seeds latest_audit_id
// from the tenant's most recent report so the Trust link resolves immediately.
// ---------------------------------------------------------------------------
export function activateSubscription({ product, tenant_id, stripe_subscription_id, stripe_customer_id, stripe_session_id } = {}) {
  if (!product || !tenant_id) return { ok: false, reason: 'missing_fields' };
  return withTransaction(() => {
    // Tenant-fenced lookup: a subscription is only ever matched within the
    // owning tenant. The stripe_subscription_id cross-check (s.tenant_id ===
    // tenant_id) guarantees a reused/forged id can never mutate another tenant's
    // subscription row.
    let sub = stripe_subscription_id
      ? findOne(SUBSCRIPTIONS, (s) => s.stripe_subscription_id === stripe_subscription_id && s.tenant_id === tenant_id)
      : null;
    if (!sub) sub = findOne(SUBSCRIPTIONS, (s) => s.tenant_id === tenant_id && s.product_key === product);
    const ts = nowIso();
    if (sub) {
      update(SUBSCRIPTIONS, (s) => s.id === sub.id, {
        status: 'active', product_key: product,
        stripe_subscription_id: stripe_subscription_id || sub.stripe_subscription_id || null,
        stripe_customer_id: stripe_customer_id || sub.stripe_customer_id || null,
        updated_at: ts,
      });
      return { ok: true, already: true, sub: findOne(SUBSCRIPTIONS, (s) => s.id === sub.id) };
    }
    const audits = find(AUDITS, (r) => r.tenant_id === tenant_id && r.report)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const seed = audits[0] || null;
    const row = {
      id: storeId('asrsub'),
      tenant_id,
      product_key: product,
      status: 'active',
      cadence: product === 'growth' ? 'on_deploy' : 'weekly',
      stripe_subscription_id: stripe_subscription_id || null,
      stripe_customer_id: stripe_customer_id || null,
      stripe_session_id: stripe_session_id || null,
      public_slug: mintSlug(),
      latest_audit_id: seed ? seed.id : null,
      source_audit_id: seed ? seed.id : null,
      next_run_at: plusWeekIso(),
      last_run_at: null,
      created_at: ts,
      updated_at: ts,
    };
    insert(SUBSCRIPTIONS, row);
    return { ok: true, sub: row };
  });
}

export function setSubscriptionStatus({ stripe_subscription_id, status } = {}) {
  if (!stripe_subscription_id || !status) return { ok: false, reason: 'missing_fields' };
  const ts = nowIso();
  let n = 0;
  try { n = update(SUBSCRIPTIONS, (s) => s.stripe_subscription_id === stripe_subscription_id, { status, updated_at: ts }) || 0; }
  catch { /* never throw across the webhook boundary */ }
  return { ok: true, updated: n };
}

// Atomically claim a due subscription so two concurrent ticks cannot both run
// it. Pushes next_run_at forward inside the unit; returns true iff THIS caller
// won the claim. withTransaction is BEGIN IMMEDIATE on sqlite.
function claimDue(subId, tNow) {
  return withTransaction(() => {
    const fresh = findOne(SUBSCRIPTIONS, (s) => s.id === subId);
    if (!fresh || fresh.status !== 'active') return null;
    if (!fresh.next_run_at || new Date(fresh.next_run_at).getTime() > tNow) return null;
    update(SUBSCRIPTIONS, (s) => s.id === subId, { next_run_at: plusWeekIso(), updated_at: nowIso() });
    return fresh;
  });
}

function reattestSub(sub, { signer } = {}) {
  const source = sub.source_audit_id ? findOne(AUDITS, (r) => r.id === sub.source_audit_id) : null;
  const baseLogs = source && source.logs ? source.logs : null;
  if (!baseLogs) return { sub: sub.id, ok: false, reason: 'no_source_logs' };
  let audit, built;
  try {
    audit = runAudit(baseLogs, { source: source.source || 'reattest' });
    built = buildAndSignReport(audit, { subject: source.subject || sub.product_key, verify_url: verifyUrl(), tier: 'report', signer });
  } catch (e) {
    return { sub: sub.id, ok: false, reason: e && e.message };
  }
  const ts = nowIso();
  const auditRow = {
    id: newAuditId(),
    tenant_id: sub.tenant_id,
    subject: source.subject || 'Agent fleet',
    source: 'reattest',
    retention_days: source.retention_days ?? null,
    status: 'complete',
    logs: baseLogs,
    record_count: source.record_count || 0,
    report: built.envelope,
    report_id: built.report_id,
    summary: audit.summary,
    paid: true, tier: 'report', public: false, public_slug: null,
    subscription_id: sub.id,
    created_at: ts, updated_at: ts,
  };
  insert(AUDITS, auditRow);
  update(SUBSCRIPTIONS, (s) => s.id === sub.id, { latest_audit_id: auditRow.id, last_run_at: ts, updated_at: ts });
  return { sub: sub.id, ok: true, audit_id: auditRow.id, readiness_pct: audit.summary ? audit.summary.readiness_pct : null };
}

// Run every active subscription whose next_run_at has passed. Claim-then-run so
// a double tick never double-signs. now/limit/signer are injectable for tests.
export function runDueReattestations({ now, limit = 50, signer } = {}) {
  const tNow = now ? new Date(now).getTime() : Date.now();
  const candidates = find(SUBSCRIPTIONS, (s) => s.status === 'active' && s.next_run_at && new Date(s.next_run_at).getTime() <= tNow)
    .slice(0, Math.max(1, limit));
  const results = [];
  for (const c of candidates) {
    const claimed = claimDue(c.id, tNow);
    if (!claimed) { results.push({ sub: c.id, ok: false, reason: 'not_claimed' }); continue; }
    results.push(reattestSub(claimed, { signer }));
  }
  return { ok: true, considered: candidates.length, ran: results.filter((r) => r.ok).length, results };
}

// Growth "on every deploy": force an immediate re-attestation for a tenant's
// active subscription(s), bypassing next_run_at.
export function forceReattest({ tenant_id, signer } = {}) {
  if (!tenant_id) return { ok: false, reason: 'no_tenant' };
  const subs = find(SUBSCRIPTIONS, (s) => s.tenant_id === tenant_id && s.status === 'active');
  if (!subs.length) return { ok: false, reason: 'no_active_subscription' };
  const results = subs.map((s) => reattestSub(s, { signer }));
  return { ok: results.some((r) => r.ok), ran: results.filter((r) => r.ok).length, results };
}

// ---------------------------------------------------------------------------
// Resolve a public slug (audit slug first, then subscription slug) to the
// envelope the public Trust route serves. Returns null when nothing matches.
// ---------------------------------------------------------------------------
export function resolveTrust(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const audits = findByField(AUDITS, 'public_slug', slug);
  const audit = audits.find((r) => r && r.public === true && r.paid === true && r.report);
  if (audit) {
    return { envelope: audit.report, lapsed: false, report_id: audit.report_id, subject: audit.subject, kind: 'report' };
  }
  const subs = findByField(SUBSCRIPTIONS, 'public_slug', slug);
  const sub = subs[0];
  if (sub) {
    const latest = sub.latest_audit_id ? findOne(AUDITS, (r) => r.id === sub.latest_audit_id) : null;
    if (latest && latest.report) {
      // Staleness: the "always-current" promise is self-evidencing. last_run_at
      // is set on re-attestation; for the seed report it may be null, so fall
      // back to the report's generated_at.
      const lastIso = sub.last_run_at || (latest.report && latest.report.generated_at) || sub.created_at || null;
      const ageMs = lastIso ? (Date.now() - new Date(lastIso).getTime()) : null;
      const ageHours = (ageMs != null && ageMs >= 0) ? Math.floor(ageMs / 3600000) : null;
      return {
        envelope: latest.report,
        lapsed: sub.status !== 'active',
        report_id: latest.report_id,
        subject: latest.subject,
        kind: 'continuous',
        status: sub.status,
        last_run_at: lastIso,
        age_hours: ageHours,
        stale: ageHours != null && ageHours > 24 * 8, // >8 days without a refresh
      };
    }
    // Subscription exists but has not produced its first report yet (subscribed
    // before running a scan). Return a PENDING state so the Trust route renders
    // a "your first report is generating" page instead of a 404.
    return { pending: true, kind: 'continuous', status: sub.status, subject: null };
  }
  return null;
}

export default {
  SUBSCRIPTIONS, PACKAGES, mintSlug,
  fulfillReportPurchase, fulfillPackagePurchase, resignPendingReports, activateSubscription, setSubscriptionStatus,
  runDueReattestations, forceReattest, resolveTrust,
};
