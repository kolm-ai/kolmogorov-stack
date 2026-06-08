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
import { loadOrCreateDefaultSigner } from './ed25519.js';
import { tryAppendAudit } from './audit.js';
import { createAsrCheckout, asrBillingReady } from './asr-billing.js';
import { resolveTrust, runDueReattestations, forceReattest } from './asr-fulfillment.js';

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

// Constant-time string compare for the cron secret (length-guarded).
function _safeEq(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
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

export function register(r, deps = {}) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('audit-routes.register: router with get/post required');
  }

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
    const trusted = verify.ok === true && issuer.recognized === true;
    return res.json({ ok: true, trusted, verify, issuer });
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
  // POST /v1/audit/continuous/tick  (cron-secret gated, in PUBLIC_API) - run
  // every Continuous subscription whose re-attestation is due. Driven by an
  // EXTERNAL scheduler hitting this with x-kolm-cron-secret (containers restart,
  // so no in-process timer). Idempotent: claim-then-run, never double-signs.
  // -------------------------------------------------------------------------
  r.post('/v1/audit/continuous/tick', (req, res) => {
    const secret = process.env.KOLM_CRON_SECRET;
    if (!secret) return _err(res, 503, 'cron_not_configured', 'set KOLM_CRON_SECRET to enable scheduled re-attestation');
    const provided = (req.headers && (req.headers['x-kolm-cron-secret'] || req.headers['x-cron-secret']))
      || (req.query && req.query.secret) || '';
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
    if (hit.lapsed) {
      const banner = '<div style="background:#92400e;color:#fff;padding:11px 16px;border-radius:8px;margin:0 0 22px;font:600 13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">Subscription lapsed - this is the last signed report from an inactive Continuous plan. It remains verifiable, but is no longer refreshed on new deploys.</div>';
      html = html.replace(/(<body[^>]*>)/, `$1${banner}`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  });

  return r;
}

export default register;

export const AUDIT_ROUTES_SPEC = {
  version: AUDIT_ROUTES_VERSION,
  spec_version: AUDIT_SPEC_VERSION,
  report_schema: AUDIT_REPORT_SCHEMA,
  report_version: AUDIT_REPORT_VERSION,
  routes: [
    'POST /v1/audit/sessions',
    'POST /v1/audit/sessions/:id/ingest',
    'POST /v1/audit/sessions/:id/run',
    'GET /v1/audit/sessions/:id',
    'GET /v1/audit/sessions/:id/report',
    'POST /v1/audit/scan',
    'GET /v1/audit/reports',
    'POST /v1/audit/report/checkout',
    'POST /v1/audit/continuous/checkout',
    'POST /v1/audit/continuous/tick (cron-secret)',
    'POST /v1/audit/continuous/deploy-hook',
    'POST /v1/audit/report/verify (public)',
    'GET /v1/audit/issuer-key (public)',
    'GET /v1/trust/:slug (public)',
  ],
};
