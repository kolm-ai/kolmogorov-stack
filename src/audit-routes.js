// src/audit-routes.js
//
// Agent Security-Review audit - the HTTP surface that turns the deterministic
// trinity (src/audit-orchestrator.js) into the deliverable a buyer's review
// group receives: a cryptographically signed (Ed25519), offline-verifiable
// evidence report.
//
// Exports register(r, deps) so the orchestrator mounts the whole surface with
// ONE call (import + register) and does NOT edit the body of buildRouter().
// Mirrors src/intoto-receipt-routes.js: auth-required + tenant-scoped (the
// tenant id is forced from req.tenant_record.id, never read from body/query),
// every handler returns a well-formed {ok,...} envelope, nothing throws across
// the boundary. The single exception is POST /v1/audit/report/verify, which is
// PUBLIC (added to PUBLIC_API in src/auth.js) because offline verification must
// work for a reviewer who has no kolm account.
//
// Routes (none collide with the pre-existing GET /v1/audit/{log,verify,export*}
// - those are HMAC audit-LOG routes; everything here lives under
// /v1/audit/sessions, /v1/audit/scan, or /v1/audit/report):
//
//   POST /v1/audit/sessions                  create a session            (201)
//   POST /v1/audit/sessions/:id/ingest       append logs to a session    (200)
//   POST /v1/audit/sessions/:id/run          run + sign the report       (200)
//   GET  /v1/audit/sessions/:id              session status + summary    (200)
//   GET  /v1/audit/sessions/:id/report       fetch report ?format=json|html|pdf
//   POST /v1/audit/scan                       one-shot scan → signed report
//   POST /v1/audit/report/verify  (PUBLIC)    verify a posted signed report

import { insert, update, find, findByField, withTransaction, id as storeId } from './store.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, AUDIT_SPEC_VERSION } from './audit-orchestrator.js';
import {
  buildAndSignReport,
  renderReportHtml,
  renderReportPdf,
  verifyReport,
  stripWirePayload,
  AUDIT_REPORT_SCHEMA,
  AUDIT_REPORT_VERSION,
} from './attestation-report-builder.js';
import { EXPORTERS as FRAMEWORK_EXPORTERS, EXPORT_FORMATS } from './framework-export.js';
import { buildOscalAssessmentResults, buildRemediationTable } from './oscal-export.js';
import { loadOrCreateDefaultSigner, keyFingerprint } from './ed25519.js';
import { register as registerTransparencyLogRoutes } from './transparency-log-routes.js';
import { register as registerTrustCenter, recordTrustView } from './trust-center.js';
import { revoke as revokeIssuerKey, status as issuerKeyStatus, KEY_REVOCATION_VERSION } from './key-revocation.js';
import { tryAppendAudit } from './audit.js';
import { createAsrCheckout, asrBillingReady } from './asr-billing.js';
import { resolveTrust, resolvePriorReport, runDueReattestations, forceReattest, SUBSCRIPTIONS as ASR_SUBSCRIPTIONS } from './asr-fulfillment.js';
import { computeAuditDelta } from './audit-delta.js';
import { runFixRetest } from './fix-retest.js';
import { autofillQuestionnaire, toQuestionnaireCsv, QUESTIONNAIRE_TEMPLATES } from './questionnaire-autofill.js';
import { importAgentLogs } from './log-importer.js';
import { normalizeCoverageDeclaration } from './coverage-declaration.js';
import { allCapturesForTenant } from './capture-store.js';
import { KOLM_CAPTURE_SOURCE } from './audit-ingest.js';
import { addWatch, buildPortfolioView } from './buyer-portfolio.js';
import { runActiveBattery, ACTIVE_PROBE_IDS, ACTIVE_RED_TEAM_SPEC_VERSION } from './active-redteam.js';
import { mergeActiveResults } from './red-team.js';
// One-off run notifications: notify() is async and can throw (unknown event /
// store hiccup); see _notifyReportReady below for the fire-and-forget wrapper
// that keeps it out of the response path.
import { notify } from './notifications.js';

export const AUDIT_ROUTES_VERSION = 'asr-audit-routes/0.2';

const TABLE = 'agent_audits';

// ---------------------------------------------------------------------------
// tenantHasReportEntitlement(tenantId, auditRow?) -> Promise<boolean>
//
// The REVENUE GATE the report routes call to decide summary-vs-report (and
// 403-vs-deliverable). A tenant is entitled to the FULL signed report when
// EITHER:
//   (a) the specific audit row was PAID for - paid:true, or tier:'report'
//       (the one-off Signed Readiness Report purchase flips both), OR
//   (b) the tenant holds an ACTIVE Continuous subscription (an asr_subscriptions
//       row with status:'active') - the subscription entitles every deliverable
//       the tenant fetches/exports, even off an unpaid scan row.
//
// A cancelled / lapsed subscription does NOT entitle. A null/empty tenant id
// never accidentally entitles. Async so the gate can later consult an external
// billing source without changing call sites; the current implementation reads
// the local store synchronously.
// ---------------------------------------------------------------------------
export async function tenantHasReportEntitlement(tenantId, auditRow = null) {
  // (a) the audit row itself was paid.
  if (auditRow && typeof auditRow === 'object') {
    if (auditRow.paid === true) return true;
    if (auditRow.tier === 'report') return true;
  }
  // (b) an active Continuous subscription on this tenant.
  const tid = tenantId == null ? '' : String(tenantId);
  if (!tid) return false;
  const activeSub = find(ASR_SUBSCRIPTIONS, (s) => s && s.tenant_id === tid && s.status === 'active');
  return Array.isArray(activeSub) ? activeSub.length > 0 : !!activeSub;
}

// Defensive cap so a single tenant cannot accumulate an unbounded session in
// the JSON store. 20k records is far above any real agent export a buyer hands
// over; beyond it we ask the caller to split the export.
const MAX_RECORDS_PER_SESSION = 20000;

// Byte ceiling on the accumulated JSONL for one session. The express body limit
// (4mb) caps a single request, but /ingest accumulates across calls - without a
// byte cap a caller could grow the stored logs unboundedly (and, because the
// JSON store rewrites the whole table file per write, turn accumulation into
// O(n²) I/O). 24 MiB holds a very large export while staying far under anything
// that would strain the store.
const MAX_BYTES_PER_SESSION = 24 * 1024 * 1024;

// Retention window is a buyer-facing number (mapped to EU AI Act Art.12). Clamp
// the caller-supplied value to a sane integer range so a garbage / hostile value
// never reaches the analyzer or the report. null = "not declared".
function _clampRetentionDays(v) {
  if (!Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 0) return 0;
  if (n > 36500) return 36500; // 100 years - an obvious upper sanity bound
  return n;
}

// Operator egress allowlist (GAP-1 plumbing half): the request body may carry
// allowed_hosts, the set of egress destinations the operator sanctions. It is
// threaded into runAudit's analyzerOpts.egress.allowedHosts so the egress
// analyzer grades observed destinations against the operator's intent. Caps
// keep a hostile body from inflating the audit: <=200 entries, each a hostname
// string <=253 chars (RFC 1035 name length).
const MAX_ALLOWED_HOSTS = 200;
const MAX_HOST_LEN = 253;
function _normalizeAllowedHosts(raw) {
  if (raw == null) return { ok: true, hosts: null };
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_HOSTS) return { ok: false };
  const hosts = [];
  for (const h of raw) {
    if (typeof h !== 'string') return { ok: false };
    const s = h.trim().toLowerCase();
    if (!s || s.length > MAX_HOST_LEN) return { ok: false };
    hosts.push(s);
  }
  return { ok: true, hosts: hosts.length ? hosts : null };
}

// Coverage declaration (GAP-3): validate the body's coverage_declaration via
// src/coverage-declaration.js. Returns { ok:true, declaration|null } or
// { ok:false, error } for the route to map onto a 400.
function _coverageFromBody(body) {
  if (!body || body.coverage_declaration == null) return { ok: true, declaration: null };
  const norm = normalizeCoverageDeclaration(body.coverage_declaration);
  if (!norm.ok) return { ok: false, error: norm.error };
  return { ok: true, declaration: norm.declaration };
}

const MAX_ACTIVE_HEADERS = 50;
const MAX_ACTIVE_HEADER_VALUE_LEN = 8192;
const SAFE_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BLOCKED_ACTIVE_HEADERS = new Set(['connection', 'content-length', 'host', 'transfer-encoding', 'upgrade']);

function _normalizeActiveHeaders(raw) {
  if (raw == null) return { ok: true, headers: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'active headers must be an object of HTTP header names to scalar values' };
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_ACTIVE_HEADERS) {
    return { ok: false, error: `active headers are capped at ${MAX_ACTIVE_HEADERS} entries` };
  }
  const headers = {};
  for (const [nameRaw, valueRaw] of entries) {
    const name = String(nameRaw || '').trim().toLowerCase();
    if (!name || !SAFE_HEADER_NAME.test(name) || BLOCKED_ACTIVE_HEADERS.has(name)) {
      return { ok: false, error: `active header "${nameRaw}" is not allowed` };
    }
    if (!['string', 'number', 'boolean'].includes(typeof valueRaw)) {
      return { ok: false, error: `active header "${name}" must have a scalar value` };
    }
    const value = String(valueRaw);
    if (value.length > MAX_ACTIVE_HEADER_VALUE_LEN || /[\r\n]/.test(value)) {
      return { ok: false, error: `active header "${name}" has an invalid value` };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}

function _normalizeActiveProbeIds(raw) {
  if (raw == null) return { ok: true, ids: null };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ACTIVE_PROBE_IDS.length) {
    return { ok: false, error: `active probe_ids must be a non-empty array of at most ${ACTIVE_PROBE_IDS.length} known probe ids` };
  }
  const allowed = new Set(ACTIVE_PROBE_IDS);
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'active probe_ids must contain strings only' };
    const id = item.trim();
    if (!allowed.has(id)) return { ok: false, error: `unknown active probe id: ${id}` };
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ok: true, ids };
}

function _activeModelFromBody(body) {
  const raw = body && body.model != null ? body.model : 'staging-agent';
  const model = String(raw || '').trim();
  return model ? model.slice(0, 200) : 'staging-agent';
}

function _activeTimeoutFromBody(body) {
  const n = Number(body && body.timeout_ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(250, Math.min(60000, Math.trunc(n)));
}

function _activeResponseSummary(activeRun, mergedRedTeam) {
  const probes = activeRun && Array.isArray(activeRun.probes) ? activeRun.probes : [];
  const counts = { resisted: 0, exposed: 0, untested: 0 };
  for (const p of probes) {
    if (p && Object.prototype.hasOwnProperty.call(counts, p.status)) counts[p.status] += 1;
  }
  const mergedCount = mergedRedTeam
    && mergedRedTeam.summary
    && mergedRedTeam.summary.active
    && Number.isFinite(mergedRedTeam.summary.active.probes_merged)
    ? mergedRedTeam.summary.active.probes_merged
    : 0;
  return {
    spec_version: activeRun && activeRun.spec_version ? activeRun.spec_version : ACTIVE_RED_TEAM_SPEC_VERSION,
    endpoint_digest: activeRun && typeof activeRun.endpoint_digest === 'string' ? activeRun.endpoint_digest : null,
    consent_recorded: !!(activeRun && activeRun.consent),
    consent_attestor: activeRun && activeRun.consent && activeRun.consent.attestor ? activeRun.consent.attestor : null,
    consent_asserted_at: activeRun && activeRun.consent && activeRun.consent.asserted_at ? activeRun.consent.asserted_at : null,
    probes_total: probes.length,
    probes_merged: mergedCount,
    resisted: counts.resisted,
    exposed: counts.exposed,
    untested: counts.untested,
    probes: probes.map((p) => ({
      id: p.id,
      status: p.status,
      transcript_digest: typeof p.transcript_digest === 'string' ? p.transcript_digest : null,
    })),
  };
}

// Normalize a caller-supplied source/source_label EXACTLY as the grading path
// will see it. The routes stamp String(raw).slice(0,64); runAudit then trims,
// and computeEvidenceTier trims again before comparing to KOLM_CAPTURE_SOURCE.
// So the effective graded value is trim(slice(raw,0,64)). The reserved-source
// guard MUST test this same form - testing String(raw).trim() instead let a
// value like "kolm-capture"+52_spaces+"X" (65 chars) slip the guard yet slice
// back to "kolm-capture" downstream and forge a grade-A capture attestation
// over vendor logs. One normalizer, used by both the guard and the stamp,
// closes that gap permanently.
function _normalizeSource(raw) {
  if (raw == null) return null;
  return String(raw).slice(0, 64).trim();
}
function _claimsCaptureSource(raw) {
  return _normalizeSource(raw) === KOLM_CAPTURE_SOURCE;
}

// Lightweight per-IP fixed-window limiter for the PUBLIC verify route. Pure
// compute, but still abusable as a CPU sink, so cap it. Honors
// KOLM_RATE_LIMIT_DISABLED=1 (set in tests). Self-contained - no express-rate-
// limit dependency, no proxy-trust config to get wrong.
const _VERIFY_RL = { windowMs: 60 * 1000, max: 120, hits: new Map() };
function _verifyRateLimited(req) {
  if (process.env.KOLM_RATE_LIMIT_DISABLED === '1') return false;
  const now = Date.now();
  let ip = 'unknown';
  try {
    ip = req.ip
      || (req.headers && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
      || (req.socket && req.socket.remoteAddress)
      || 'unknown';
  } catch { /* keep 'unknown' */ }
  let e = _VERIFY_RL.hits.get(ip);
  if (!e || now - e.start >= _VERIFY_RL.windowMs) { e = { start: now, n: 0 }; _VERIFY_RL.hits.set(ip, e); }
  e.n += 1;
  // Opportunistic sweep so the map cannot grow without bound.
  if (_VERIFY_RL.hits.size > 5000) {
    for (const [k, v] of _VERIFY_RL.hits) { if (now - v.start >= _VERIFY_RL.windowMs) _VERIFY_RL.hits.delete(k); }
  }
  return e.n > _VERIFY_RL.max;
}

function _err(res, code, error, detail) {
  return res.status(code).json({ ok: false, error, ...(detail ? { detail: String(detail) } : {}) });
}

// ---------------------------------------------------------------------------
// Tier-2 issuer provenance (server side). verifyReport() proves tier-1 only:
// "signed by the holder of the embedded key, untampered since". That is NOT
// enough on its own - a forger can re-sign an EDITED report with their OWN key
// and tier-1 still passes. Tier-2 asks the second question: is that embedded
// key one this product recognizes (the live signer, or a published issuer in
// public/keys/kolm-issuers.json)? The /verify browser page does the same check;
// mirroring it here closes the same forgeability on the HTTP route. Pure, never
// throws.
// ---------------------------------------------------------------------------
function _normPem(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

const _KEYRING_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'keys', 'kolm-issuers.json');
let _keyringCache; // undefined = not loaded; array thereafter
function _publishedIssuers() {
  if (_keyringCache !== undefined) return _keyringCache;
  try {
    const k = JSON.parse(fs.readFileSync(_KEYRING_PATH, 'utf8'));
    _keyringCache = (k && Array.isArray(k.issuers)) ? k.issuers.filter((i) => i && typeof i.public_key === 'string') : [];
  } catch { _keyringCache = []; }
  return _keyringCache;
}

let _liveSignerPubCache; // undefined = unknown, null = none, string = normalized PEM
function _liveSignerPubNorm() {
  if (_liveSignerPubCache === undefined) {
    try { const s = loadOrCreateDefaultSigner(); _liveSignerPubCache = (s && s.publicKey) ? _normPem(s.publicKey) : null; }
    catch { _liveSignerPubCache = null; }
  }
  return _liveSignerPubCache;
}

function _issuerProvenance(envelope) {
  const out = { recognized: false, matches_live_signer: false };
  try {
    const block = envelope && typeof envelope === 'object' ? envelope.signature_ed25519 : null;
    const pem = block && typeof block === 'object' && typeof block.public_key === 'string' ? block.public_key : null;
    if (!pem) return out;
    const target = _normPem(pem);
    if (target && _liveSignerPubNorm() === target) {
      return { recognized: true, matches_live_signer: true, kid: 'live', status: 'live' };
    }
    for (const iss of _publishedIssuers()) {
      if (_normPem(iss.public_key) === target) {
        return { recognized: true, matches_live_signer: false, kid: iss.kid || null, label: iss.label || null, status: iss.status || null };
      }
    }
  } catch { /* never throw across the verify boundary */ }
  return out;
}

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec || !trec.id) {
    res.status(401).json({ ok: false, error: 'auth_required', hint: 'send Authorization: Bearer <ks_* key>' });
    return null;
  }
  return trec;
}

function _newId() {
  return 'audses_' + crypto.randomBytes(10).toString('hex');
}

// Normalize any accepted log shape (JSONL text, a JSON array/wrapper string, an
// array of records/strings, or a single record) into clean JSONL text +
// a record count. Storing TEXT (not an array of strings) keeps accumulation
// across multiple /ingest calls valid - two JSON-array strings can't be
// concatenated, but two JSONL blocks can - and avoids the array-of-strings
// trap in ingestForAudit (which treats a string element as a non-object record).
function _toJsonl(input) {
  const recs = _parseRecords(input);
  const lines = [];
  for (const r of recs) {
    try { lines.push(JSON.stringify(r)); } catch { /* unserializable record - drop */ }
  }
  return { text: lines.join('\n'), count: lines.length };
}

function _parseRecords(input) {
  if (input == null) return [];
  if (Array.isArray(input)) return input.map(_coerceRecord).filter((r) => r != null);
  if (typeof input === 'object') return [input];
  if (typeof input !== 'string') return [];
  const t = input.trim();
  if (t === '') return [];
  if (t[0] === '[' || t[0] === '{') {
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return p.filter((r) => r != null);
      if (p && typeof p === 'object') {
        for (const k of ['data', 'rows', 'events', 'generations']) {
          if (Array.isArray(p[k])) return p[k].filter((r) => r != null);
        }
        return [p];
      }
    } catch { /* not a single JSON document - fall through to JSONL */ }
  }
  const out = [];
  for (const raw of t.replace(/\r\n/g, '\n').split('\n')) {
    const s = raw.trim();
    if (s === '') continue;
    try { const o = JSON.parse(s); if (o != null) out.push(o); }
    catch { /* unparseable line at the API boundary - skip (runAudit re-validates) */ }
  }
  return out;
}

// An array element may already be an object, or a JSON-encoded string line.
function _coerceRecord(el) {
  if (el == null) return null;
  if (typeof el === 'object') return el;
  if (typeof el === 'string') {
    const s = el.trim();
    if (s === '') return null;
    try { return JSON.parse(s); } catch { return null; }
  }
  return null;
}

function _getSession(tenant_id, id) {
  if (!id) return null;
  const rows = findByField(TABLE, 'id', id);
  return rows.find((r) => r && r.tenant_id === tenant_id) || null;
}

// Resolve an id (a session id audses_* OR a report id asrr_*) to the tenant's
// own agent_audits row. Tenant-fenced: only ever returns a row whose tenant_id
// matches, so a foreign / unknown id is indistinguishable from absent (null) and
// the delta route can never read across the tenant boundary. Tries the row id
// first (the common case), then falls back to report_id. Pure read; never throws.
function _resolveOwnedReportRow(tenant_id, id) {
  if (!tenant_id || !id) return null;
  try {
    const byId = findByField(TABLE, 'id', id).find((r) => r && r.tenant_id === tenant_id);
    if (byId) return byId;
    const byReport = findByField(TABLE, 'report_id', id).find((r) => r && r.tenant_id === tenant_id);
    return byReport || null;
  } catch { return null; }
}

function _verifyUrlFor() {
  const base = (process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
  return `${base}/verify`;
}

function _publicBase() {
  return (process.env.PUBLIC_BASE || process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '');
}

function _trustUrlFor(slug) {
  return slug ? `${_publicBase()}/v1/trust/${slug}` : null;
}

// Rendered when a Continuous Trust link is valid but its first re-attestation
// has not run yet (subscribed before any scan). Auto-refreshes.
function _trustPendingHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report generating - kolm.ai</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b0e14;background:#f6f7f4;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{max-width:520px;text-align:center;padding:40px 28px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#b3431f;animation:p 1.2s infinite}@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}h1{font-size:22px;margin:18px 0 8px}p{color:#5b6472}</style></head>
<body><div class="card"><span class="dot"></span><h1>This Trust link is live - the first signed report is not generated yet</h1><p>The first signed report generates on the subscription's first attestation cycle. The vendor can trigger it immediately by running one Agent Exposure Scan from their account, or by calling the deploy-hook endpoint (POST /v1/audit/continuous/deploy-hook) after a deploy. This page refreshes automatically. Questions: <a href="mailto:dev@kolm.ai">dev@kolm.ai</a>.</p></div></body></html>`;
}

// Constant-time string compare for the cron secret (length-guarded).
function _safeEq(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

// Admin gate for the key-revocation route. Two accepted paths:
//   (1) the request reached here via authMiddleware with Bearer ADMIN_KEY,
//       which sets req.is_admin (the established convention), OR
//   (2) an x-admin-key header equal to ADMIN_KEY (constant-time compared).
// With no ADMIN_KEY configured the route is closed (returns false).
function _adminOk(req) {
  if (req && req.is_admin === true) return true;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const supplied = (req && req.headers && (req.headers['x-admin-key'] || req.headers['x-kolm-admin-key'])) || '';
  return _safeEq(supplied, adminKey);
}

// The fingerprint of the key a report is signed by, recomputed from the embedded
// public key (never trusting the claimed key_fingerprint). null when absent.
function _embeddedKeyFingerprint(envelope) {
  try {
    const block = envelope && typeof envelope === 'object' ? envelope.signature_ed25519 : null;
    const pem = block && typeof block.public_key === 'string' ? block.public_key : null;
    return pem ? keyFingerprint(pem) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// _notifyReportReady - fire-and-forget 'audit_report_ready' for one-off AUTHED
// runs (scan / import / session run), so the event is not exclusive to the
// Continuous re-attestation path. Mirrors the _notify wrapper in
// src/asr-fulfillment.js: notify() is async and can throw; both the synchronous
// throw and the rejected promise are swallowed and the result is NEVER awaited,
// so a webhook / email failure can never fail or slow the scan response.
// Every caller passes trec.id from req.tenant_record (set by _authOrReject), so
// an unauthenticated request can never reach this - and the tenantId guard
// keeps it that way even if a future caller forgets the auth fence.
// ---------------------------------------------------------------------------
function _notifyReportReady(tenantId, payload) {
  try {
    if (!tenantId) return;
    const p = notify(tenantId, 'audit_report_ready', payload || {});
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch { /* best-effort: a notify failure never blocks the run */ }
}

// Run the orchestrator + (optionally) build+sign the report. Returns
// { audit?, report?, signError?, auditError? }. Never throws across the
// boundary: runAudit is designed not to throw, but we still guard it (a
// pathological export must not surface as a raw Express 500); a signer failure
// is surfaced as signError so the caller maps a clean 503.
function _runAndSign(logsText, { source, subject, retentionDays, sign, tier, allowedHosts, coverageDeclaration }) {
  const opts = { source: source || 'import' };
  if (Number.isFinite(retentionDays)) opts.retentionDays = retentionDays;
  // GAP-1 plumbing: the operator's sanctioned egress destinations reach the
  // egress analyzer via runAudit's analyzerOpts passthrough.
  if (Array.isArray(allowedHosts) && allowedHosts.length) {
    opts.analyzerOpts = { egress: { allowedHosts } };
  }
  let audit;
  try {
    audit = runAudit(logsText, opts);
  } catch (e) {
    return { audit: null, report: null, auditError: e };
  }
  if (sign === false) return { audit, report: null };
  try {
    // tier defaults to 'scan' -> the envelope is watermarked ("UNPAID PREVIEW").
    // The free scan + session-run paths leave tier unset and so deliver a
    // watermarked preview; only the paid path re-signs as tier:'report'.
    const signOpts = { subject, verify_url: _verifyUrlFor(), tier: tier || 'scan' };
    // GAP-3: a route-validated coverage declaration is bound INSIDE the signed
    // envelope by the builder (signature-covered, like evidence_tier).
    if (coverageDeclaration) signOpts.coverage_declaration = coverageDeclaration;
    const built = buildAndSignReport(audit, signOpts);
    return { audit, report: built };
  } catch (e) {
    return { audit, report: null, signError: e };
  }
}

async function _runAndSignWithActive(logsText, {
  source,
  subject,
  retentionDays,
  sign,
  tier,
  allowedHosts,
  coverageDeclaration,
  activeEndpoint,
  activeHeaders,
  activeModel,
  activeConsent,
  activeProbeIds,
  activeTimeoutMs,
}) {
  const base = _runAndSign(logsText, {
    source,
    subject,
    retentionDays,
    sign: false,
    allowedHosts,
    coverageDeclaration,
  });
  if (base.auditError) return base;
  if (!base.audit) return { audit: null, report: null, auditError: new Error('the supplied logs could not be analyzed') };

  let activeRun;
  try {
    activeRun = await runActiveBattery({
      endpoint: activeEndpoint,
      headers: activeHeaders || {},
      model: activeModel || 'staging-agent',
      consent: activeConsent,
      probeIds: activeProbeIds || undefined,
      timeoutMs: activeTimeoutMs,
    });
  } catch (e) {
    return { audit: base.audit, report: null, activeRun: null, activeError: e };
  }

  const mergedRedTeam = mergeActiveResults(base.audit.red_team, activeRun);
  const audit = { ...base.audit, red_team: mergedRedTeam };
  if (sign === false) return { audit, report: null, activeRun };

  try {
    const signOpts = { subject, verify_url: _verifyUrlFor(), tier: tier || 'scan' };
    if (coverageDeclaration) signOpts.coverage_declaration = coverageDeclaration;
    const built = buildAndSignReport(audit, signOpts);
    return { audit, report: built, activeRun };
  } catch (e) {
    return { audit, report: null, activeRun, signError: e };
  }
}

// ---------------------------------------------------------------------------
// Tier-A capture bridge - load the CALLING tenant's own gateway observations.
//
// The store's allCapturesForTenant(x) matches rows where o.tenant === x OR
// o.tenant_id === x (capture rows carry both; gateway-receipt rows carry only
// the tenant NAME). That OR is too loose to trust on its own for a grade-A
// evidence path: an attacker who NAMES their tenant equal to a victim's tenant
// id would match the victim's pinned rows. So every returned row is re-checked
// here: a row carrying tenant_id MUST equal the canonical trec.id (the pin
// wins); only rows WITHOUT a tenant_id (receipt rows) fall back to the name
// fence. Never throws; a store failure reads as zero rows for the caller to
// surface.
// ---------------------------------------------------------------------------
function _ownsCaptureRow(row, trec) {
  if (!row || typeof row !== 'object') return false;
  if (row.tenant_id != null) return row.tenant_id === trec.id;
  const t = row.tenant;
  if (t == null) return false;
  return t === trec.id || (trec.name != null && t === trec.name);
}

async function _loadTenantCaptures(trec) {
  const idents = [trec.id];
  if (trec.name && trec.name !== trec.id) idents.push(trec.name);
  const seen = new Set();
  const out = [];
  for (const ident of idents) {
    let rows = [];
    try { rows = await allCapturesForTenant(ident, MAX_RECORDS_PER_SESSION); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    for (const row of rows) {
      if (!_ownsCaptureRow(row, trec)) continue;
      const key = String((row.id != null ? row.id : row.receipt_id) || '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(row);
      if (out.length >= MAX_RECORDS_PER_SESSION) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procurement exports (src/framework-export.js). Turns a signed report envelope
// into the artifact a buyer's GRC / procurement team ingests: CSV (findings x
// controls), a SpreadsheetML .xls workbook, Drata / Vanta control-evidence JSON,
// an executive summary, or the framework crosswalk. The formatter is a pure,
// read-only view over the SAME signed envelope (it never re-signs), so it shares
// the report route's auth/tenant fence. Sends the artifact as a download with
// the formatter's own Content-Type + filename; an unknown format is a clean 400.
// ---------------------------------------------------------------------------
function _sendExport(res, envelope, formatRaw) {
  const fmt = String(formatRaw == null ? 'csv' : formatRaw).toLowerCase();
  const fn = FRAMEWORK_EXPORTERS[fmt];
  if (!fn) return _err(res, 400, 'invalid_format', `format must be one of: ${EXPORT_FORMATS.join('|')}`);
  let art;
  try { art = fn(envelope); }
  catch (e) { return _err(res, 500, 'export_failed', e && e.message); }
  res.setHeader('Content-Type', art.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${art.filename}"`);
  return res.send(art.body);
}

// ---------------------------------------------------------------------------
// renderBadgeSvg(envelope) - a small shields.io-style status badge for the
// shareable Trust link (an embeddable "Agent Security: NN% ready" pill).
//
// Kept LOCAL to this module (not in framework-export.js) on purpose: the badge
// is a view over the SAME signed envelope, but it is part of the HTTP serving
// surface this file owns, so it shares this module's lifecycle. Pure +
// NEVER-throws (mirrors the framework-export.js obj()/str() idiom): a malformed
// or absent envelope degrades to the grey "unknown" badge rather than throwing,
// so the public badge route can never 500. ASCII-only output.
// ---------------------------------------------------------------------------
function _bObj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
function _bStr(x) { return x == null ? '' : String(x); }

// Minimal XML-escape so a subject / label can never break the SVG markup.
function _svgEsc(s) {
  return _bStr(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Rough monospace-ish width so the two pill halves size to their text. 7px/char
// is a stable approximation for the 11px label font used below.
function _textW(s) { return Math.max(0, _bStr(s).length) * 7 + 10; }

// How long a published report stays "fresh" on the badge. Past this window the
// pill goes grey + 'stale (Month YYYY)' regardless of readiness, so an
// abandoned report can never keep serving a green pill.
const BADGE_STALE_DAYS = 30;
const BADGE_STALE_MS = BADGE_STALE_DAYS * 24 * 60 * 60 * 1000;

// Month names for the stale badge's "(May 2026)" suffix. ASCII only.
const _BADGE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// _badgeStateFor(envelope) -> { revoked, stale, stale_month_year } for the
// route-side badge. Reads the SAME signals the public verify route trusts:
//   revoked - the embedded signing key's fingerprint (recomputed from the
//             embedded public key, never the claimed key_fingerprint) is
//             'revoked' in the persisted key-revocation store. Revocation
//             outranks both staleness and readiness.
//   stale   - generated_at is older than BADGE_STALE_DAYS days. Readiness
//             bucket colours only apply to fresh reports.
// Deliberately ALLOWED to throw: the badge route wraps the state check + the
// render in one try/catch that degrades to the grey "unknown" badge, so an
// internal error in these checks reads as unknown - never a 500, and never a
// wrongly-green pill.
function _badgeStateFor(envelope) {
  const out = { revoked: false, stale: false, stale_month_year: null };
  if (!envelope || typeof envelope !== 'object') return out;
  const fp = _embeddedKeyFingerprint(envelope);
  if (fp && issuerKeyStatus(fp).status === 'revoked') {
    out.revoked = true;
    return out;
  }
  const gen = typeof envelope.generated_at === 'string' ? Date.parse(envelope.generated_at) : NaN;
  if (Number.isFinite(gen) && Date.now() - gen > BADGE_STALE_MS) {
    out.stale = true;
    const d = new Date(gen);
    out.stale_month_year = _BADGE_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  return out;
}

function renderBadgeSvg(envelope, state) {
  // The right-hand value + its colour. Default = the grey "unknown" badge a
  // caller gets when the slug does not resolve (or the envelope is malformed).
  let label = 'agent security';
  let value = 'unknown';
  let color = '#9f9f9f'; // grey
  try {
    const st = _bObj(state);
    if (st.revoked === true) {
      // The issuer key behind this report is revoked: the signature can no
      // longer be trusted, so the pill must never show a readiness number.
      // Neutral grey (the existing unknown palette) - no alarm red.
      value = 'report revoked';
    } else if (st.stale === true) {
      // Older than BADGE_STALE_DAYS: the report stays verifiable but the badge
      // loses its colour and names the month it was generated.
      value = st.stale_month_year ? ('stale (' + st.stale_month_year + ')') : 'stale';
    } else {
      const env = _bObj(envelope);
      const summary = _bObj(env.summary);
      const pct = summary.readiness_pct;
      if (typeof pct === 'number' && Number.isFinite(pct)) {
        const n = Math.max(0, Math.min(100, Math.round(pct)));
        value = n + '% ready';
        // Traffic-light by readiness: red < 50 <= amber < 80 <= green.
        // Only reachable for a FRESH, non-revoked report (see above).
        color = n >= 80 ? '#2e7d32' : (n >= 50 ? '#b58900' : '#c0392b');
      }
    }
  } catch { /* fall through to the grey unknown badge - never throw */ }

  const lw = Math.round(_textW(label));
  const vw = Math.round(_textW(value));
  const w = lw + vw;
  const lblEsc = _svgEsc(label);
  const valEsc = _svgEsc(value);
  // Standard two-segment shields-style badge: a dark label half + a coloured
  // value half. Self-contained (no external fonts / images). ASCII only.
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="20" role="img" '
    + 'aria-label="' + lblEsc + ': ' + valEsc + '">'
    + '<title>' + lblEsc + ': ' + valEsc + '</title>'
    + '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/>'
    + '<stop offset="1" stop-opacity=".1"/></linearGradient>'
    + '<clipPath id="r"><rect width="' + w + '" height="20" rx="3" fill="#fff"/></clipPath>'
    + '<g clip-path="url(#r)">'
    + '<rect width="' + lw + '" height="20" fill="#444"/>'
    + '<rect x="' + lw + '" width="' + vw + '" height="20" fill="' + color + '"/>'
    + '<rect width="' + w + '" height="20" fill="url(#s)"/></g>'
    + '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">'
    + '<text x="' + (lw / 2) + '" y="14">' + lblEsc + '</text>'
    + '<text x="' + (lw + vw / 2) + '" y="14">' + valEsc + '</text>'
    + '</g></svg>';
}

export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('audit-routes.register: router with get/post required');
  }

  // OFFER #7 Buyer Portfolio: adapt the spine store primitives to the injected
  // `store` shape buyer-portfolio.js expects (dependency-injected, so no spine
  // schema change). resolveTrust is the same lineage resolver the Trust routes use.
  const _buyerStore = {
    insert, update, findByField,
    id: (prefix) => storeId(prefix),
    resolveTrust,
  };

  // TRACK CRYPTO-SERVICES / M4 - mount the PUBLIC transparency-log read surface
  // (size / entries / proof / checkpoints) onto the same router. Kept as its own
  // module + register so router.js does not grow; the paths are allow-listed in
  // PUBLIC_API (see the track caveats for the exact paths to add to auth.js).
  try { registerTransparencyLogRoutes(r); }
  catch (e) { /* a transparency-log wiring failure must not break audit routes */ if (process.env.NODE_ENV !== 'production') console.error('[audit-routes] transparency-log mount failed:', e && e.message); }

  // S7 Trust Center - the seller-facing analytics on each shareable Trust Link
  // (who opened it, how many distinct viewers) + the optional NDA share gate.
  // GET /v1/trust/:slug/views and GET /v1/trust-center stay auth-gated (NOT in
  // PUBLIC_API) so the global authMiddleware fences them to the owning tenant;
  // POST /v1/trust/:slug/unlock is PUBLIC (allow-listed in src/auth.js). The
  // authMiddleware is forwarded so the authenticated routes resolve the tenant
  // even before the global gate populates req.tenant_record.
  try { registerTrustCenter(r, { authMiddleware: deps && deps.authMiddleware }); }
  catch (e) { /* a trust-center wiring failure must not break audit routes */ if (process.env.NODE_ENV !== 'production') console.error('[audit-routes] trust-center mount failed:', e && e.message); }

  // -------------------------------------------------------------------------
  // POST /v1/audit/sessions - open a session.
  // body: { subject?, source?, retention_days? }
  // -------------------------------------------------------------------------
  r.post('/v1/audit/sessions', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    // 'kolm-capture' is the RESERVED grade-A source: only the scan/import
    // bridge (which loads the tenant's own stored gateway captures) may stamp
    // it. A caller-supplied source must never claim first-party capture.
    if (_claimsCaptureSource(body.source)) {
      return _err(res, 400, 'source_reserved', `source "${KOLM_CAPTURE_SOURCE}" is reserved for the gateway-capture bridge; POST /v1/audit/scan with {"source":"${KOLM_CAPTURE_SOURCE}"} and no logs instead`);
    }
    const now = new Date().toISOString();
    const row = {
      id: _newId(),
      tenant_id: trec.id,
      subject: String(body.subject || 'Agent fleet').slice(0, 200),
      source: _normalizeSource(body.source) || null,
      retention_days: Number.isFinite(body.retention_days) ? body.retention_days : null,
      status: 'open',
      logs: '',
      record_count: 0,
      report: null,
      report_id: null,
      summary: null,
      created_at: now,
      updated_at: now,
    };
    try { insert(TABLE, row); }
    catch (e) { return _err(res, 500, 'session_create_failed', e && e.message); }
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.session_created', payload: { id: row.id, subject: row.subject } });
    return res.status(201).json({
      ok: true,
      audit: { id: row.id, status: row.status, subject: row.subject, source: row.source, record_count: 0, created_at: now },
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/sessions/:id/ingest - append logs.
  // body: { logs }  (JSONL text, JSON array, or array of records)
  // -------------------------------------------------------------------------
  r.post('/v1/audit/sessions/:id/ingest', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const logsInput = body.logs != null ? body.logs : body;
    const { text, count } = _toJsonl(logsInput);
    if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');

    // Read-modify-write inside a transaction so two concurrent /ingest calls
    // cannot lose each other's appends (both read record_count=N, both write
    // N+delta, one append vanishes). In the JSON store withTransaction is a
    // single-tick pass-through; in sqlite it is BEGIN IMMEDIATE / COMMIT. The
    // session is re-read INSIDE the unit so the merge sees fresh state.
    let outcome;
    try {
      outcome = withTransaction(() => {
        const fresh = _getSession(trec.id, id);
        if (!fresh) return { err: [404, 'session_not_found', `no audit session ${id} for this tenant`] };
        if (fresh.status === 'complete') return { err: [409, 'session_closed', 'this session already produced a report; open a new session'] };
        const newCount = (fresh.record_count || 0) + count;
        if (newCount > MAX_RECORDS_PER_SESSION) {
          return { err: [413, 'too_many_records', `a session holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`] };
        }
        const mergedLogs = fresh.logs ? (fresh.logs + '\n' + text) : text;
        if (Buffer.byteLength(mergedLogs, 'utf8') > MAX_BYTES_PER_SESSION) {
          return { err: [413, 'session_too_large', `a session holds at most ${Math.floor(MAX_BYTES_PER_SESSION / (1024 * 1024))} MiB of logs; split the export`] };
        }
        const now = new Date().toISOString();
        update(TABLE, (row) => row.id === id && row.tenant_id === trec.id, { logs: mergedLogs, record_count: newCount, updated_at: now });
        return { ok: true, record_count: newCount };
      });
    } catch (e) {
      return _err(res, 500, 'ingest_failed', e && e.message);
    }
    if (outcome && outcome.err) return _err(res, outcome.err[0], outcome.err[1], outcome.err[2]);
    return res.json({ ok: true, id, accepted: count, record_count: outcome.record_count });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/sessions/:id/run - run the audit + build+sign the report.
  // body: { subject?, source?, retention_days?, sign? }
  // -------------------------------------------------------------------------
  r.post('/v1/audit/sessions/:id/run', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    if (!sess.record_count) return _err(res, 400, 'no_records', 'ingest at least one log record before running');

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (_claimsCaptureSource(body.source)) {
      return _err(res, 400, 'source_reserved', `source "${KOLM_CAPTURE_SOURCE}" is reserved for the gateway-capture bridge; POST /v1/audit/scan with {"source":"${KOLM_CAPTURE_SOURCE}"} and no logs instead`);
    }
    const sign = body.sign !== false;
    const hostsNorm = _normalizeAllowedHosts(body.allowed_hosts);
    if (!hostsNorm.ok) {
      return _err(res, 400, 'invalid_allowed_hosts', `allowed_hosts must be an array of at most ${MAX_ALLOWED_HOSTS} hostname strings (each <=${MAX_HOST_LEN} chars)`);
    }
    const covNorm = _coverageFromBody(body);
    if (!covNorm.ok) {
      return _err(res, 400, 'invalid_coverage_declaration', covNorm.error);
    }
    const { audit, report, signError, auditError } = _runAndSign(sess.logs, {
      source: _normalizeSource(body.source) || sess.source,
      subject: body.subject || sess.subject,
      retentionDays: _clampRetentionDays(Number.isFinite(body.retention_days) ? body.retention_days : sess.retention_days),
      sign,
      allowedHosts: hostsNorm.hosts,
      coverageDeclaration: covNorm.declaration,
    });
    if (auditError) {
      return _err(res, 422, 'audit_failed', auditError.message || 'the supplied logs could not be analyzed');
    }
    if (sign && signError) {
      return _err(res, 503, 'no_signer_configured', signError.message || 'no Ed25519 signer available');
    }
    const now = new Date().toISOString();
    update(TABLE, (row) => row.id === id && row.tenant_id === trec.id, {
      status: 'complete',
      summary: audit.summary,
      report: report ? report.envelope : null,
      report_id: report ? report.report_id : null,
      updated_at: now,
    });
    tryAppendAudit({
      tenant_id: trec.id, actor: trec.id, op: 'agent_audit.report_signed',
      payload: { id, report_id: report ? report.report_id : null, readiness_pct: audit.summary.readiness_pct, blocking: audit.summary.blocking_count, signed: !!report },
    });
    // Fire-and-forget (never awaited): a signed report from a one-off session
    // run announces itself the same way a Continuous re-attestation does.
    if (report) {
      _notifyReportReady(trec.id, {
        id,
        report_id: report.report_id,
        subject: body.subject || sess.subject,
        readiness_pct: audit.summary ? audit.summary.readiness_pct : null,
        evidence_tier_grade: audit.evidence_tier ? (audit.evidence_tier.grade || null) : null,
      });
    }
    return res.json({
      ok: true,
      id,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      summary: audit.summary,
      verify_url: _verifyUrlFor(),
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/sessions/:id - session status + summary (no raw logs).
  // -------------------------------------------------------------------------
  r.get('/v1/audit/sessions/:id', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    return res.json({
      ok: true,
      audit: {
        id: sess.id,
        status: sess.status,
        subject: sess.subject,
        source: sess.source,
        record_count: sess.record_count,
        report_id: sess.report_id || null,
        has_report: !!sess.report,
        summary: sess.summary || null,
        created_at: sess.created_at,
        updated_at: sess.updated_at,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/sessions/:id/report?format=json|html|pdf - the artifact.
  // Returns the bare signed envelope (json), rendered HTML, or a PDF stream - 
  // each is a downloadable deliverable, not an {ok}-wrapped API envelope.
  // -------------------------------------------------------------------------
  r.get('/v1/audit/sessions/:id/report', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    if (!sess.report) return _err(res, 409, 'report_not_ready', 'run the session before fetching its report');

    // Strip the server-side-only _full_payload carry-over before the envelope
    // reaches the client (the scan tier stashes its withheld paid-tier sections
    // there for the paid upgrade; it must never go out on the wire). Stripping a
    // non-signature-covered field leaves the signature valid.
    const envelope = stripWirePayload(sess.report);
    const format = (req.query && String(req.query.format || 'json')).toLowerCase();
    const fname = (sess.report_id || 'agent-security-report');

    if (format === 'html') {
      let html;
      try { html = renderReportHtml(envelope); }
      catch (e) { return _err(res, 500, 'html_render_error', e && e.message); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    if (format === 'pdf') {
      try {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}.pdf"`);
        await renderReportPdf(envelope, res);
        return undefined;
      } catch (e) {
        if (!res.headersSent) {
          if (typeof res.removeHeader === 'function') { res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); }
          const code = e && e.code === 'PDFKIT_UNAVAILABLE' ? 503 : 500;
          return _err(res, code, code === 503 ? 'pdf_unavailable' : 'pdf_render_error', e && e.message);
        }
        return undefined;
      }
    }
    // json (default) - bare signed envelope, downloadable + offline-verifiable.
    let json;
    try { json = JSON.stringify(envelope, null, 2); }
    catch (e) { return _err(res, 500, 'json_render_error', e && e.message); }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.json"`);
    return res.send(json);
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/sessions/:id/export?format=csv|xlsx|drata|vanta|exec|crosswalk
  // The signed report reshaped into a procurement-ingestible artifact. Auth-
  // gated + tenant-fenced exactly like the sibling /report route (the export is
  // a view over the SAME signed envelope - it carries the key fingerprint +
  // verify URL so an importer can always trace it back to the signed source).
  // -------------------------------------------------------------------------
  r.get('/v1/audit/sessions/:id/export', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    if (!sess.report) return _err(res, 409, 'report_not_ready', 'run the session before exporting its report');
    const format = (req.query && req.query.format) || 'csv';
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.export', payload: { id, report_id: sess.report_id, format: String(format).toLowerCase() } });
    return _sendExport(res, stripWirePayload(sess.report), format);
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/:id/oscal  - GRC Evidence Pack (OFFER #6). Auth-gated +
  // tenant-fenced exactly like the sibling /export route. Default returns the
  // OSCAL assessment-results JSON; ?format=poam returns the POA&M-style
  // remediation table. kolm MAPS to standards; this is an assessment-results
  // export, never a certification. Read-only view over the SAME signed report.
  // Tiers: Full Readiness ($15,000) and Continuous-Plus ($3,500/mo).
  // -------------------------------------------------------------------------
  r.get('/v1/audit/:id/oscal', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'audit_not_found', `no audit ${id} for this tenant`);
    if (!sess.report) return _err(res, 409, 'report_not_ready', 'run or scan the audit before exporting its GRC pack');
    const envelope = sess.report;
    // The signed envelope carries findings[] (asr + controls mapped), summary,
    // and evidence_tier - exactly the fields oscal-export derives from.
    const resultLike = {
      spec_version: envelope.report_version || envelope.schema || null,
      summary: envelope.summary || {},
      controls: { findings: Array.isArray(envelope.findings) ? envelope.findings : [] },
      findings: Array.isArray(envelope.findings) ? envelope.findings : [],
      evidence_tier: envelope.evidence_tier || null,
      subject: envelope.subject || { name: sess.subject },
    };
    const meta = {
      subject: (envelope.subject && envelope.subject.name) || sess.subject,
      report_id: sess.report_id || envelope.report_id || null,
      generated: envelope.generated_at || null,
      verify_url: envelope.verify_url || _verifyUrlFor(),
      key_fingerprint: (envelope.signature_ed25519 && envelope.signature_ed25519.key_fingerprint) || null,
    };
    const format = (req.query && String(req.query.format || 'oscal')).toLowerCase();
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.oscal_export', payload: { id, report_id: sess.report_id, format } });
    let artifact;
    try {
      artifact = format === 'poam' ? buildRemediationTable(resultLike) : buildOscalAssessmentResults(resultLike, meta);
    } catch (e) { return _err(res, 500, 'oscal_export_failed', e && e.message); }
    const fname = (sess.report_id || 'agent-security-report') + (format === 'poam' ? '-poam' : '-oscal');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.json"`);
    return res.send(JSON.stringify(artifact, null, 2));
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/sessions/:id/delta?against=<other_session_or_report_id>
  //   (AUTH, tenant-fenced) - the signed delta between two reports the CALLER
  // already owns. Unlike GET /v1/trust/:slug/delta (PUBLIC, prior-vs-current off
  // a slug's lineage), this diffs any two of the tenant's own reports addressed
  // by session id (audses_*) OR report id (asrr_*). BOTH ids must resolve to a
  // report owned by this tenant - a foreign / unknown id is {ok:false} (404/403),
  // never another tenant's data. No re-sign; computeAuditDelta is pure + never
  // throws. The :id is "current"; ?against=<id> is the prior baseline.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/sessions/:id/delta', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const against = (req.query && req.query.against) || body.against;
    if (!against) {
      return _err(res, 400, 'against_required', 'pass ?against=<other_session_or_report_id> (a report you own)');
    }
    // Resolve the CURRENT side (the path id). A missing report is its own status
    // so the caller can tell "you do not own this" from "it has no report yet".
    const curRow = _resolveOwnedReportRow(trec.id, id);
    if (!curRow) return _err(res, 404, 'not_found', `no audit ${id} for this tenant`);
    if (!curRow.report) return _err(res, 409, 'report_not_ready', `audit ${id} has no signed report yet`);
    // Resolve the AGAINST side (the prior baseline). A foreign / unknown id must
    // be indistinguishable from "absent" so the route never leaks the existence
    // of another tenant's report -> 404, not 403-with-detail.
    const priorRow = _resolveOwnedReportRow(trec.id, String(against));
    if (!priorRow) return _err(res, 404, 'against_not_found', `no audit ${against} for this tenant`);
    if (!priorRow.report) return _err(res, 409, 'against_report_not_ready', `audit ${against} has no signed report yet`);

    let delta = null;
    try { delta = computeAuditDelta(priorRow.report, curRow.report); }
    catch { delta = null; }
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.delta', payload: { id, against: String(against), report_id: curRow.report_id || null, against_report_id: priorRow.report_id || null } });
    return res.json({
      ok: true,
      id,
      against: String(against),
      report_id: curRow.report_id || null,
      against_report_id: priorRow.report_id || null,
      delta,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/:id/retest  (AUTH, tenant-fenced) - OFFER #9 Fix Verification
  // Re-Test. Re-runs the audit over a FRESH log window (body.logs) and produces a
  // focused delta that classifies the prior report's finding(s) as resolved /
  // still_open / regressed, linking both report ids. The :id (a session id
  // audses_* OR a report id asrr_*) MUST resolve to a report this tenant owns - a
  // foreign / unknown id is 404, never another tenant's data. No re-sign here;
  // runFixRetest is pure + never throws (the diff is computeAuditDelta).
  // Tier: a Continuous ($299/$999 per month) on-demand tick, or a follow-on $750
  // Signed Readiness Report that embeds result.delta.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/:id/retest', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    // Resolve + tenant-fence the PRIOR audit. Ownership is forced from
    // req.tenant_record.id (via _resolveOwnedReportRow), never read from the body.
    const priorRow = _resolveOwnedReportRow(trec.id, id);
    if (!priorRow) return _err(res, 404, 'not_found', `no audit ${id} for this tenant`);
    if (!priorRow.report) return _err(res, 409, 'report_not_ready', `audit ${id} has no signed report yet`);
    // Parse the fresh window from the body (same accepted shapes as /ingest).
    const logsInput = body.logs != null ? body.logs : null;
    if (logsInput == null) return _err(res, 400, 'logs_required', 'POST { "logs": <JSONL text | array of records>, "focus_finding_ids"?: [..] }');
    const { text, count } = _toJsonl(logsInput);
    if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied for the re-test window');
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `a re-test window holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }
    let result;
    try {
      result = runFixRetest({
        priorAudit: priorRow.report,
        newLogs: text,
        focusFindingIds: Array.isArray(body.focus_finding_ids) ? body.focus_finding_ids : (body.focus_finding_ids != null ? [body.focus_finding_ids] : null),
      });
    } catch (e) {
      return _err(res, 500, 'retest_failed', e && e.message);
    }
    tryAppendAudit({
      tenant_id: trec.id, actor: trec.id, op: 'agent_audit.retest',
      payload: { id, prior_report_id: result.prior_id, new_report_id: result.new_id, resolved: result.resolved.length, still_open: result.still_open.length, regressed: result.regressed.length },
    });
    return res.json({
      ok: true,
      id,
      prior_id: result.prior_id,
      new_id: result.new_id,
      resolved: result.resolved,
      still_open: result.still_open,
      regressed: result.regressed,
      delta: result.delta,
    });
  });

  // -------------------------------------------------------------------------
  // OFFER #7 Buyer Portfolio Dashboard - the buyer side of the trust link.
  // Both routes are AUTH-gated; the global authMiddleware fences them to the
  // owning tenant via req.tenant_record.id. A buyer seat lives under the EXISTING
  // Continuous $999/mo shape - no new price or tier.
  // -------------------------------------------------------------------------
  // POST /v1/buyer/watchlist - add a vendor Trust slug to the buyer's watchlist.
  // body: { slug, label? }
  r.post('/v1/buyer/watchlist', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const result = addWatch(trec.id, _buyerStore, { slug: body.slug, label: body.label });
    if (!result.ok) {
      const map = { no_tenant: 401, store_unavailable: 503, invalid_slug: 400, watchlist_full: 409, insert_failed: 500 };
      return _err(res, map[result.error] || 400, result.error, result.detail);
    }
    return res.status(result.already ? 200 : 201).json({ ok: true, already: !!result.already, watch: result.watch });
  });

  // GET /v1/buyer/portfolio - the buyer's vendor portfolio pane (read surface).
  r.get('/v1/buyer/portfolio', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    let view;
    try { view = buildPortfolioView(trec.id, _buyerStore); }
    catch (e) { return _err(res, 500, 'portfolio_failed', e && e.message); }
    return res.json({ ok: true, vendors: view.vendors });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/scan - one-shot: logs → signed report in a single call.
  // The fast path behind the "Agent Exposure Scan" + the full report. Persists
  // a completed session by default so the report is fetchable + re-verifiable.
  // body: { logs, subject?, source?, retention_days?, sign?, persist? }
  //
  // Tier-A bridge: { "source": "kolm-capture" } with NO logs audits the CALLING
  // tenant's own stored gateway captures/receipts instead of a vendor export.
  // The resulting report carries evidence grade A (first-party capture). The
  // source value is reserved: supplying it WITH logs is a clean 400, so vendor
  // logs can never masquerade as gateway captures.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/scan', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const isCaptureBridge = _claimsCaptureSource(body.source);

    let text;
    let count;
    if (isCaptureBridge) {
      if (body.logs != null) {
        return _err(res, 400, 'logs_not_allowed', `source "${KOLM_CAPTURE_SOURCE}" audits this tenant's stored gateway captures; do not supply logs (use a vendor source tag for vendor logs)`);
      }
      let rows;
      try { rows = await _loadTenantCaptures(trec); }
      catch (e) { return _err(res, 500, 'capture_load_failed', e && e.message); }
      if (!rows.length) {
        return _err(res, 409, 'no_captures', 'this tenant has no stored gateway captures to audit; route agent traffic through the kolm gateway first, or scan a vendor log export');
      }
      ({ text, count } = _toJsonl(rows));
      if (count === 0) {
        return _err(res, 409, 'no_captures', 'this tenant has no auditable gateway captures');
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES_PER_SESSION) {
        return _err(res, 413, 'captures_too_large', `the stored captures exceed ${Math.floor(MAX_BYTES_PER_SESSION / (1024 * 1024))} MiB; contact dev@kolm.ai for a staged audit`);
      }
    } else {
      const logsInput = body.logs != null ? body.logs : null;
      if (logsInput == null) return _err(res, 400, 'logs_required', 'POST { "logs": <JSONL text | array of records> }');
      ({ text, count } = _toJsonl(logsInput));
      if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');
    }
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `a scan holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }

    const sign = body.sign !== false;
    const subject = String(body.subject || 'Agent fleet').slice(0, 200);
    const source = isCaptureBridge ? KOLM_CAPTURE_SOURCE : (_normalizeSource(body.source) || 'import');
    const retentionDays = _clampRetentionDays(body.retention_days);
    const hostsNorm = _normalizeAllowedHosts(body.allowed_hosts);
    if (!hostsNorm.ok) {
      return _err(res, 400, 'invalid_allowed_hosts', `allowed_hosts must be an array of at most ${MAX_ALLOWED_HOSTS} hostname strings (each <=${MAX_HOST_LEN} chars)`);
    }
    const covNorm = _coverageFromBody(body);
    if (!covNorm.ok) {
      return _err(res, 400, 'invalid_coverage_declaration', covNorm.error);
    }
    const { audit, report, signError, auditError } = _runAndSign(text, {
      source, subject,
      retentionDays,
      sign,
      // The kolm-capture bridge is a FIRST-PARTY grade-A attestation over the
      // tenant's own gateway captures (not a paywalled vendor preview), so it
      // builds the full report tier - keeping the signature-covered evidence_tier
      // grade INSIDE the envelope rather than withholding it as a scan-tier stub.
      tier: isCaptureBridge ? 'report' : 'scan',
      allowedHosts: hostsNorm.hosts,
      coverageDeclaration: covNorm.declaration,
    });
    if (auditError) {
      return _err(res, 422, 'audit_failed', auditError.message || 'the supplied logs could not be analyzed');
    }
    if (sign && signError) {
      return _err(res, 503, 'no_signer_configured', signError.message || 'no Ed25519 signer available');
    }

    let id = null;
    if (body.persist !== false) {
      const now = new Date().toISOString();
      id = _newId();
      try {
        insert(TABLE, {
          id, tenant_id: trec.id, subject, source,
          retention_days: retentionDays,
          status: 'complete', logs: text, record_count: count,
          report: report ? report.envelope : null,
          report_id: report ? report.report_id : null,
          summary: audit.summary, created_at: now, updated_at: now,
        });
      } catch { id = null; /* persistence is best-effort; the report is still returned inline */ }
    }
    tryAppendAudit({
      tenant_id: trec.id, actor: trec.id, op: 'agent_audit.scan',
      payload: { id, report_id: report ? report.report_id : null, records: count, readiness_pct: audit.summary.readiness_pct, blocking: audit.summary.blocking_count, signed: !!report },
    });
    // Fire-and-forget (never awaited): an authed one-shot scan that produced a
    // signed report announces 'audit_report_ready' like the Continuous path.
    if (report) {
      _notifyReportReady(trec.id, {
        id,
        report_id: report.report_id,
        subject,
        readiness_pct: audit.summary ? audit.summary.readiness_pct : null,
        evidence_tier_grade: audit.evidence_tier ? (audit.evidence_tier.grade || null) : null,
      });
    }
    return res.json({
      ok: true,
      id,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      summary: audit.summary,
      ingest: audit.ingest,
      evidence_tier: audit.evidence_tier || null,
      report: report ? report.envelope : null,
      verify_url: _verifyUrlFor(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/redteam/active - one-shot passive audit + CONSENTED active probe
  // battery + signed report. This is the product route for the Deep Red-Team
  // tier: the active battery is still guarded by src/active-redteam.js consent
  // validation before any network probe is sent, and the route only returns
  // digests/statuses (never prompts, responses, canaries, or consent tokens).
  // body: { logs|source:"kolm-capture", endpoint, headers?, model?, consent,
  //         probe_ids?, timeout_ms?, subject?, source?, retention_days?, sign?,
  //         persist? }
  // -------------------------------------------------------------------------
  r.post('/v1/redteam/active', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const isCaptureBridge = _claimsCaptureSource(body.source);

    let text;
    let count;
    if (isCaptureBridge) {
      if (body.logs != null) {
        return _err(res, 400, 'logs_not_allowed', `source "${KOLM_CAPTURE_SOURCE}" audits this tenant's stored gateway captures; do not supply logs (use a vendor source tag for vendor logs)`);
      }
      let rows;
      try { rows = await _loadTenantCaptures(trec); }
      catch (e) { return _err(res, 500, 'capture_load_failed', e && e.message); }
      if (!rows.length) {
        return _err(res, 409, 'no_captures', 'this tenant has no stored gateway captures to audit; route agent traffic through the kolm gateway first, or scan a vendor log export');
      }
      ({ text, count } = _toJsonl(rows));
      if (count === 0) return _err(res, 409, 'no_captures', 'this tenant has no auditable gateway captures');
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES_PER_SESSION) {
        return _err(res, 413, 'captures_too_large', `the stored captures exceed ${Math.floor(MAX_BYTES_PER_SESSION / (1024 * 1024))} MiB; contact dev@kolm.ai for a staged audit`);
      }
    } else {
      const logsInput = body.logs != null ? body.logs : null;
      if (logsInput == null) return _err(res, 400, 'logs_required', 'POST { "logs": <JSONL text | array of records>, "endpoint": "https://staging.example/v1/chat/completions", "consent": {...} }');
      ({ text, count } = _toJsonl(logsInput));
      if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');
    }
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `a scan holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }

    const headersNorm = _normalizeActiveHeaders(body.headers != null ? body.headers : body.endpoint_headers);
    if (!headersNorm.ok) return _err(res, 400, 'invalid_active_headers', headersNorm.error);
    const probeNorm = _normalizeActiveProbeIds(body.probe_ids != null ? body.probe_ids : body.probeIds);
    if (!probeNorm.ok) return _err(res, 400, 'invalid_active_probe_ids', probeNorm.error);
    const hostsNorm = _normalizeAllowedHosts(body.allowed_hosts);
    if (!hostsNorm.ok) {
      return _err(res, 400, 'invalid_allowed_hosts', `allowed_hosts must be an array of at most ${MAX_ALLOWED_HOSTS} hostname strings (each <=${MAX_HOST_LEN} chars)`);
    }
    const covNorm = _coverageFromBody(body);
    if (!covNorm.ok) return _err(res, 400, 'invalid_coverage_declaration', covNorm.error);

    const consent = body.consent && typeof body.consent === 'object'
      ? body.consent
      : {
        token: body.consent_token,
        statement: body.consent_statement,
        attestor: body.consent_attestor,
        asserted_at: body.consent_asserted_at,
      };
    const sign = body.sign !== false;
    const subject = String(body.subject || 'Agent fleet').slice(0, 200);
    const source = isCaptureBridge ? KOLM_CAPTURE_SOURCE : (_normalizeSource(body.source) || 'import');
    const retentionDays = _clampRetentionDays(body.retention_days);
    const { audit, report, activeRun, activeError, signError, auditError } = await _runAndSignWithActive(text, {
      source,
      subject,
      retentionDays,
      sign,
      tier: isCaptureBridge ? 'report' : 'scan',
      allowedHosts: hostsNorm.hosts,
      coverageDeclaration: covNorm.declaration,
      activeEndpoint: body.endpoint,
      activeHeaders: headersNorm.headers,
      activeModel: _activeModelFromBody(body),
      activeConsent: consent,
      activeProbeIds: probeNorm.ids,
      activeTimeoutMs: _activeTimeoutFromBody(body),
    });
    if (auditError) return _err(res, 422, 'audit_failed', auditError.message || 'the supplied logs could not be analyzed');
    if (activeError) {
      const code = activeError.code === 'CONSENT_REQUIRED' ? 'active_consent_required'
        : activeError.code === 'ENDPOINT_REQUIRED' ? 'active_endpoint_required'
        : 'active_redteam_error';
      const status = code === 'active_redteam_error' ? 500 : 400;
      return _err(res, status, code, activeError.message || 'active red-team battery could not start');
    }
    if (sign && signError) return _err(res, 503, 'no_signer_configured', signError.message || 'no Ed25519 signer available');

    const activeSummary = _activeResponseSummary(activeRun, audit && audit.red_team);
    let id = null;
    if (body.persist !== false) {
      const now = new Date().toISOString();
      id = _newId();
      try {
        insert(TABLE, {
          id, tenant_id: trec.id, subject, source,
          retention_days: retentionDays,
          status: 'complete', logs: text, record_count: count,
          active_redteam: activeSummary,
          report: report ? report.envelope : null,
          report_id: report ? report.report_id : null,
          summary: audit.summary, created_at: now, updated_at: now,
        });
      } catch { id = null; /* persistence is best-effort; the report is still returned inline */ }
    }
    tryAppendAudit({
      tenant_id: trec.id, actor: trec.id, op: 'agent_audit.active_redteam',
      payload: {
        id,
        report_id: report ? report.report_id : null,
        records: count,
        active_spec_version: activeSummary.spec_version,
        active_probes_total: activeSummary.probes_total,
        active_probes_merged: activeSummary.probes_merged,
        readiness_pct: audit.summary.readiness_pct,
        blocking: audit.summary.blocking_count,
        signed: !!report,
      },
    });
    if (report) {
      _notifyReportReady(trec.id, {
        id,
        report_id: report.report_id,
        subject,
        readiness_pct: audit.summary ? audit.summary.readiness_pct : null,
        evidence_tier_grade: audit.evidence_tier ? (audit.evidence_tier.grade || null) : null,
        active_redteam: { probes_total: activeSummary.probes_total, probes_merged: activeSummary.probes_merged },
      });
    }
    return res.json({
      ok: true,
      id,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      active_redteam: activeSummary,
      summary: audit.summary,
      ingest: audit.ingest,
      evidence_tier: audit.evidence_tier || null,
      report: report ? report.envelope : null,
      verify_url: _verifyUrlFor(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/report/verify  (PUBLIC) - offline-style verification of a
  // posted signed report. Pure compute, no tenant data touched, never throws.
  // body: { report: <envelope> }  OR the bare envelope as the request body.
  // HTTP is 200 whenever a report was supplied; the verdict is in the body.
  //
  // Two tiers (mirrors the /verify browser page):
  //   verify.ok - tier 1: signed by the holder of the embedded key, untampered.
  //   issuer.recognized - tier 2: that key is one this product publishes (the
  //                       live signer or a key in public/keys/kolm-issuers.json).
  //   trusted - verify.ok AND issuer.recognized. A consumer that only checks
  //                verify.ok would accept a rogue-signed forgery; check trusted.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/report/verify', (req, res) => {
    if (_verifyRateLimited(req)) {
      return res.status(429).json({ ok: false, error: 'rate_limited', detail: 'verification caps at 120/min from this address - verify offline in your browser at /verify, or mail dev@kolm.ai', contact: 'dev@kolm.ai' });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return _err(res, 400, 'report_required', 'POST { "report": <signed envelope> }');
    const envelope = body.report && typeof body.report === 'object' ? body.report : body;
    if (!envelope || typeof envelope !== 'object' || !envelope.schema) {
      return _err(res, 400, 'report_required', 'POST { "report": <signed envelope> } with a schema field');
    }
    const verify = verifyReport(envelope);
    const issuer = _issuerProvenance(envelope);
    // Tier-3: key lifecycle. A signature can verify (tier 1) by a RECOGNIZED
    // issuer (tier 2) and STILL be untrustworthy if that key has since been
    // revoked (compromised / withdrawn). Recompute the embedded fingerprint and
    // consult the persisted revocation store; a revoked key forces trusted:false
    // with a clear reason, exactly like the offline browser verifier.
    const fp = _embeddedKeyFingerprint(envelope);
    let revoked = false;
    let revocation = null;
    if (fp) {
      try {
        const st = issuerKeyStatus(fp);
        revoked = st.status === 'revoked';
        revocation = { fingerprint: fp, status: st.status, valid: st.valid, revoked_at: st.revoked_at, reason: st.reason };
      } catch { /* never throw across the verify boundary */ }
    }
    const trusted = verify.ok === true && issuer.recognized === true && revoked === false;
    const out = { ok: true, trusted, verify, issuer, revocation };
    if (revoked) out.reason = 'issuer_key_revoked';
    return res.json(out);
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/issuer-key  (PUBLIC) - the live Ed25519 PUBLIC key this
  // server signs evidence reports with, so a buyer (or the /verify page's
  // trusted-issuer keyring) can pin against the authoritative source instead of
  // trusting whatever key a report embeds. Returns ONLY the public half; the
  // private key never leaves the signer. Never throws.
  // -------------------------------------------------------------------------
  r.get('/v1/audit/issuer-key', (req, res) => {
    let signer = null;
    try { signer = loadOrCreateDefaultSigner(); } catch { signer = null; }
    if (!signer || !signer.publicKey) {
      return res.status(503).json({ ok: false, error: 'no_issuer_key', detail: 'this server has no Ed25519 signer configured (KOLM_ED25519_DISABLE=1 or key store unavailable)' });
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({
      ok: true,
      alg: 'ed25519',
      spec: 'kolm-ed25519-v1',
      public_key: signer.publicKey,
      key_fingerprint: signer.key_fingerprint,
      source: signer.source || null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/issuer-key/:fp/status  (PUBLIC) - the lifecycle status of an
  // issuer key fingerprint: 'live' | 'rotated' | 'revoked' + valid flag, so a
  // buyer's verifier can confirm the key that signed a report is still trusted
  // RIGHT NOW (a signature that verifies against a REVOKED key must be refused).
  // Pure read over the persisted key-revocation store; never throws.
  // -------------------------------------------------------------------------
  r.get('/v1/audit/issuer-key/:fp/status', (req, res) => {
    const fp = req.params && req.params.fp;
    let st;
    try { st = issuerKeyStatus(fp); }
    catch (e) { return _err(res, 500, 'status_failed', e && e.message); }
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({
      ok: true,
      fingerprint: st.fingerprint,
      valid: st.valid,
      status: st.status,
      revoked_at: st.revoked_at,
      reason: st.reason,
      next_rotation_at: st.next_rotation_at,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/issuer-key/:fp/revoke  (ADMIN-gated) - mark an issuer key
  // revoked. After this, POST /v1/audit/report/verify returns trusted:false +
  // reason:'issuer_key_revoked' for any report signed by that key, and the
  // public status endpoint reports valid:false. Gated by ADMIN_KEY (Bearer
  // ADMIN_KEY via authMiddleware -> req.is_admin, or an x-admin-key header).
  // body: { reason? }
  // -------------------------------------------------------------------------
  r.post('/v1/audit/issuer-key/:fp/revoke', (req, res) => {
    if (!_adminOk(req)) {
      return res.status(403).json({ ok: false, error: 'admin_required', detail: 'set ADMIN_KEY and authenticate as admin (Bearer ADMIN_KEY or x-admin-key header)' });
    }
    const fp = req.params && req.params.fp;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let st;
    try { st = revokeIssuerKey(fp, body.reason || 'admin_revocation'); }
    catch (e) { return _err(res, 400, 'revoke_failed', e && e.message); }
    tryAppendAudit({
      tenant_id: req.tenant_record ? req.tenant_record.id : 'admin',
      actor: 'admin', op: 'agent_audit.issuer_key_revoked',
      payload: { fingerprint: st.fingerprint, reason: st.reason, store: KEY_REVOCATION_VERSION },
    });
    return res.json({
      ok: true,
      fingerprint: st.fingerprint,
      valid: st.valid,
      status: st.status,
      revoked_at: st.revoked_at,
      reason: st.reason,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/reports - the tenant's report dashboard data. Lists every
  // audit/report this tenant owns (scan previews + paid reports) plus which ASR
  // products are currently purchasable. Powers public/dashboard.html.
  // -------------------------------------------------------------------------
  r.get('/v1/audit/reports', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const rows = findByField(TABLE, 'tenant_id', trec.id) || [];
    const reports = rows
      .filter((row) => row && row.report_id)
      .map((row) => ({
        id: row.id,
        report_id: row.report_id,
        subject: row.subject,
        readiness_pct: row.summary ? (row.summary.readiness_pct ?? null) : null,
        blocking_count: row.summary ? (row.summary.blocking_count ?? null) : null,
        tier: row.tier || (row.paid ? 'report' : 'scan'),
        paid: row.paid === true,
        public_slug: row.public_slug || null,
        trust_url: _trustUrlFor(row.public_slug),
        source: row.source || null,
        created_at: row.created_at,
      }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return res.json({ ok: true, reports, billing: asrBillingReady() });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/report/checkout - start the $750 one-time purchase of the
  // Signed Readiness Report for a specific audit. body: { audit_id }.
  // The audit must belong to the caller and already have a (watermarked) report.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/report/checkout', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const auditId = body.audit_id || body.id;
    if (!auditId) return _err(res, 400, 'audit_id_required', 'POST { "audit_id": "<audses_...>" }');
    const row = _getSession(trec.id, auditId);
    if (!row) return _err(res, 404, 'audit_not_found', `no audit ${auditId} for this tenant`);
    if (!row.report) return _err(res, 409, 'report_not_ready', 'scan or run the audit before purchasing the signed report');
    if (row.paid === true) {
      return res.json({ ok: true, already_paid: true, trust_url: _trustUrlFor(row.public_slug) });
    }
    try {
      const out = await createAsrCheckout({ product: 'report', tenant: trec.id, audit_id: auditId, email: trec.email || trec.owner_email });
      tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.checkout_started', payload: { audit_id: auditId, product: 'report', source: out.source } });
      return res.json({ ok: true, url: out.url, source: out.source });
    } catch (e) {
      const code = e && e.statusCode ? e.statusCode : 500;
      return res.status(code).json({ ok: false, error: (e && e.code) || 'checkout_failed', detail: e && e.message, ...(e && e.missing ? { missing: e.missing } : {}) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/continuous/checkout - subscribe to Continuous re-attestation.
  // body: { plan: "starter" | "growth" }.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/continuous/checkout', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const product = String(body.plan || body.product || '').toLowerCase();
    if (product !== 'starter' && product !== 'growth') {
      return _err(res, 400, 'invalid_plan', 'POST { "plan": "starter" | "growth" }');
    }
    try {
      const out = await createAsrCheckout({ product, tenant: trec.id, email: trec.email || trec.owner_email });
      tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.checkout_started', payload: { product, source: out.source } });
      return res.json({ ok: true, url: out.url, source: out.source });
    } catch (e) {
      const code = e && e.statusCode ? e.statusCode : 500;
      return res.status(code).json({ ok: false, error: (e && e.code) || 'checkout_failed', detail: e && e.message, ...(e && e.missing ? { missing: e.missing } : {}) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/package/checkout - self-serve purchase of an enterprise
  // PACKAGE. body: { product: "full" | "plus" }.
  //   full -> $15,000 one-time Full Readiness (a durable tenant entitlement,
  //           fulfilled by fulfillPackagePurchase in the webhook).
  //   plus -> $3,500/mo Continuous-Plus (flows through the existing subscription
  //           path; activated by activateSubscription with product_key 'plus').
  // Env-gated 503 degrade: when the product is not wired, createAsrCheckout
  // throws BillingNotConfiguredError (statusCode 503) listing the exact env vars.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/package/checkout', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const product = String(body.product || '').toLowerCase();
    if (product !== 'full' && product !== 'plus') {
      return _err(res, 400, 'invalid_product', 'POST { "product": "full" | "plus" }');
    }
    try {
      const out = await createAsrCheckout({ product, tenant: trec.id, email: trec.email || trec.owner_email });
      tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.checkout_started', payload: { product, source: out.source } });
      return res.json({ ok: true, url: out.url, source: out.source });
    } catch (e) {
      const code = e && e.statusCode ? e.statusCode : 500;
      return res.status(code).json({ ok: false, error: (e && e.code) || 'checkout_failed', detail: e && e.message, ...(e && e.missing ? { missing: e.missing } : {}) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/import - the Continuous ONRAMP. Pull logs the tenant already
  // has (inline in the request, or fetched from a url they control) through the
  // SAME scan -> sign path as /v1/audit/scan, yielding a signed report. Auth-
  // gated + tenant-fenced (the row is forced onto req.tenant_record.id), size-
  // capped (src/log-importer.js), and it never throws across the boundary.
  // body: { source?: 'inline'|'url'|'kolm-capture', logs?, url?, headers?,
  //         subject?, source_label?, retention_days?, sign?, persist? }
  // Designed to be hit on a schedule by a tiny sidecar (see docs/onramp.md).
  //
  // Tier-A bridge: source 'kolm-capture' skips the inline/url transport and
  // audits the CALLING tenant's own stored gateway captures (grade A). The
  // label is reserved - source_label may never claim it for vendor logs.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/import', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const source = String(body.source || (body.url ? 'url' : 'inline')).toLowerCase();
    const isCaptureBridge = source === KOLM_CAPTURE_SOURCE;
    if (!isCaptureBridge && _claimsCaptureSource(body.source_label)) {
      return _err(res, 400, 'source_label_reserved', `source_label "${KOLM_CAPTURE_SOURCE}" is reserved for the gateway-capture bridge; use {"source":"${KOLM_CAPTURE_SOURCE}"} (no logs/url) to audit this tenant's stored gateway captures`);
    }

    let text;
    let count;
    let bytes;
    if (isCaptureBridge) {
      if (body.logs != null || body.url != null) {
        return _err(res, 400, 'logs_not_allowed', `source "${KOLM_CAPTURE_SOURCE}" audits this tenant's stored gateway captures; do not supply logs or a url`);
      }
      let rows;
      try { rows = await _loadTenantCaptures(trec); }
      catch (e) { return _err(res, 500, 'capture_load_failed', e && e.message); }
      if (!rows.length) {
        return _err(res, 409, 'no_captures', 'this tenant has no stored gateway captures to audit; route agent traffic through the kolm gateway first, or import a vendor log export');
      }
      ({ text, count } = _toJsonl(rows));
      if (count === 0) {
        return _err(res, 409, 'no_captures', 'this tenant has no auditable gateway captures');
      }
      bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_BYTES_PER_SESSION) {
        return _err(res, 413, 'captures_too_large', `the stored captures exceed ${Math.floor(MAX_BYTES_PER_SESSION / (1024 * 1024))} MiB; contact dev@kolm.ai for a staged audit`);
      }
    } else {
      let imported;
      try {
        imported = await importAgentLogs({
          source,
          url: body.url,
          headers: body.headers,
          logs: body.logs != null ? body.logs : null,
          maxBytes: MAX_BYTES_PER_SESSION,
        });
      } catch (e) {
        // importAgentLogs is contracted never to throw; this is belt-and-suspenders.
        return _err(res, 500, 'import_failed', e && e.message);
      }
      if (!imported || !imported.ok) {
        const reason = (imported && imported.reason) || 'import_failed';
        const code = reason === 'too_large' ? 413
          : (reason === 'fetch_failed' || reason === 'fetch_status' || reason === 'fetch_timeout' || reason === 'read_failed' || reason === 'fetch_unavailable') ? 502
          : 400; // no_logs / url_required / invalid_url / blocked_url / invalid_source / unserializable_logs
        return _err(res, code, reason, imported && imported.detail);
      }
      ({ text, count } = _toJsonl(imported.payload));
      if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');
      bytes = imported.bytes;
    }
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `an import holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }

    const sign = body.sign !== false;
    const subject = String(body.subject || 'Agent fleet').slice(0, 200);
    const srcLabel = isCaptureBridge
      ? KOLM_CAPTURE_SOURCE
      : (_normalizeSource(body.source_label) || (source === 'url' ? 'import:url' : 'import'));
    const retentionDays = _clampRetentionDays(body.retention_days);
    const hostsNorm = _normalizeAllowedHosts(body.allowed_hosts);
    if (!hostsNorm.ok) {
      return _err(res, 400, 'invalid_allowed_hosts', `allowed_hosts must be an array of at most ${MAX_ALLOWED_HOSTS} hostname strings (each <=${MAX_HOST_LEN} chars)`);
    }
    const covNorm = _coverageFromBody(body);
    if (!covNorm.ok) {
      return _err(res, 400, 'invalid_coverage_declaration', covNorm.error);
    }
    const { audit, report, signError, auditError } = _runAndSign(text, {
      source: srcLabel, subject, retentionDays, sign,
      // First-party capture bridge -> full report tier (see scan route note).
      tier: isCaptureBridge ? 'report' : 'scan',
      allowedHosts: hostsNorm.hosts,
      coverageDeclaration: covNorm.declaration,
    });
    if (auditError) {
      return _err(res, 422, 'audit_failed', auditError.message || 'the supplied logs could not be analyzed');
    }
    if (sign && signError) {
      return _err(res, 503, 'no_signer_configured', signError.message || 'no Ed25519 signer available');
    }

    let id = null;
    if (body.persist !== false) {
      const now = new Date().toISOString();
      id = _newId();
      try {
        insert(TABLE, {
          id, tenant_id: trec.id, subject, source: srcLabel,
          retention_days: retentionDays,
          status: 'complete', logs: text, record_count: count,
          report: report ? report.envelope : null,
          report_id: report ? report.report_id : null,
          summary: audit.summary, created_at: now, updated_at: now,
        });
      } catch { id = null; /* persistence is best-effort; the report is still returned inline */ }
    }
    tryAppendAudit({
      tenant_id: trec.id, actor: trec.id, op: 'agent_audit.import',
      payload: { id, source, report_id: report ? report.report_id : null, records: count, bytes, readiness_pct: audit.summary.readiness_pct, signed: !!report },
    });
    // Fire-and-forget (never awaited): an authed import that produced a signed
    // report announces 'audit_report_ready' like the Continuous path.
    if (report) {
      _notifyReportReady(trec.id, {
        id,
        report_id: report.report_id,
        subject,
        readiness_pct: audit.summary ? audit.summary.readiness_pct : null,
        evidence_tier_grade: audit.evidence_tier ? (audit.evidence_tier.grade || null) : null,
      });
    }
    return res.json({
      ok: true,
      id,
      source,
      bytes,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      summary: audit.summary,
      ingest: audit.ingest,
      evidence_tier: audit.evidence_tier || null,
      report: report ? report.envelope : null,
      verify_url: _verifyUrlFor(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/continuous/tick  (cron-secret gated, in PUBLIC_API) - run
  // every Continuous subscription whose re-attestation is due. Driven by an
  // EXTERNAL scheduler hitting this with x-kolm-cron-secret (containers restart,
  // so no in-process timer). Idempotent: claim-then-run, never double-signs.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/continuous/tick', async (req, res) => {
    const secret = process.env.KOLM_CRON_SECRET;
    if (!secret) return _err(res, 503, 'cron_not_configured', 'set KOLM_CRON_SECRET to enable scheduled re-attestation');
    // Header-only: never accept the secret via query string (it would leak into
    // access logs / referrers). Matches the W258-SEC-1 no-secret-in-query policy.
    const provided = (req.headers && (req.headers['x-kolm-cron-secret'] || req.headers['x-cron-secret'])) || '';
    if (!_safeEq(provided, secret)) {
      return res.status(403).json({ ok: false, error: 'forbidden', detail: 'missing or invalid x-kolm-cron-secret' });
    }
    // Thread an explicit signer the same way the Stripe webhook now does, so the
    // scheduled re-attestation signs with the canonical per-machine key rather
    // than relying on the fulfillment default. null preserves current behavior.
    let __signer = null;
    try { const ed = await import('./ed25519.js'); __signer = ed.loadOrCreateDefaultSigner(); } catch { __signer = null; }
    let out;
    try { out = runDueReattestations({ signer: __signer }); }
    catch (e) { return _err(res, 500, 'tick_failed', e && e.message); }
    return res.json({ ok: true, ...out });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/continuous/deploy-hook - Growth "on every deploy": force an
  // immediate re-attestation for the caller's active subscription(s). Auth-gated
  // by the tenant's own API key (call it from CI after a deploy).
  // -------------------------------------------------------------------------
  r.post('/v1/audit/continuous/deploy-hook', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    // Thread an explicit signer (mirrors the webhook + scheduled tick wiring).
    // null preserves current behavior.
    let __signer = null;
    try { const ed = await import('./ed25519.js'); __signer = ed.loadOrCreateDefaultSigner(); } catch { __signer = null; }
    let out;
    try { out = forceReattest({ tenant_id: trec.id, signer: __signer }); }
    catch (e) { return _err(res, 500, 'reattest_failed', e && e.message); }
    if (!out.ok && out.reason === 'no_active_subscription') {
      return _err(res, 409, 'no_active_subscription', 'no active Continuous subscription for this tenant');
    }
    return res.json({ ok: true, ...out });
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug  (PUBLIC) - the shareable Trust link a buyer hands their
  // review group. Renders the paid signed report (html default, ?format=json|pdf)
  // and verifies offline. The slug is an unguessable capability token; possession
  // is the grant. Resolves a paid audit slug OR a subscription's stable slug
  // (always-current). A lapsed subscription serves its last report with a banner.
  // -------------------------------------------------------------------------
  r.get('/v1/trust/:slug', async (req, res) => {
    const slug = req.params && req.params.slug;
    const hit = resolveTrust(slug);
    if (!hit) return _err(res, 404, 'not_found', 'no published report at this link');
    // S7: log this Trust Link view for the owning seller (counts + distinct,
    // pseudonymous viewers). recordTrustView hashes the IP at the boundary and
    // NEVER stores a raw IP; it resolves the owner tenant from the slug itself.
    // Best-effort: view logging must never block or break serving the report.
    try {
      recordTrustView({
        slug,
        ip: (req.headers && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
          || req.ip
          || (req.socket && req.socket.remoteAddress)
          || '',
        ua: req.headers && req.headers['user-agent'],
        referer: req.headers && (req.headers.referer || req.headers.referrer),
      });
    } catch { /* view logging is best-effort */ }
    // A Continuous subscription that has not produced its first report yet:
    // render a "generating" page instead of a 404 (the link is valid).
    if (hit.pending) {
      const fmt = (req.query && String(req.query.format || 'html')).toLowerCase();
      if (fmt === 'json') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.json({ ok: true, status: 'pending', detail: 'first report is being generated' }); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(_trustPendingHtml());
    }
    // Defense-in-depth: strip the server-side-only _full_payload carry-over if
    // any resolved envelope ever carries it (resolveTrust yields paid/report-tier
    // envelopes, which already drop it on the paid upgrade; this keeps the public
    // Trust surface free of the carry-over regardless).
    const envelope = stripWirePayload(hit.envelope);
    const format = (req.query && String(req.query.format || 'html')).toLowerCase();
    const fname = hit.report_id || 'agent-security-report';

    if (format === 'json') {
      let json;
      try { json = JSON.stringify(envelope, null, 2); }
      catch (e) { return _err(res, 500, 'json_render_error', e && e.message); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(json);
    }
    if (format === 'pdf') {
      try {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${fname}.pdf"`);
        await renderReportPdf(envelope, res);
        return undefined;
      } catch (e) {
        if (!res.headersSent) {
          if (typeof res.removeHeader === 'function') { res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); }
          const code = e && e.code === 'PDFKIT_UNAVAILABLE' ? 503 : 500;
          return _err(res, code, code === 503 ? 'pdf_unavailable' : 'pdf_render_error', e && e.message);
        }
        return undefined;
      }
    }
    // html (default) - render in the browser, no upload, offline-verifiable.
    // S9 into the artifact: the drift vs the immediately-prior signed report is
    // rendered INSIDE the report (renderReportHtml's opts.delta - the same
    // 'What changed since the last attestation' block the builder owns). Same
    // helpers as the sibling /v1/trust/:slug/delta route. The whole computation
    // is best-effort: it can NEVER block or fail serving the report (a first
    // attestation or a delta hiccup just renders the report with no drift block).
    let prior = null;
    try { prior = resolvePriorReport(slug); } catch { prior = null; }
    let delta = null;
    if (prior) {
      try { delta = computeAuditDelta(prior, hit.envelope); } catch { delta = null; }
    }
    let html;
    try { html = renderReportHtml(envelope, { delta, trustSlug: slug }); }
    catch (e) { return _err(res, 500, 'html_render_error', e && e.message); }
    // Self-evidencing freshness for Continuous: lapsed > stale > current.
    const bstyle = (bg) => `background:${bg};color:#fff;padding:11px 16px;border-radius:8px;margin:0 0 22px;font:600 13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif`;
    let banner = '';
    if (hit.lapsed) {
      banner = `<div style="${bstyle('#92400e')}">Subscription lapsed - this is the last signed report from an inactive Continuous plan. It remains verifiable, but is no longer refreshed on new deploys.</div>`;
    } else if (hit.kind === 'continuous' && hit.stale) {
      banner = `<div style="${bstyle('#9a6700')}">This Continuous report has not refreshed in over 8 days${hit.age_hours != null ? ` (last re-attested ${hit.age_hours}h ago)` : ''}. Contact the vendor if their agents have shipped since.</div>`;
    } else if (hit.kind === 'continuous' && hit.age_hours != null) {
      banner = `<div style="${bstyle('#0f5132')}">Continuous - last re-attested ${hit.age_hours}h ago. This link refreshes automatically.</div>`;
    }
    if (banner) html = html.replace(/(<body[^>]*>)/, `$1${banner}`);
    // Reviewer toolbar (upgrade #2): the public Trust link is the reviewer's
    // WORKING surface, so the already-mounted procurement endpoints get a
    // sticky strip of working links at the top of the artifact. HTML-wrapper
    // only (the signed envelope underneath is untouched), applied ONLY on this
    // route - never on the watermarked authed session render. Cool slate,
    // squared corners, no glows, no warm colors.
    const eslug = encodeURIComponent(slug);
    const tbA = 'color:#fff;text-decoration:none;border:1px solid #2a3140;background:#141925;padding:4px 10px;border-radius:0;white-space:nowrap';
    const toolbar = `<div style="position:sticky;top:0;z-index:9999;background:#0b0e14;color:#fff;font:500 13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">`
      + `<span style="font-weight:700;letter-spacing:.04em;margin-right:6px">Reviewer tools</span>`
      + `<a style="${tbA}" href="/v1/trust/${eslug}/export?format=drata">Export Drata</a>`
      + `<a style="${tbA}" href="/v1/trust/${eslug}/export?format=vanta">Export Vanta</a>`
      + `<a style="${tbA}" href="/v1/trust/${eslug}/questionnaire?format=csv">Questionnaire CSV</a>`
      + `<a style="${tbA}" href="/v1/trust/${eslug}/badge.svg">Badge</a>`
      + `<a style="${tbA}" href="/v1/trust/${eslug}/delta">Drift JSON</a>`
      + `<a style="${tbA}" href="/verify?trust=${eslug}">Verify this report</a>`
      + `</div>`;
    html = html.replace(/(<body[^>]*>)/, `$1${toolbar}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug/export?format=...  (PUBLIC) - the same procurement
  // exports off the shareable Trust link, so a buyer's review group can pull a
  // CSV / .xls / Drata / Vanta / exec / crosswalk artifact straight into their
  // GRC tool with no kolm account. Possession of the unguessable slug is the
  // grant; resolveTrust only yields an envelope for a PAID audit or an active /
  // lapsed Continuous subscription (a not-yet-generated subscription is 409).
  // -------------------------------------------------------------------------
  r.get('/v1/trust/:slug/export', (req, res) => {
    const slug = req.params && req.params.slug;
    const hit = resolveTrust(slug);
    if (!hit) return _err(res, 404, 'not_found', 'no published report at this link');
    if (hit.pending || !hit.envelope) {
      return _err(res, 409, 'report_not_ready', 'this Continuous link has not generated its first report yet');
    }
    res.setHeader('Cache-Control', 'no-store');
    return _sendExport(res, hit.envelope, req.query && req.query.format);
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug/badge.svg  (PUBLIC) - a small embeddable status badge
  // ("Agent Security: NN% ready") for the shareable Trust link, so a vendor can
  // drop the live readiness pill into a README / status page. Resolves the slug
  // via the SAME resolveTrust path as GET /v1/trust/:slug/export. If the slug
  // does not resolve (or has not generated its first report yet), it serves the
  // grey "unknown" badge - it NEVER 500s. The badge is STATE-BEARING (a report
  // older than BADGE_STALE_DAYS goes grey 'stale (Month YYYY)'; a report whose
  // issuer key is revoked goes grey 'report revoked', outranking staleness and
  // readiness), so it is cached for only 5 minutes - short enough that a
  // revocation or freshness change propagates promptly. Allow-listed in
  // src/auth.js PUBLIC_API alongside the other /v1/trust regexes.
  // -------------------------------------------------------------------------
  r.get('/v1/trust/:slug/badge.svg', (req, res) => {
    const slug = req.params && req.params.slug;
    let envelope = null;
    try {
      const hit = resolveTrust(slug);
      // A resolved-but-pending Continuous link (no first report yet) has no
      // envelope: fall through to the grey "unknown" badge, never an error.
      if (hit && !hit.pending && hit.envelope) envelope = hit.envelope;
    } catch { envelope = null; }
    // State check (revocation + staleness) and render share ONE guard: any
    // internal error in either degrades to the grey "unknown" badge via
    // renderBadgeSvg(null) (itself never-throws), explicitly preserving the
    // route's NEVER-500 property.
    let svg;
    try { svg = renderBadgeSvg(envelope, envelope ? _badgeStateFor(envelope) : null); }
    catch { svg = renderBadgeSvg(null); }
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    // Short max-age: a state-bearing image must not be pinned in caches long
    // after the underlying report goes stale or its issuer key is revoked.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(svg);
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug/questionnaire?template=generic-ai-vendor[&format=csv]
  //   (PUBLIC) - the buyer's reviewer pre-fills a standard security questionnaire
  // straight from the SIGNED report behind the Trust Link, so they reuse the
  // signed evidence instead of re-interviewing the vendor by email. Possession of
  // the unguessable slug is the grant (same capability level as the report it
  // derives from); allow-listed in PUBLIC_API alongside GET /v1/trust/:slug.
  // Answers are DERIVED from the report - a control the run never assessed is
  // 'n/a', never an unsupported 'yes'.
  // -------------------------------------------------------------------------
  r.get('/v1/trust/:slug/questionnaire', (req, res) => {
    const slug = req.params && req.params.slug;
    const hit = resolveTrust(slug);
    if (!hit) return _err(res, 404, 'not_found', 'no published report at this link');
    if (hit.pending || !hit.envelope) {
      return _err(res, 409, 'report_not_ready', 'this Continuous link has not generated its first report yet');
    }
    res.setHeader('Cache-Control', 'no-store');
    return _sendQuestionnaire(res, hit.envelope, req.query, hit.report_id);
  });

  // -------------------------------------------------------------------------
  // GET /v1/trust/:slug/delta  (PUBLIC) - the signed drift between the report this
  // Trust Link serves now and its immediately-prior signed report (S9). Possession
  // of the unguessable slug is the grant (same capability level as the report it
  // diffs); allow-list it in PUBLIC_API alongside GET /v1/trust/:slug. The prior is
  // resolved from the audit / subscription history (resolvePriorReport); a link
  // with no prior (a first-cycle Continuous report or a standalone $750 report)
  // returns { ok:true, delta:null, note } rather than a 404. computeAuditDelta is
  // pure + never-throws; this route never re-signs and touches no tenant data.
  // -------------------------------------------------------------------------
  r.get('/v1/trust/:slug/delta', (req, res) => {
    const slug = req.params && req.params.slug;
    const hit = resolveTrust(slug);
    if (!hit) return _err(res, 404, 'not_found', 'no published report at this link');
    res.setHeader('Cache-Control', 'no-store');
    if (hit.pending || !hit.envelope) {
      return res.json({ ok: true, delta: null, kind: hit.kind || null, note: 'this Continuous link has not generated its first report yet' });
    }
    let prior = null;
    try { prior = resolvePriorReport(slug); } catch { prior = null; }
    if (!prior) {
      return res.json({ ok: true, delta: null, kind: hit.kind || null, report_id: hit.report_id || null, note: 'no prior signed report to compare against (this is the first attestation)' });
    }
    let delta = null;
    try { delta = computeAuditDelta(prior, hit.envelope); } catch { delta = null; }
    return res.json({ ok: true, delta, kind: hit.kind || null, report_id: hit.report_id || null });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/sessions/:id/questionnaire?template=...[&format=csv]
  //   (AUTH, tenant-fenced) - the SELLER pre-fills a questionnaire from their own
  // session's signed report (e.g. to attach to an RFP response before sharing).
  // Tenant-fenced exactly like the sibling /report + /export routes. body may
  // carry { template, format } as an alternative to the query string.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/sessions/:id/questionnaire', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    if (!sess.report) return _err(res, 409, 'report_not_ready', 'run the session before generating a questionnaire');
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const query = {
      template: (req.query && req.query.template) || body.template,
      format: (req.query && req.query.format) || body.format,
    };
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.questionnaire', payload: { id, report_id: sess.report_id, template: String(query.template || 'generic-ai-vendor') } });
    return _sendQuestionnaire(res, sess.report, query, sess.report_id);
  });

  // -------------------------------------------------------------------------
  // GET /v1/audit/sessions/:id/questionnaire?template=...[&format=csv]
  //   (AUTH, tenant-fenced) - the openable GET alias of the POST above, so a
  // seller can pull their session's autofilled questionnaire from a browser / a
  // simple link. Identical auth + tenant fence + pure-view semantics; query-only
  // (no body). The POST form stays for callers that prefer to send { template }.
  // -------------------------------------------------------------------------
  r.get('/v1/audit/sessions/:id/questionnaire', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const id = req.params && req.params.id;
    const sess = _getSession(trec.id, id);
    if (!sess) return _err(res, 404, 'session_not_found', `no audit session ${id} for this tenant`);
    if (!sess.report) return _err(res, 409, 'report_not_ready', 'run the session before generating a questionnaire');
    const query = { template: req.query && req.query.template, format: req.query && req.query.format };
    tryAppendAudit({ tenant_id: trec.id, actor: trec.id, op: 'agent_audit.questionnaire', payload: { id, report_id: sess.report_id, template: String(query.template || 'generic-ai-vendor'), method: 'GET' } });
    return _sendQuestionnaire(res, sess.report, query, sess.report_id);
  });

  // -------------------------------------------------------------------------
  // JSON 404 fallback for the namespaces this surface owns. Registered LAST so
  // every specific route above matches first; an unmatched GET sub-path under
  // /v1/audit or /v1/trust then returns a clean {ok:false} JSON envelope instead
  // of Express's default HTML "Cannot GET ..." page. Scoped to GET on exactly the
  // two namespaces this module owns, so it never shadows another surface (all
  // other /v1/audit + /v1/trust handlers are registered before this point).
  // -------------------------------------------------------------------------
  const _jsonNotFound = (req, res) =>
    res.status(404).json({ ok: false, error: 'not_found', detail: `no such endpoint: ${req.method} ${req.path}`, contact: 'dev@kolm.ai' });
  r.get('/v1/audit/*', _jsonNotFound);
  r.get('/v1/trust/*', _jsonNotFound);

  return r;
}

// ---------------------------------------------------------------------------
// Render an autofilled questionnaire over a signed report envelope, as JSON
// (default) or RFC-4180 CSV (?format=csv). Pure view over the SAME signed report
// (src/questionnaire-autofill.js never re-signs and never throws). An unknown
// template is a clean 400 listing the available templates.
// ---------------------------------------------------------------------------
function _sendQuestionnaire(res, envelope, query, reportId) {
  const template = (query && query.template) ? String(query.template) : 'generic-ai-vendor';
  let result;
  try { result = autofillQuestionnaire(envelope, { template }); }
  catch (e) { return _err(res, 500, 'questionnaire_failed', e && e.message); }
  if (result && result.error) {
    return res.status(400).json({ ok: false, error: result.error, available_templates: result.available_templates || QUESTIONNAIRE_TEMPLATES.map((t) => t.id) });
  }
  const fmt = String((query && query.format) || 'json').toLowerCase();
  if (fmt === 'csv') {
    let csv;
    try { csv = toQuestionnaireCsv(result); }
    catch (e) { return _err(res, 500, 'questionnaire_csv_failed', e && e.message); }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${(reportId || 'agent-security-report')}-${result.template}-questionnaire.csv"`);
    return res.send(csv);
  }
  return res.json({ ok: true, ...result, templates: QUESTIONNAIRE_TEMPLATES });
}

export default register;

export const AUDIT_ROUTES_SPEC = {
  version: AUDIT_ROUTES_VERSION,
  spec_version: AUDIT_SPEC_VERSION,
  report_schema: AUDIT_REPORT_SCHEMA,
  report_version: AUDIT_REPORT_VERSION,
  export_formats: [...EXPORT_FORMATS],
  routes: [
    'POST /v1/audit/sessions',
    'POST /v1/audit/sessions/:id/ingest',
    'POST /v1/audit/sessions/:id/run',
    'GET /v1/audit/sessions/:id',
    'GET /v1/audit/sessions/:id/report',
    'GET /v1/audit/sessions/:id/export',
    'POST /v1/audit/sessions/:id/delta (auth, tenant-fenced)',
    'GET /v1/audit/:id/oscal (auth, tenant-fenced)',
    'POST /v1/audit/:id/retest (auth, tenant-fenced)',
    'POST /v1/buyer/watchlist (auth, tenant-fenced)',
    'GET /v1/buyer/portfolio (auth, tenant-fenced)',
    'POST /v1/audit/sessions/:id/questionnaire',
    'GET /v1/audit/sessions/:id/questionnaire (auth, tenant-fenced)',
    'POST /v1/audit/scan',
    'POST /v1/audit/import',
    'GET /v1/audit/reports',
    'POST /v1/audit/report/checkout',
    'POST /v1/audit/continuous/checkout',
    'POST /v1/audit/package/checkout',
    'POST /v1/audit/continuous/tick (cron-secret)',
    'POST /v1/audit/continuous/deploy-hook',
    'POST /v1/audit/report/verify (public)',
    'GET /v1/audit/issuer-key (public)',
    'GET /v1/audit/issuer-key/:fp/status (public)',
    'POST /v1/audit/issuer-key/:fp/revoke (admin)',
    'GET /v1/transparency-log/size (public)',
    'GET /v1/transparency-log/entries (public)',
    'GET /v1/transparency-log/entries/:seq (public)',
    'GET /v1/transparency-log/proof/:seq (public)',
    'GET /v1/transparency-log/checkpoints/latest (public)',
    'GET /v1/transparency-log/checkpoints (public)',
    'GET /v1/trust/:slug (public)',
    'GET /v1/trust/:slug/export (public)',
    'GET /v1/trust/:slug/badge.svg (public)',
    'GET /v1/trust/:slug/questionnaire (public)',
    'GET /v1/trust/:slug/delta (public)',
    'GET /v1/trust/:slug/views (auth, tenant-fenced)',
    'GET /v1/trust-center (auth, tenant-fenced)',
    'POST /v1/trust/:slug/unlock (public)',
  ],
};
