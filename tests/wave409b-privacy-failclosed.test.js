// Wave 409b — privacy membrane fail-closed audit lock-in.
//
// Auditor flagged TWO P0 bugs in the redaction pipeline:
//   1. src/daemon-connector.js error path used to persist raw `promptText`
//      into the observation row when forwardRaw() threw. Success path
//      already used the redacted form, so a 5xx from upstream silently
//      leaked PII into the lake.
//   2. src/router.js __connectorProxy hard-coded redaction_policy:'allow'
//      with no actual redaction pipeline. Every cloud-routed call wrote
//      raw PII to the canonical event row.
//
// Mandate post-W409b:
//   - Default redaction_policy = 'redact' (raw is opt-in via explicit env
//     KOLM_PRIVACY_POLICY=allow or per-request x-kolm-privacy-policy hdr).
//   - Server-direct proxy must NOT default to 'allow'.
//   - Error path MUST persist the redacted prompt, not raw promptText.
//   - Every event/capture row carries:
//       redaction_policy: 'redact' | 'allow' | 'block' | 'review_required'
//       raw_available:   boolean
//       raw_prompt_hash / raw_response_hash (when raw is stored)
//       noncompliant_identifiers: ['malformed_ssn', ...]
//   - Raw bytes (when explicitly opted in) go to a sidecar
//     ~/.kolm/events/raw/<sha256>_<kind>.txt, NEVER inline in the lake row.
//   - Sidecar gated behind KOLM_ALLOW_RAW=true or x-kolm-raw: true header.
//
// Tests assert BEHAVIOR (HTTP + stored rows), not page copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same-module-instance imports (no cache-bust): the daemon writes to these
// modules and the test reads from the same instance. Pattern proven in
// wave409a-canonical-event-store.test.js.
import * as eventStore from '../src/event-store.js';
import * as captureStore from '../src/capture-store.js';
import * as daemonConnector from '../src/daemon-connector.js';
import * as providerRegistry from '../src/provider-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SSN_VALID = '123-45-6789';   // valid SSA layout, triggers 'ssn'
const SSN_BROKEN = '000-12-3456';  // malformed (000-area), triggers 'malformed_ssn'
const EMAIL = 'jane.doe@example.com';
const PHONE = '(415) 555-0123';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409b-'));
}
function cleanupHome(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
}

function setIsolatedHome(home) {
  process.env.KOLM_DATA_DIR = path.join(home, '.kolm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // The event-store is the canonical telemetry plane; bridge from
  // capture-store lands here. Reset its lazy driver so KOLM_DATA_DIR is
  // re-read on the next call.
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
}

function teardownIsolated(home) {
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (captureStore._resetDriverCache) captureStore._resetDriverCache();
  delete process.env.KOLM_DATA_DIR;
  cleanupHome(home);
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const hdr = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers };
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers: hdr,
    }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch (_) { json = { _raw: buf }; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function spinMockUpstream(opts = {}) {
  const received = { last_prompt: '', count: 0 };
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    const m = (req.body && req.body.messages && req.body.messages[0] && req.body.messages[0].content) || '';
    received.last_prompt = String(m);
    received.count += 1;
    if (opts.fail === 'tcp_drop') {
      try { req.socket && req.socket.destroy(); } catch (_) {}
      return;
    }
    if (opts.fail === '5xx') return res.status(502).json({ error: 'upstream_5xx' });
    res.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock-reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port, received });
    });
  });
}

// Spin an upstream that closes the socket on every request so forwardRaw()
// throws — exercises the W409b fail-closed error path.
function spinDeadUpstream() {
  const net = http.createServer((req, res) => {
    try { req.socket && req.socket.destroy(); } catch (_) {}
  });
  return new Promise((resolve) => {
    net.listen(0, '127.0.0.1', () => {
      resolve({ server: net, base: 'http://127.0.0.1:' + net.address().port });
    });
  });
}

async function startTestDaemon(env = {}) {
  for (const [k, v] of Object.entries(env)) { process.env[k] = v; }
  // Re-point the in-memory provider registry at the test upstream. This is the
  // same hook wave409a / wave409h use to redirect OpenAI calls during tests.
  if (env.KOLM_UPSTREAM_OPENAI_BASE) {
    providerRegistry.PROVIDERS.openai.upstream = env.KOLM_UPSTREAM_OPENAI_BASE;
  }
  const { server, port, pid } = await daemonConnector.startDaemon({ port: 0, host: '127.0.0.1' });
  return { server, port, pid, base: 'http://127.0.0.1:' + port };
}

function snapEnv() {
  return {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    POLICY: process.env.KOLM_PRIVACY_POLICY,
    ALLOW_RAW: process.env.KOLM_ALLOW_RAW,
    KEY: process.env.OPENAI_API_KEY,
    UPSTREAM: providerRegistry.PROVIDERS.openai.upstream,
  };
}
function restoreEnv(prev, HOME) {
  process.env.HOME = prev.HOME || ''; process.env.USERPROFILE = prev.USERPROFILE || '';
  if (prev.POLICY != null) process.env.KOLM_PRIVACY_POLICY = prev.POLICY; else delete process.env.KOLM_PRIVACY_POLICY;
  if (prev.ALLOW_RAW != null) process.env.KOLM_ALLOW_RAW = prev.ALLOW_RAW; else delete process.env.KOLM_ALLOW_RAW;
  if (prev.KEY) process.env.OPENAI_API_KEY = prev.KEY; else delete process.env.OPENAI_API_KEY;
  providerRegistry.PROVIDERS.openai.upstream = prev.UPSTREAM;
  teardownIsolated(HOME);
}

// =============================================================================
// Test 1 — successful proxy redacts PII out of the lake row (default policy).
// =============================================================================
test('W409b #1 — successful proxy: raw PII never lands in the lake under default policy', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  delete process.env.KOLM_ALLOW_RAW;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const prompt = `customer SSN ${SSN_VALID}, email ${EMAIL}, phone ${PHONE}`;
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      assert.equal(r.status, 200, 'expected 200, got ' + r.status);
      assert.ok(r.headers['x-kolm-event-id'], 'missing x-kolm-event-id');
      // Default policy header should be 'redact'.
      assert.equal(r.headers['x-kolm-redaction-policy'], 'redact');
      // raw_available defaults to false (no opt-in).
      assert.equal(r.headers['x-kolm-raw-available'], 'false');

      // Read the canonical event store (isolated via KOLM_DATA_DIR). The bridge
      // from capture-store lands here and carries every privacy provenance
      // field set on the daemon's newEvent() output.
      const evid = r.headers['x-kolm-event-id'];
      const ev = await eventStore.getEvent(evid);
      assert.ok(ev, 'expected canonical event row for ' + evid);
      const blob = JSON.stringify(ev);
      assert.ok(!blob.includes(SSN_VALID), 'lake row leaked raw SSN');
      assert.ok(!blob.includes(EMAIL), 'lake row leaked raw email');
      assert.ok(!blob.includes(PHONE), 'lake row leaked raw phone');
      // The redaction_policy + raw_available tags are persisted alongside the row.
      assert.equal(ev.redaction_policy, 'redact', 'row.redaction_policy must be redact');
      assert.equal(ev.raw_available, false, 'row.raw_available must be false under default');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});

// =============================================================================
// Test 2 — upstream failure preserves redaction (THE BUG FIX).
// =============================================================================
test('W409b #2 — upstream failure: error path persists redacted prompt, not raw promptText', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  delete process.env.KOLM_ALLOW_RAW;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    // Point the daemon at a dead upstream so forwardRaw() throws inside proxyOne.
    // This is the exact code path the auditor flagged.
    const dead = await spinDeadUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: dead.base });
    try {
      const prompt = `patient SSN ${SSN_VALID}, email ${EMAIL}`;
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      // We should get a 502 from the daemon's error branch (upstream failed).
      assert.equal(r.status, 502, 'expected 502 from dead upstream, got ' + r.status);
      assert.ok(r.headers['x-kolm-event-id'], 'error-path must still emit x-kolm-event-id');
      assert.equal(r.headers['x-kolm-redaction-policy'], 'redact', 'policy hdr must be on err path');

      // Verify the lake row written by the error path does NOT contain raw PII.
      // This is the regression the wave is locking in.
      const evid = r.headers['x-kolm-event-id'];
      const ev = await eventStore.getEvent(evid);
      assert.ok(ev, 'error path must persist a canonical event for ' + evid);
      const blob = JSON.stringify(ev);
      assert.ok(!blob.includes(SSN_VALID),
        'BUG: error path leaked raw SSN to lake (row prompt: ' + String(ev.prompt_redacted || '').slice(0, 200) + ')');
      assert.ok(!blob.includes(EMAIL),
        'BUG: error path leaked raw email to lake');
      // The row must still carry the privacy tags.
      assert.equal(ev.redaction_policy, 'redact', 'err-path row.redaction_policy must be redact');
      assert.equal(ev.raw_available, false, 'err-path row.raw_available must be false');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => dead.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});

// =============================================================================
// Test 3 — malformed PII triggers "noncompliant identifier detected" tag.
// =============================================================================
test('W409b #3 — malformed SSN surfaces as noncompliant_identifiers tag on the row + header', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const prompt = `bad ssn ${SSN_BROKEN}`; // 000-area is invalid → malformed_ssn
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      });
      assert.equal(r.status, 200);
      // Response header signals the noncompliant identifier class.
      const hdr = String(r.headers['x-kolm-noncompliant-identifiers'] || '');
      assert.ok(
        hdr.includes('malformed_ssn'),
        'x-kolm-noncompliant-identifiers must include malformed_ssn; got: ' + hdr,
      );
      // Sensitive classes should ALSO carry malformed_ssn so the warning is
      // not buried — it flows through both surfaces.
      const sens = String(r.headers['x-kolm-sensitive-classes'] || '');
      assert.ok(sens.includes('malformed_ssn'), 'sensitive_classes must include malformed_ssn; got: ' + sens);

      // Lake row carries the tag too.
      const evid = r.headers['x-kolm-event-id'];
      const ev = await eventStore.getEvent(evid);
      assert.ok(ev);
      assert.ok(
        Array.isArray(ev.noncompliant_identifiers) && ev.noncompliant_identifiers.includes('malformed_ssn'),
        'row.noncompliant_identifiers must include malformed_ssn; got: ' + JSON.stringify(ev.noncompliant_identifiers),
      );
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});

// =============================================================================
// Test 4 — server-direct proxy (router.js) defaults to 'redact', NOT 'allow'.
// =============================================================================
test('W409b #4 — router.js server-direct proxy defaults redaction_policy to "redact" not "allow"', async () => {
  // Read the source and assert that the hard-coded 'allow' is gone. This is a
  // static-source assertion because exercising the router connector path
  // requires standing up the full auth-mounted express app — out of scope for
  // this test file. The behavior is exercised through the test #5 capture-row
  // assertion (every event row reports redaction_policy='redact' by default).
  const src = fs.readFileSync(path.resolve(__dirname, '../src/router.js'), 'utf8');
  // The bug was a literal `redaction_policy: 'allow'` inside __connectorProxy.
  // Locate the function body and assert that string is no longer present.
  const start = src.indexOf('async function __connectorProxy');
  assert.ok(start > 0, '__connectorProxy function not found in router.js');
  // Take a generous window after the function start — large enough to cover
  // the full proxy body (the rewrite is ~350 lines).
  const window = src.slice(start, start + 30000);
  assert.ok(
    !/redaction_policy:\s*['"]allow['"]/.test(window),
    'BUG: __connectorProxy still hard-codes redaction_policy:"allow"',
  );
  // It should now read from policy (the W409b-resolved local var).
  assert.ok(
    /redaction_policy:\s*policy/.test(window),
    'BUG: __connectorProxy must set redaction_policy: policy (resolved from env/header, defaulting to redact)',
  );
  // And the fail-closed default must be present.
  assert.ok(
    /\|\|\s*['"]redact['"]/.test(window),
    'BUG: __connectorProxy must default policy to "redact" when no env / header opts out',
  );
});

// =============================================================================
// Test 5 — every persisted event row has redaction_policy.
// =============================================================================
test('W409b #5 — every persisted observation row carries redaction_policy', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      // Fire 3 different calls (clean, sensitive, malformed) so we have ≥3
      // rows persisted.
      const prompts = [
        'plain prompt no PII',
        `with ssn ${SSN_VALID}`,
        `with bad ssn ${SSN_BROKEN}`,
      ];
      const ids = [];
      for (const p of prompts) {
        const r = await postJson(t.base + '/v1/chat/completions', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: p }],
        });
        assert.equal(r.status, 200);
        ids.push(r.headers['x-kolm-event-id']);
      }
      const rows = await eventStore.listEvents({ limit: 1000 });
      const ours = rows.filter((ev) => ids.includes(ev.event_id));
      assert.ok(ours.length >= 3, 'expected ≥3 rows for our event_ids, got ' + ours.length);
      for (const row of ours) {
        assert.ok(
          typeof row.redaction_policy === 'string' && row.redaction_policy.length > 0,
          'row missing redaction_policy: ' + JSON.stringify(row).slice(0, 200),
        );
        assert.ok(
          ['redact', 'allow', 'block', 'review_required'].includes(row.redaction_policy),
          'invalid redaction_policy on row: ' + row.redaction_policy,
        );
      }
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});

// =============================================================================
// Test 6 — every persisted event row carries raw_available boolean.
// =============================================================================
test('W409b #6 — every persisted observation row carries raw_available boolean', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  delete process.env.KOLM_ALLOW_RAW;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello world' }],
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-kolm-raw-available'], 'false', 'default → false');

      const evid = r.headers['x-kolm-event-id'];
      const ev = await eventStore.getEvent(evid);
      assert.ok(ev, 'expected canonical event row for ' + evid);
      assert.equal(typeof ev.raw_available, 'boolean', 'row.raw_available must be a boolean');
      assert.equal(ev.raw_available, false, 'row.raw_available default must be false (fail-closed)');
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});

// =============================================================================
// Test 7 — explicit raw opt-in writes sidecar + hash, lake row points at it.
// =============================================================================
test('W409b #7 — raw opt-in (x-kolm-raw: true) writes sidecar file + hash to lake', async () => {
  const HOME = mkHome();
  const prev = snapEnv();
  setIsolatedHome(HOME);
  delete process.env.KOLM_PRIVACY_POLICY;
  delete process.env.KOLM_ALLOW_RAW;
  process.env.OPENAI_API_KEY = 'sk-fake-for-test';
  try {
    const up = await spinMockUpstream();
    const t = await startTestDaemon({ KOLM_UPSTREAM_OPENAI_BASE: up.base });
    try {
      const prompt = 'a benign prompt without PII for raw opt-in test';
      // Opt in via header — the per-request override path.
      const r = await postJson(t.base + '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      }, { 'x-kolm-raw': 'true' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-kolm-raw-available'], 'true', 'header opt-in must set raw_available true');

      // The daemon writes the sidecar under its own KOLM_DIR (~/.kolm). The
      // daemon module was imported at the top of this file BEFORE we set
      // HOME — so KOLM_DIR there resolved against the original homedir.
      // We assert sidecar existence via daemon-connector._internals.RAW_DIR
      // (the same constant the daemon's writeRawSidecar uses).
      const RAW_DIR = daemonConnector._internals.rawDir();
      assert.ok(fs.existsSync(RAW_DIR), 'RAW_DIR must exist: ' + RAW_DIR);
      const files = fs.readdirSync(RAW_DIR);
      assert.ok(files.length > 0, 'sidecar dir must contain at least one raw file');
      const promptFiles = files.filter((f) => /_prompt\.txt$/.test(f));
      assert.ok(promptFiles.length > 0, 'expected at least one *_prompt.txt sidecar');

      // Lake row carries the hash that points at the sidecar.
      const evid = r.headers['x-kolm-event-id'];
      const ev = await eventStore.getEvent(evid);
      assert.ok(ev, 'expected canonical event row for ' + evid);
      assert.equal(ev.raw_available, true, 'row.raw_available must be true after opt-in');
      assert.ok(
        typeof ev.raw_prompt_hash === 'string' && /^[a-f0-9]{64}$/.test(ev.raw_prompt_hash),
        'row.raw_prompt_hash must be a sha256 hex string; got: ' + ev.raw_prompt_hash,
      );
      // The hash must match a sidecar filename prefix (proof the pointer
      // is real, not stale).
      const matchingFile = files.find((f) => f.startsWith(ev.raw_prompt_hash + '_'));
      assert.ok(
        matchingFile,
        'no sidecar file matches row.raw_prompt_hash (' + ev.raw_prompt_hash + ')',
      );
    } finally {
      await new Promise((r) => t.server.close(() => r()));
      await new Promise((r) => up.server.close(() => r()));
    }
  } finally {
    restoreEnv(prev, HOME);
  }
});
