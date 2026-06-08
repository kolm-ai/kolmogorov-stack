// src/dunning.js
//
// M12 - failed-payment dunning. When Stripe reports `invoice.payment_failed`,
// a Fortune-500 buyer's card may have simply expired; cutting them off at the
// first failure is hostile and loses revenue. Instead we schedule a 3 / 7 / 14
// day retry ladder, send a templated reminder before each retry, and only
// SUSPEND after the final attempt lapses. Stripe runs its own card retries in
// parallel; this ladder is OUR notification + grace-period state machine, so a
// `customer.subscription.updated` back to `active` (or a later
// `invoice.payment_succeeded`) clears the schedule via resolveDunning().
//
// State lives in the tenant-fenced `dunning_schedule` table, one open row per
// (tenant, subscription). retryPaymentFailure() is the pure offset calculator;
// scheduleDunning() opens/refreshes a row on a failure; runDueDunning() is the
// idempotent sweep the in-process scheduler should call on each tick.
//
// WIRING NOTE: runDueDunning() is exported for the existing server-side sweep to
// call (the same place runDueReattestations is ticked). This module deliberately
// does NOT edit server.js; an operator wires `import { runDueDunning } from
// './src/dunning.js'` into the sweep and passes a `sendFn` that renders
// tEmailDunning() through src/email.js sendEmail().

import { id as storeId, insert, update, find, findOne, withTransaction } from './store.js';

export const DUNNING = 'dunning_schedule';

// The retry ladder, in days from the most recent failure/retry. After the last
// offset lapses with no recovery, the subscription is suspended.
export const RETRY_OFFSETS_DAYS = [3, 7, 14];

function nowIso() { return new Date().toISOString(); }

// Pure: given a customer ref + 1-based attempt number, return the next action.
// attempt 1 -> retry in 3d, 2 -> 7d, 3 -> 14d, 4+ -> suspend. Never throws.
export function retryPaymentFailure(customer, attempt = 1) {
  const a = Math.max(1, Math.floor(Number(attempt) || 1));
  const idx = a - 1;
  if (idx >= RETRY_OFFSETS_DAYS.length) {
    return { customer: customer || null, attempt: a, action: 'suspend', offset_days: null, next_retry_at: null, final: true };
  }
  const offsetDays = RETRY_OFFSETS_DAYS[idx];
  const next = new Date(Date.now() + offsetDays * 86400000).toISOString();
  return { customer: customer || null, attempt: a, action: 'retry', offset_days: offsetDays, next_retry_at: next, final: false };
}

// Open (or refresh) a dunning schedule on a failed payment. Idempotent: a second
// failure event for the same open (tenant, subscription) schedule does not
// double-advance the ladder - it only backfills the latest invoice id. The
// ladder advances on the SWEEP (runDueDunning), so Stripe re-delivering the same
// `invoice.payment_failed` never skips a grace step. Tenant-fenced.
export function scheduleDunning({ tenant_id, stripe_customer_id = null, stripe_subscription_id = null, stripe_invoice_id = null, now } = {}) {
  if (!tenant_id) return { ok: false, reason: 'no_tenant' };
  const tNow = now ? new Date(now).getTime() : Date.now();
  return withTransaction(() => {
    const open = findOne(DUNNING, (d) => d && d.tenant_id === tenant_id && d.status === 'scheduled'
      && (stripe_subscription_id ? d.stripe_subscription_id === stripe_subscription_id : true));
    if (open) {
      if (stripe_invoice_id && open.stripe_invoice_id !== stripe_invoice_id) {
        update(DUNNING, (d) => d.id === open.id, { stripe_invoice_id, last_failed_at: nowIso(), updated_at: nowIso() });
      }
      return { ok: true, already: true, dunning: findOne(DUNNING, (d) => d.id === open.id) };
    }
    const ts = nowIso();
    const row = {
      id: storeId('dun'),
      tenant_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_invoice_id,
      attempt: 1,
      status: 'scheduled',
      next_retry_at: new Date(tNow + RETRY_OFFSETS_DAYS[0] * 86400000).toISOString(),
      first_failed_at: ts,
      last_failed_at: ts,
      suspended_at: null,
      resolved_at: null,
      created_at: ts,
      updated_at: ts,
    };
    insert(DUNNING, row);
    const fresh = findOne(DUNNING, (d) => d.id === row.id);
    if (!fresh) return { ok: false, reason: 'write_unconfirmed', retryable: true };
    return { ok: true, created: true, dunning: fresh };
  });
}

// Close any open schedule for a tenant (optionally scoped to a subscription)
// when payment recovers. Idempotent; returns the number of rows closed.
export function resolveDunning({ tenant_id, stripe_subscription_id = null } = {}) {
  if (!tenant_id) return { ok: false, reason: 'no_tenant', closed: 0 };
  const ts = nowIso();
  let closed = 0;
  try {
    closed = update(DUNNING, (d) => d && d.tenant_id === tenant_id && d.status === 'scheduled'
      && (stripe_subscription_id ? d.stripe_subscription_id === stripe_subscription_id : true),
      { status: 'recovered', resolved_at: ts, updated_at: ts }) || 0;
  } catch { /* never throw across the webhook boundary */ }
  return { ok: true, closed };
}

// Atomically claim + advance one due schedule. Returns the post-advance row (with
// `_final`) or null if another tick already took it. withTransaction is BEGIN
// IMMEDIATE on sqlite, so two concurrent ticks cannot both advance the same row.
function advanceOne(rowId, tNow) {
  return withTransaction(() => {
    const fresh = findOne(DUNNING, (d) => d.id === rowId);
    if (!fresh || fresh.status !== 'scheduled') return null;
    if (!fresh.next_retry_at || new Date(fresh.next_retry_at).getTime() > tNow) return null;
    const nextAttempt = (fresh.attempt || 1) + 1;
    const sched = retryPaymentFailure(fresh.stripe_customer_id || fresh.tenant_id, nextAttempt);
    const patch = sched.final
      ? { attempt: nextAttempt, status: 'suspended', next_retry_at: null, suspended_at: nowIso(), updated_at: nowIso() }
      : { attempt: nextAttempt, next_retry_at: sched.next_retry_at, updated_at: nowIso() };
    update(DUNNING, (d) => d.id === fresh.id, patch);
    return { ...fresh, ...patch, _final: !!sched.final };
  });
}

// Idempotent sweep: advance every schedule whose next_retry_at has passed,
// sending a reminder (or suspension notice) via the injected sendFn. sendFn may
// be sync or async; failures are swallowed so one bad email never stalls the
// ladder. now/limit/sendFn are injectable for tests.
export function runDueDunning({ now, limit = 100, sendFn } = {}) {
  const tNow = now ? new Date(now).getTime() : Date.now();
  const due = find(DUNNING, (d) => d && d.status === 'scheduled' && d.next_retry_at && new Date(d.next_retry_at).getTime() <= tNow)
    .slice(0, Math.max(1, limit));
  const results = [];
  for (const d of due) {
    const advanced = advanceOne(d.id, tNow);
    if (!advanced) { results.push({ id: d.id, ok: false, reason: 'not_claimed' }); continue; }
    let emailed = false;
    if (typeof sendFn === 'function') {
      try { Promise.resolve(sendFn({ dunning: advanced, final: advanced._final })).catch(() => {}); emailed = true; }
      catch { /* sendFn threw synchronously; reminder is best-effort */ }
    }
    results.push({ id: advanced.id, ok: true, tenant_id: advanced.tenant_id, attempt: advanced.attempt, suspended: advanced.status === 'suspended', emailed });
  }
  return { ok: true, due: due.length, processed: results.filter((r) => r.ok).length, results };
}

// List open/closed schedules for a tenant (account page + support). Tenant-fenced.
export function listDunning(tenant_id) {
  if (!tenant_id) return [];
  return find(DUNNING, (d) => d && d.tenant_id === tenant_id)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// Pure templated dunning email. Returns { subject, html, text } so the caller
// pre-renders for the audit log before sending. Mirrors the email.js template
// style (inline-styled 600px block, single manage CTA, dev@kolm.ai contact).
export function tEmailDunning({ email, attempt = 1, final = false, amount_cents, currency = 'usd', next_retry_at, manage_url } = {}) {
  const url = manage_url || 'https://kolm.ai/account-billing';
  const amount = (typeof amount_cents === 'number' && amount_cents > 0)
    ? `${(amount_cents / 100).toLocaleString(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() })}`
    : null;
  const retryDate = next_retry_at ? new Date(next_retry_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  const subject = final
    ? 'Final notice: your kolm subscription will be suspended'
    : `Action needed: payment failed for your kolm subscription (attempt ${attempt})`;
  const headline = final
    ? 'We were unable to collect payment after several attempts.'
    : 'We were unable to collect payment for your kolm subscription.';
  const action = final
    ? 'Update your payment method now to avoid suspension. If we cannot collect, your subscription will be suspended and continuous re-attestation will pause.'
    : (retryDate
      ? `We will retry automatically on ${retryDate}. Update your payment method now to avoid any interruption.`
      : 'We will retry automatically over the next few days. Update your payment method now to avoid any interruption.');
  const textLines = [
    headline,
    '',
    amount ? `Amount due: ${amount}` : null,
    `Attempt:    ${attempt}`,
    retryDate && !final ? `Next retry: ${retryDate}` : null,
    '',
    action,
    '',
    `Update payment method: ${url}`,
    '',
    'Questions: dev@kolm.ai',
    '',
    ' - kolm',
  ].filter((l) => l != null);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<div style="max-width:600px;margin:0 auto;padding:24px;font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">`
    + `<p style="margin:0 0 12px 0"><strong>${esc(headline)}</strong></p>`
    + `<div style="background:#f6f5f2;padding:12px;border-radius:6px;font:12px/1.55 ui-monospace,Menlo,monospace">`
    + (amount ? `<div>Amount due: ${esc(amount)}</div>` : '')
    + `<div>Attempt: ${esc(String(attempt))}</div>`
    + (retryDate && !final ? `<div>Next retry: ${esc(retryDate)}</div>` : '')
    + `</div>`
    + `<p style="margin:12px 0">${esc(action)}</p>`
    + `<p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#0b0b0d;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Update payment method</a></p>`
    + `<p style="margin:24px 0 0 0;font-size:12px;color:#555">Questions: <a href="mailto:dev@kolm.ai">dev@kolm.ai</a></p>`
    + `</div>`;
  return { subject, html, text: textLines.join('\n') };
}

export default {
  DUNNING, RETRY_OFFSETS_DAYS,
  retryPaymentFailure, scheduleDunning, resolveDunning, runDueDunning, listDunning, tEmailDunning,
};
