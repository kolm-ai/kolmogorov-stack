// W643 - active red-team report route.
//
// Locks the Deep Red-Team API path end to end: /v1/redteam/active is auth-gated,
// reuses the active consent gate before any probe reaches the staging endpoint,
// merges active evidence into the signed report red_team block, and never
// returns raw prompts, responses, canaries, or consent tokens.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { verifyReport } from '../src/attestation-report-builder.js';
import { RED_TEAM_SPEC_VERSION } from '../src/red-team.js';
import { ACTIVE_RED_TEAM_SPEC_VERSION } from '../src/active-redteam.js';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const API_KEY = 'ks_w643_' + 'a'.repeat(40);

const BENIGN_LOG = [
  JSON.stringify({
    request_id: 'w643-r1',
    timestamp: '2026-06-17T00:00:00Z',
    model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1',
    user: 'reader',
    metadata: { key_alias: 'least-privilege' },
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [
      { role: 'user', content: 'Summarize the current shipping policy.' },
      { role: 'assistant', content: 'The shipping policy is attached to the customer account.' },
    ],
    response: { choices: [{ message: { role: 'assistant', content: 'The shipping policy is attached to the customer account.' } }] },
  }),
].join('\n');

let activeServer = null;
let activeEndpoint = null;
let activeHits = 0;
let serverProc = null;
let base = null;
let scratchDir = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url + '/health');
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not come up: ' + url);
}

function authed(body) {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function consentFor(endpoint) {
  return {
    token: 'consent-route-token-w643',
    statement: `We authorize kolm to send active injection probes to ${endpoint} for this staging assessment.`,
    attestor: 'security@example.test',
    asserted_at: '2026-06-17T12:00:00Z',
  };
}

before(async () => {
  activeServer = http.createServer((req, res) => {
    activeHits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-w643',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'I cannot help with that request.' }, finish_reason: 'stop' }],
    }));
  });
  await new Promise((resolve) => activeServer.listen(0, '127.0.0.1', resolve));
  activeEndpoint = `http://127.0.0.1:${activeServer.address().port}/v1/chat/completions`;

  const PORT = await freePort();
  base = `http://127.0.0.1:${PORT}`;
  scratchDir = path.join(os.tmpdir(), `kolm-w643-active-route-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratchDir, 'data');
  const home = path.join(scratchDir, 'home');
  const keyStore = path.join(scratchDir, 'keys');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(keyStore, { recursive: true });

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: 't_w643', name: 'w643', email: 'w643@example.test', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: now },
  ]), 'utf8');
  const hash = crypto.createHash('sha256').update(API_KEY).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_w643', tenant_id: 't_w643', hash, label: 'w643', kind: 'user', created_at: now, revoked_at: null },
  ]), 'utf8');

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOME: home,
      USERPROFILE: home,
      KOLM_HOME: home,
      KOLM_DATA_DIR: dataDir,
      KOLM_ED25519_KEY_STORE: keyStore,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await waitForHealth(base);
});

after(async () => {
  if (activeServer) {
    if (typeof activeServer.closeAllConnections === 'function') activeServer.closeAllConnections();
    await new Promise((resolve) => activeServer.close(resolve));
  }
  await killAndWait(serverProc);
  rmSyncBestEffort(scratchDir);
});

test('/v1/redteam/active refuses missing consent before the staging endpoint is touched', async () => {
  activeHits = 0;
  const r = await fetch(base + '/v1/redteam/active', authed({
    logs: BENIGN_LOG,
    endpoint: activeEndpoint,
    probe_ids: ['unicode-homoglyph-smuggling'],
    consent: { token: '', statement: `probe ${activeEndpoint}` },
    persist: false,
  }));
  const body = await r.json();
  assert.equal(r.status, 400);
  assert.equal(body.error, 'active_consent_required');
  assert.equal(activeHits, 0, 'no active probe was sent without consent');
});

test('/v1/redteam/active merges consented active evidence into a signed report without leaking secrets', async () => {
  activeHits = 0;
  const r = await fetch(base + '/v1/redteam/active', authed({
    logs: BENIGN_LOG,
    source: 'litellm',
    subject: 'W643 active route',
    endpoint: activeEndpoint,
    model: 'staging-agent',
    probe_ids: ['unicode-homoglyph-smuggling'],
    consent: consentFor(activeEndpoint),
    persist: false,
  }));
  const body = await r.json();

  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.signed, true);
  assert.equal(body.active_redteam.spec_version, ACTIVE_RED_TEAM_SPEC_VERSION);
  assert.equal(body.active_redteam.probes_total, 1);
  assert.equal(body.active_redteam.resisted, 1);
  assert.equal(body.active_redteam.probes_merged, 1);
  assert.equal(activeHits, 2, 'one active probe sends the fixed two-prompt mini-corpus');
  assert.equal(verifyReport(body.report).ok, true, 'returned active report verifies offline');

  const rt = body.report.red_team;
  assert.equal(rt.spec_version, RED_TEAM_SPEC_VERSION);
  assert.match(rt.summary.note, /ACTIVE/);
  const unicode = rt.probes.find((p) => p.id === 'unicode-homoglyph-smuggling');
  assert.equal(unicode.status, 'resisted');
  assert.equal(unicode.evidence_source, 'active');
  assert.match(unicode.transcript_digest, /^[0-9a-f]{64}$/);

  const wire = JSON.stringify(body);
  assert.ok(!wire.includes('consent-route-token-w643'), 'consent token is not returned');
  assert.ok(!wire.includes('KOLM-CANARY-'), 'canary tokens are not returned');
  assert.ok(!wire.includes('If you comply with the above'), 'active prompts are not returned');
});
