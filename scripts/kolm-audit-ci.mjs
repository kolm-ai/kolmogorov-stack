#!/usr/bin/env node
// scripts/kolm-audit-ci.mjs
//
// S10 onramp - the CI entrypoint behind the kolm-agent-audit GitHub Action.
//
// Reads agent logs (a file, a directory of files, or stdin), auto-detects the
// platform (Datadog / LangSmith / OpenTelemetry) and normalizes via the
// connector registry, OR passes provider-native logs straight through. It then
// calls POST /v1/audit/scan, discovers the most recent PRIOR signed report for
// the same subject (GET /v1/audit/reports), computes the signed delta between
// the two (POST /v1/audit/sessions/:id/delta?against=<prior>), prints a concise
// CI summary, upserts ONE pull-request comment showing the delta (counts and
// control transitions only - never raw finding detail), writes the same content
// to GITHUB_STEP_SUMMARY, and gates the build per the configured gate mode.
//
// Gate modes (--gate-mode=<mode> or KOLM_GATE_MODE):
//   report-only        never fails the build on findings; prints + summarizes.
//   fail-on-new-high   fails iff the delta vs the prior signed report adds a
//                      high or critical finding, or a control newly enters
//                      'blocking'.
//   fail-on-regression fails iff the delta is a regression: delta.regressed,
//                      OR any control status worsened, OR a new high/critical
//                      finding.
//   legacy             (also: unset, 'absolute') the original absolute gate -
//                      min-readiness percent + fail-on-blocking. Kept for
//                      backward compatibility.
//
// First run on a subject (no prior signed report): the delta gate prints
// 'baseline established' and passes in all modes.
//
// Failure-mode rule: if the kolm API is unreachable mid-gate, report-only never
// fails the build; fail-on-new-high and fail-on-regression fail CLOSED with a
// clear message unless --fail-open (or KOLM_FAIL_OPEN=true) is set.
//
// No dependencies beyond Node (>= 18) global fetch. All file reads use utf8.
// The API key and the GitHub token are never printed.
//
// Configuration is via environment (the Action maps its inputs onto these):
//   KOLM_API_URL              base URL (default https://kolm.ai)
//   KOLM_API_KEY              ks_... key (required)
//   KOLM_AUDIT_LOGS           path to a file or directory ('-' or empty = stdin)
//   KOLM_AUDIT_SOURCE         auto | datadog | langsmith | otel | raw (default auto)
//   KOLM_AUDIT_SUBJECT        report subject (default "Agent fleet")
//   KOLM_GATE_MODE            report-only | fail-on-new-high | fail-on-regression | legacy
//   KOLM_FAIL_OPEN            true|false (default false) - see failure-mode rule
//   KOLM_GITHUB_TOKEN         token for the PR comment (GITHUB_TOKEN also read)
//   KOLM_AUDIT_COMMENT        true|false (default true) - enable the PR comment
//   KOLM_TRUST_SLUG           optional public Trust slug, linked in the comment
//   KOLM_AUDIT_SIGN           true|false (default true)
//   KOLM_AUDIT_RETENTION_DAYS optional declared retention window (number)
//
// Legacy absolute gate (documented as legacy; authoritative when the gate mode
// is 'legacy' / unset; under the delta gate modes it is enforced only when
// KOLM_AUDIT_ABSOLUTE_GATE=true, and never under report-only):
//   KOLM_AUDIT_MIN_READINESS     fail under this readiness percent (default 80)
//   KOLM_AUDIT_FAIL_ON_BLOCKING  true|false (default true)
//   KOLM_AUDIT_ABSOLUTE_GATE     true|false (default false) - enforce the two
//                                flags above IN ADDITION to a delta gate mode
//
// A path may also be passed as the first CLI argument. Questions: dev@kolm.ai

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectConnector, normalizeWith, SOURCES } from '../src/connectors/index.js';

/* ----------------------------- pure helpers ------------------------------- */
/* Everything in this block is pure (no env, no fs, no fetch) and exported so
 * tests/kolm-audit-ci.test.js can exercise the gate decisions and the comment
 * renderer with fabricated payloads. */

export const COMMENT_MARKER = '<!-- kolm-agent-audit -->';

// Control status vocabulary rank: a transition to a higher rank is worse.
// Mirrors src/audit-delta.js (pass -> untested -> attention -> blocking).
export const STATUS_RANK = { pass: 0, untested: 1, attention: 2, blocking: 3 };

export const GATE_MODES = ['legacy', 'report-only', 'fail-on-new-high', 'fail-on-regression'];

// Normalize a raw gate-mode string. '' / null -> 'legacy' (backward compatible);
// 'absolute' is an alias for 'legacy'; an unknown value -> null (config error).
export function parseGateMode(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === 'legacy' || v === 'absolute') return 'legacy';
  return GATE_MODES.includes(v) ? v : null;
}

// Minimal CLI parsing: flags first, the first bare argument is the logs path.
//   --gate-mode=<mode> | --gate-mode <mode> | --fail-open
export function parseCliArgs(argv) {
  const out = { logsPath: '', gateMode: null, failOpen: false };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--fail-open') { out.failOpen = true; continue; }
    if (a.startsWith('--gate-mode=')) { out.gateMode = a.slice('--gate-mode='.length); continue; }
    if (a === '--gate-mode') { out.gateMode = args[i + 1] != null ? String(args[i + 1]) : ''; i++; continue; }
    if (!a.startsWith('--') && !out.logsPath) out.logsPath = a;
  }
  return out;
}

function _addedFindings(delta) {
  return delta && Array.isArray(delta.findings_added) ? delta.findings_added : [];
}
function _changedControls(delta) {
  return delta && Array.isArray(delta.controls_changed) ? delta.controls_changed : [];
}
function _severe(findings) {
  return findings.filter((f) => f && (f.severity === 'high' || f.severity === 'critical'));
}

// The delta gate decision. Pure. `delta` is the object returned by
// POST /v1/audit/sessions/:id/delta (readiness_change, regressed,
// controls_changed:[{id,from_status,to_status}], findings_added, findings_resolved).
// A null delta (baseline run, or report-only) never fails here - availability
// failures are handled by the caller per the failure-mode rule.
export function evaluateDeltaGate(mode, delta) {
  const out = { failed: false, reasons: [] };
  if (mode === 'report-only' || mode === 'legacy') return out;
  if (!delta || typeof delta !== 'object') return out;

  const severe = _severe(_addedFindings(delta));
  const changed = _changedControls(delta);
  const newlyBlocking = changed.filter((c) => c && c.to_status === 'blocking');
  const worsened = changed.filter(
    (c) => c && (STATUS_RANK[c.to_status] ?? 1) > (STATUS_RANK[c.from_status] ?? 1),
  );

  if (mode === 'fail-on-new-high') {
    if (severe.length) out.reasons.push(`${severe.length} new high or critical finding(s) versus the prior signed report`);
    if (newlyBlocking.length) out.reasons.push(`control(s) newly blocking versus the prior signed report: ${newlyBlocking.map((c) => c.id).join(', ')}`);
  } else if (mode === 'fail-on-regression') {
    if (delta.regressed === true) out.reasons.push('the signed delta marks this run as a regression versus the prior report');
    if (worsened.length) out.reasons.push(`control status worsened: ${worsened.map((c) => `${c.id} ${c.from_status} -> ${c.to_status}`).join(', ')}`);
    if (severe.length) out.reasons.push(`${severe.length} new high or critical finding(s) versus the prior signed report`);
  }
  out.failed = out.reasons.length > 0;
  return out;
}

// The legacy absolute gate (min readiness percent + fail-on-blocking). Pure.
export function evaluateAbsoluteGate({ readiness, blockingCount, minReadiness, failOnBlocking }) {
  const reasons = [];
  if (readiness == null) {
    reasons.push('the scan ingested no auditable events from the supplied logs');
  } else if (readiness < minReadiness) {
    reasons.push(`readiness ${readiness}% is below the required ${minReadiness}%`);
  }
  if (failOnBlocking && blockingCount > 0) {
    reasons.push(`${blockingCount} blocking finding(s) and fail-on-blocking is enabled`);
  }
  return { failed: reasons.length > 0, reasons };
}

// Pick the most recent PRIOR complete session for the same subject from the
// GET /v1/audit/reports listing ({ id, report_id, subject, created_at, ... }).
// Excludes the row the current scan just persisted (by session id and, when the
// session id is unknown, by report id). Pure; returns the row or null.
export function selectPriorSession(reports, { subject, currentId, currentReportId } = {}) {
  const rows = (Array.isArray(reports) ? reports : []).filter(
    (r) => r && r.id && r.report_id
      && (subject == null || r.subject === subject)
      && (!currentId || r.id !== currentId)
      && (!currentReportId || r.report_id !== currentReportId),
  );
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return rows.length ? rows[0] : null;
}

function _mdCell(v) {
  return String(v == null ? '-' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Render the single PR comment (and the step summary - same content). Pure,
// ASCII-only. Deltas first, one line per changed control, counts with zero
// finding detail: finding titles and descriptions NEVER appear here, they stay
// in the private report.
export function renderPrComment(model) {
  const m = model || {};
  const summary = m.summary && typeof m.summary === 'object' ? m.summary : {};
  const controls = Array.isArray(summary.controls) ? summary.controls : [];
  const delta = m.delta && typeof m.delta === 'object' ? m.delta : null;

  const passCount = controls.filter((c) => c && c.status === 'pass').length;
  const controlsBit = controls.length ? `${passCount}/${controls.length} controls pass` : 'scan complete';

  let direction;
  if (m.baseline) {
    direction = 'baseline established, no prior signed report for this subject';
  } else if (!delta) {
    direction = 'delta vs the prior signed report unavailable on this run';
  } else if (typeof delta.readiness_change === 'number') {
    direction = delta.readiness_change === 0
      ? 'readiness unchanged vs last signed report'
      : `readiness ${delta.readiness_change > 0 ? '+' : ''}${delta.readiness_change} vs last signed report`;
  } else {
    direction = 'readiness n/a vs last signed report';
  }

  const lines = [COMMENT_MARKER, `**kolm agent audit: ${controlsBit} (${direction})**`, ''];

  const changed = _changedControls(delta);
  if (!m.baseline && changed.length) {
    const names = new Map(controls.map((c) => [String(c && c.id), c && c.name ? String(c.name) : '-']));
    lines.push('| Control | Name | Change |');
    lines.push('| --- | --- | --- |');
    for (const c of changed) {
      lines.push(`| ${_mdCell(c.id)} | ${_mdCell(names.get(String(c.id)))} | ${_mdCell(c.from_status)} -> ${_mdCell(c.to_status)} |`);
    }
    lines.push('');
  }

  if (m.baseline) {
    lines.push('Baseline established. The next run on this subject reports the delta against this signed report.');
  } else if (delta) {
    const added = _addedFindings(delta);
    const resolved = Array.isArray(delta.findings_resolved) ? delta.findings_resolved : [];
    lines.push(`${added.length} new finding(s) (${_severe(added).length} high or critical), ${resolved.length} resolved. Finding detail stays in the private report.`);
  } else {
    lines.push('The delta against the prior signed report could not be computed on this run.');
  }

  lines.push('');
  lines.push(`Gate mode: ${m.gateMode || 'legacy'} - ${m.passed ? 'passed' : 'failed'}.`);
  lines.push('');

  const base = String(m.apiUrl || 'https://kolm.ai').replace(/\/+$/, '');
  const sessionBit = m.sessionId
    ? `Session ${m.sessionId} in the [kolm dashboard](${base}/dashboard).`
    : `Reports live in the [kolm dashboard](${base}/dashboard).`;
  lines.push(sessionBit + (m.trustUrl ? ` Public trust link: ${m.trustUrl}` : ''));
  lines.push('');

  const verifyUrl = m.verifyUrl || `${base}/verify`;
  lines.push(m.signed && m.reportId
    ? `signed report ${m.reportId} - verify offline at ${verifyUrl}`
    : `unsigned scan preview - signed reports verify offline at ${verifyUrl}`);
  return lines.join('\n');
}

// Find the pull-request number from the Actions environment: the event payload
// (pull_request.number) when GITHUB_EVENT_PATH points at one, else GITHUB_REF
// of the form refs/pull/<n>/... . Returns a number or null.
export function detectPrNumber(env, readFile) {
  const e = env || {};
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  if (e.GITHUB_EVENT_PATH) {
    try {
      const ev = JSON.parse(read(e.GITHUB_EVENT_PATH));
      const n = ev && ev.pull_request && Number(ev.pull_request.number);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through to GITHUB_REF */ }
  }
  const match = String(e.GITHUB_REF || '').match(/^refs\/pull\/(\d+)(\/|$)/);
  return match ? Number(match[1]) : null;
}

/* --------------------------------- config --------------------------------- */

function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envNum(name, dflt) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}

const CLI = parseCliArgs(process.argv.slice(2));

const CFG = {
  apiUrl: String(process.env.KOLM_API_URL || 'https://kolm.ai').replace(/\/+$/, ''),
  apiKey: process.env.KOLM_API_KEY || '',
  logsPath: CLI.logsPath || process.env.KOLM_AUDIT_LOGS || '',
  source: String(process.env.KOLM_AUDIT_SOURCE || 'auto').toLowerCase(),
  subject: process.env.KOLM_AUDIT_SUBJECT || 'Agent fleet',
  gateModeRaw: CLI.gateMode != null ? CLI.gateMode : (process.env.KOLM_GATE_MODE || ''),
  failOpen: CLI.failOpen || envBool('KOLM_FAIL_OPEN', false),
  minReadiness: envNum('KOLM_AUDIT_MIN_READINESS', 80),
  failOnBlocking: envBool('KOLM_AUDIT_FAIL_ON_BLOCKING', true),
  absoluteGate: envBool('KOLM_AUDIT_ABSOLUTE_GATE', false),
  sign: envBool('KOLM_AUDIT_SIGN', true),
  comment: envBool('KOLM_AUDIT_COMMENT', true),
  trustSlug: String(process.env.KOLM_TRUST_SLUG || '').trim(),
  githubToken: process.env.KOLM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',
  retentionDays: process.env.KOLM_AUDIT_RETENTION_DAYS != null && process.env.KOLM_AUDIT_RETENTION_DAYS !== ''
    ? envNum('KOLM_AUDIT_RETENTION_DAYS', null) : null,
};

const IN_GHA = !!process.env.GITHUB_ACTIONS;

/* ------------------------------ CI annotations ----------------------------- */

function log(msg) { process.stdout.write(String(msg) + '\n'); }
function notice(msg) { log(IN_GHA ? `::notice::${msg}` : msg); }
function warn(msg) { log(IN_GHA ? `::warning::${msg}` : `warning: ${msg}`); }
function error(msg) { log(IN_GHA ? `::error::${msg}` : `error: ${msg}`); }

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  try { fs.appendFileSync(f, `${name}=${String(value)}\n`, 'utf8'); } catch { /* output write is best-effort */ }
}
function stepSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, md + '\n', 'utf8'); } catch { /* summary write is best-effort */ }
}

// process.exit() is deliberately avoided everywhere: on Windows, exiting while
// undici keep-alive sockets are live crashes Node with 0xC0000409 and corrupts
// the gate's exit code. GateExit unwinds main() instead; the runner at the
// bottom maps it onto process.exitCode and lets the event loop drain.
class GateExit extends Error {
  constructor(code) { super(`gate exit ${code}`); this.code = code; }
}

function fail(msg) {
  error(msg);
  setOutput('passed', 'false');
  throw new GateExit(1);
}

// A pass exit that the report-only / fail-open paths share.
function passExit(msg) {
  if (msg) notice(msg);
  setOutput('passed', 'true');
  throw new GateExit(0);
}

/* ------------------------------- read logs -------------------------------- */

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Return a list of { name, text } log blobs from a file, a directory of files,
// or stdin. All reads are utf8.
async function loadInputs() {
  const p = CFG.logsPath;
  if (!p || p === '-') {
    const text = await readStdin();
    return text.trim() ? [{ name: 'stdin', text }] : [];
  }
  let st;
  try { st = fs.statSync(p); }
  catch { fail(`logs path not found: ${p}`); return []; }
  if (st.isDirectory()) {
    const out = [];
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fp = path.join(p, entry.name);
      try { const text = fs.readFileSync(fp, 'utf8'); if (text.trim()) out.push({ name: entry.name, text }); }
      catch { warn(`could not read ${fp}`); }
    }
    return out;
  }
  try { return [{ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }]; }
  catch { fail(`could not read ${p}`); return []; }
}

// Parse a non-connector text blob into an array of records (JSON array, wrapper,
// JSONL, or a single object). The kolm server ingests provider-native shapes
// (LiteLLM / Helicone / Portkey / OpenRouter / raw OpenAI) directly.
function rawRecords(text) {
  const t = String(text).trim();
  if (t === '') return [];
  if (t[0] === '[' || t[0] === '{') {
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return p;
      if (p && typeof p === 'object') {
        for (const k of ['data', 'rows', 'events', 'generations', 'spans', 'runs']) {
          if (Array.isArray(p[k])) return p[k];
        }
        return [p];
      }
    } catch { /* fall through to JSONL */ }
  }
  const out = [];
  for (const line of t.replace(/\r\n/g, '\n').split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    try { out.push(JSON.parse(s)); } catch { /* skip unparseable line */ }
  }
  return out;
}

// Normalize all inputs into ONE records array the server can ingest, plus the
// set of detected sources for the report label.
function buildPayload(inputs) {
  const records = [];
  const detected = new Set();
  for (const { name, text } of inputs) {
    let source = CFG.source;
    if (source === 'auto') source = detectConnector(text) || 'raw';
    if (source !== 'raw' && SOURCES.includes(source)) {
      const events = normalizeWith(source, text);
      if (events.length) {
        detected.add(source);
        for (const e of events) records.push(e);
        log(`  ${name}: detected ${source}, ${events.length} event(s)`);
        continue;
      }
      log(`  ${name}: ${source} produced no events, falling back to raw passthrough`);
    }
    const recs = rawRecords(text);
    if (recs.length) { detected.add('raw'); for (const r of recs) records.push(r); log(`  ${name}: ${recs.length} raw record(s)`); }
    else log(`  ${name}: no parseable records`);
  }
  const label = detected.size === 1 ? [...detected][0] : (detected.size > 1 ? 'mixed' : 'import');
  return { records, label };
}

/* ------------------------------- kolm API --------------------------------- */

async function kolmFetch(pathname, { method = 'GET', body = null } = {}) {
  let resp;
  try {
    resp = await fetch(`${CFG.apiUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${CFG.apiKey}`,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, detail: (e && e.message) || 'network error' };
  }
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON body */ }
  return { ok: resp.ok, status: resp.status, json, detail: null };
}

async function postScan(records, label, sign) {
  const body = { logs: records, subject: CFG.subject, source: label, sign };
  if (CFG.retentionDays != null) body.retention_days = CFG.retentionDays;
  return kolmFetch('/v1/audit/scan', { method: 'POST', body });
}

// Discover the prior signed report for the same subject and compute the signed
// delta current-vs-prior. Returns one of:
//   { kind: 'baseline' }
//   { kind: 'delta', delta, prior }
//   { kind: 'unavailable', detail }
async function resolveDelta({ sessionId, reportId, signed }) {
  const listing = await kolmFetch('/v1/audit/reports');
  if (!listing.ok || !listing.json || listing.json.ok !== true) {
    return { kind: 'unavailable', detail: listing.status === 0 ? `could not reach the kolm API (${listing.detail})` : `GET /v1/audit/reports returned HTTP ${listing.status}` };
  }
  const prior = selectPriorSession(listing.json.reports, {
    subject: CFG.subject,
    currentId: sessionId,
    currentReportId: reportId,
  });
  if (!prior) return { kind: 'baseline' };
  if (!sessionId) {
    return { kind: 'unavailable', detail: 'the scan session was not persisted, so the delta route cannot address it' };
  }
  if (!signed) {
    return { kind: 'unavailable', detail: 'this scan is an unsigned preview; the delta gate compares signed reports (leave sign enabled)' };
  }
  const res = await kolmFetch(
    `/v1/audit/sessions/${encodeURIComponent(sessionId)}/delta?against=${encodeURIComponent(prior.id)}`,
    { method: 'POST', body: {} },
  );
  if (!res.ok || !res.json || res.json.ok !== true || !res.json.delta) {
    const why = res.status === 0
      ? `could not reach the kolm API (${res.detail})`
      : `delta route returned HTTP ${res.status}${res.json && res.json.error ? ` (${res.json.error})` : ''}`;
    return { kind: 'unavailable', detail: why };
  }
  return { kind: 'delta', delta: res.json.delta, prior };
}

/* ------------------------------- PR comment -------------------------------- */

async function githubFetch(url, { method = 'GET', body = null } = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${CFG.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kolm-agent-audit',
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, detail: (e && e.message) || 'network error' };
  }
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON body */ }
  return { ok: resp.ok, status: resp.status, json, detail: null };
}

// Upsert the ONE kolm comment on the PR: PATCH the existing comment carrying
// COMMENT_MARKER, else POST a new one. Best-effort: a comment failure warns and
// never fails the build.
async function upsertPrComment(bodyMarkdown) {
  if (!CFG.comment) return;
  if (!CFG.githubToken) return;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const prNumber = detectPrNumber(process.env);
  if (!repo || !prNumber) return;
  const apiBase = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  const list = await githubFetch(`${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!list.ok || !Array.isArray(list.json)) {
    warn(`could not list PR comments (HTTP ${list.status}); skipping the PR comment.`);
    return;
  }
  const mine = list.json.find((c) => c && typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));
  const res = mine
    ? await githubFetch(`${apiBase}/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: bodyMarkdown } })
    : await githubFetch(`${apiBase}/repos/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body: bodyMarkdown } });
  if (!res.ok) warn(`could not ${mine ? 'update' : 'create'} the PR comment (HTTP ${res.status}).`);
  else log(`PR comment ${mine ? 'updated' : 'created'} on #${prNumber}.`);
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const gateMode = parseGateMode(CFG.gateModeRaw);
  if (gateMode == null) {
    fail(`unknown gate mode "${CFG.gateModeRaw}". Valid: report-only | fail-on-new-high | fail-on-regression | legacy.`);
  }
  const reportOnly = gateMode === 'report-only';
  setOutput('gate-mode', gateMode);

  if (!CFG.apiKey) fail('KOLM_API_KEY is not set. Create a key in your kolm account and store it as a CI secret.');

  log(`kolm agent audit -> ${CFG.apiUrl} (gate mode: ${gateMode})`);
  const inputs = await loadInputs();
  if (inputs.length === 0) fail('no logs supplied. Pass a file or directory, set KOLM_AUDIT_LOGS, or pipe logs on stdin.');

  const { records, label } = buildPayload(inputs);
  if (records.length === 0) fail('no parseable log records were found in the supplied logs.');
  log(`prepared ${records.length} record(s) (source: ${label})`);

  let result = await postScan(records, label, CFG.sign);
  // If signing is unavailable on the deployment, retry unsigned so the gate
  // still gets its readiness verdict.
  if (!result.ok && result.json && result.json.error === 'no_signer_configured' && CFG.sign) {
    warn('no signer configured on the deployment; re-running the scan unsigned for the readiness gate.');
    result = await postScan(records, label, false);
  }
  if (result.status === 0 || !result.ok || !result.json || result.json.ok !== true) {
    const j = result.json || {};
    const why = result.status === 0
      ? `could not reach the kolm API: ${result.detail || 'network error'}`
      : `scan failed (HTTP ${result.status}): ${j.error || 'unknown_error'}${j.detail ? ' - ' + j.detail : ''}`;
    if (reportOnly) {
      warn(`${why}`);
      stepSummary(`## kolm agent audit\n\nThe scan could not run on this build (${why}). Gate mode report-only never fails the build.`);
      passExit('report-only: the scan was unavailable; not failing the build.');
    }
    if (gateMode !== 'legacy' && CFG.failOpen) {
      warn(`${why}`);
      stepSummary(`## kolm agent audit\n\nThe scan could not run on this build (${why}). --fail-open is set, so the gate passes.`);
      passExit('--fail-open: the kolm API was unavailable; letting the build proceed.');
    }
    fail(gateMode === 'legacy' ? why : `${why}. Gate mode ${gateMode} fails closed; pass --fail-open to let builds proceed when the kolm API is unavailable.`);
  }

  const out = result.json;
  const summary = out.summary || {};
  const readiness = summary.readiness_pct;
  const blocking = Array.isArray(summary.blocking) ? summary.blocking : [];
  const sessionId = out.id || null;
  const reportId = out.report_id || null;
  const trustUrl = out.trust_url || (CFG.trustSlug ? `${CFG.apiUrl}/v1/trust/${CFG.trustSlug}` : null);
  const verifyUrl = out.verify_url || `${CFG.apiUrl}/verify`;

  // --- print the CI summary ---
  log('');
  log(`readiness: ${readiness == null ? 'n/a (no events ingested)' : readiness + '%'}`);
  log(`blocking findings: ${blocking.length}`);
  for (const b of blocking.slice(0, 10)) {
    log(`  - [${b.severity}] ${b.title || b.id}${b.asr ? ` (${b.asr})` : ''}${b.frameworks && b.frameworks.length ? ` :: ${b.frameworks.join(', ')}` : ''}`);
  }
  if (reportId) log(`report id: ${reportId}${out.signed ? ` (signed, key ${out.key_fingerprint || '?'})` : ' (unsigned preview)'}`);
  if (trustUrl) notice(`Trust link: ${trustUrl}`);
  else log(`verify reports offline at: ${verifyUrl}`);

  // --- delta vs the most recent prior signed report for this subject ---
  const deltaOutcome = await resolveDelta({ sessionId, reportId, signed: !!out.signed });
  const baseline = deltaOutcome.kind === 'baseline';
  const delta = deltaOutcome.kind === 'delta' ? deltaOutcome.delta : null;
  setOutput('baseline', String(baseline));
  if (baseline) {
    notice(`baseline established - no prior signed report for subject "${CFG.subject}". The next run gates on the delta against this report.`);
  } else if (delta) {
    log(`delta vs ${deltaOutcome.prior.report_id}: ${delta.summary || 'computed'}`);
  } else {
    warn(`delta unavailable: ${deltaOutcome.detail}`);
  }

  // --- policy gate ---
  const reasons = [];
  if (gateMode === 'legacy') {
    const abs = evaluateAbsoluteGate({
      readiness, blockingCount: blocking.length,
      minReadiness: CFG.minReadiness, failOnBlocking: CFG.failOnBlocking,
    });
    reasons.push(...abs.reasons);
  } else if (!reportOnly) {
    if (deltaOutcome.kind === 'unavailable') {
      if (CFG.failOpen) {
        warn(`--fail-open: the delta could not be computed (${deltaOutcome.detail}); letting the build proceed.`);
      } else {
        reasons.push(`gate mode ${gateMode} could not compute the delta against the prior signed report (${deltaOutcome.detail}) and fails closed. Pass --fail-open to let builds proceed when the kolm API is unavailable.`);
      }
    } else if (delta) {
      reasons.push(...evaluateDeltaGate(gateMode, delta).reasons);
    }
    // baseline: the delta gate passes in all modes.
    if (CFG.absoluteGate) {
      const abs = evaluateAbsoluteGate({
        readiness, blockingCount: blocking.length,
        minReadiness: CFG.minReadiness, failOnBlocking: CFG.failOnBlocking,
      });
      for (const r of abs.reasons) reasons.push(`legacy absolute gate: ${r}`);
    }
  }
  const passed = reportOnly || reasons.length === 0;

  // --- Action outputs ---
  setOutput('readiness', readiness == null ? '' : String(readiness));
  setOutput('blocking-count', String(blocking.length));
  setOutput('report-id', reportId || '');
  setOutput('trust-url', trustUrl || '');
  setOutput('verify-url', verifyUrl);

  // --- PR comment + step summary (same content; the summary writes ALWAYS) ---
  const commentMd = renderPrComment({
    summary, delta, baseline,
    gateMode, passed,
    reportId, signed: !!out.signed, sessionId,
    apiUrl: CFG.apiUrl, verifyUrl, trustUrl,
  });
  stepSummary(commentMd);
  await upsertPrComment(commentMd);

  if (!passed) {
    setOutput('passed', 'false');
    for (const r of reasons) error(`gate failed: ${r}`);
    throw new GateExit(1);
  }
  if (reportOnly && reasons.length) {
    for (const r of reasons) warn(`report-only (not failing the build): ${r}`);
  }
  setOutput('passed', 'true');
  notice(`agent security gate passed (mode ${gateMode}, readiness ${readiness == null ? 'n/a' : readiness + '%'}, ${blocking.length} blocking).`);
  throw new GateExit(0);
}

// Run only when executed directly (node scripts/kolm-audit-ci.mjs ...), so the
// pure helpers above are importable by tests without side effects.
const SELF_PATH = fileURLToPath(import.meta.url);
const ENTRY_PATH = process.argv[1] ? path.resolve(process.argv[1]) : '';
const IS_MAIN = ENTRY_PATH !== '' && (process.platform === 'win32'
  ? ENTRY_PATH.toLowerCase() === SELF_PATH.toLowerCase()
  : ENTRY_PATH === SELF_PATH);

if (IS_MAIN) {
  main().then(
    () => { process.exitCode = 0; },
    (e) => {
      if (e instanceof GateExit) { process.exitCode = e.code; return; }
      error(`unexpected error: ${e && e.message ? e.message : e}`);
      setOutput('passed', 'false');
      process.exitCode = 1;
    },
  );
}
