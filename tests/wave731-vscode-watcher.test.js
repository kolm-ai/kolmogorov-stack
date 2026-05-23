// W731 — VS Code Extension Capture Monitoring tests.
//
// Atomic items pinned (matches the W731 implementation):
//
//   1) sdk/vscode/package.json has all W731 commands + configuration keys
//   2) capture-watcher module imports cleanly + exports KOLM_VSCODE_WATCHER_VERSION
//   3) pattern-detector module imports cleanly + Jaccard similarity > 0.7 fires
//      on synthetic repetitive captures (>=3 matches)
//   4) distill-command module imports cleanly + classifies 401 / 503 / unknown
//      error envelopes per the W731-3 contract
//   5) cost-savings module imports cleanly + computeSavings(0, *) renders $0.00
//      and NEVER fabricates a positive value (W731-5 honesty contract)
//   6) router-switch module imports cleanly + ROUTE_ENDPOINT references the
//      W709 /v1/route/chat/completions path
//   7) capture-watcher honest no-op when KOLM_API_KEY absent (W731-1 contract)
//   8) cost-savings never fabricates positive value when capture count = 0
//   9) cli/kolm.js defines cmdW731VscodeInstall dispatcher exactly once + is
//      wired from the main() switch
//  10) Family lock-in uses regex wave(\d{3,4}) — no explicit-array per W604
//  11) capture-watcher throttle: same file within throttle window emits 0
//      captures (W731-1 contract — max 1 per 5s per file)
//  12) router-switch formatBadge classifies student vs teacher decisions
//
// All tests import via plain CommonJS-shim (require) or dynamic import; no
// VS Code extension host is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SDK_VSCODE_DIR = path.join(REPO_ROOT, 'sdk', 'vscode');
const SRC_DIR = path.join(SDK_VSCODE_DIR, 'src');
const PKG_PATH = path.join(SDK_VSCODE_DIR, 'package.json');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

const requireFrom = createRequire(import.meta.url);

function loadW731(name) {
  return requireFrom(path.join(SRC_DIR, name + '.js'));
}

// =============================================================================
// 1) package.json contributes the W731 commands + configuration keys
// =============================================================================

test('W731 #1 — sdk/vscode/package.json has W731 commands + configuration keys', () => {
  assert.ok(fs.existsSync(PKG_PATH), `package.json must exist at ${PKG_PATH}`);
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  // engine + activation
  assert.ok(pkg.engines && pkg.engines.vscode && pkg.engines.vscode.includes('1.85'),
    `expected engines.vscode ^1.85.0; got ${JSON.stringify(pkg.engines)}`);
  const activation = pkg.activationEvents || [];
  assert.ok(activation.includes('onStartupFinished'),
    `expected onStartupFinished activation event; got ${JSON.stringify(activation)}`);
  // commands
  const cmds = (pkg.contributes && pkg.contributes.commands) || [];
  const cmdNames = cmds.map(c => c.command);
  for (const expected of [
    'kolm.distillCodingAssistant',
    'kolm.viewCaptures',
    'kolm.viewCostSavings',
  ]) {
    assert.ok(cmdNames.includes(expected),
      `expected contributes.commands to include "${expected}"; got ${JSON.stringify(cmdNames)}`);
  }
  // configuration keys
  const props = (pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) || {};
  for (const key of ['kolm.apiKey', 'kolm.baseUrl', 'kolm.namespace', 'kolm.costPerCall']) {
    assert.ok(Object.prototype.hasOwnProperty.call(props, key),
      `expected configuration property "${key}"; got keys ${Object.keys(props).join(',')}`);
  }
  // baseUrl default
  assert.equal(props['kolm.baseUrl'].default, 'https://kolm.ai',
    `kolm.baseUrl default must be https://kolm.ai`);
  // namespace default
  assert.equal(props['kolm.namespace'].default, 'vscode-codegen',
    `kolm.namespace default must be vscode-codegen`);
});

// =============================================================================
// 2) capture-watcher exports cleanly + version stamp
// =============================================================================

test('W731 #2 — capture-watcher imports cleanly with version stamp', () => {
  const mod = loadW731('capture-watcher');
  assert.equal(mod.KOLM_VSCODE_WATCHER_VERSION, 'w731-v1',
    `expected version 'w731-v1'; got ${mod.KOLM_VSCODE_WATCHER_VERSION}`);
  for (const name of ['activate', 'isCompletionShaped', 'extractPromptWindow', 'postCapture']) {
    assert.equal(typeof mod[name], 'function',
      `expected ${name} to be a function; got ${typeof mod[name]}`);
  }
});

// =============================================================================
// 3) pattern-detector fires when Jaccard similarity > 0.7 on >=3 captures
// =============================================================================

test('W731 #3 — pattern-detector fires kolm.patternRepetitionDetected on Jaccard>0.7 with 3 dupes', () => {
  const mod = loadW731('pattern-detector');
  assert.equal(typeof mod.createDetector, 'function');
  const events = [];
  const detector = mod.createDetector({
    threshold: 0.7,
    minMatches: 3,
    emit: (e) => events.push(e),
  });
  // Three nearly-identical completions — Jaccard on 4-gram shingles will be ~1.
  const baseCompletion = 'function add(a, b) {\n  return a + b;\n}';
  detector.observe({ completion: baseCompletion, ts: 1 });
  detector.observe({ completion: baseCompletion, ts: 2 });
  detector.observe({ completion: baseCompletion, ts: 3 });
  assert.ok(events.length >= 1,
    `expected at least 1 emit on the 3rd duplicate; got ${events.length} events`);
  const ev = events[0];
  assert.equal(ev.kind, 'kolm.patternRepetitionDetected',
    `expected kind=kolm.patternRepetitionDetected; got ${ev.kind}`);
  assert.ok(ev.matches >= 3,
    `expected matches>=3; got ${ev.matches}`);
  assert.ok(ev.maxSim > 0.7,
    `expected maxSim>0.7; got ${ev.maxSim}`);
  // Cluster dedup — observing a 4th near-duplicate must not re-fire
  const before = events.length;
  detector.observe({ completion: baseCompletion, ts: 4 });
  assert.equal(events.length, before,
    `same cluster must not re-emit; got ${events.length - before} extra emits`);
});

// =============================================================================
// 4) distill-command imports cleanly + classifies 401 / 503 / unknown
// =============================================================================

test('W731 #4 — distill-command imports cleanly + _classifyError handles 401/503/unknown', () => {
  const mod = loadW731('distill-command');
  assert.equal(mod.KOLM_VSCODE_DISTILL_COMMAND_VERSION, 'w731-v1');
  assert.equal(typeof mod.runDistill, 'function');
  assert.equal(typeof mod._classifyError, 'function');
  const k401 = mod._classifyError(new Error('http 401 unauthorized'), null);
  assert.equal(k401.kind, 'unauthenticated',
    `401 must classify as unauthenticated; got ${JSON.stringify(k401)}`);
  assert.ok(k401.userMessage.includes('kolm.apiKey'),
    `401 user message must mention kolm.apiKey; got ${k401.userMessage}`);
  const k503 = mod._classifyError(new Error('http 503'), { error: 'module_missing', message: 'router not loaded' });
  assert.equal(k503.kind, 'unavailable',
    `503 must classify as unavailable; got ${JSON.stringify(k503)}`);
  const kU = mod._classifyError(new Error('connection refused'), null);
  assert.equal(kU.kind, 'unknown',
    `random errors must classify as unknown; got ${JSON.stringify(kU)}`);
});

// =============================================================================
// 5) cost-savings imports cleanly + Jaccard etc. (the W731-5 honesty contract)
// =============================================================================

test('W731 #5 — cost-savings exports + computeSavings honest formatting', () => {
  const mod = loadW731('cost-savings');
  assert.equal(mod.KOLM_VSCODE_COST_SAVINGS_VERSION, 'w731-v1');
  assert.equal(typeof mod.computeSavings, 'function');
  assert.equal(typeof mod.fetchTodaysCaptureCount, 'function');
  const s = mod.computeSavings(100, 0.003);
  assert.equal(s.captureCount, 100);
  assert.equal(s.savedFormatted, '$0.30',
    `expected $0.30 for 100 captures @ $0.003; got ${s.savedFormatted}`);
});

// =============================================================================
// 6) router-switch imports cleanly + W709 endpoint reference
// =============================================================================

test('W731 #6 — router-switch imports cleanly + references W709 /v1/route/chat/completions', () => {
  const mod = loadW731('router-switch');
  assert.equal(mod.KOLM_VSCODE_ROUTER_SWITCH_VERSION, 'w731-v1');
  assert.equal(mod.ROUTE_ENDPOINT, '/v1/route/chat/completions',
    `expected ROUTE_ENDPOINT to be the W709 /v1/route/chat/completions path; got ${mod.ROUTE_ENDPOINT}`);
  assert.equal(typeof mod.routeOnce, 'function');
  assert.equal(typeof mod.formatBadge, 'function');
  // Source-level reference to the W709 router file
  const src = fs.readFileSync(path.join(SRC_DIR, 'router-switch.js'), 'utf8');
  assert.ok(/W709|confidence.router|runtime-confidence-router/i.test(src),
    `router-switch.js must reference W709 / confidence-router in its comments; first 500 chars: ${src.slice(0,500)}`);
});

// =============================================================================
// 7) Capture-watcher honest no-op when KOLM_API_KEY absent
// =============================================================================

test('W731 #7 — capture-watcher honest no-op when KOLM_API_KEY is absent', async () => {
  const mod = loadW731('capture-watcher');
  const calls = { request: 0, toast: 0 };
  delete process.env.KOLM_API_KEY;
  // Stub vscode-like API.
  const fakeVscode = {
    workspace: {
      onDidChangeTextDocument: (handler) => ({ dispose() {}, _handler: handler }),
    },
    window: {
      showInformationMessage: (msg) => { calls.toast += 1; calls.lastMsg = msg; },
    },
  };
  const fakeRequest = async () => { calls.request += 1; return {}; };
  const watcher = mod.activate({
    vscode: fakeVscode,
    cfg: () => ({ baseUrl: 'https://kolm.test', namespace: 'vscode-codegen' }),
    request: fakeRequest,
  });
  // Fire a synthetic large change.
  await watcher._handler({
    document: { uri: { toString: () => 'file:///foo.js' }, lineAt: () => ({ text: 'x' }), lineCount: 10 },
    contentChanges: [{ text: 'a'.repeat(100), range: { start: { line: 5 }, end: { line: 5 } } }],
  });
  assert.equal(calls.request, 0,
    `request must NOT fire when api key is absent; got ${calls.request} calls`);
  assert.equal(calls.toast, 1,
    `toast must fire exactly once when api key is absent; got ${calls.toast}`);
  assert.ok(/kolm\.apiKey/.test(calls.lastMsg || ''),
    `toast must mention kolm.apiKey; got: ${calls.lastMsg}`);
  watcher.dispose();
});

// =============================================================================
// 8) cost-savings NEVER fabricates positive value when capture count = 0
// =============================================================================

test('W731 #8 — cost-savings never fabricates positive value when capture count is 0', () => {
  const mod = loadW731('cost-savings');
  const zero = mod.computeSavings(0, 0.003);
  assert.equal(zero.captureCount, 0);
  assert.equal(zero.savedUsd, 0,
    `savedUsd must be exactly 0 when capture count is 0; got ${zero.savedUsd}`);
  assert.equal(zero.savedFormatted, '$0.00',
    `savedFormatted must render '$0.00'; got ${zero.savedFormatted}`);
  // Negative or NaN inputs must also clamp to 0 (honest, never fabricate)
  for (const bad of [-5, NaN, undefined, null, 'lots']) {
    const s = mod.computeSavings(bad, 0.003);
    assert.equal(s.savedUsd, 0,
      `bad input ${JSON.stringify(bad)} must clamp savedUsd to 0; got ${s.savedUsd}`);
    assert.equal(s.savedFormatted, '$0.00',
      `bad input ${JSON.stringify(bad)} must render $0.00; got ${s.savedFormatted}`);
  }
});

// =============================================================================
// 9) cli/kolm.js defines cmdW731VscodeInstall dispatcher
// =============================================================================

test('W731 #9 — cli/kolm.js defines cmdW731VscodeInstall dispatcher exactly once + wired from main', () => {
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW731VscodeInstall\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW731VscodeInstall dispatcher definition; got ${defs.length}`);
  // Must be wired from the main switch
  assert.ok(cli.includes('cmdW731VscodeInstall(rest)'),
    `cmdW731VscodeInstall must be routed from the CLI dispatcher (looked for cmdW731VscodeInstall(rest))`);
  assert.ok(/case ['"]vscode['"]/.test(cli),
    `expected case 'vscode': arm in the CLI switch`);
});

// =============================================================================
// 10) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W731 #10 — wave731 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 11) Capture-watcher throttle: same file within window emits one capture
// =============================================================================

test('W731 #11 — capture-watcher throttles to <=1 capture per file per window', async () => {
  const mod = loadW731('capture-watcher');
  process.env.KOLM_API_KEY = 'ks_test_w731';
  let requestCalls = 0;
  const fakeVscode = {
    workspace: { onDidChangeTextDocument: () => ({ dispose() {} }) },
    window: { showInformationMessage: () => {} },
  };
  const fakeRequest = async () => { requestCalls += 1; return { ok: true }; };
  const watcher = mod.activate({
    vscode: fakeVscode,
    cfg: () => ({ baseUrl: 'https://kolm.test', namespace: 'vscode-codegen', throttleMs: 10000 }),
    request: fakeRequest,
  });
  const change = (i) => ({
    document: { uri: { toString: () => 'file:///foo.js' }, lineAt: () => ({ text: 'x' }), lineCount: 10 },
    contentChanges: [{ text: 'a'.repeat(100) + i, range: { start: { line: 5 }, end: { line: 5 } } }],
  });
  await watcher._handler(change(1));
  await watcher._handler(change(2));
  await watcher._handler(change(3));
  assert.equal(requestCalls, 1,
    `expected throttle to permit exactly 1 capture per file in window; got ${requestCalls}`);
  watcher.dispose();
  delete process.env.KOLM_API_KEY;
});

// =============================================================================
// 12) router-switch formatBadge classifies student vs teacher decisions
// =============================================================================

test('W731 #12 — router-switch.formatBadge maps decisions to local / cloud labels', () => {
  const mod = loadW731('router-switch');
  const local = mod.formatBadge('student');
  assert.equal(local.text, 'local',
    `decision 'student' must format as local; got ${JSON.stringify(local)}`);
  const cloud = mod.formatBadge('teacher');
  assert.equal(cloud.text, 'cloud',
    `decision 'teacher' must format as cloud; got ${JSON.stringify(cloud)}`);
  const aliasLocal = mod.formatBadge('local');
  assert.equal(aliasLocal.text, 'local');
  const aliasCloud = mod.formatBadge('cloud');
  assert.equal(aliasCloud.text, 'cloud');
  const unknown = mod.formatBadge('something-else');
  assert.equal(unknown.text, 'unknown',
    `unknown decisions must format as unknown; got ${JSON.stringify(unknown)}`);
});
