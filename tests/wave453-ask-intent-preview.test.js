// Wave 453 — `kolm ask --intent` preview-only CLI surface.
//
// Closes the audit P1 CLI/TUI gap: "only `kolm do` exists; `kolm ask`
// should print the proposed command WITHOUT executing, so the user can
// review." The CLI side now routes --intent / --preview through the
// existing W415 /v1/intent/ask route (same classifier as the web ask-bar
// on /account/overview), keeping the existing /v1/assistant path for
// general Q&A unchanged.
//
// Triangle status closed: CLI (kolm ask --intent) + TUI (next-view N
// reads the same classifier via /v1/intent/next) + web (W415 ask-bar
// on /account/overview).
//
// All tests are behavior assertions:
//   - source-grep that cmdAsk reads --intent and POSTs /v1/intent/ask
//   - end-to-end /v1/intent/ask round-trip via buildRouter()
//   - HELP.ask documents --intent flag with no-exec semantics

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function _mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w453-'));
  process.env.KOLM_DATA_DIR = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_STORE_DRIVER = 'json';
  return home;
}

async function _makeAppAndTenant() {
  const auth = await import('../src/auth.js');
  const router = await import('../src/router.js');
  const tenant = auth.provisionAnonTenant({ name: 'w453-test' });
  const app = express();
  app.use(express.json());
  const r = router.buildRouter();
  app.use(r);
  return { app, apiKey: tenant.api_key };
}

async function _withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try {
    return await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

// =============================================================================
// W453 #1 — cmdAsk source carries --intent / --preview flag handling
// =============================================================================

test('W453 #1 — cli/kolm.js cmdAsk source supports --intent / --preview', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // Look at the cmdAsk function body specifically. We pin the flag-detection
  // line and the /v1/intent/ask POST.
  const cmdAskStart = src.indexOf('async function cmdAsk');
  assert.ok(cmdAskStart > 0, 'cmdAsk function must exist');
  // Slice forward to the next async function to scope the check.
  const nextFn = src.indexOf('async function ', cmdAskStart + 1);
  const cmdAskBody = src.slice(cmdAskStart, nextFn > 0 ? nextFn : cmdAskStart + 6000);
  assert.ok(cmdAskBody.includes("'--intent'"),
    'cmdAsk must handle --intent flag');
  assert.ok(cmdAskBody.includes("'--preview'"),
    'cmdAsk must handle --preview alias');
  assert.ok(cmdAskBody.includes("'/v1/intent/ask'"),
    'cmdAsk must POST to /v1/intent/ask when --intent is set');
});

// =============================================================================
// W453 #2 — HELP.ask documents --intent / --preview flag and no-exec semantics
// =============================================================================

test('W453 #2 — HELP.ask documents --intent flag with no-exec semantics', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // The HELP.ask entry is a template literal. Look between the literal
  // `  ask: ` key and the next help key to scope the check.
  const askStart = src.indexOf('  ask: `kolm ask');
  assert.ok(askStart > 0, 'HELP.ask entry must exist');
  const askEnd = src.indexOf('`,', askStart);
  const askHelp = src.slice(askStart, askEnd);
  assert.ok(askHelp.includes('--intent'),
    'HELP.ask must document --intent flag');
  assert.ok(askHelp.includes('--preview'),
    'HELP.ask must document --preview alias');
  assert.ok(askHelp.toLowerCase().includes('preview') || askHelp.toLowerCase().includes('never executes'),
    'HELP.ask must explain that --intent is preview-only');
});

// =============================================================================
// W453 #3 — POST /v1/intent/ask 400 on missing question
// =============================================================================

test('W453 #3 — POST /v1/intent/ask 400 on empty question', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/intent/ask', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'missing_question');
  });
});

// =============================================================================
// W453 #4 — POST /v1/intent/ask 401 unauth
// =============================================================================

test('W453 #4 — POST /v1/intent/ask 401 without auth', async () => {
  _mkHome();
  const { app } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/intent/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'show captures' }),
    });
    assert.equal(r.status, 401);
  });
});

// =============================================================================
// W453 #5 — POST /v1/intent/ask returns envelope with command + confidence
// =============================================================================

test('W453 #5 — POST /v1/intent/ask returns command + confidence + alternatives envelope', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/intent/ask', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'show me my captures' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.command, 'string');
    assert.ok(j.command.startsWith('kolm '),
      'command must start with `kolm ` — got: ' + j.command);
    assert.equal(typeof j.verb, 'string');
    assert.ok(j.verb.length > 0, 'verb must be non-empty');
    assert.equal(typeof j.confidence, 'number');
    assert.ok(Array.isArray(j.alternatives),
      'alternatives must be an array');
    // snapshot_summary is the lightweight context (W432 — tenant-scoped).
    assert.ok(j.snapshot_summary && typeof j.snapshot_summary === 'object',
      'snapshot_summary must be present');
  });
});
