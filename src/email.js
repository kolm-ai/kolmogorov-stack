// Transactional email via Resend HTTP API. No SDK dep - built-in fetch.
//
// Configuration:
//   RESEND_API_KEY          - re_... from https://resend.com/api-keys
//   EMAIL_FROM              - "kolm <hello@kolm.ai>"  (must be a verified
//                              sender on Resend; for the kolm.ai domain,
//                              add the DNS records Resend prints)
//   EMAIL_REPLY_TO          - optional, defaults to EMAIL_FROM
//
// If RESEND_API_KEY is unset, sendMail() returns { skipped: true } so the rest
// of the app never blocks on email - every email path is best-effort.

const RESEND_URL = 'https://api.resend.com/emails';

export function emailConfigured() {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

export async function sendMail({ to, subject, html, text, replyTo, tags }) {
  if (!emailConfigured()) return { skipped: true, reason: 'email_not_configured' };
  if (!to || !subject || (!html && !text)) {
    return { skipped: true, reason: 'missing fields' };
  }
  const body = {
    from: process.env.EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    reply_to: replyTo || process.env.EMAIL_REPLY_TO || undefined,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (tags) body.tags = tags;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] resend error', res.status, json);
      return { ok: false, status: res.status, error: json.message || 'resend error' };
    }
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[email] send threw', err);
    return { ok: false, error: String(err.message || err) };
  }
}

export async function sendWelcome({ email, apiKey, plan, billingUrl }) {
  const planLabel = (plan || 'free').toString();
  const subject = `Your kolm compiler API key${billingUrl ? ' (payment required)' : ''}`;
  const lines = [
    `Welcome to kolm.`,
    ``,
    `Your compiler API key:`,
    `  ${apiKey}`,
    ``,
    `Save it. We don't store the raw key - only a hash. You can rotate any time from`,
    `  https://kolm.ai/account/overview`,
    ``,
    `Plan: ${planLabel}`,
  ];
  if (billingUrl) {
    lines.push('', `Complete payment to activate your paid tier:`, `  ${billingUrl}`);
    lines.push('', `Until payment is confirmed, your account is on the Free tier.`);
  }
  lines.push(
    '',
    `Compiler path: route a namespace through /v1/route, compile it with /v1/compile, then deploy the signed artifact.`,
    `Docs: https://kolm.ai/docs`,
    `Quickstart: https://kolm.ai/docs#quickstart`,
    '',
    ` - kolm`,
  );
  return sendMail({
    to: email,
    subject,
    text: lines.join('\n'),
    html: lines.map(l => l ? `<div>${escapeHtml(l)}</div>` : '<div>&nbsp;</div>').join(''),
    tags: [{ name: 'kind', value: 'welcome' }],
  });
}

export async function sendBillingActivated({ email, plan, quota }) {
  const subject = `Your kolm ${plan} tier is active`;
  const text = [
    `Payment confirmed. Your kolm ${plan} tier is now active.`,
    ``,
    `Monthly quota: ${quota.toLocaleString()} requests.`,
    ``,
    `Manage at https://kolm.ai/account.`,
    ``,
    ` - kolm`,
  ].join('\n');
  return sendMail({ to: email, subject, text, tags: [{ name: 'kind', value: 'billing_activated' }] });
}

export async function sendBillingFailed({ email, plan }) {
  const subject = `Action needed: payment failed for your kolm ${plan} tier`;
  const text = [
    `Stripe was unable to charge your card for the ${plan} tier.`,
    ``,
    `Stripe will retry automatically over the next 7 days. To update your payment method`,
    `or cancel, manage your subscription at https://kolm.ai/account.`,
    ``,
    `Your account stays active during the retry window. If all retries fail your tenant`,
    `will downgrade to the Free tier.`,
    ``,
    ` - kolm`,
  ].join('\n');
  return sendMail({ to: email, subject, text, tags: [{ name: 'kind', value: 'billing_failed' }] });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------------------
// Wave 253 sec#5 - setup-token flow.
//
// Background: pre-W253 the welcome email carried the raw API key in plaintext
// in the message body AND inside Resend's request log. A leak of EMAIL_FROM's
// Resend log (or an inbox compromise weeks after onboarding) would surrender
// every customer key. The setup token replaces that with:
//
//   1. Mint at signup time: tok = base64url({apiKeyId, exp}) + '.' + hmac(secret, payload)
//      The token NEVER carries the raw key, only the apiKeyId opaque handle.
//   2. Welcome email links to /setup?token=<tok>. The link expires in 30
//      minutes (configurable via KOLM_SETUP_TOKEN_TTL_SEC). After expiry the
//      user must request a fresh token via /forgot-key.
//   3. Browser POSTs the token to /v1/setup/reveal. The backend calls
//      verifySetupToken, then consumeRawKeyForReveal(apiKeyId) which is a
//      one-shot in-memory cache populated at signup. After one consume the
//      key is gone; refreshing the page shows a "key already revealed" error
//      and the user must rotate.
//
// The secret is KOLM_SETUP_SECRET. If the env var is unset we mint a process-
// local fallback in process.__kolm_setup_secret_fallback so dev still works.
// ---------------------------------------------------------------------------

import nodeCrypto from 'node:crypto';

const SETUP_TTL_SEC = Number(process.env.KOLM_SETUP_TOKEN_TTL_SEC || 1800);

function getSetupSecret() {
  if (process.env.KOLM_SETUP_SECRET) return String(process.env.KOLM_SETUP_SECRET);
  if (!process.__kolm_setup_secret_fallback) {
    process.__kolm_setup_secret_fallback = nodeCrypto.randomBytes(32).toString('hex');
  }
  return process.__kolm_setup_secret_fallback;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function mintSetupToken(apiKeyId, opts = {}) {
  const exp = Date.now() + (opts.ttlSec || SETUP_TTL_SEC) * 1000;
  const payload = JSON.stringify({ apiKeyId: String(apiKeyId), exp });
  const head = b64urlEncode(payload);
  const sig = b64urlEncode(nodeCrypto.createHmac('sha256', getSetupSecret()).update(head).digest());
  return head + '.' + sig;
}

export function verifySetupToken(tok) {
  try {
    if (typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
    const [head, sig] = tok.split('.', 2);
    if (!head || !sig) return null;
    const expected = b64urlEncode(nodeCrypto.createHmac('sha256', getSetupSecret()).update(head).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(head));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// In-memory single-use cache: { apiKeyId -> { key, exp } }
const RAW_KEY_CACHE = new Map();

export function cacheRawKeyForReveal(apiKeyId, rawKey, opts = {}) {
  if (!apiKeyId || !rawKey) return;
  const exp = Date.now() + (opts.ttlSec || SETUP_TTL_SEC) * 1000;
  RAW_KEY_CACHE.set(String(apiKeyId), { key: String(rawKey), exp });
  // Lazy GC - sweep on every set so the map never grows unbounded.
  const now = Date.now();
  for (const [k, v] of RAW_KEY_CACHE) {
    if (v.exp < now) RAW_KEY_CACHE.delete(k);
  }
}

export function consumeRawKeyForReveal(apiKeyId) {
  if (!apiKeyId) return null;
  const id = String(apiKeyId);
  const entry = RAW_KEY_CACHE.get(id);
  if (!entry) return null;
  RAW_KEY_CACHE.delete(id);
  if (entry.exp < Date.now()) return null;
  return entry.key;
}

// ---------------------------------------------------------------------------
// LM-8 (V1 launch 2026-05-26) - transactional email surface.
//
// Three template helpers + one sendEmail() façade. The transport is Resend
// over plain fetch (no SDK dep). If RESEND_API_KEY is unset OR the network
// throws, the envelope is appended to data/email-outbox.jsonl so the rest of
// the system never has to know whether the secret is rotated yet. The local
// outbox is the launch-day safety net: kolm ships even when secrets haven't
// reached prod env.
//
// sendEmail() NEVER throws. Three return shapes:
//   { ok: true, delivered: true,  message_id }   - Resend ack
//   { ok: true, delivered: false, queued: true } - local outbox fallback
//   { ok: true, delivered: false, queued: false, reason } - bad input (no to/subject/body)
//
// Templates (tEmail*) are pure functions - they return {subject, html, text}
// and do not perform IO. That keeps unit tests synchronous and lets the
// caller pre-render the body for audit logs before sending.
// ---------------------------------------------------------------------------

import nodeFs from 'node:fs';
import nodePath from 'node:path';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_OUTBOX_PATH = nodePath.resolve(process.cwd(), 'data', 'email-outbox.jsonl');

function _emailFrom() {
  return process.env.KOLM_EMAIL_FROM || 'kolm <hello@kolm.ai>';
}

function _appendOutbox(envelope) {
  try {
    const dir = nodePath.dirname(EMAIL_OUTBOX_PATH);
    if (!nodeFs.existsSync(dir)) nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.appendFileSync(EMAIL_OUTBOX_PATH, JSON.stringify(envelope) + '\n');
    return true;
  } catch (_e) {
    // Even the outbox is best-effort - disk full, read-only FS, etc. We log
    // and swallow rather than throw because email is never load-bearing for
    // the calling handler.
    try { console.error('[email] outbox write failed', _e && _e.message); } catch (_) {} // deliberate: cleanup
    return false;
  }
}

export async function sendEmail({ to, subject, html, text, tag } = {}) {
  // Bad-input guard. We do not throw - the caller is always fire-and-forget.
  if (!to || !subject || (!html && !text)) {
    return { ok: true, delivered: false, queued: false, reason: 'missing_fields' };
  }
  const envelope = {
    ts: new Date().toISOString(),
    to,
    subject,
    tag: tag || null,
    html: html || null,
    text: text || null,
  };

  // No API key -> drop straight into the outbox.
  if (!process.env.RESEND_API_KEY) {
    const queued = _appendOutbox(envelope);
    return { ok: true, delivered: false, queued };
  }

  try {
    const body = {
      from: _emailFrom(),
      to: Array.isArray(to) ? to : [to],
      subject,
    };
    if (html) body.html = html;
    if (text) body.text = text;
    if (tag) body.tags = [{ name: 'kind', value: String(tag) }];

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Resend rejected (4xx/5xx). Treat as a transport failure - queue locally
      // so the audit trail is preserved and an operator can replay later.
      _appendOutbox({ ...envelope, _resend_status: res.status });
      return { ok: true, delivered: false, queued: true };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, delivered: true, message_id: json.id || null };
  } catch (_err) {
    // Network blew up. Same fallback path as the missing-key branch.
    _appendOutbox({ ...envelope, _send_error: String(_err && _err.message || _err) });
    return { ok: true, delivered: false, queued: true };
  }
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function _wrapHtml(blocks) {
  // Inline-style block: every transactional client renders this consistently
  // (Gmail/Outlook strip <style>). 600px max-width is the de-facto standard.
  const inner = blocks.map((b) => {
    if (b == null) return '';
    if (typeof b === 'string') return `<p style="margin:0 0 12px 0;font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">${b}</p>`;
    return b;
  }).join('');
  return `<div style="max-width:600px;margin:0 auto;padding:24px;font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">${inner}</div>`;
}

function _ctaButton(label, href) {
  return `<p style="margin:20px 0"><a href="${_esc(href)}" style="display:inline-block;padding:10px 18px;background:#0b0b0d;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${_esc(label)}</a></p>`;
}

// Signup confirmation - sent fire-and-forget on /v1/signup success.
// Single CTA to /account/overview (per LM-8 spec). Plan label appears in
// both subject and body so the recipient can disambiguate multi-tenant signups.
export function tEmailSignup({ email, tenant_id, plan_tier } = {}) {
  const plan = String(plan_tier || 'free').toLowerCase();
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const acctUrl = 'https://kolm.ai/account/overview';
  const subject = `Welcome to kolm - your ${planLabel} compiler workspace is live`;
  const textLines = [
    `Welcome to kolm.`,
    ``,
    `Your compiler workspace is provisioned on the ${planLabel} tier.`,
    `Tenant: ${tenant_id || '(pending)'}`,
    `Email:  ${email || '(unknown)'}`,
    ``,
    `Open your compiler overview to grab your API key, set spending caps,`,
    `route one namespace through the API wrapper, and compile your first artifact:`,
    `  ${acctUrl}`,
    ``,
    `Docs:        https://kolm.ai/docs`,
    `Quickstart:  https://kolm.ai/docs#quickstart`,
    ``,
    `Reply to this email if you hit any friction.`,
    ``,
    ` - kolm`,
  ];
  const html = _wrapHtml([
    `Welcome to <strong>kolm</strong>.`,
    `Your compiler workspace is provisioned on the <strong>${_esc(planLabel)}</strong> tier.`,
    `<div style="background:#f6f5f2;padding:12px;border-radius:6px;font:12px/1.55 ui-monospace,Menlo,monospace"><div>Tenant: ${_esc(tenant_id || '(pending)')}</div><div>Email: ${_esc(email || '(unknown)')}</div></div>`,
    `Open your compiler overview to grab your API key, set spending caps, route one namespace through the API wrapper, and compile your first artifact.`,
    _ctaButton('Open compiler overview', acctUrl),
    `<p style="margin:24px 0 0 0;font:12px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#555">Docs: <a href="https://kolm.ai/docs">kolm.ai/docs</a> &nbsp;/&nbsp; Quickstart: <a href="https://kolm.ai/docs#quickstart">kolm.ai/docs#quickstart</a></p>`,
  ]);
  return { subject, html, text: textLines.join('\n') };
}

// Signed Readiness Report ready - sent fire-and-forget after a $750 purchase
// clears (Stripe webhook). Single CTA to the shareable Trust link the buyer
// hands their reviewer. readiness_pct + subject_name are optional context.
export function tEmailReportReady({ email, report_id, trust_url, readiness_pct, subject_name } = {}) {
  const url = trust_url || 'https://kolm.ai/dashboard';
  const pct = (readiness_pct == null || readiness_pct === '') ? null : `${readiness_pct}%`;
  const subj = subject_name || 'your agent fleet';
  const subject = 'Your Signed Readiness Report is ready';
  const textLines = [
    `Your Signed Readiness Report is ready.`,
    ``,
    `Subject:   ${subj}`,
    pct ? `Readiness: ${pct} (assessed controls)` : null,
    `Report id: ${report_id || '(pending)'}`,
    ``,
    `Share this link with your buyer's security review group. It renders the`,
    `signed report and lets them verify the Ed25519 signature offline, with no`,
    `kolm account:`,
    `  ${url}`,
    ``,
    `The report is unwatermarked and distributable. The signature covers every`,
    `byte, so a single altered finding breaks verification.`,
    ``,
    `Questions: dev@kolm.ai`,
    ``,
    ` - kolm`,
  ].filter((l) => l != null);
  const html = _wrapHtml([
    `Your <strong>Signed Readiness Report</strong> is ready.`,
    `<div style="background:#f6f5f2;padding:12px;border-radius:6px;font:12px/1.55 ui-monospace,Menlo,monospace"><div>Subject: ${_esc(subj)}</div>${pct ? `<div>Readiness: ${_esc(pct)} (assessed controls)</div>` : ''}<div>Report: ${_esc(report_id || '(pending)')}</div></div>`,
    `Share this link with your buyer's security review group. It renders the signed report and lets them verify the Ed25519 signature offline, with no kolm account.`,
    _ctaButton('Open the Trust link', url),
    `<p style="margin:24px 0 0 0;font:12px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#555">The report is unwatermarked and distributable. The signature covers every byte, so a single altered finding breaks verification. &nbsp;·&nbsp; Questions: <a href="mailto:dev@kolm.ai">dev@kolm.ai</a></p>`,
  ]);
  return { subject, html, text: textLines.join('\n') };
}

// Compile-done - sent on both success and failure paths.
// k_score and duration_s are optional (failure path may not have them).
export function tEmailCompileDone({ email, tenant_id, artifact_id, status, k_score, duration_s } = {}) {
  const ok = String(status) === 'success';
  const aid = artifact_id || '(unknown)';
  const aHref = `https://kolm.ai/account/artifacts/${encodeURIComponent(aid)}`;
  const subject = ok
    ? `Compile finished - ${aid}`
    : `Compile failed - ${aid}`;
  const dur = (typeof duration_s === 'number') ? `${duration_s.toFixed(1)}s` : ' - ';
  const k = (typeof k_score === 'number') ? k_score.toFixed(3) : ' - ';
  const verb = ok ? 'completed' : 'failed';
  const textLines = [
    `Your compile job ${verb}.`,
    ``,
    `Artifact:    ${aid}`,
    `Tenant:      ${tenant_id || '(unknown)'}`,
    `Status:      ${ok ? 'success' : 'failed'}`,
    `K-score:     ${k}`,
    `Duration:    ${dur}`,
    ``,
    ok
      ? `Inspect or run the artifact from your dashboard:`
      : `Open the compile log to see the failure detail:`,
    `  ${aHref}`,
    ``,
    ` - kolm`,
  ];
  const statusBadge = ok
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#e6f7ec;color:#0a5;font-weight:600">success</span>`
    : `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#fde8e8;color:#a01;font-weight:600">failed</span>`;
  const html = _wrapHtml([
    `Your compile job ${verb}. ${statusBadge}`,
    `<div style="background:#f6f5f2;padding:12px;border-radius:6px;font:12px/1.55 ui-monospace,Menlo,monospace"><div>Artifact: ${_esc(aid)}</div><div>Tenant: ${_esc(tenant_id || '(unknown)')}</div><div>K-score: ${_esc(k)}</div><div>Duration: ${_esc(dur)}</div></div>`,
    ok
      ? `Inspect or run the artifact from your dashboard.`
      : `Open the compile log to see the failure detail.`,
    _ctaButton(ok ? 'Open artifact' : 'Open compile log', aHref),
  ]);
  return { subject, html, text: textLines.join('\n') };
}

// Usage alert - fires at 80% and 100% of the monthly gateway-call cap.
// `threshold` is 80 or 100. Upgrade CTA appears for non-enterprise tiers
// only - enterprise has bespoke billing terms and a /pricing link would be
// noise.
export function tEmailUsageAlert({ email, tenant_id, threshold, used, cap, plan_tier } = {}) {
  const th = Number(threshold) || 0;
  const plan = String(plan_tier || 'free').toLowerCase();
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const isAt100 = th >= 100;
  const isEnterprise = plan === 'enterprise';
  const usedN = (typeof used === 'number') ? used : 0;
  const capN = (typeof cap === 'number' && cap > 0) ? cap : 0;
  const pctLabel = capN > 0
    ? `${Math.round((usedN / capN) * 100)}%`
    : `${th}%`;
  const subject = isAt100
    ? `Usage cap reached - kolm gateway calls are paused`
    : `You have used 80% of your monthly kolm gateway cap`;
  const acctUrl = 'https://kolm.ai/account/overview';
  const priceUrl = 'https://kolm.ai/pricing';
  const headline = isAt100
    ? `You have hit 100% of your monthly gateway-call cap.`
    : `You have used 80% of your monthly gateway-call cap.`;
  const action = isAt100
    ? `New gateway calls are being rejected with HTTP 429 until your quota resets at the start of the next billing period.`
    : `You have headroom for now, but at the current rate you may exceed the cap before the period ends.`;
  const textLines = [
    headline,
    ``,
    `Tenant:    ${tenant_id || '(unknown)'}`,
    `Plan:      ${planLabel}`,
    `Used:      ${usedN.toLocaleString()} / ${capN.toLocaleString()} (${pctLabel})`,
    `Threshold: ${th}%`,
    ``,
    action,
    ``,
    `Account overview:  ${acctUrl}`,
  ];
  if (!isEnterprise) {
    textLines.push(`Upgrade plan:      ${priceUrl}`);
  } else {
    textLines.push(`Contact your kolm account rep to raise the cap.`);
  }
  textLines.push('', ' - kolm');

  const ctaHtml = isEnterprise
    ? _ctaButton('Open account overview', acctUrl)
    : `${_ctaButton('Upgrade plan', priceUrl)}<p style="margin:8px 0;font:12px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#555">Or review your usage at <a href="${_esc(acctUrl)}">${_esc(acctUrl)}</a></p>`;

  const html = _wrapHtml([
    `<strong>${_esc(headline)}</strong>`,
    `<div style="background:#f6f5f2;padding:12px;border-radius:6px;font:12px/1.55 ui-monospace,Menlo,monospace"><div>Tenant: ${_esc(tenant_id || '(unknown)')}</div><div>Plan: ${_esc(planLabel)}</div><div>Used: ${_esc(String(usedN))} / ${_esc(String(capN))} (${_esc(pctLabel)})</div><div>Threshold: ${_esc(String(th))}%</div></div>`,
    action,
    ctaHtml,
  ]);
  return { subject, html, text: textLines.join('\n') };
}

// Exposed for tests + CLI introspection.
export function emailOutboxPath() { return EMAIL_OUTBOX_PATH; }
