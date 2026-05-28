// W742 — Gateway Mode tests.
//
// Atomic items pinned (matches the W742 implementation):
//
//   [W742-1] Capture from local Ollama/vLLM instances via KOLM_GATEWAY_MODE.
//   [W742-2] Offline distillation surfaces as `local-*` modes — same chokepoint.
//   [W742-3] Mock gateway for testing without API costs (KOLM_GATEWAY_MODE=mock)
//            short-circuits the billing path; pinned in test #12 below.
//
// Tests:
//   #1  — GATEWAY_MODE_VERSION constant is 'w742-v1'
//   #2  — GATEWAY_MODES frozen array contains exactly the 4 modes
//   #3  — currentMode() defaults to 'cloud' when env unset
//   #4  — currentMode() throws on unknown mode value
//   #5  — mockGatewayCall('echo') returns last user message
//   #6  — mockGatewayCall('reverse') returns reversed string
//   #7  — mockGatewayCall('fixed') with KOLM_MOCK_RESPONSE set
//   #8  — mockGatewayCall token counts deterministic (same input → same output, never NaN)
//   #9  — localOllamaCall returns ollama_not_reachable on closed port
//   #10 — dispatchByMode honest envelope on unknown mode
//   #11 — GET /v1/gateway/mode auth-gated 401 then 200 envelope
//   #12 — /v1/chat/completions with KOLM_GATEWAY_MODE=mock skips billing
//   #13 — public/docs/gateway-mode.html exists with brand-lock + 4-mode table
//   #14 — vercel.json has /docs/gateway-mode rewrite
//   #15 — cli/kolm.js defines cmdW742Gateway exactly once + wired
//   #16 — wave742 sibling test count uses wave(\d{3,4}) regex + threshold

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  GATEWAY_MODE_VERSION,
  GATEWAY_MODES,
  currentMode,
  localOllamaCall,
  localVllmCall,
  mockGatewayCall,
  dispatchByMode,
  probeReachability,
} from '../src/gateway-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'gateway-mode.html');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

// Helper: per-test sandbox so KOLM_DATA_DIR etc. don't leak.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w742-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Ensure no stray gateway-mode env leaks between tests.
  delete process.env.KOLM_GATEWAY_MODE;
  delete process.env.KOLM_MOCK_RESPONSE;
  delete process.env.KOLM_MOCK_KIND;
  delete process.env.KOLM_OLLAMA_URL;
  delete process.env.KOLM_VLLM_URL;
  delete process.env.KOLM_GATEWAY_LOCAL_MODEL;
  return tmp;
}

// =============================================================================
// 1) Version constant
// =============================================================================

test('W742 #1 — GATEWAY_MODE_VERSION is "w742-v1"', () => {
  freshDir();
  assert.equal(GATEWAY_MODE_VERSION, 'w742-v1',
    `expected GATEWAY_MODE_VERSION="w742-v1"; got ${JSON.stringify(GATEWAY_MODE_VERSION)}`);
});

// =============================================================================
// 2) Frozen 4-mode array
// =============================================================================

test('W742 #2 — GATEWAY_MODES is a frozen array of exactly the 4 modes', () => {
  freshDir();
  assert.ok(Array.isArray(GATEWAY_MODES), 'GATEWAY_MODES must be an array');
  assert.equal(GATEWAY_MODES.length, 4,
    `expected exactly 4 modes; got ${GATEWAY_MODES.length}: ${GATEWAY_MODES.join(',')}`);
  for (const m of ['cloud', 'local-ollama', 'local-vllm', 'mock']) {
    assert.ok(GATEWAY_MODES.indexOf(m) >= 0, `GATEWAY_MODES must include "${m}"`);
  }
  // Frozen guard — mutation must throw or be a no-op (strict mode throws).
  assert.ok(Object.isFrozen(GATEWAY_MODES), 'GATEWAY_MODES must be Object.frozen()');
});

// =============================================================================
// 3) currentMode default
// =============================================================================

test('W742 #3 — currentMode() defaults to "cloud" when KOLM_GATEWAY_MODE is unset', () => {
  freshDir();
  // freshDir() already deletes the env var; double-check.
  assert.equal(process.env.KOLM_GATEWAY_MODE, undefined);
  assert.equal(currentMode(), 'cloud', 'unset env must default to cloud');
  // Empty string must also default to cloud (some shells set "").
  process.env.KOLM_GATEWAY_MODE = '';
  assert.equal(currentMode(), 'cloud', 'empty env must default to cloud');
  // Explicit "cloud" works too (case-insensitive).
  process.env.KOLM_GATEWAY_MODE = 'CLOUD';
  assert.equal(currentMode(), 'cloud', 'explicit cloud (case-insensitive) must resolve');
  // Trimmed whitespace.
  process.env.KOLM_GATEWAY_MODE = '  cloud  ';
  assert.equal(currentMode(), 'cloud', 'whitespace must be trimmed');
});

// =============================================================================
// 4) currentMode throws on unknown mode
// =============================================================================

test('W742 #4 — currentMode() throws on unknown mode value (fail loud)', () => {
  freshDir();
  process.env.KOLM_GATEWAY_MODE = 'local-olama'; // typo for local-ollama
  assert.throws(() => currentMode(), (e) => {
    assert.equal(e.code, 'unknown_gateway_mode');
    assert.ok(Array.isArray(e.allowed) && e.allowed.length === 4);
    assert.ok(/local-olama/.test(String(e.message)),
      `error message must echo the bad value; got ${e.message}`);
    return true;
  });
  // Garbage values too.
  process.env.KOLM_GATEWAY_MODE = 'banana';
  assert.throws(() => currentMode(), /unknown KOLM_GATEWAY_MODE/);
});

// =============================================================================
// 5) mockGatewayCall echo
// =============================================================================

test('W742 #5 — mockGatewayCall(\'echo\') returns last user message verbatim', () => {
  freshDir();
  const out = mockGatewayCall({
    messages: [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'hello world' },
    ],
    mockKind: 'echo',
  });
  assert.equal(out.ok, true);
  assert.equal(out.content, 'hello world',
    `echo must return the last user message; got ${JSON.stringify(out.content)}`);
  // Multi-turn — should still find the LAST user message.
  const out2 = mockGatewayCall({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
    mockKind: 'echo',
  });
  assert.equal(out2.content, 'second');
});

// =============================================================================
// 6) mockGatewayCall reverse
// =============================================================================

test('W742 #6 — mockGatewayCall(\'reverse\') returns reversed string', () => {
  freshDir();
  const out = mockGatewayCall({
    messages: [{ role: 'user', content: 'abcd' }],
    mockKind: 'reverse',
  });
  assert.equal(out.ok, true);
  assert.equal(out.content, 'dcba',
    `reverse must reverse the string; got ${JSON.stringify(out.content)}`);
  // Empty string is allowed (last user msg = '') → reversed = ''.
  const out2 = mockGatewayCall({
    messages: [{ role: 'user', content: '' }],
    mockKind: 'reverse',
  });
  assert.equal(out2.ok, true);
  assert.equal(out2.content, '');
});

// =============================================================================
// 7) mockGatewayCall fixed (with KOLM_MOCK_RESPONSE)
// =============================================================================

test('W742 #7 — mockGatewayCall(\'fixed\') returns KOLM_MOCK_RESPONSE env value (or default)', () => {
  freshDir();
  // Default (env unset) → 'mock_response_default'.
  delete process.env.KOLM_MOCK_RESPONSE;
  const def = mockGatewayCall({
    messages: [{ role: 'user', content: 'whatever' }],
    mockKind: 'fixed',
  });
  assert.equal(def.ok, true);
  assert.equal(def.content, 'mock_response_default',
    `unset KOLM_MOCK_RESPONSE must default; got ${JSON.stringify(def.content)}`);
  // Set → returns the env value.
  process.env.KOLM_MOCK_RESPONSE = 'predictable test output';
  const set = mockGatewayCall({
    messages: [{ role: 'user', content: 'whatever' }],
    mockKind: 'fixed',
  });
  assert.equal(set.content, 'predictable test output');
});

// =============================================================================
// 8) Token counts deterministic + never NaN
// =============================================================================

test('W742 #8 — mockGatewayCall token counts are deterministic (same input → same output, never NaN)', () => {
  freshDir();
  const messages = [
    { role: 'user', content: 'hello world! how are you today?' }, // 31 chars → floor(31/4)=7
  ];
  const a = mockGatewayCall({ messages, mockKind: 'echo' });
  const b = mockGatewayCall({ messages, mockKind: 'echo' });
  assert.equal(a.usage.prompt_tokens, b.usage.prompt_tokens, 'usage.prompt_tokens must be deterministic');
  assert.equal(a.usage.completion_tokens, b.usage.completion_tokens, 'usage.completion_tokens must be deterministic');
  assert.equal(a.usage.prompt_tokens, 7, `prompt_tokens must be floor(31/4)=7; got ${a.usage.prompt_tokens}`);
  // Both numbers must be integers, finite, and non-NaN.
  for (const u of [a.usage.prompt_tokens, a.usage.completion_tokens,
                   b.usage.prompt_tokens, b.usage.completion_tokens]) {
    assert.equal(Number.isFinite(u), true, 'usage numbers must be finite');
    assert.equal(Number.isNaN(u), false, 'usage numbers must not be NaN');
    assert.equal(Number.isInteger(u), true, 'usage numbers must be integers');
  }
  // Zero-content message must produce 0 tokens, not NaN.
  const zero = mockGatewayCall({
    messages: [{ role: 'user', content: '' }],
    mockKind: 'echo',
  });
  assert.equal(zero.usage.prompt_tokens, 0);
  assert.equal(zero.usage.completion_tokens, 0);
});

// =============================================================================
// 9) localOllamaCall returns ollama_not_reachable on closed port
// =============================================================================

test('W742 #9 — localOllamaCall returns ollama_not_reachable on a closed port', async () => {
  freshDir();
  // Port 65530 — guaranteed-unbound high port. ECONNREFUSED on every OS.
  const out = await localOllamaCall({
    model: 'qwen2.5:7b',
    messages: [{ role: 'user', content: 'hi' }],
    base_url: 'http://127.0.0.1:65530',
  });
  assert.equal(out.ok, false, `closed port must fail; got ${JSON.stringify(out)}`);
  assert.equal(out.error, 'ollama_not_reachable',
    `error must be ollama_not_reachable; got ${JSON.stringify(out.error)}`);
  assert.ok(typeof out.hint === 'string' && /ollama serve/.test(out.hint),
    `hint must mention 'ollama serve'; got ${JSON.stringify(out.hint)}`);
  assert.equal(out.version, 'w742-v1');
});

// =============================================================================
// 10) dispatchByMode honest envelope on unknown mode
// =============================================================================

test('W742 #10 — dispatchByMode returns honest envelope on unknown / missing mode', async () => {
  freshDir();
  const unk = await dispatchByMode({
    mode: 'banana',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'whatever',
  });
  assert.equal(unk.ok, false);
  assert.equal(unk.error, 'unknown_gateway_mode');
  assert.deepEqual(unk.allowed, ['cloud', 'local-ollama', 'local-vllm', 'mock']);
  assert.equal(unk.version, 'w742-v1');

  // Missing mode entirely.
  const miss = await dispatchByMode({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'whatever',
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'unknown_gateway_mode');

  // Cloud-mode is explicitly NOT dispatched through this entry point.
  const cloud = await dispatchByMode({
    mode: 'cloud',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'whatever',
  });
  assert.equal(cloud.ok, false);
  assert.equal(cloud.error, 'cloud_mode_not_dispatched_here');

  // Mock-mode through dispatchByMode works.
  const mock = await dispatchByMode({
    mode: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'whatever',
    mockKind: 'echo',
  });
  assert.equal(mock.ok, true);
  assert.equal(mock.content, 'hi');
});

// =============================================================================
// 11) GET /v1/gateway/mode auth-gated 401 then 200 envelope
// =============================================================================

test('W742 #11 — GET /v1/gateway/mode is auth-gated (401 then 200)', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

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
    // 11a — no auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/gateway/mode`);
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    // 11b — with auth → 200 + envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/gateway/mode`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.ok(['cloud', 'local-ollama', 'local-vllm', 'mock'].indexOf(body.mode) >= 0,
      `mode must be one of the four; got ${body.mode}`);
    assert.equal(typeof body.ollama_reachable, 'boolean');
    assert.equal(typeof body.vllm_reachable, 'boolean');
    assert.deepEqual(body.allowed, ['cloud', 'local-ollama', 'local-vllm', 'mock']);
    assert.equal(body.version, 'w742-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) /v1/chat/completions with KOLM_GATEWAY_MODE=mock skips billing
// =============================================================================
//
// W742-3 lock — mock mode must NEVER call usageIncrementMeter('hosted_inference', ...).
// We assert two things:
//   (a) The response carries kolm_w742.billed:false.
//   (b) The response content is the deterministic mock echo (i.e. the cloud
//       path was NOT reached — if it had been, we'd see no kolm_w742 stamp
//       and either an upstream-key error or a non-deterministic teacher
//       response).
// We do NOT need to monkey-patch the meter because the route's mock branch
// short-circuits BEFORE __hostedInferenceWrapper (where the meter lives).
// =============================================================================

test('W742 #12 — /v1/chat/completions with KOLM_GATEWAY_MODE=mock skips billing (W742-3 lock)', async () => {
  freshDir();
  process.env.KOLM_GATEWAY_MODE = 'mock';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

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
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    assert.equal(resp.status, 200, `mock mode must succeed with 200; got ${resp.status}`);
    const body = await resp.json();
    // Mock echo: content must equal the input.
    assert.ok(body.choices && body.choices[0] && body.choices[0].message,
      `expected OpenAI-shape envelope; got ${JSON.stringify(body)}`);
    assert.equal(body.choices[0].message.content, 'ping',
      `mock echo must return the input; got ${JSON.stringify(body.choices[0].message.content)}`);
    // W742-3 lock: kolm_w742.billed must be false.
    assert.ok(body.kolm_w742, `mock response must carry kolm_w742 stamp; got ${JSON.stringify(body)}`);
    assert.equal(body.kolm_w742.mode, 'mock');
    assert.equal(body.kolm_w742.billed, false,
      `mock mode must NEVER bill hosted_inference (W742-3 lock); got kolm_w742=${JSON.stringify(body.kolm_w742)}`);
    assert.equal(body.kolm_w742.version, 'w742-v1');
    // Usage is deterministic — 4 chars → 1 token.
    assert.equal(body.usage.prompt_tokens, 1);
    assert.equal(body.usage.completion_tokens, 1);
  } finally {
    delete process.env.KOLM_GATEWAY_MODE;
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 13) /docs/gateway-mode.html exists with brand-lock + 4-mode table
// =============================================================================

test('W742 #13 — /docs/gateway-mode.html exists with brand-lock + 4-mode table', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock
  for (const needle of [
    'Open-source AI workbench',          // eyebrow brand lock
    'Frontier AI on your own infrastructure.', // H1 brand lock
    'kolm.ai',                            // brand
    'class="ks-nav"',                     // nav shell
    'ks-foot',                            // footer shell (W902 unified ks-footer→ks-foot across 642 static pages)
    'KOLM_GATEWAY_MODE',                  // env var
    'kolm gateway',                       // CLI
    '/v1/gateway/mode',                   // API
    '/v1/chat/completions',               // dispatch surface
    'localhost',                          // privacy / local mode
    'kolm_w742',                          // billing-skip stamp
    'w742-v1',                            // version stamp
    'cloud',                              // mode
    'local-ollama',                       // mode
    'local-vllm',                         // mode
    'mock',                               // mode
    'ollama serve',                       // hint
    'vllm',                               // mode mention in body
    'KOLM_MOCK_RESPONSE',                 // mock fixed
    'KOLM_OLLAMA_URL',                    // ollama base
    'KOLM_VLLM_URL',                      // vllm base
  ]) {
    assert.ok(html.includes(needle), `gateway-mode.html must mention "${needle}"`);
  }
  // 4-mode table — count rows in the modes table by counting <td><code>cloud</code></td>-ish lines.
  // We use a forgiving regex so future copy edits don't break the lock.
  for (const m of ['cloud', 'local-ollama', 'local-vllm', 'mock']) {
    const re = new RegExp(`<code>${m}</code>`);
    assert.ok(re.test(html), `gateway-mode.html must wrap mode "${m}" in a <code> tag at least once`);
  }
  // Privacy note is load-bearing for the W742-1 promise.
  assert.ok(/never leaves your network|never sends/i.test(html),
    'gateway-mode.html must call out the privacy property');
});

// =============================================================================
// 14) vercel.json has the /docs/gateway-mode rewrite
// =============================================================================

test('W742 #14 — vercel.json has /docs/gateway-mode rewrite', () => {
  freshDir();
  const txt = fs.readFileSync(VERCEL_PATH, 'utf8');
  assert.ok(/"\/docs\/gateway-mode"/.test(txt),
    'vercel.json must include a /docs/gateway-mode source rewrite');
  assert.ok(/"\/docs\/gateway-mode\.html"/.test(txt),
    'vercel.json must include the /docs/gateway-mode.html destination');
  // Round-trip parse so we know we did not corrupt the JSON.
  const parsed = JSON.parse(txt);
  assert.ok(Array.isArray(parsed.rewrites), 'vercel.json must have a rewrites array');
  const hit = parsed.rewrites.find((r) => r && r.source === '/docs/gateway-mode');
  assert.ok(hit, 'rewrites must include {source:"/docs/gateway-mode", destination:"/docs/gateway-mode.html"}');
  assert.equal(hit.destination, '/docs/gateway-mode.html');
});

// =============================================================================
// 15) cli/kolm.js defines cmdW742Gateway exactly once + wired
// =============================================================================

test('W742 #15 — cli/kolm.js defines cmdW742Gateway exactly once + wired from case \'gateway\'', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW742Gateway\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW742Gateway dispatcher definition; got ${defs.length}`);
  // Routed from `case 'gateway'` arm.
  assert.ok(/case\s+['"]gateway['"]/.test(cli),
    `cli must have a case 'gateway' arm`);
  assert.ok(cli.includes('cmdW742Gateway(rest)'),
    `cmdW742Gateway must be invoked with the rest args`);
  // Honest fallbacks: the gateway_mode_module_missing envelope is load-bearing
  // for the W742-1 promise (the CLI must say "missing" loudly rather than
  // silently falling back to cloud).
  assert.ok(cli.includes('gateway_mode_module_missing'),
    `cmdW742Gateway must emit gateway_mode_module_missing on import failure`);
});

// =============================================================================
// 16) wave742 sibling test count uses wave(\d{3,4}) regex + threshold (W604)
// =============================================================================

test('W742 #16 — wave742 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold — at least 3 wave files MUST exist (W742 + W738 + W741 minimum).
  // Forward-compatible: adding more wave tests does not break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 17) probeReachability — defense-in-depth on the helper used by GET /v1/gateway/mode
// =============================================================================

test('W742 #17 — probeReachability returns {ollama_reachable, vllm_reachable} as booleans', async () => {
  freshDir();
  // Point both at guaranteed-unreachable ports so we deterministically get false.
  const out = await probeReachability({
    ollama_url: 'http://127.0.0.1:65530',
    vllm_url: 'http://127.0.0.1:65531',
  });
  assert.equal(typeof out.ollama_reachable, 'boolean');
  assert.equal(typeof out.vllm_reachable, 'boolean');
  assert.equal(out.ollama_reachable, false, 'closed port must yield false');
  assert.equal(out.vllm_reachable, false, 'closed port must yield false');
});

// =============================================================================
// 18) localVllmCall — vllm_not_reachable on closed port (mirror of #9 for vllm)
// =============================================================================

test('W742 #18 — localVllmCall returns vllm_not_reachable on closed port', async () => {
  freshDir();
  const out = await localVllmCall({
    model: 'Qwen/Qwen2.5-7B-Instruct',
    messages: [{ role: 'user', content: 'hi' }],
    base_url: 'http://127.0.0.1:65530',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'vllm_not_reachable');
  assert.ok(typeof out.hint === 'string' && out.hint.length > 0);
  assert.equal(out.version, 'w742-v1');
});
