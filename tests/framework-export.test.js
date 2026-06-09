// Agent Security-Review - procurement export formatter + route tests.
//
// Two halves:
//
//  (A) PURE unit tests over a real signed envelope (built from the committed
//      dogfood fixture): every formatter produces valid, parseable output - the
//      CSV parses (RFC 4180, including a hostile comma/quote subject), the
//      SpreadsheetML is well-formed XML with three sheets, the Drata/Vanta JSON
//      carries the documented control-evidence shape, the exec summary + the
//      crosswalk render the headline facts - none of them throws on a malformed
//      envelope, and none of them mutates the envelope (read-only over the
//      already-signed payload).
//
//  (B) ROUTE tests against a spawned server.js: the session export is auth-gated
//      + tenant-fenced and returns the right Content-Type per format; the public
//      Trust-slug export serves the same artifacts with NO account; unknown
//      formats are a clean 400.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

import { runAudit } from '../src/audit-orchestrator.js';
import { buildAndSignReport } from '../src/attestation-report-builder.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  toCSV, toExcelXml, toDrata, toVanta,
  toExecutiveSummaryMarkdown, toFrameworkCrosswalk,
  EXPORTERS, EXPORT_FORMATS,
} from '../src/framework-export.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

// A self-contained signer so the unit tests never depend on a cached key store.
const KP = generateKeyPair();
const SIGNER = { privateKey: KP.privateKey, publicKey: KP.publicKey, key_fingerprint: keyFingerprint(KP.publicKey) };

// The dogfood fixture is intentionally bad (over-permissioned + shared key + no
// tamper-evidence) so the exports exercise blocking findings + framework spread.
// A comma + quotes + angle brackets in the subject exercise CSV/XML/MD escaping.
function fixtureEnvelope(subject = 'Helpwise, "Inc." <ops>') {
  const audit = runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
  return buildAndSignReport(audit, { subject, tier: 'report', watermark: false, signer: SIGNER }).envelope;
}

// ---------------------------------------------------------------------------
// Tiny dependency-free parsers used only by the assertions.
// ---------------------------------------------------------------------------

// RFC 4180 CSV parser: handles quoted fields, doubled inner quotes, CRLF rows.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else { field += ch; }
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Dependency-free XML well-formedness check: balanced/nested tags, no stray '<'
// in text, every '&' is an entity. Throws an assertion on the first violation.
function assertWellFormedXml(xml) {
  const s = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  const stack = [];
  let last = 0, m;
  while ((m = tagRe.exec(s))) {
    const between = s.slice(last, m.index);
    assert.ok(!between.includes('<'), 'no stray "<" in text content');
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between), 'every "&" in text is an XML entity');
    last = tagRe.lastIndex;
    const closing = m[1] === '/';
    const name = m[2];
    const selfClose = /\/\s*>$/.test(m[0]);
    if (closing) assert.equal(stack.pop(), name, `closing </${name}> matches the open tag`);
    else if (!selfClose) stack.push(name);
  }
  assert.equal(stack.length, 0, `all tags closed (dangling: ${stack.join(',')})`);
}

// ===========================================================================
// (A) PURE unit tests.
// ===========================================================================

test('every formatter returns { filename, contentType, body } with a real body', () => {
  const env = fixtureEnvelope();
  assert.deepEqual(EXPORT_FORMATS, ['csv', 'xlsx', 'drata', 'vanta', 'exec', 'crosswalk']);
  for (const fmt of EXPORT_FORMATS) {
    const a = EXPORTERS[fmt](env);
    assert.ok(a && typeof a === 'object', `${fmt}: returns an object`);
    assert.ok(typeof a.filename === 'string' && a.filename.length, `${fmt}: filename`);
    assert.ok(typeof a.contentType === 'string' && a.contentType.length, `${fmt}: contentType`);
    assert.ok(typeof a.body === 'string' && a.body.length > 0, `${fmt}: non-empty body`);
    assert.ok(a.filename.startsWith(env.report_id), `${fmt}: filename carries the report id`);
  }
});

test('toCSV is valid RFC 4180: every record has the header column count', () => {
  const env = fixtureEnvelope();
  const { body, filename, contentType } = toCSV(env);
  assert.match(contentType, /text\/csv/);
  assert.match(filename, /-findings\.csv$/);
  assert.ok(body.includes('\r\n'), 'records are CRLF-separated');
  const rows = parseCsv(body);
  const header = rows[0];
  assert.equal(header[0], 'report_id');
  assert.equal(header.length, 18, 'header has the full column set');
  assert.ok(rows.length >= 2, 'at least the header + one data row');
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].length, header.length, `row ${i} has the header column count (quoting is correct)`);
  }
  // The hostile subject round-trips through the quoting intact.
  assert.equal(rows[1][1], 'Helpwise, "Inc." <ops>', 'comma+quote subject parses back exactly');
  // Every finding id appears in the CSV.
  for (const f of env.findings) assert.ok(body.includes(f.id), `finding ${f.id} present in CSV`);
});

test('toCSV maps findings x controls (a finding with N framework refs => N rows)', () => {
  const env = fixtureEnvelope();
  const rows = parseCsv(toCSV(env).body).slice(1);
  const fIdx = 4, fwIdx = 11, ctrlIdx = 12;
  // Pick a finding known to carry multiple framework refs.
  const multi = env.findings.find((f) => (f.frameworks || []).length >= 2);
  assert.ok(multi, 'fixture has a finding mapped to multiple controls');
  const itsRows = rows.filter((r) => r[fIdx] === multi.id);
  assert.equal(itsRows.length, multi.frameworks.length, 'one CSV row per mapped control');
  // The framework + control columns are populated from the finding refs.
  for (const r of itsRows) { assert.ok(r[fwIdx], 'framework column populated'); assert.ok(r[ctrlIdx], 'control_id populated'); }
});

test('toExcelXml is well-formed SpreadsheetML with three named sheets', () => {
  const env = fixtureEnvelope('Acme <Bold> & Co, "GRC"');
  const { body, filename, contentType } = toExcelXml(env);
  assert.equal(contentType, 'application/vnd.ms-excel');
  assert.match(filename, /\.xls$/);
  assert.ok(body.startsWith('<?xml'), 'starts with the XML declaration');
  assert.ok(body.includes('<?mso-application progid="Excel.Sheet"?>'), 'carries the Excel processing instruction');
  assertWellFormedXml(body);
  const sheets = [...body.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ['Summary', 'Findings', 'Framework Crosswalk']);
  // Hostile subject is escaped, not raw.
  assert.ok(!body.includes('<Bold>'), 'angle brackets in the subject are escaped');
  assert.ok(body.includes('Acme &lt;Bold&gt; &amp; Co'), 'subject is XML-escaped in a cell');
  // Headline facts present.
  assert.ok(body.includes('Readiness (assessed controls)'), 'summary sheet carries the readiness row');
  assert.ok(body.includes(env.signature_ed25519.key_fingerprint), 'workbook carries the signing fingerprint');
});

test('toExcelXml stays well-formed even with control chars in a value', () => {
  // Illegal-in-XML control chars (here injected via a finding title) must be
  // stripped so the workbook is never broken by a hostile log value.
  const env = { report_id: 'asrr_ctrl', findings: [{ id: 'x', title: 'bad \u0007\u0000\u001f title & <b>' }] };
  const { body } = toExcelXml(env);
  assertWellFormedXml(body);
  const rawCtrl = [...body].filter((c) => { const x = c.charCodeAt(0); return (x < 9) || (x > 10 && x < 13) || (x > 13 && x < 32); });
  assert.equal(rawCtrl.length, 0, 'illegal control chars are stripped, not embedded');
});

test('toDrata emits the documented control-evidence shape', () => {
  const env = fixtureEnvelope();
  const { body, filename, contentType } = toDrata(env);
  assert.match(contentType, /application\/json/);
  assert.match(filename, /-drata\.json$/);
  const p = JSON.parse(body);
  assert.equal(p.$schema, 'kolm-control-evidence/1');
  assert.equal(p.format, 'drata-external-evidence');
  assert.equal(p.source.vendor, 'kolm.ai');
  assert.equal(p.source.report_id, env.report_id);
  assert.equal(p.verification.key_fingerprint, env.signature_ed25519.key_fingerprint);
  assert.equal(p.verification.offline_verifiable, true);
  assert.ok(typeof p.mapping_note === 'string' && p.mapping_note.length, 'mapping is documented in the payload');
  assert.ok(Array.isArray(p.evidence) && p.evidence.length >= 1, 'evidence array present');
  const allowed = new Set(['PASSED', 'NEEDS_ATTENTION', 'FAILED', 'NOT_ASSESSED']);
  for (const ev of p.evidence) {
    assert.ok(ev.framework && ev.control, 'each item has framework + control');
    assert.ok(allowed.has(ev.status), `status ${ev.status} is a documented Drata value`);
    assert.ok('controlName' in ev && 'collectedAt' in ev && Array.isArray(ev.findings), 'evidence item is fully shaped');
  }
  // Scope is disclosed: the not-assessed ASR controls ride along as NOT_ASSESSED.
  assert.ok(p.evidence.some((e) => e.control === 'ASR-4' && e.status === 'NOT_ASSESSED'), 'ASR-4 disclosed as not assessed');
});

test('toVanta emits the documented control-evidence shape', () => {
  const env = fixtureEnvelope();
  const { body, filename, contentType } = toVanta(env);
  assert.match(contentType, /application\/json/);
  assert.match(filename, /-vanta\.json$/);
  const p = JSON.parse(body);
  assert.equal(p.$schema, 'kolm-control-evidence/1');
  assert.equal(p.format, 'vanta-custom-evidence');
  assert.equal(p.verification.key_fingerprint, env.signature_ed25519.key_fingerprint);
  assert.ok(Array.isArray(p.controls) && p.controls.length >= 1);
  const allowed = new Set(['OK', 'NEEDS_ATTENTION', 'FAILING', 'NOT_ASSESSED']);
  for (const c of p.controls) {
    assert.ok(c.framework && c.controlId, 'each control has framework + controlId');
    assert.ok(allowed.has(c.status), `status ${c.status} is a documented Vanta value`);
    assert.ok(typeof c.findingsCount === 'number' && Array.isArray(c.findings), 'control entry is fully shaped');
  }
  // Both the ASR spine and a buyer framework (SOC 2 TSC) are represented.
  assert.ok(p.controls.some((c) => c.framework.startsWith('ASR')), 'ASR spine present');
  assert.ok(p.controls.some((c) => c.framework === 'SOC 2 TSC'), 'SOC 2 TSC controls present');
});

test('toExecutiveSummaryMarkdown is a crisp one-pager with the headline facts', () => {
  const env = fixtureEnvelope('Helpwise Inc');
  const { body, filename, contentType } = toExecutiveSummaryMarkdown(env);
  assert.match(contentType, /text\/markdown/);
  assert.match(filename, /-executive-summary\.md$/);
  assert.match(body, /^# Agent Security-Review - Executive Summary/);
  assert.ok(body.includes('Helpwise Inc'), 'subject rendered');
  assert.ok(body.includes(env.report_id), 'report id rendered');
  assert.ok(body.includes('## Verdict') && body.includes('## Control status') && body.includes('## Scope & limitations'), 'all key sections present');
  assert.ok(body.includes(env.signature_ed25519.key_fingerprint), 'verification fingerprint rendered');
  assert.ok(body.split('\n').length < 80, 'stays roughly one page');
});

test('toFrameworkCrosswalk renders the ASR-to-framework matrix + per-framework detail', () => {
  const env = fixtureEnvelope();
  const { body, filename, contentType } = toFrameworkCrosswalk(env);
  assert.match(contentType, /text\/markdown/);
  assert.match(filename, /-framework-crosswalk\.md$/);
  assert.ok(body.includes('## ASR control coverage'), 'matrix section present');
  assert.ok(body.includes('## Framework control detail'), 'detail section present');
  // All six framework columns are headers.
  for (const col of ['SOC 2 TSC', 'ISO/IEC 42001', 'NIST AI RMF', 'EU AI Act', 'OWASP LLM & Agentic', 'MITRE ATLAS']) {
    assert.ok(body.includes(col), `column ${col} present`);
  }
  // All eight ASR rows appear (assessed + not-assessed), and a concrete mapping.
  for (const id of ['ASR-1', 'ASR-2', 'ASR-3', 'ASR-4', 'ASR-5', 'ASR-6', 'ASR-7', 'ASR-8']) assert.ok(body.includes(id), `${id} row present`);
  assert.ok(/ASR-1 Least privilege \| BLOCKING/.test(body), 'ASR-1 shows its blocking status');
  assert.ok(body.includes('CC6'), 'SOC 2 control id surfaced in the matrix');
});

test('no formatter throws on malformed / partial envelopes (returns a valid artifact)', () => {
  const bads = [
    null, undefined, 42, 'nope', [], {},
    { schema: 'x' },
    { summary: null, findings: null, frameworks: null },
    { summary: { controls: 'oops', not_assessed: 7 }, findings: [{ id: 'a', frameworks: 'no' }] },
    { findings: [null, 5, { id: 'b', asr: 7, frameworks: [null, 'SOC 2 TSC CC6'] }], frameworks: [null, { controls: [null] }] },
  ];
  for (const fmt of EXPORT_FORMATS) {
    for (const bad of bads) {
      let out;
      assert.doesNotThrow(() => { out = EXPORTERS[fmt](bad); }, `${fmt} must not throw on ${JSON.stringify(bad)}`);
      assert.ok(out && typeof out.body === 'string', `${fmt} still returns a body for ${JSON.stringify(bad)}`);
      assert.ok(typeof out.filename === 'string' && typeof out.contentType === 'string', `${fmt} returns full envelope`);
    }
  }
  // The .xls path must remain well-formed even from a partial envelope.
  assertWellFormedXml(toExcelXml({ findings: [{ id: 'b', title: 'x & y < z' }] }).body);
  // Drata/Vanta partial output is still valid JSON.
  assert.doesNotThrow(() => JSON.parse(toDrata({ summary: {} }).body));
  assert.doesNotThrow(() => JSON.parse(toVanta({ frameworks: [] }).body));
});

test('formatters are read-only: the envelope is not mutated', () => {
  const env = fixtureEnvelope();
  const snapshot = JSON.stringify(env);
  for (const fmt of EXPORT_FORMATS) EXPORTERS[fmt](env);
  assert.equal(JSON.stringify(env), snapshot, 'envelope is unchanged after all exports');
});

test('exports never contain the banned word "honest"/"honesty"', () => {
  const env = fixtureEnvelope();
  let blob = '';
  for (const fmt of EXPORT_FORMATS) blob += EXPORTERS[fmt](env).body;
  assert.ok(!blob.toLowerCase().includes('honest'), 'no "honest"/"honesty" in any export');
});

test('exports carry dev@kolm.ai and never a personal address', () => {
  const env = fixtureEnvelope();
  const blob = toExecutiveSummaryMarkdown(env).body + toFrameworkCrosswalk(env).body;
  assert.ok(blob.includes('dev@kolm.ai'), 'contact surface is dev@kolm.ai');
  const personal = Buffer.from('cm9kbmV5eWVzZXBAZ21haWwuY29t', 'base64').toString('utf8');
  let all = '';
  for (const fmt of EXPORT_FORMATS) all += EXPORTERS[fmt](env).body;
  assert.ok(!all.includes(personal), 'no personal email in any export');
});

// ===========================================================================
// (B) ROUTE tests against a spawned server.
// ===========================================================================

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

let serverProc = null;
let base = null;
let scratchDir = null;
const KEY_A = 'ks_fwexport_tenant_a_' + 'a'.repeat(28);
const KEY_B = 'ks_fwexport_tenant_b_' + 'b'.repeat(28);
const TRUST_SLUG = 'fwexporttrustslug0001';
let sessionA = null; // a completed, signed session owned by tenant A

test('setup - boot server with two tenants + a pre-published Trust report', async () => {
  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-fwexport-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: 't_fwexport_a', name: 'fwexport-a', email: 'a@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
    { id: 't_fwexport_b', name: 'fwexport-b', email: 'b@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const h = (k) => crypto.createHash('sha256').update(k).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_a', tenant_id: 't_fwexport_a', hash: h(KEY_A), label: 'a', kind: 'user', created_at: now, revoked_at: null },
    { id: 'apik_b', tenant_id: 't_fwexport_b', hash: h(KEY_B), label: 'b', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  // Seed a PAID, PUBLIC audit row so the public Trust-slug export resolves with
  // no account (mirrors what fulfillReportPurchase produces). The envelope is a
  // genuine signed report (built in-process); the export reads it read-only.
  const env = fixtureEnvelope('Trust Export Co');
  const audit = runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
  fs.writeFileSync(path.join(dataDir, 'agent_audits.json'), JSON.stringify([
    {
      id: 'audses_fwexport_paid', tenant_id: 't_fwexport_a', subject: 'Trust Export Co', source: 'litellm',
      status: 'complete', logs: '', record_count: 6, report: env, report_id: env.report_id, summary: audit.summary,
      paid: true, public: true, public_slug: TRUST_SLUG, tier: 'report', created_at: now, updated_at: now,
    },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT), NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir, KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json', KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1', DEFAULT_TENANT: 'fwexport-a',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealth(base);
});

test('a one-shot scan gives tenant A a completed, signed session to export', async () => {
  const r = await fetch(`${base}/v1/audit/scan`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: fs.readFileSync(FIXTURE, 'utf8'), subject: 'Tenant A export', source: 'litellm' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.signed, true);
  assert.ok(j.id, 'scan persisted a session');
  sessionA = j.id;
});

test('GET /v1/audit/sessions/:id/export requires auth (401 without a key)', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionA}/export?format=csv`);
  assert.equal(r.status, 401, 'private export route is not public');
});

test('session export returns the right Content-Type + Disposition for every format', async () => {
  const expect = {
    csv: /text\/csv/, xlsx: /application\/vnd\.ms-excel/, drata: /application\/json/,
    vanta: /application\/json/, exec: /text\/markdown/, crosswalk: /text\/markdown/,
  };
  for (const fmt of EXPORT_FORMATS) {
    const r = await fetch(`${base}/v1/audit/sessions/${sessionA}/export?format=${fmt}`, { headers: { Authorization: `Bearer ${KEY_A}` } });
    assert.equal(r.status, 200, `${fmt} -> 200`);
    assert.match(r.headers.get('content-type') || '', expect[fmt], `${fmt} content-type`);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename=/, `${fmt} is a download`);
    const text = await r.text();
    assert.ok(text.length > 0, `${fmt} body non-empty`);
    if (fmt === 'csv') assert.ok(parseCsv(text)[0][0] === 'report_id', 'csv body parses');
    if (fmt === 'drata' || fmt === 'vanta') assert.doesNotThrow(() => JSON.parse(text), `${fmt} body is JSON`);
    if (fmt === 'xlsx') assertWellFormedXml(text);
  }
});

test('session export defaults to CSV when no format is given', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionA}/export`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/csv/);
});

test('session export rejects an unknown format with 400', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionA}/export?format=docx`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'invalid_format');
});

test('session export is tenant-fenced: tenant B cannot export tenant A\'s session', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/${sessionA}/export?format=csv`, { headers: { Authorization: `Bearer ${KEY_B}` } });
  assert.equal(r.status, 404, 'cross-tenant export is a 404, not a leak');
  const j = await r.json();
  assert.equal(j.error, 'session_not_found');
});

test('session export for an unknown session returns 404', async () => {
  const r = await fetch(`${base}/v1/audit/sessions/audses_nope/export?format=csv`, { headers: { Authorization: `Bearer ${KEY_A}` } });
  assert.equal(r.status, 404);
});

test('PUBLIC Trust-slug export serves the artifact with NO account', async () => {
  // No Authorization header at all - a buyer's GRC team has no kolm account.
  for (const [fmt, ct] of [['csv', /text\/csv/], ['xlsx', /vnd\.ms-excel/], ['drata', /application\/json/], ['exec', /text\/markdown/], ['crosswalk', /text\/markdown/]]) {
    const r = await fetch(`${base}/v1/trust/${TRUST_SLUG}/export?format=${fmt}`);
    assert.equal(r.status, 200, `public ${fmt} export reachable without a key`);
    assert.match(r.headers.get('content-type') || '', ct, `public ${fmt} content-type`);
    const text = await r.text();
    assert.ok(text.includes('Trust Export Co') || fmt === 'xlsx' || fmt === 'drata' || fmt === 'csv', `${fmt} renders the subject`);
  }
});

test('PUBLIC Trust export: unknown slug -> 404, bad format -> 400', async () => {
  const r404 = await fetch(`${base}/v1/trust/doesnotexistslug/export?format=csv`);
  assert.equal(r404.status, 404);
  const r400 = await fetch(`${base}/v1/trust/${TRUST_SLUG}/export?format=nope`);
  assert.equal(r400.status, 400);
});

test('teardown', async () => {
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});
