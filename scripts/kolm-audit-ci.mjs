#!/usr/bin/env node
// scripts/kolm-audit-ci.mjs
//
// S10 onramp - the CI entrypoint behind the kolm-agent-audit GitHub Action.
//
// Reads agent logs (a file, a directory of files, or stdin), auto-detects the
// platform (Datadog / LangSmith / OpenTelemetry) and normalizes via the
// connector registry, OR passes provider-native logs straight through. It then
// calls POST /v1/audit/scan, prints a concise CI summary (readiness, top
// blockers, report id), writes GitHub Action outputs, and exits non-zero when
// the run violates the configured policy (readiness below a threshold, or any
// blocking finding when fail-on-blocking is set).
//
// No dependencies beyond Node (>= 18) global fetch. All file reads use utf8.
//
// Configuration is via environment (the Action maps its inputs onto these):
//   KOLM_API_URL              base URL (default https://kolm.ai)
//   KOLM_API_KEY              ks_... key (required)
//   KOLM_AUDIT_LOGS           path to a file or directory ('-' or empty = stdin)
//   KOLM_AUDIT_SOURCE         auto | datadog | langsmith | otel | raw (default auto)
//   KOLM_AUDIT_SUBJECT        report subject (default "Agent fleet")
//   KOLM_AUDIT_MIN_READINESS  fail under this readiness percent (default 80)
//   KOLM_AUDIT_FAIL_ON_BLOCKING  true|false (default true)
//   KOLM_AUDIT_SIGN           true|false (default true)
//   KOLM_AUDIT_RETENTION_DAYS optional declared retention window (number)
//
// A path may also be passed as the first CLI argument. Questions: dev@kolm.ai

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectConnector, normalizeWith, SOURCES } from '../src/connectors/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* --------------------------------- config --------------------------------- */

function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

const CFG = {
  apiUrl: String(process.env.KOLM_API_URL || 'https://kolm.ai').replace(/\/+$/, ''),
  apiKey: process.env.KOLM_API_KEY || '',
  logsPath: process.argv[2] || process.env.KOLM_AUDIT_LOGS || '',
  source: String(process.env.KOLM_AUDIT_SOURCE || 'auto').toLowerCase(),
  subject: process.env.KOLM_AUDIT_SUBJECT || 'Agent fleet',
  minReadiness: envNum('KOLM_AUDIT_MIN_READINESS', 80),
  failOnBlocking: envBool('KOLM_AUDIT_FAIL_ON_BLOCKING', true),
  sign: envBool('KOLM_AUDIT_SIGN', true),
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

function fail(msg) {
  error(msg);
  setOutput('passed', 'false');
  process.exit(1);
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

/* --------------------------------- scan ----------------------------------- */

async function postScan(records, label, sign) {
  const body = { logs: records, subject: CFG.subject, source: label, sign };
  if (CFG.retentionDays != null) body.retention_days = CFG.retentionDays;
  let resp;
  try {
    resp = await fetch(`${CFG.apiUrl}/v1/audit/scan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: 'network_error', detail: e && e.message };
  }
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON body */ }
  return { ok: resp.ok, status: resp.status, json };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  if (!CFG.apiKey) fail('KOLM_API_KEY is not set. Create a key in your kolm account and store it as a CI secret.');

  log(`kolm agent audit -> ${CFG.apiUrl}`);
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
  if (result.status === 0) fail(`could not reach the kolm API: ${result.detail || 'network error'}`);
  if (!result.ok || !result.json || result.json.ok !== true) {
    const j = result.json || {};
    fail(`scan failed (HTTP ${result.status}): ${j.error || 'unknown_error'}${j.detail ? ' - ' + j.detail : ''}`);
  }

  const out = result.json;
  const summary = out.summary || {};
  const readiness = summary.readiness_pct;
  const blocking = Array.isArray(summary.blocking) ? summary.blocking : [];
  const reportId = out.report_id || null;
  const trustUrl = out.trust_url || null;          // present only for a purchased / continuous report
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

  // --- Action outputs ---
  setOutput('readiness', readiness == null ? '' : String(readiness));
  setOutput('blocking-count', String(blocking.length));
  setOutput('report-id', reportId || '');
  setOutput('trust-url', trustUrl || '');
  setOutput('verify-url', verifyUrl);

  // --- step summary ---
  stepSummary(`## kolm agent security audit\n\n- Readiness: ${readiness == null ? 'n/a' : readiness + '%'} (threshold ${CFG.minReadiness}%)\n- Blocking findings: ${blocking.length}\n- Report id: ${reportId || 'n/a'}${trustUrl ? `\n- Trust link: ${trustUrl}` : ''}`);

  // --- policy gate ---
  const reasons = [];
  if (readiness == null) {
    reasons.push('the scan ingested no auditable events from the supplied logs');
  } else if (readiness < CFG.minReadiness) {
    reasons.push(`readiness ${readiness}% is below the required ${CFG.minReadiness}%`);
  }
  if (CFG.failOnBlocking && blocking.length > 0) {
    reasons.push(`${blocking.length} blocking finding(s) and fail-on-blocking is enabled`);
  }
  if (reasons.length) {
    setOutput('passed', 'false');
    for (const r of reasons) error(`gate failed: ${r}`);
    process.exit(1);
  }
  setOutput('passed', 'true');
  notice(`agent security gate passed (readiness ${readiness}%, ${blocking.length} blocking).`);
  process.exit(0);
}

main().catch((e) => { fail(`unexpected error: ${e && e.message ? e.message : e}`); });
