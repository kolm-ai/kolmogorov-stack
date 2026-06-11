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
import { buildAndSignReport, resignAsTier, canonicalizeReport } from './attestation-report-builder.js';
import { computeAuditDelta } from './audit-delta.js';
import { timestampDigest, selfIssueTimestamp } from './rfc3161-timestamp.js';
// G-routes: fire Continuous re-attestation notifications. notify() is async and
// can throw (unknown event / store hiccup); the _notify wrapper below makes every
// call fire-and-forget so a notification failure can NEVER fail fulfillment.
import { notify } from './notifications.js';
// M14 - audit trail. Package fulfillment + subscription activation are
// money-bearing state transitions, so each writes one chained audit row.
// tryAppendAudit never throws, so the fulfillment path is never blocked by an
// audit-store hiccup (it is safe inside the surrounding withTransaction - the
// chain append uses a re-entrant SAVEPOINT).
import { tryAppendAudit, AUDIT_OPS } from './audit.js';

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

// The public Trust link for a subscription's stable slug (mirrors the
// _trustUrlFor / _publicBase helpers in audit-routes.js). null when no slug.
function _publicBase() {
  return (process.env.PUBLIC_BASE || process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
}
function trustUrlFor(slug) {
  return slug ? `${_publicBase()}/v1/trust/${slug}` : null;
}

// Fire-and-forget notification. notify() is async and may reject (an unknown
// event type, a transient store error, a webhook timeout); fulfillment must
// NEVER fail because a notification did. We swallow both the synchronous throw
// and the rejected promise, and never await the result.
function _notify(tenant, eventType, payload) {
  try {
    if (!tenant) return;
    const p = notify(tenant, eventType, payload || {});
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch { /* best-effort: a notify failure never blocks fulfillment */ }
}

// ---------------------------------------------------------------------------
// Trusted timestamping of the PAID deliverable (the $750 report / Trust Link).
//
// An Ed25519 signature proves WHO signed and that nothing changed since; it does
// NOT prove WHEN. The paid report therefore additionally carries an RFC 3161
// timestamp over its SIGNED report digest (sha256 of the canonical signed bytes,
// the same value the signature covers). The timestamp is DETACHED evidence
// (canonicalizeReport excludes timestamp_evidence), so attaching it never breaks
// the signature.
//
// Two layers, both offline-safe and best-effort - they NEVER throw and NEVER
// block fulfillment:
//   * a SYNCHRONOUS self-issued token (selfIssueTimestamp) is attached the moment
//     the report is sold, so the deliverable is always anchored in time without a
//     network round-trip at request time (the free scan path stays un-timestamped);
//   * an asynchronous upgrade to an INDEPENDENT public TSA (timestampDigest) runs
//     post-commit when one is configured, replacing the self token with a stronger
//     third-party countersignature (status:'offline' when no TSA is reachable).
// ---------------------------------------------------------------------------
function _reportDigest(env) {
  try { return crypto.createHash('sha256').update(canonicalizeReport(env), 'utf8').digest('hex'); }
  catch { return null; }
}

// Attach a synchronous, offline-safe self-issued RFC 3161 timestamp to a signed
// paid report envelope IN PLACE. selfIssueTimestamp is pure crypto (no network)
// and never throws. Returns the same envelope. Best-effort.
function _attachReportTimestamp(env) {
  try {
    if (!env || typeof env !== 'object' || env.tier !== 'report') return env;
    const digest = _reportDigest(env);
    if (!digest) return env;
    const te = selfIssueTimestamp(digest);
    if (te && typeof te === 'object') env.timestamp_evidence = te;
  } catch { /* best-effort: leave the report un-timestamped */ }
  return env;
}

// Attach an RFC 3161 timestamp over a signed paid report's digest via
// timestampDigest (the INDEPENDENT public TSA path). Offline-safe: timestampDigest
// never throws and yields status:'offline' when no TSA is reachable. Mutates +
// returns the envelope. opts.selfIssueTimestamp forces the offline self path
// (used by tests for a deterministic token with no network). Best-effort.
export async function attachPaidTimestamp(envelope, opts = {}) {
  try {
    if (!envelope || typeof envelope !== 'object') return envelope;
    const digest = _reportDigest(envelope);
    if (!digest) return envelope;
    let te;
    if (opts.selfIssueTimestamp === true) {
      te = selfIssueTimestamp(digest, { signer: opts.timestampSigner });
    } else {
      te = await timestampDigest(digest, {
        tsaUrl: opts.tsaUrl,
        timeoutMs: opts.timeoutMs,
        fallbackSelfIssue: opts.fallbackSelfIssue === true,
      });
    }
    if (te && typeof te === 'object') envelope.timestamp_evidence = te;
  } catch { /* best-effort */ }
  return envelope;
}

// Upgrade a STORED paid report's timestamp to an independent-TSA token and
// persist it. Async + post-commit so it never blocks the money-write. Idempotent:
// a no-op when the row already carries an external (source!='self') timestamp for
// the current digest, or when no external token can be obtained (the sync self
// baseline stands). Keyed by audit_id (the money path that produced it was already
// tenant-fenced). NEVER throws.
export async function upgradeReportTimestamp(audit_id, opts = {}) {
  try {
    if (!audit_id) return { ok: false, reason: 'no_audit_id' };
    const row = findOne(AUDITS, (r) => r && r.id === audit_id);
    if (!row || !row.report || row.report.tier !== 'report') return { ok: false, reason: 'not_paid_report' };
    const env = row.report;
    const digest = _reportDigest(env);
    if (!digest) return { ok: false, reason: 'no_digest' };
    const cur = env.timestamp_evidence;
    if (cur && typeof cur === 'object' && cur.status === 'timestamped' && cur.source && cur.source !== 'self' && cur.message_imprint === digest) {
      return { ok: true, already: true, status: 'timestamped', source: cur.source };
    }
    const te = await timestampDigest(digest, { tsaUrl: opts.tsaUrl, timeoutMs: opts.timeoutMs, fallbackSelfIssue: opts.fallbackSelfIssue === true });
    if (!te || te.status !== 'timestamped') {
      return { ok: false, reason: (te && te.reason) || 'offline', status: te ? te.status : 'offline' };
    }
    const updated = { ...env, timestamp_evidence: te };
    update(AUDITS, (r) => r.id === audit_id, { report: updated, updated_at: nowIso() });
    return { ok: true, status: 'timestamped', source: te.source || 'tsa' };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// $750 one-time: upgrade a paid audit row to an unwatermarked report + slug.
// Idempotent: a webhook retry on an already-fulfilled row returns it unchanged.
// ---------------------------------------------------------------------------
export function fulfillReportPurchase({ audit_id, stripe_session_id, signer } = {}) {
  if (!audit_id) return { ok: false, reason: 'no_audit_id' };
  const result = withTransaction(() => {
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
      try {
        upgraded = resignAsTier(row.report, 'report', signer);
        // Anchor the paid deliverable in time the moment it is sold, synchronously
        // and offline-safe (self-issued RFC 3161 token; no network at request
        // time). Best-effort; never blocks fulfillment.
        upgraded = _attachReportTimestamp(upgraded);
      } catch { upgraded = row.report; pendingResign = true; }
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
  // Economics telemetry (die-risk #1): one 'agent_audit.checkout_completed' op
  // per ACTUAL state transition, so started-vs-paid conversion is countable by
  // joining the existing agent_audit.checkout_started ops. The already-fulfilled
  // retry path (result.already) appends NOTHING, so a redelivered webhook never
  // double-counts. tryAppendAudit never throws, and the extra try/catch
  // guarantees telemetry can never push the webhook onto its retry path.
  if (result && result.ok && !result.already) {
    try {
      const tid = result.row ? result.row.tenant_id : null;
      tryAppendAudit({
        tenant_id: tid,
        actor: 'system',
        op: 'agent_audit.checkout_completed',
        payload: { product: 'report', tenant_id: tid, audit_id },
      });
    } catch { /* telemetry is best-effort, never the webhook's problem */ }
  }
  // Post-commit, best-effort upgrade to an INDEPENDENT public TSA token. The
  // timestampDigest call is async, so it runs AFTER the sync money-write and never
  // blocks the webhook's sync return; the sync self-issued baseline already stands.
  // Gated on KOLM_TSA_URL so no network fires unless an operator opted into an
  // external TSA. The in-flight promise is exposed as result.timestamp for an
  // async-aware caller (or a test); the Stripe webhook ignores the extra field.
  if (result && result.ok && !result.already && process.env.KOLM_TSA_URL) {
    result.timestamp = upgradeReportTimestamp(audit_id, {}).catch(() => null);
  }
  return result;
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
      let upgraded = resignAsTier(row.report, 'report', signer);
      upgraded = _attachReportTimestamp(upgraded); // self-heal the trusted timestamp too
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
  const result = withTransaction(() => {
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
    tryAppendAudit({
      tenant_id,
      actor: 'system',
      op: AUDIT_OPS.STRIPE_EVENT,
      payload: { kind: 'asr_package_fulfilled', product, package_id: fresh.id, stripe_session_id: stripe_session_id || null },
    });
    return { ok: true, pkg: fresh };
  });
  // Economics telemetry (die-risk #1): see fulfillReportPurchase. Appends only
  // on a real transition (never on the idempotent already path); can never throw.
  if (result && result.ok && !result.already) {
    try {
      tryAppendAudit({
        tenant_id,
        actor: 'system',
        op: 'agent_audit.checkout_completed',
        payload: { product, tenant_id, package_id: result.pkg ? result.pkg.id : null },
      });
    } catch { /* telemetry is best-effort, never the webhook's problem */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Continuous: activate (or re-activate) a subscription. Idempotent on the Stripe
// subscription id (or, lacking one, on tenant+product). Seeds latest_audit_id
// from the tenant's most recent report so the Trust link resolves immediately.
// ---------------------------------------------------------------------------
export function activateSubscription({ product, tenant_id, stripe_subscription_id, stripe_customer_id, stripe_session_id } = {}) {
  if (!product || !tenant_id) return { ok: false, reason: 'missing_fields' };
  const result = withTransaction(() => {
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
      tryAppendAudit({
        tenant_id,
        actor: 'system',
        op: AUDIT_OPS.STRIPE_EVENT,
        payload: { kind: 'asr_subscription_reactivated', product, subscription_id: sub.id, stripe_subscription_id: stripe_subscription_id || sub.stripe_subscription_id || null },
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
      // Die-risk #7: the FIRST attestation must not wait a week. next_run_at
      // starts at NOW so the in-process 30-minute sweep (runDueReattestations)
      // picks the subscription up on its next tick when seed logs exist
      // (reattestSub already handles a subscription with no stored source
      // gracefully). Every SUBSEQUENT cycle still re-schedules +1 week via
      // claimDue, so the weekly cadence is unchanged after the first run.
      next_run_at: nowIso(),
      last_run_at: null,
      created_at: ts,
      updated_at: ts,
    };
    insert(SUBSCRIPTIONS, row);
    tryAppendAudit({
      tenant_id,
      actor: 'system',
      op: AUDIT_OPS.STRIPE_EVENT,
      payload: { kind: 'asr_subscription_activated', product, subscription_id: row.id, stripe_subscription_id: stripe_subscription_id || null, public_slug: row.public_slug },
    });
    return { ok: true, sub: row };
  });
  // Economics telemetry (die-risk #1): see fulfillReportPurchase. Appends only
  // on a real activation (never on the idempotent re-activation path); can
  // never throw, so it can never trigger the webhook retry path.
  if (result && result.ok && !result.already) {
    try {
      tryAppendAudit({
        tenant_id,
        actor: 'system',
        op: 'agent_audit.checkout_completed',
        payload: { product, tenant_id, subscription_id: result.sub ? result.sub.id : null },
      });
    } catch { /* telemetry is best-effort, never the webhook's problem */ }
  }
  return result;
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
  // The report this cycle replaces - the subscription's CURRENT latest report.
  // S9: the new report carries a signed delta vs this one so a Continuous
  // customer sees exactly what changed this cycle.
  const prevRow = sub.latest_audit_id ? findOne(AUDITS, (r) => r.id === sub.latest_audit_id) : null;
  const prevReport = prevRow && prevRow.report ? prevRow.report : null;
  let audit, built;
  try {
    audit = runAudit(baseLogs, { source: source.source || 'reattest' });
    built = buildAndSignReport(audit, { subject: source.subject || sub.product_key, verify_url: verifyUrl(), tier: 'report', signer });
    // The re-attested report is the live paid deliverable behind the stable Trust
    // Link: anchor it in time too (sync, offline-safe, best-effort).
    _attachReportTimestamp(built.envelope);
  } catch (e) {
    return { sub: sub.id, ok: false, reason: e && e.message };
  }
  // computeAuditDelta is pure + never-throws; guard anyway so a delta hiccup can
  // never block a re-attestation. null when there is no prior report (first run).
  let drift = null;
  try { drift = prevReport ? computeAuditDelta(prevReport, built.envelope) : null; }
  catch { drift = null; }
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
    drift,
    paid: true, tier: 'report', public: false, public_slug: null,
    subscription_id: sub.id,
    created_at: ts, updated_at: ts,
  };
  insert(AUDITS, auditRow);
  update(SUBSCRIPTIONS, (s) => s.id === sub.id, { latest_audit_id: auditRow.id, last_run_at: ts, updated_at: ts });

  // G-routes: notify the tenant about this re-attestation. Both calls are
  // fire-and-forget (see _notify) so a webhook / email failure never fails the
  // re-attestation. The Trust link is the subscription's stable, always-current
  // public slug.
  const trustUrl = trustUrlFor(sub.public_slug);
  const subject = source.subject || sub.product_key || 'Agent fleet';
  const readinessPct = audit.summary ? audit.summary.readiness_pct : null;
  // audit_report_ready - a fresh signed report was published this cycle.
  _notify(sub.tenant_id, 'audit_report_ready', { trust_url: trustUrl, readiness_pct: readinessPct, subject });
  // reattestation_drift - only when the delta shows real movement vs the prior
  // cycle (a new or resolved finding, or a readiness change). A no-change cycle
  // stays quiet so a Continuous customer is only pinged when something moved.
  if (drift && (
    (Array.isArray(drift.findings_added) && drift.findings_added.length > 0) ||
    (Array.isArray(drift.findings_resolved) && drift.findings_resolved.length > 0) ||
    (drift.readiness_change != null && drift.readiness_change !== 0)
  )) {
    _notify(sub.tenant_id, 'reattestation_drift', {
      trust_url: trustUrl,
      subject,
      summary: drift.summary || null,
      readiness_change: drift.readiness_change,
      findings_added: Array.isArray(drift.findings_added) ? drift.findings_added.length : 0,
      findings_resolved: Array.isArray(drift.findings_resolved) ? drift.findings_resolved.length : 0,
      regressed: drift.regressed === true,
    });
  }

  return { sub: sub.id, ok: true, audit_id: auditRow.id, readiness_pct: audit.summary ? audit.summary.readiness_pct : null, regressed: drift ? drift.regressed === true : null };
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

// ---------------------------------------------------------------------------
// S9 - resolve the signed report immediately PRIOR to the one a Trust Link
// currently serves, so the public delta route can diff "now vs last cycle".
//
//   * one-time paid audit slug: a standalone $750 report has no prior unless it
//     is itself part of a subscription lineage -> null.
//   * subscription slug: the lineage is the seed report (source_audit_id) plus
//     every re-attestation row (subscription_id === sub.id), ordered by
//     created_at. The prior is the report immediately before the current
//     latest_audit_id in that ordering (null when the latest IS the first).
//
// Pure read over the store; never throws. Returns a signed envelope or null.
// ---------------------------------------------------------------------------
function _subscriptionLineage(sub) {
  const rows = [];
  if (sub.source_audit_id) {
    const seed = findOne(AUDITS, (r) => r.id === sub.source_audit_id);
    if (seed && seed.report) rows.push(seed);
  }
  for (const r of find(AUDITS, (x) => x && x.subscription_id === sub.id && x.report)) {
    if (!rows.some((existing) => existing.id === r.id)) rows.push(r);
  }
  rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return rows;
}

export function resolvePriorReport(slug) {
  try {
    if (!slug || typeof slug !== 'string') return null;
    // One-time paid audit slug.
    const audits = findByField(AUDITS, 'public_slug', slug);
    const audit = audits.find((r) => r && r.public === true && r.paid === true && r.report);
    if (audit && !audit.subscription_id) return null;

    // Subscription slug (or a paid audit that is part of a subscription lineage).
    const subs = findByField(SUBSCRIPTIONS, 'public_slug', slug);
    const sub = subs[0];
    if (!sub) return null;
    const lineage = _subscriptionLineage(sub);
    if (lineage.length < 2) return null;
    const currentId = sub.latest_audit_id || lineage[lineage.length - 1].id;
    let idx = lineage.findIndex((r) => r.id === currentId);
    if (idx < 0) idx = lineage.length - 1; // unknown latest -> treat last as current
    const prior = idx > 0 ? lineage[idx - 1] : null;
    return prior && prior.report ? prior.report : null;
  } catch {
    return null;
  }
}

export default {
  SUBSCRIPTIONS, PACKAGES, mintSlug,
  fulfillReportPurchase, fulfillPackagePurchase, resignPendingReports, activateSubscription, setSubscriptionStatus,
  runDueReattestations, forceReattest, resolveTrust, resolvePriorReport,
  attachPaidTimestamp, upgradeReportTimestamp,
};
