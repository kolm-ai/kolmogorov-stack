// src/invoices.js
//
// M11 - durable invoice / receipt ledger. Stripe is the source of truth for the
// hosted invoice page + the PDF, but a Fortune-500 buyer's finance team expects
// to pull every receipt from THEIR account surface without a Stripe login, and
// our own support + audit trail needs a local record that survives a Stripe
// outage. This module stores a tenant-fenced reference row per paid Stripe
// invoice (the URLs + amount + period, never card data) and lists them for the
// account billing page (GET /v1/account/invoices).
//
// Every write is fenced to the purchasing tenant and idempotent on
// stripe_invoice_id, so a webhook retry (Stripe re-delivers liberally) never
// creates a duplicate receipt. Post-write read-back mirrors asr-fulfillment.js
// so a silent ephemeral-store failure surfaces as `retryable` rather than a
// lost receipt.

import { id as storeId, insert, update, find, findOne, withTransaction } from './store.js';

export const INVOICES = 'invoices';

function nowIso() { return new Date().toISOString(); }
function epochToIso(sec) {
  return (typeof sec === 'number' && sec > 0) ? new Date(sec * 1000).toISOString() : null;
}

// Record (or backfill) a tenant invoice from a Stripe invoice object. The Stripe
// `invoice.payment_succeeded` / `invoice.paid` events already carry
// hosted_invoice_url + invoice_pdf, so no extra Stripe round-trip is needed in
// the common path; the router can pass a freshly retrieved invoice when an event
// lacks the URLs.
export function recordInvoiceFromStripe({ tenant_id, invoice, source = 'webhook' } = {}) {
  if (!tenant_id) return { ok: false, reason: 'no_tenant' };
  if (!invoice || typeof invoice !== 'object') return { ok: false, reason: 'no_invoice' };
  const stripeId = invoice.id || null;
  return withTransaction(() => {
    // Tenant-fenced idempotency: the (tenant_id, stripe_invoice_id) pair makes a
    // forged/reused invoice id unable to read or mutate another tenant's row.
    if (stripeId) {
      const existing = findOne(INVOICES, (x) => x && x.tenant_id === tenant_id && x.stripe_invoice_id === stripeId);
      if (existing) {
        // Backfill URLs if a later event carries them and the first did not.
        const patch = {};
        if (!existing.hosted_invoice_url && invoice.hosted_invoice_url) patch.hosted_invoice_url = invoice.hosted_invoice_url;
        if (!existing.invoice_pdf && invoice.invoice_pdf) patch.invoice_pdf = invoice.invoice_pdf;
        if (Object.keys(patch).length) {
          patch.updated_at = nowIso();
          update(INVOICES, (x) => x.id === existing.id, patch);
        }
        return { ok: true, already: true, invoice: findOne(INVOICES, (x) => x.id === existing.id) };
      }
    }
    const ts = nowIso();
    const amountPaid = typeof invoice.amount_paid === 'number'
      ? invoice.amount_paid
      : (typeof invoice.amount_due === 'number' ? invoice.amount_due : (typeof invoice.total === 'number' ? invoice.total : null));
    const row = {
      id: storeId('inv'),
      tenant_id,
      stripe_invoice_id: stripeId,
      number: invoice.number || null,
      amount_paid_cents: amountPaid,
      currency: (invoice.currency || 'usd').toLowerCase(),
      status: invoice.status || 'paid',
      hosted_invoice_url: invoice.hosted_invoice_url || null,
      invoice_pdf: invoice.invoice_pdf || null,
      stripe_customer_id: invoice.customer || null,
      stripe_subscription_id: invoice.subscription || null,
      period_start: epochToIso(invoice.period_start),
      period_end: epochToIso(invoice.period_end),
      description: invoice.description || (invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].description) || null,
      source,
      created_at: ts,
      updated_at: ts,
    };
    insert(INVOICES, row);
    const fresh = findOne(INVOICES, (x) => x.id === row.id);
    if (!fresh) return { ok: false, reason: 'write_unconfirmed', retryable: true };
    return { ok: true, invoice: fresh };
  });
}

// M13 - record an admin-issued refund as a credit-memo row in the same ledger
// so the buyer's finance team sees it on their account surface. Tenant-fenced;
// the amount is stored as a NEGATIVE amount_paid_cents to read as a credit.
export function recordRefund({ tenant_id, stripe_refund_id = null, stripe_charge_id = null, amount_cents = null, currency = 'usd', reason = null } = {}) {
  if (!tenant_id) return { ok: false, reason: 'no_tenant' };
  return withTransaction(() => {
    if (stripe_refund_id) {
      const existing = findOne(INVOICES, (x) => x && x.tenant_id === tenant_id && x.stripe_refund_id === stripe_refund_id);
      if (existing) return { ok: true, already: true, refund: existing };
    }
    const ts = nowIso();
    const cents = (typeof amount_cents === 'number') ? -Math.abs(Math.round(amount_cents)) : null;
    const row = {
      id: storeId('inv'),
      tenant_id,
      stripe_invoice_id: null,
      stripe_refund_id: stripe_refund_id || null,
      stripe_charge_id: stripe_charge_id || null,
      number: null,
      amount_paid_cents: cents,
      currency: (currency || 'usd').toLowerCase(),
      status: 'refunded',
      hosted_invoice_url: null,
      invoice_pdf: null,
      description: reason ? `Refund: ${String(reason).slice(0, 200)}` : 'Refund',
      kind: 'refund',
      source: 'admin_refund',
      created_at: ts,
      updated_at: ts,
    };
    insert(INVOICES, row);
    return { ok: true, refund: findOne(INVOICES, (x) => x.id === row.id) };
  });
}

// List a tenant's invoices, newest first. Tenant-fenced.
export function listInvoices(tenant_id, { limit = 100 } = {}) {
  if (!tenant_id) return [];
  return find(INVOICES, (x) => x && x.tenant_id === tenant_id && !x._deleted)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, Math.max(1, Math.min(limit, 1000)));
}

// Scrub a stored row to the public shape the account page + API surface returns.
export function publicInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    amount_paid_cents: row.amount_paid_cents,
    currency: row.currency,
    status: row.status,
    kind: row.kind || 'invoice',
    hosted_invoice_url: row.hosted_invoice_url,
    invoice_pdf: row.invoice_pdf,
    period_start: row.period_start || null,
    period_end: row.period_end || null,
    description: row.description,
    created_at: row.created_at,
  };
}

export default { INVOICES, recordInvoiceFromStripe, recordRefund, listInvoices, publicInvoice };
