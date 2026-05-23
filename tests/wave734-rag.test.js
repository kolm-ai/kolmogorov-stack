// W734 — RAG-aware distillation tests.
//
// Atomic items pinned (matches the W734 implementation):
//
//   1) RAG_CAPTURE_VERSION exported and pinned to 'w734-v1'
//   2) parseRetrievedContextHeader handles base64 JSON correctly
//   3) parseRetrievedContextHeader returns invalid_header on malformed input
//   4) parseRetrievedContextHeader returns {ok:true, retrieved:[]} on absence
//   5) formatCaptureForTraining emits <RETRIEVED ...> blocks when retrieved_context present
//   6) formatCaptureForTraining falls through to normal format when absent
//   7) POST /v1/capture/log with kolm-retrieved-context header → capture row has retrieved_context field
//   8) Python captureWithContext function exists in sdk/python/kolm/client.py
//   9) Node captureWithContext function exists in sdk/node/index.mjs
//  10) Bakeoff context_faithfulness is in [0,1] OR null (honest absence)
//  11) public/docs/rag.html exists with brand-lock content
//  12) cli/kolm.js defines cmdW734RagCapture exactly once + wired from `case 'rag'`
//  13) Family lock-in uses regex wave(\d{3,4}) (no explicit-array per W604)
//
// W604 anti-brittleness: no explicit-array family checks. Assertions key on
// load-bearing tokens (version stamp, header tag presence, file existence,
// regex on cli/kolm.js + SDK files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  RAG_CAPTURE_VERSION,
  parseRetrievedContextHeader,
  formatCaptureForTraining,
  extractRetrievedFromResponse,
  computeContextFaithfulness,
} from '../src/rag-capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'rag.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const PY_SDK_PATH = path.join(REPO_ROOT, 'sdk', 'python', 'kolm', 'client.py');
const NODE_SDK_PATH = path.join(REPO_ROOT, 'sdk', 'node', 'index.mjs');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w734-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Helper that mirrors the SDK's base64-of-JSON encoding so the parser test
// + the route test both go through the same wire format.
function encodeHeader(arr) {
  return Buffer.from(JSON.stringify(arr), 'utf8').toString('base64');
}

// =============================================================================
// 1) Version stamp
// =============================================================================

test('W734 #1 — RAG_CAPTURE_VERSION is "w734-v1"', () => {
  freshDir();
  assert.equal(RAG_CAPTURE_VERSION, 'w734-v1',
    `expected version 'w734-v1'; got ${JSON.stringify(RAG_CAPTURE_VERSION)}`);
});

// =============================================================================
// 2) parseRetrievedContextHeader handles base64 JSON correctly
// =============================================================================

test('W734 #2 — parseRetrievedContextHeader decodes valid base64 JSON array', () => {
  freshDir();
  const arr = [
    { source: 'kolm.ai/docs/refunds', text: 'Refunds within 30 days.', score: 0.92 },
    { source: 'kolm.ai/docs/refunds#partial', text: 'Partial refunds available.' },
  ];
  const req = { headers: { 'kolm-retrieved-context': encodeHeader(arr) } };
  const out = parseRetrievedContextHeader(req);
  assert.equal(out.ok, true, 'parser must succeed on valid input');
  assert.equal(out.retrieved.length, 2, 'must surface both items');
  assert.equal(out.retrieved[0].source, 'kolm.ai/docs/refunds');
  assert.equal(out.retrieved[0].text, 'Refunds within 30 days.');
  assert.equal(out.retrieved[0].score, 0.92);
  // Optional score is normalised to null when absent — NOT undefined, NOT 0.
  assert.equal(out.retrieved[1].score, null,
    `missing score must surface as null (honest absence); got ${out.retrieved[1].score}`);
});

// =============================================================================
// 3) parseRetrievedContextHeader returns invalid_header on malformed input
// =============================================================================

test('W734 #3 — parseRetrievedContextHeader returns invalid_header on malformed input', () => {
  freshDir();
  // 3a — non-base64 garbage that still contains base64-ish chars but doesn't
  // decode to JSON. Buffer.from('!!!!', 'base64') yields an empty buffer.
  const r1 = parseRetrievedContextHeader({ headers: { 'kolm-retrieved-context': '!!!!' } });
  assert.equal(r1.ok, false, '!!!! must fail');
  assert.equal(r1.error, 'invalid_header', `error must be invalid_header; got ${r1.error}`);
  assert.ok(typeof r1.hint === 'string' && r1.hint.length > 0,
    `hint must be a non-empty string; got ${JSON.stringify(r1.hint)}`);

  // 3b — base64 of a JSON OBJECT (not array). Spec requires array.
  const r2 = parseRetrievedContextHeader({
    headers: { 'kolm-retrieved-context': Buffer.from('{"oops":true}', 'utf8').toString('base64') },
  });
  assert.equal(r2.ok, false, 'JSON object must fail (array required)');
  assert.equal(r2.error, 'invalid_header');

  // 3c — array with missing required fields. {source} only, no text.
  const r3 = parseRetrievedContextHeader({
    headers: { 'kolm-retrieved-context': encodeHeader([{ source: 'x' }]) },
  });
  assert.equal(r3.ok, false, 'item missing text must fail');
  assert.equal(r3.error, 'invalid_header');
});

// =============================================================================
// 4) parseRetrievedContextHeader returns {ok:true, retrieved:[]} on absence
// =============================================================================

test('W734 #4 — parseRetrievedContextHeader treats absence as honest no-op', () => {
  freshDir();
  // No headers object at all.
  const r1 = parseRetrievedContextHeader({});
  assert.equal(r1.ok, true, 'absence must be ok:true (non-RAG request is the common case)');
  assert.ok(Array.isArray(r1.retrieved) && r1.retrieved.length === 0,
    `retrieved must be an empty array on absence; got ${JSON.stringify(r1.retrieved)}`);
  // Empty headers map.
  const r2 = parseRetrievedContextHeader({ headers: {} });
  assert.equal(r2.ok, true);
  assert.equal(r2.retrieved.length, 0);
  // Empty string header value (some proxies emit "" instead of dropping).
  const r3 = parseRetrievedContextHeader({ headers: { 'kolm-retrieved-context': '' } });
  assert.equal(r3.ok, true);
  assert.equal(r3.retrieved.length, 0);
});

// =============================================================================
// 5) formatCaptureForTraining emits <RETRIEVED ...> blocks when present
// =============================================================================

test('W734 #5 — formatCaptureForTraining emits <RETRIEVED ...> blocks for RAG captures', () => {
  freshDir();
  const capture = {
    prompt: 'When did kolm.ai launch?',
    response: 'kolm.ai launched in May 2026.',
    retrieved_context: [
      { source: 'kolm.ai/changelog', text: 'Launched 2026-05.', score: 0.94 },
      { source: 'kolm.ai/about',     text: 'Founded in 2026.', score: 0.71 },
    ],
  };
  const out = formatCaptureForTraining(capture);
  assert.equal(typeof out, 'string', `must return string; got ${typeof out}`);
  // Tag presence is load-bearing — the student keys on it.
  assert.ok(out.includes('<RETRIEVED'),
    `output must include <RETRIEVED tag; got:\n${out}`);
  assert.ok(out.includes('</RETRIEVED>'),
    `output must include closing </RETRIEVED> tag; got:\n${out}`);
  // Both sources must appear in their respective opening tags.
  assert.ok(out.includes('source=kolm.ai/changelog'),
    `must surface first source URL inside an opening tag; got:\n${out}`);
  assert.ok(out.includes('source=kolm.ai/about'),
    `must surface second source URL inside an opening tag; got:\n${out}`);
  // USER / ASSISTANT lines must follow the RETRIEVED blocks.
  assert.ok(out.includes('USER: When did kolm.ai launch?'),
    `USER line must be present after retrieved blocks; got:\n${out}`);
  assert.ok(out.includes('ASSISTANT: kolm.ai launched in May 2026.'),
    `ASSISTANT line must be present after retrieved blocks; got:\n${out}`);
  // Score formatting: "0.94" not "0.940000..." — readability matters.
  assert.ok(/score=0\.\d{2}/.test(out),
    `score must format to 2dp; got:\n${out}`);
});

// =============================================================================
// 6) formatCaptureForTraining falls through to normal format when absent
// =============================================================================

test('W734 #6 — formatCaptureForTraining falls through to USER/ASSISTANT when no retrieved_context', () => {
  freshDir();
  // No retrieved_context at all (the legacy capture shape).
  const c1 = { prompt: 'hello', response: 'hi there' };
  const o1 = formatCaptureForTraining(c1);
  assert.equal(o1, 'USER: hello\nASSISTANT: hi there',
    `legacy format must be USER:/ASSISTANT:; got ${JSON.stringify(o1)}`);
  assert.ok(!o1.includes('<RETRIEVED'),
    `legacy format MUST NOT inject <RETRIEVED tags; got ${o1}`);
  // Empty retrieved_context array — still falls through (no chunks to prefix).
  const c2 = { prompt: 'hello', response: 'hi', retrieved_context: [] };
  const o2 = formatCaptureForTraining(c2);
  assert.equal(o2, 'USER: hello\nASSISTANT: hi',
    `empty array must fall through to legacy format; got ${JSON.stringify(o2)}`);
});

// =============================================================================
// 7) POST /v1/capture/log with header → row carries retrieved_context
// =============================================================================

test('W734 #7 — POST /v1/capture/log with kolm-retrieved-context header persists retrieved_context on the row', async () => {
  const tmp = freshDir();
  // store.js validates KOLM_STORE_DRIVER ∈ {json, sqlite}. json is fine for
  // this test — we don't need sqlite-only features.
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  delete process.env.KOLM_CAPTURE_DRIVER;

  const eventStore = await import('../src/event-store.js');
  const captureStore = await import('../src/capture-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const ns = 'w734_ns_' + Date.now().toString(36);
    const retrieved = [
      { source: 'kolm.ai/docs/refunds', text: 'Refunds within 30 days.', score: 0.92 },
    ];
    const headerVal = encodeHeader(retrieved);
    const res = await fetch(`http://127.0.0.1:${port}/v1/capture/log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
        'kolm-retrieved-context': headerVal,
      },
      body: JSON.stringify({
        namespace: ns,
        items: [{ input: 'Can I refund after 45 days?', output: 'No, refunds are 30-day only.' }],
        provider: 'manual',
      }),
    });
    assert.ok(res.status === 201 || res.status === 207,
      `expected 201 or 207 from /v1/capture/log; got ${res.status}`);
    // Read the persisted capture-store rows for THIS tenant + namespace; the
    // retrieved_context field must be present and non-null.
    const rows = await captureStore.listCaptures(t.name, ns, 100);
    assert.ok(rows.length >= 1, `expected at least 1 capture row; got ${rows.length}`);
    const row = rows[0];
    assert.ok(Array.isArray(row.retrieved_context),
      `row.retrieved_context must be an array; got ${typeof row.retrieved_context}: ${JSON.stringify(row.retrieved_context)}`);
    assert.equal(row.retrieved_context.length, 1, 'must persist 1 retrieved chunk');
    assert.equal(row.retrieved_context[0].source, 'kolm.ai/docs/refunds');
    assert.equal(row.retrieved_context[0].text, 'Refunds within 30 days.');

    // Malformed header should fail loud with 400 + invalid_retrieved_context_header.
    const resBad = await fetch(`http://127.0.0.1:${port}/v1/capture/log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
        'kolm-retrieved-context': '!!!!',
      },
      body: JSON.stringify({
        namespace: ns,
        items: [{ input: 'x', output: 'y' }],
      }),
    });
    assert.equal(resBad.status, 400,
      `malformed header must yield 400; got ${resBad.status}`);
    const errBody = await resBad.json().catch(() => ({}));
    assert.equal(errBody.error, 'invalid_retrieved_context_header',
      `error must be invalid_retrieved_context_header; got ${JSON.stringify(errBody)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    if (captureStore._resetDriverCache) captureStore._resetDriverCache();
  }
});

// =============================================================================
// 8) Python captureWithContext present
// =============================================================================

test('W734 #8 — sdk/python/kolm/client.py defines capture_with_context helper', () => {
  freshDir();
  assert.ok(fs.existsSync(PY_SDK_PATH), `expected Python SDK at ${PY_SDK_PATH}`);
  const src = fs.readFileSync(PY_SDK_PATH, 'utf8');
  // Function signature lock-in (regex, not exact line, so reformatting won't
  // break the test). The W734-3 spec requires capture_with_context as a
  // method on the Kolm client class.
  assert.ok(/def\s+capture_with_context\s*\(/.test(src),
    'Python SDK must define capture_with_context method');
  // Header name is load-bearing — must use the exact wire-format string.
  assert.ok(src.includes('kolm-retrieved-context'),
    'Python SDK must set the kolm-retrieved-context header');
  // base64-encoding must be invoked on the JSON payload.
  assert.ok(/base64\.b64encode/.test(src),
    'Python SDK must base64-encode the retrieved payload');
});

// =============================================================================
// 9) Node captureWithContext present
// =============================================================================

test('W734 #9 — sdk/node/index.mjs defines captureWithContext helper', () => {
  freshDir();
  assert.ok(fs.existsSync(NODE_SDK_PATH), `expected Node SDK at ${NODE_SDK_PATH}`);
  const src = fs.readFileSync(NODE_SDK_PATH, 'utf8');
  assert.ok(/captureWithContext\s*\(/.test(src),
    'Node SDK must define captureWithContext method');
  assert.ok(src.includes('kolm-retrieved-context'),
    'Node SDK must set the kolm-retrieved-context header');
  // base64 encoding via Buffer or btoa must be invoked.
  assert.ok(/Buffer\.from\s*\([^)]*\)\.toString\s*\(\s*["']base64["']/.test(src) || src.includes('btoa'),
    'Node SDK must base64-encode the retrieved payload (Buffer or btoa)');
});

// =============================================================================
// 10) Bakeoff context_faithfulness axis is in [0,1] OR null (honest absence)
// =============================================================================

test('W734 #10 — context_faithfulness score is in [0,1] when retrieved present, null when absent', () => {
  freshDir();
  // Present + plausible — score is in [0,1].
  const retrieved = [
    { source: 's1', text: 'refund policy is thirty days from purchase date' },
  ];
  const response = 'Refund policy is thirty days from purchase date.';
  const s1 = computeContextFaithfulness(response, retrieved);
  assert.equal(typeof s1, 'number', `score must be a number; got ${typeof s1}`);
  assert.ok(s1 >= 0 && s1 <= 1, `score must be in [0,1]; got ${s1}`);
  assert.ok(s1 > 0.5,
    `strong overlap response must score >0.5; got ${s1}`);

  // Absent (no retrieved_context) — null, NOT 0.
  const sNullEmpty = computeContextFaithfulness(response, []);
  assert.equal(sNullEmpty, null,
    `empty retrieved must yield null (honest absence); got ${sNullEmpty}`);
  const sNullMissing = computeContextFaithfulness(response, null);
  assert.equal(sNullMissing, null,
    `null retrieved must yield null (honest absence); got ${sNullMissing}`);
  const sNullUndef = computeContextFaithfulness(response, undefined);
  assert.equal(sNullUndef, null,
    `undefined retrieved must yield null; got ${sNullUndef}`);

  // Zero overlap — 0.0 is valid (response ignores retrieved). NOT null.
  const sZero = computeContextFaithfulness('completely unrelated nonsense words xyzzy plugh',
    [{ source: 's1', text: 'refund policy thirty days purchase date' }]);
  assert.equal(typeof sZero, 'number',
    `zero-overlap response must yield a number (NOT null — we have retrieved data); got ${sZero}`);
  assert.ok(sZero >= 0 && sZero <= 1, `zero-overlap score must still be in [0,1]; got ${sZero}`);

  // Bakeoff integration: summarize() of an empty-calls path must yield
  // context_faithfulness: null (honest absence, not 0).
  // We don't import bakeoff itself (heavy chain); we lock the wiring by
  // reading the source and asserting the null contract is encoded.
  const bakeoffSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bakeoff.js'), 'utf8');
  assert.ok(bakeoffSrc.includes('context_faithfulness'),
    'bakeoff.js must reference context_faithfulness column');
  assert.ok(/computeContextFaithfulness/.test(bakeoffSrc),
    'bakeoff.js must import computeContextFaithfulness from rag-capture.js');
});

// =============================================================================
// 11) public/docs/rag.html exists with brand-lock content
// =============================================================================

test('W734 #11 — /docs/rag.html exists with brand-lock content', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock matches the W724 / W730 docs shell pattern: ks-nav + ks-footer +
  // canonical brand string. These tokens are load-bearing for the docs shell
  // injection scripts.
  for (const needle of [
    'kolm.ai',                  // brand
    'class="ks-nav"',           // nav shell
    'ks-footer',                // footer shell
    'kolm-retrieved-context',   // the header we document
    'RAG',                      // topic word
    'captureWithContext',       // Node SDK helper name
    'capture_with_context',     // Python SDK helper name
    'context_faithfulness',     // bakeoff axis name
  ]) {
    assert.ok(html.includes(needle),
      `rag.html must mention "${needle}"`);
  }
  // Training-data format tag is HTML-escaped in the rendered doc so the
  // <RETRIEVED tag literal does not break the parser. Either the literal
  // or the escaped form satisfies the brand-lock — the load-bearing token
  // is "RETRIEVED" wrapped in angle-bracket syntax.
  assert.ok(html.includes('<RETRIEVED') || html.includes('&lt;RETRIEVED'),
    'rag.html must document the <RETRIEVED training-format tag (literal or HTML-escaped)');
});

// =============================================================================
// 12) cli/kolm.js defines cmdW734RagCapture exactly once + wired via case 'rag'
// =============================================================================

test('W734 #12 — cli/kolm.js defines cmdW734RagCapture dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Distinct-named per the W724/W726/W727/W728/W729/W730/W731/W732/W733
  // precedent so parallel wave agents can't collide on the symbol.
  const defs = cli.match(/async function cmdW734RagCapture\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW734RagCapture dispatcher definition; got ${defs.length}`);
  // Must be routed from a `case 'rag'` arm in main().
  assert.ok(/case\s+['"]rag['"]\s*:/.test(cli),
    `cmdW734RagCapture must be routed from case 'rag' in main()`);
  assert.ok(cli.includes('cmdW734RagCapture(rest)'),
    `cmdW734RagCapture must be invoked with the rest args`);
  // Honest fallbacks: context_file_not_found is the load-bearing error code.
  assert.ok(cli.includes('context_file_not_found'),
    `cmdW734RagCapture must emit context_file_not_found envelope on missing file`);
});

// =============================================================================
// 13) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W734 #13 — wave734 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  // Walk the tests directory and count files matching wave(\d{3,4}). The
  // W604 anti-brittleness directive FORBIDS explicit-array family checks.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave-test files MUST exist (W734 itself +
  // siblings like W730/W731/W732/W733). Threshold is forward-compat: adding
  // more wave tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 14) extractRetrievedFromResponse (W734-1 secondary path) — opportunistic
// =============================================================================

test('W734 #14 — extractRetrievedFromResponse pulls <sources> blocks out of inline responses', () => {
  freshDir();
  const response = `Here is the answer.

<sources>
  <source url="https://kolm.ai/docs/refunds" score="0.91">Refunds within 30 days.</source>
  <source url="https://kolm.ai/docs/billing">Billing FAQ.</source>
</sources>`;
  const out = extractRetrievedFromResponse(response, null);
  assert.ok(Array.isArray(out), 'must return an array');
  assert.equal(out.length, 2, `expected 2 extracted sources; got ${out.length}`);
  assert.equal(out[0].source, 'https://kolm.ai/docs/refunds');
  assert.equal(out[0].score, 0.91);
  // Empty / no-match input → empty array, never throws.
  const empty = extractRetrievedFromResponse('plain response with no sources', null);
  assert.ok(Array.isArray(empty) && empty.length === 0,
    `no-match input must return empty array; got ${JSON.stringify(empty)}`);
});
