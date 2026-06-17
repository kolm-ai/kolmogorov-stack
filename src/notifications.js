// Wave 215 - threshold alerts for the capture loop.
//
// When a namespace crosses 100 / 500 / 1000 captured pairs, fire:
//   1. an x-kolm-distill-ready: true response header on subsequent capture
//      responses (so SDKs / proxies can flag the namespace immediately),
//   2. a WebPush message to every push subscription registered for the
//      tenant (best-effort; failed subs are removed),
//   3. a transactional email via src/email.js (best-effort; skipped when
//      RESEND_API_KEY is unset).
//
// State is keyed (tenant, namespace) -> last_threshold_fired so each
// threshold fires at most once per namespace per kolm install. Reset the
// per-namespace state row to re-fire (used by tests + the dashboard
// "test alert" button).
//
// Opt-in: a tenant must call setPreferences({ threshold_alerts: true })
// before any threshold fires. Default-off keeps existing tenants quiet.

import { all, insert, update, remove, findOne, find } from './store.js';
import { sendMail, emailConfigured } from './email.js';
import { normalizePushEndpoint, sendWebPush, vapidConfigured, vapidPublicKey } from './webpush.js';

export const THRESHOLDS = [100, 500, 1000];

const PREFS_TABLE = 'notification_preferences';
const STATE_TABLE = 'notification_state';
const PUSH_TABLE = 'push_subscriptions';

export function getPreferences(tenant) {
  if (!tenant) throw new Error('tenant required');
  const row = findOne(PREFS_TABLE, (r) => r.tenant === tenant);
  return row || {
    tenant,
    threshold_alerts: false,
    email: null,
    updated_at: null,
  };
}

export function setPreferences(tenant, patch) {
  if (!tenant) throw new Error('tenant required');
  const existing = findOne(PREFS_TABLE, (r) => r.tenant === tenant);
  const next = {
    tenant,
    threshold_alerts: !!patch.threshold_alerts,
    email: typeof patch.email === 'string' ? patch.email.slice(0, 254) : (existing?.email || null),
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    update(PREFS_TABLE, (r) => r.tenant === tenant, next);
  } else {
    insert(PREFS_TABLE, next);
  }
  return next;
}

export function listPushSubscriptions(tenant) {
  return find(PUSH_TABLE, (r) => r.tenant === tenant);
}

function assertSafePushEndpoint(endpoint) {
  return normalizePushEndpoint(endpoint);
}

export function addPushSubscription(tenant, subscription) {
  if (!tenant) throw new Error('tenant required');
  if (!subscription || !subscription.endpoint) throw new Error('subscription.endpoint required');
  const endpoint = assertSafePushEndpoint(String(subscription.endpoint));
  const existing = findOne(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint);
  const row = {
    tenant,
    endpoint,
    keys: subscription.keys || {},
    created_at: existing?.created_at || new Date().toISOString(),
    last_sent_at: existing?.last_sent_at || null,
  };
  if (existing) {
    update(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint, row);
  } else {
    insert(PUSH_TABLE, row);
  }
  return row;
}

export function removePushSubscription(tenant, endpoint) {
  return remove(PUSH_TABLE, (r) => r.tenant === tenant && r.endpoint === endpoint);
}

export function getThresholdState(tenant, namespace) {
  return findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace) || {
    tenant,
    namespace,
    last_threshold_fired: 0,
    fired_at: null,
  };
}

export function setThresholdState(tenant, namespace, threshold) {
  const existing = findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
  const row = {
    tenant,
    namespace,
    last_threshold_fired: threshold,
    fired_at: new Date().toISOString(),
  };
  if (existing) {
    update(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace, row);
  } else {
    insert(STATE_TABLE, row);
  }
  return row;
}

// W253: atomic check-and-set used by recordCapture to dedupe threshold
// alerts. Returns true if this caller actually advanced the threshold (in
// which case the caller should fire alerts), false if a concurrent capture
// already advanced past `threshold` (in which case alerts were/will be
// fired by that caller). The check + write are collapsed into one
// synchronous block so two same-process await-chains cannot both pass the
// gate. Multi-process deploys still need a DB-level unique constraint;
// vercel_postgres should add a UNIQUE(tenant, namespace, threshold) index
// on the threshold_state table.
export function tryAdvanceThresholdState(tenant, namespace, threshold) {
  const existing = findOne(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
  if (existing && existing.last_threshold_fired >= threshold) return false;
  const row = {
    tenant,
    namespace,
    last_threshold_fired: threshold,
    fired_at: new Date().toISOString(),
  };
  if (existing) {
    update(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace, row);
  } else {
    insert(STATE_TABLE, row);
  }
  return true;
}

export function _resetThresholdState(tenant, namespace) {
  return remove(STATE_TABLE, (r) => r.tenant === tenant && r.namespace === namespace);
}

// nextThreshold(count) -> the threshold this row crosses, or 0 if none.
// Crossing means: count >= T AND prior count < T. Caller passes the count
// AFTER the capture insert.
export function thresholdCrossedBy(prevCount, newCount) {
  for (const t of THRESHOLDS) {
    if (prevCount < t && newCount >= t) return t;
  }
  return 0;
}

// True when the namespace has crossed any threshold (used to set the
// x-kolm-distill-ready response header).
export function isDistillReady(tenant, namespace) {
  const st = getThresholdState(tenant, namespace);
  return st.last_threshold_fired > 0;
}

// Fire alerts for a (tenant, namespace) crossing.
// Caller is expected to dedupe via setThresholdState BEFORE invoking. We
// don't dedupe here so tests can fire alerts at will without bumping state.
export async function fireThresholdAlert({ tenant, namespace, count, threshold, baseUrl }) {
  const prefs = getPreferences(tenant);
  if (!prefs.threshold_alerts) {
    return { ok: false, reason: 'opted_out', tenant, namespace, threshold };
  }
  const subs = listPushSubscriptions(tenant);
  const url = (baseUrl || process.env.PUBLIC_BASE || 'https://kolm.ai') + '/captures?namespace=' + encodeURIComponent(namespace);
  const title = `kolm: namespace "${namespace}" hit ${threshold} captures`;
  const body = threshold >= 1000
    ? `1,000+ captures - Specialist LoRA distill is now ready. Open /captures to promote.`
    : `${count} captures - recipe distill is now ready. Open /captures to preview.`;
  const payload = JSON.stringify({ title, body, url, tenant, namespace, threshold, count });

  const pushResults = [];
  for (const sub of subs) {
    try {
      const r = await sendWebPush(sub, payload);
      pushResults.push({ endpoint: sub.endpoint, ok: r.ok, status: r.status });
      if (r.ok) {
        update(PUSH_TABLE, (x) => x.tenant === tenant && x.endpoint === sub.endpoint, { ...sub, last_sent_at: new Date().toISOString() });
      }
      // 404 / 410 means the subscription is dead - drop it.
      if (r.status === 404 || r.status === 410) {
        removePushSubscription(tenant, sub.endpoint);
      }
    } catch (e) {
      pushResults.push({ endpoint: sub.endpoint, ok: false, error: String(e.message || e) });
    }
  }

  let emailResult = { skipped: true, reason: 'no_recipient' };
  if (prefs.email && emailConfigured()) {
    emailResult = await sendMail({
      to: prefs.email,
      subject: title,
      text: `${body}\n\n${url}\n\nManage notifications: ${url.replace('/captures', '/settings')}`,
      html: `<p>${body}</p><p><a href="${url}">Open /captures</a></p><p style="color:#888;font-size:12px">Manage notifications: <a href="${url.replace('/captures', '/settings')}">/settings</a></p>`,
      tags: [{ name: 'kolm_event', value: 'threshold_alert' }, { name: 'threshold', value: String(threshold) }],
    });
  }

  return {
    ok: true,
    tenant,
    namespace,
    threshold,
    count,
    push: { sent: pushResults.filter((r) => r.ok).length, failed: pushResults.filter((r) => !r.ok).length, results: pushResults },
    email: emailResult,
  };
}

// Public surface for /v1/notifications/preferences GET so the dashboard can
// show "WebPush configured: yes/no" + the VAPID public key the browser
// PushManager.subscribe() call needs.
export function publicConfig() {
  return {
    vapid_public_key: vapidPublicKey(),
    webpush_configured: vapidConfigured(),
    email_configured: emailConfigured(),
    thresholds: THRESHOLDS.slice(),
  };
}

// =====================================================================
// W910 Track C3 - multi-channel webhook notifications.
//
// Adds Slack-incoming-webhook + generic HTTP POST + email channels for
// seven event types. Per-tenant settings are stored in the same
// preferences table; delivery attempts are appended to a delivery log so
// /v1/notifications/log can render the last 50 attempts.
//
// Retry policy: 3 attempts with exponential backoff (250ms, 500ms, 1s).
// Only 5xx + network errors retry; 4xx are terminal.
// =====================================================================

export const NOTIFICATION_EVENT_TYPES = [
  'artifact_compiled',
  'drift_detected',
  'kscore_drop',
  'device_offline',
  'compile_failed',
  'quota_warning',
  'recompile_suggested',
  // Agent Security-Review (ASR) Continuous re-attestation events.
  //   audit_report_ready   - a fresh signed report was published for a subject.
  //   reattestation_drift  - a re-attestation produced a delta (new / resolved
  //                          findings, or a readiness change) vs the prior cycle.
  'audit_report_ready',
  'reattestation_drift',
];

const SETTINGS_TABLE = 'webhook_notification_settings';
const DELIVERY_TABLE = 'notification_deliveries';

const SLACK_HOST_ALLOW = ['hooks.slack.com'];
const SLACK_HOST_SUFFIX_ALLOW = ['.slack.com'];

function assertSafeWebhookUrl(raw, { allowSlack = false } = {}) {
  if (!raw) throw new Error('url required');
  let u;
  try { u = new URL(raw); }
  catch { throw new Error('url must be a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('url must be https://');
  const host = u.hostname.toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[') || host === 'localhost') {
    throw new Error('webhook host must be a public hostname');
  }
  if (allowSlack) {
    const ok = SLACK_HOST_ALLOW.includes(host) || SLACK_HOST_SUFFIX_ALLOW.some((sfx) => host.endsWith(sfx));
    if (!ok) throw new Error('slack webhook must be on hooks.slack.com');
  }
  return u.toString();
}

export function getWebhookSettings(tenant) {
  if (!tenant) throw new Error('tenant required');
  const row = findOne(SETTINGS_TABLE, (r) => r && r.tenant === tenant);
  return row || {
    tenant,
    slack_webhook_url: null,
    http_webhook_url: null,
    email_to: null,
    events: {
      artifact_compiled: true,
      drift_detected: true,
      kscore_drop: true,
      device_offline: true,
      compile_failed: true,
      quota_warning: true,
      recompile_suggested: true,
      audit_report_ready: true,
      reattestation_drift: true,
    },
    updated_at: null,
  };
}

export function setWebhookSettings(tenant, patch) {
  if (!tenant) throw new Error('tenant required');
  const existing = findOne(SETTINGS_TABLE, (r) => r && r.tenant === tenant);
  const next = { ...(existing || getWebhookSettings(tenant)), tenant };
  if ('slack_webhook_url' in patch) {
    next.slack_webhook_url = patch.slack_webhook_url
      ? assertSafeWebhookUrl(String(patch.slack_webhook_url), { allowSlack: true })
      : null;
  }
  if ('http_webhook_url' in patch) {
    next.http_webhook_url = patch.http_webhook_url
      ? assertSafeWebhookUrl(String(patch.http_webhook_url))
      : null;
  }
  if ('email_to' in patch) {
    next.email_to = typeof patch.email_to === 'string' ? patch.email_to.slice(0, 254) : null;
  }
  if (patch.events && typeof patch.events === 'object') {
    const events = { ...(next.events || {}) };
    for (const k of NOTIFICATION_EVENT_TYPES) {
      if (k in patch.events) events[k] = !!patch.events[k];
    }
    next.events = events;
  }
  next.updated_at = new Date().toISOString();
  if (existing) {
    update(SETTINGS_TABLE, (r) => r && r.tenant === tenant, next);
  } else {
    insert(SETTINGS_TABLE, next);
  }
  return next;
}

// A scalar field, hyphen-safe and length-capped, for a Slack section block.
// ASCII only (a Slack payload may be persisted into a delivery log alongside
// signed-report rows, so it stays locale-proof like the rest of this surface).
function _slackField(label, value) {
  return { type: 'mrkdwn', text: `*${label}*\n${String(value == null ? '-' : value).slice(0, 200)}` };
}

function buildSlackBlocks(eventType, payload) {
  const title = eventType.replace(/_/g, ' ');
  const p = payload && typeof payload === 'object' ? payload : {};
  let fields = [];

  // ASR Continuous events get a purpose-built field layout: a buyer-facing
  // subject + the one number that matters + the shareable Trust link.
  if (eventType === 'audit_report_ready') {
    if (p.subject != null) fields.push(_slackField('subject', p.subject));
    if (p.readiness_pct != null) fields.push(_slackField('readiness', `${p.readiness_pct}%`));
    if (p.trust_url != null) fields.push(_slackField('trust link', p.trust_url));
  } else if (eventType === 'reattestation_drift') {
    if (p.subject != null) fields.push(_slackField('subject', p.subject));
    if (p.summary != null) fields.push(_slackField('drift', p.summary));
    if (p.readiness_change != null) {
      const sign = Number(p.readiness_change) > 0 ? '+' : '';
      fields.push(_slackField('readiness change', `${sign}${p.readiness_change}`));
    }
    if (p.trust_url != null) fields.push(_slackField('trust link', p.trust_url));
  } else {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'object') continue;
      fields.push({ type: 'mrkdwn', text: `*${k}*\n${String(v).slice(0, 200)}` });
      if (fields.length >= 10) break;
    }
  }
  if (fields.length > 10) fields = fields.slice(0, 10);
  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `kolm: ${title}` } },
      ...(fields.length ? [{ type: 'section', fields }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Event: \`${eventType}\` - <https://kolm.ai/account/overview|Open dashboard>` }] },
    ],
    text: `kolm: ${title}`,
  };
}

async function postWithRetry(url, body, { headers = {} } = {}) {
  const delays = [0, 250, 500];
  const attempts = [];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    let res, status, errStr;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      status = res.status;
    } catch (e) {
      errStr = String(e.message || e);
    }
    attempts.push({ attempt: i + 1, status: status || 0, error: errStr || null });
    if (status && status >= 200 && status < 300) {
      return { ok: true, status, attempts };
    }
    if (status && status >= 400 && status < 500) {
      return { ok: false, status, attempts, terminal: true };
    }
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, status: last.status || 0, attempts, terminal: false };
}

function logDelivery(row) {
  try { insert(DELIVERY_TABLE, row); } catch { /* best-effort */ }
}

export function listDeliveries(tenant, { limit = 50 } = {}) {
  const rows = find(DELIVERY_TABLE, (r) => r && r.tenant === tenant);
  rows.sort((a, b) => Date.parse(b.attempted_at || '') - Date.parse(a.attempted_at || ''));
  return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}

export async function notify(tenant, eventType, payload = {}) {
  if (!tenant) throw new Error('tenant required');
  if (!NOTIFICATION_EVENT_TYPES.includes(eventType)) {
    throw new Error(`unknown event type ${eventType}`);
  }
  const settings = getWebhookSettings(tenant);
  if (!settings.events?.[eventType]) {
    return { ok: false, reason: 'event_disabled', tenant, eventType };
  }

  const attemptedAt = new Date().toISOString();
  const results = { slack: null, http: null, email: null };

  if (settings.slack_webhook_url) {
    const body = buildSlackBlocks(eventType, payload);
    const r = await postWithRetry(settings.slack_webhook_url, body);
    results.slack = r;
    logDelivery({ tenant, channel: 'slack', event_type: eventType, attempted_at: attemptedAt, ok: r.ok, status: r.status, attempts: r.attempts.length });
  }
  if (settings.http_webhook_url) {
    const body = { event: eventType, tenant, payload, ts: attemptedAt };
    const r = await postWithRetry(settings.http_webhook_url, body, { headers: { 'x-kolm-event': eventType } });
    results.http = r;
    logDelivery({ tenant, channel: 'http', event_type: eventType, attempted_at: attemptedAt, ok: r.ok, status: r.status, attempts: r.attempts.length });
  }
  if (settings.email_to && emailConfigured()) {
    const subject = `kolm: ${eventType.replace(/_/g, ' ')}`;
    const fieldLines = Object.entries(payload).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('\n');
    const html = `<h2 style="font-family:sans-serif;color:#1f2937">kolm: ${eventType.replace(/_/g, ' ')}</h2><pre style="background:#f3f5f7;padding:12px;border-radius:6px;color:#1f2937;font-family:monospace;font-size:12.5px">${fieldLines.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre><p style="font-family:sans-serif;color:#56606c;font-size:13px"><a href="https://kolm.ai/account/overview" style="color:#1f2937">Open dashboard</a></p>`;
    const emailRes = await sendMail({
      to: settings.email_to,
      subject,
      text: `${subject}\n\n${fieldLines}\n\nhttps://kolm.ai/account/overview`,
      html,
      tags: [{ name: 'kolm_event', value: eventType }],
    });
    results.email = emailRes;
    logDelivery({ tenant, channel: 'email', event_type: eventType, attempted_at: attemptedAt, ok: !!emailRes.ok, status: emailRes.status || (emailRes.ok ? 200 : 0), attempts: 1 });
  }

  const okCount = ['slack', 'http', 'email'].filter((c) => results[c] && (results[c].ok || results[c].ok === true)).length;
  const sentCount = ['slack', 'http', 'email'].filter((c) => results[c] != null).length;
  return { ok: okCount > 0 || sentCount === 0, tenant, eventType, results, sent: sentCount, succeeded: okCount, attempted_at: attemptedAt };
}

// Exposed for tests to assert retry/backoff without hitting the network.
export const _internals = { postWithRetry, buildSlackBlocks, assertSafeWebhookUrl };
