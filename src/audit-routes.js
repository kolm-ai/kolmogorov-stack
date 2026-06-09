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

import { insert, update, findByField, withTransaction } from './store.js';
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
  AUDIT_REPORT_SCHEMA,
  AUDIT_REPORT_VERSION,
} from './attestation-report-builder.js';
import { EXPORTERS as FRAMEWORK_EXPORTERS, EXPORT_FORMATS } from './framework-export.js';
import { loadOrCreateDefaultSigner, keyFingerprint } from './ed25519.js';
import { register as registerTransparencyLogRoutes } from './transparency-log-routes.js';
import { register as registerTrustCenter, recordTrustView } from './trust-center.js';
import { revoke as revokeIssuerKey, status as issuerKeyStatus, KEY_REVOCATION_VERSION } from './key-revocation.js';
import { tryAppendAudit } from './audit.js';
import { createAsrCheckout, asrBillingReady } from './asr-billing.js';
import { resolveTrust, resolvePriorReport, runDueReattestations, forceReattest } from './asr-fulfillment.js';
import { computeAuditDelta } from './audit-delta.js';
import { autofillQuestionnaire, toQuestionnaireCsv, QUESTIONNAIRE_TEMPLATES } from './questionnaire-autofill.js';
import { importAgentLogs } from './log-importer.js';

export const AUDIT_ROUTES_VERSION = 'asr-audit-routes/0.1';

const TABLE = 'agent_audits';

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
<body><div class="card"><span class="dot"></span><h1>Your first signed report is generating</h1><p>This Continuous Trust link is live. The first re-attestation runs shortly and this page will refresh automatically. Questions: <a href="mailto:dev@kolm.ai">dev@kolm.ai</a>.</p></div></body></html>`;
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

// Run the orchestrator + (optionally) build+sign the report. Returns
// { audit?, report?, signError?, auditError? }. Never throws across the
// boundary: runAudit is designed not to throw, but we still guard it (a
// pathological export must not surface as a raw Express 500); a signer failure
// is surfaced as signError so the caller maps a clean 503.
function _runAndSign(logsText, { source, subject, retentionDays, sign, tier }) {
  const opts = { source: source || 'import' };
  if (Number.isFinite(retentionDays)) opts.retentionDays = retentionDays;
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
    const built = buildAndSignReport(audit, { subject, verify_url: _verifyUrlFor(), tier: tier || 'scan' });
    return { audit, report: built };
  } catch (e) {
    return { audit, report: null, signError: e };
  }
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

export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('audit-routes.register: router with get/post required');
  }

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
    const now = new Date().toISOString();
    const row = {
      id: _newId(),
      tenant_id: trec.id,
      subject: String(body.subject || 'Agent fleet').slice(0, 200),
      source: body.source ? String(body.source).slice(0, 64) : null,
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
    const sign = body.sign !== false;
    const { audit, report, signError, auditError } = _runAndSign(sess.logs, {
      source: body.source || sess.source,
      subject: body.subject || sess.subject,
      retentionDays: _clampRetentionDays(Number.isFinite(body.retention_days) ? body.retention_days : sess.retention_days),
      sign,
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

    const envelope = sess.report;
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
    return _sendExport(res, sess.report, format);
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/scan - one-shot: logs → signed report in a single call.
  // The fast path behind the "Agent Exposure Scan" + the full report. Persists
  // a completed session by default so the report is fetchable + re-verifiable.
  // body: { logs, subject?, source?, retention_days?, sign?, persist? }
  // -------------------------------------------------------------------------
  r.post('/v1/audit/scan', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const logsInput = body.logs != null ? body.logs : null;
    if (logsInput == null) return _err(res, 400, 'logs_required', 'POST { "logs": <JSONL text | array of records> }');
    const { text, count } = _toJsonl(logsInput);
    if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `a scan holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }

    const sign = body.sign !== false;
    const subject = String(body.subject || 'Agent fleet').slice(0, 200);
    const source = body.source ? String(body.source).slice(0, 64) : 'import';
    const retentionDays = _clampRetentionDays(body.retention_days);
    const { audit, report, signError, auditError } = _runAndSign(text, {
      source, subject,
      retentionDays,
      sign,
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
    return res.json({
      ok: true,
      id,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      summary: audit.summary,
      ingest: audit.ingest,
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
  // body: { source?: 'inline'|'url', logs?, url?, headers?, subject?, source_label?,
  //         retention_days?, sign?, persist? }
  // Designed to be hit on a schedule by a tiny sidecar (see docs/onramp.md).
  // -------------------------------------------------------------------------
  r.post('/v1/audit/import', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const source = String(body.source || (body.url ? 'url' : 'inline')).toLowerCase();

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

    const { text, count } = _toJsonl(imported.payload);
    if (count === 0) return _err(res, 400, 'no_records', 'no parseable log records were supplied');
    if (count > MAX_RECORDS_PER_SESSION) {
      return _err(res, 413, 'too_many_records', `an import holds at most ${MAX_RECORDS_PER_SESSION} records; split the export`);
    }

    const sign = body.sign !== false;
    const subject = String(body.subject || 'Agent fleet').slice(0, 200);
    const srcLabel = body.source_label ? String(body.source_label).slice(0, 64) : (source === 'url' ? 'import:url' : 'import');
    const retentionDays = _clampRetentionDays(body.retention_days);
    const { audit, report, signError, auditError } = _runAndSign(text, { source: srcLabel, subject, retentionDays, sign });
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
      payload: { id, source, report_id: report ? report.report_id : null, records: count, bytes: imported.bytes, readiness_pct: audit.summary.readiness_pct, signed: !!report },
    });
    return res.json({
      ok: true,
      id,
      source,
      bytes: imported.bytes,
      report_id: report ? report.report_id : null,
      signed: !!report,
      key_fingerprint: report ? report.key_fingerprint : null,
      summary: audit.summary,
      ingest: audit.ingest,
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
  r.post('/v1/audit/continuous/tick', (req, res) => {
    const secret = process.env.KOLM_CRON_SECRET;
    if (!secret) return _err(res, 503, 'cron_not_configured', 'set KOLM_CRON_SECRET to enable scheduled re-attestation');
    // Header-only: never accept the secret via query string (it would leak into
    // access logs / referrers). Matches the W258-SEC-1 no-secret-in-query policy.
    const provided = (req.headers && (req.headers['x-kolm-cron-secret'] || req.headers['x-cron-secret'])) || '';
    if (!_safeEq(provided, secret)) {
      return res.status(403).json({ ok: false, error: 'forbidden', detail: 'missing or invalid x-kolm-cron-secret' });
    }
    let out;
    try { out = runDueReattestations({}); }
    catch (e) { return _err(res, 500, 'tick_failed', e && e.message); }
    return res.json({ ok: true, ...out });
  });

  // -------------------------------------------------------------------------
  // POST /v1/audit/continuous/deploy-hook - Growth "on every deploy": force an
  // immediate re-attestation for the caller's active subscription(s). Auth-gated
  // by the tenant's own API key (call it from CI after a deploy).
  // -------------------------------------------------------------------------
  r.post('/v1/audit/continuous/deploy-hook', (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    let out;
    try { out = forceReattest({ tenant_id: trec.id }); }
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
    const envelope = hit.envelope;
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
    let html;
    try { html = renderReportHtml(envelope); }
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
    'GET /v1/trust/:slug/questionnaire (public)',
    'GET /v1/trust/:slug/delta (public)',
    'GET /v1/trust/:slug/views (auth, tenant-fenced)',
    'GET /v1/trust-center (auth, tenant-fenced)',
    'POST /v1/trust/:slug/unlock (public)',
  ],
};
