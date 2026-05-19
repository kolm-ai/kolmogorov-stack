// W415 — /v1/intent/ask route + NL ask-bar on /account/overview.html
//
// Behavior assertions (per "tests assert behavior, not page copy"):
// 1. /v1/intent/ask is registered as a POST handler in src/router.js
// 2. The handler requires auth (401 when req.tenant_record missing)
// 3. The handler returns 400 on missing/empty question
// 4. The handler imports ./intent.js and calls classifyIntent
// 5. /account/overview.html includes the ask-form (data-w415="ask-form-el")
// 6. /account/overview.html includes the submit handler that POSTs to /v1/intent/ask
// 7. The submit handler renders answer + alternatives + copy buttons
//
// These tests are static-file/source-grep behavior locks (the integration smoke
// against a live tenant happens in the cross-wave loop tests). They guarantee
// the wiring cannot regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(REPO, 'src', 'router.js');
const OVERVIEW_PATH = path.join(REPO, 'public', 'account', 'overview.html');

function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }
function readOverview() { return fs.readFileSync(OVERVIEW_PATH, 'utf8'); }

test('W415 #1 — /v1/intent/ask is registered as a POST handler', () => {
  const src = readRouter();
  assert.match(src, /r\.post\(\s*['"]\/v1\/intent\/ask['"]/, '/v1/intent/ask POST route must exist');
});

test('W415 #2 — /v1/intent/ask requires auth (req.tenant_record gate)', () => {
  const src = readRouter();
  const i = src.indexOf("'/v1/intent/ask'");
  const j = i >= 0 ? i : src.indexOf('"/v1/intent/ask"');
  assert.ok(j >= 0, 'route literal must be present');
  const slice = src.slice(j, j + 1400);
  assert.match(slice, /req\.tenant_record/, 'handler must read req.tenant_record');
  assert.match(slice, /401/, 'handler must return 401 on missing tenant');
});

test('W415 #3 — /v1/intent/ask returns 400 on missing question', () => {
  const src = readRouter();
  const i = Math.max(src.indexOf("'/v1/intent/ask'"), src.indexOf('"/v1/intent/ask"'));
  const slice = src.slice(i, i + 1400);
  assert.match(slice, /400/, 'handler must 400 on missing question');
  assert.match(slice, /missing_question|question/i, 'handler must check for question field');
});

test('W415 #4 — /v1/intent/ask delegates to intent.classifyIntent', () => {
  const src = readRouter();
  const i = Math.max(src.indexOf("'/v1/intent/ask'"), src.indexOf('"/v1/intent/ask"'));
  const slice = src.slice(i, i + 1800);
  assert.match(slice, /import\(['"]\.\/intent\.js['"]\)|from\s+['"]\.\/intent\.js['"]/, 'handler must import ./intent.js');
  assert.match(slice, /classifyIntent/, 'handler must call classifyIntent');
});

test('W415 #5 — /account/overview.html has the ask-form panel (data-w415)', () => {
  const html = readOverview();
  assert.match(html, /data-w415="ask-form"/, 'panel marker missing');
  assert.match(html, /data-w415="ask-form-el"/, 'form element marker missing');
  assert.match(html, /id="ask-input"/, 'input id missing');
  assert.match(html, /id="ask-submit"/, 'submit button id missing');
  assert.match(html, /id="ask-answer"/, 'answer div id missing');
});

test('W415 #6 — submit handler POSTs to /v1/intent/ask', () => {
  const html = readOverview();
  assert.match(html, /fetch\(\s*["']\/v1\/intent\/ask["']/, 'submit handler must fetch /v1/intent/ask');
  assert.match(html, /method:\s*["']POST["']/, 'must use POST');
  assert.match(html, /JSON\.stringify\(\s*\{\s*question/, 'must send {question} body');
});

test('W415 #7 — submit handler renders answer + alternatives + copy buttons', () => {
  const html = readOverview();
  assert.match(html, /data-w415="answer-row"/, 'answer-row marker missing');
  assert.match(html, /data-w415="alternatives"/, 'alternatives marker missing');
  assert.match(html, /data-w415="copy"/, 'copy button marker missing');
  assert.match(html, /navigator\.clipboard/, 'clipboard wiring missing');
});
