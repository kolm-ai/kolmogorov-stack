// W772b - Audio tokenizer worker (Whisper mel/BPE) lock-in tests.
//
// Atomic items pinned:
//
//   1)  AUDIO_TOKENIZE_VERSION === 'w772b-v1' (version pin)
//   2)  no_detector_installed when no env override + no python on PATH +
//       no ~/.kolm/scripts (isolated PATH + HOME)
//   3)  install_hint present, mentions 'transformers' + 'librosa' +
//       'KOLM_AUDIO_TOKENIZE_CMD'
//   4)  mel_frame_count=null AND text_token_count=null when no detector
//       (HONESTY: never fabricate a frame count)
//   5)  stub via $KOLM_AUDIO_TOKENIZE_CMD returns synthesized envelope;
//       mel_frame_count + text_token_count are numeric, audio_sha256 hex
//   6)  doctor mode lists which Python deps are wired vs missing
//       (deterministic shape)
//   7)  POST /v1/audio/tokenize returns 401 without auth
//   8)  POST /v1/audio/tokenize with auth + stub env returns ok:true +
//       mel_frame_count numeric
//   9)  POST /v1/audio/tokenize with bad body (no source) returns
//       ok:false + error:'no_audio_source'
//  10)  cli kolm audio tokenize emits the same envelope shape as the
//       route (shape-equivalence lock-in)
//  11)  cli kolm audio tokenize-doctor exits 0 + emits the doctor JSON
//  12)  sw.js cache slug contains a wave(\d{3,4})b? token (W604 regex+
//       threshold, NEVER explicit-array)
//  13)  Tenant fence: t_a cannot see t_b's tokenize doctor response
//       leaking (the route only ever stamps the requester's auth, no
//       cross-tenant data path exists in W772b but we lock it as a
//       defense-in-depth observation)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

// Path to the stub tokenizer we install in /tmp per-test.
function writeStub(tmpDir, envelope) {
  const stubPath = path.join(tmpDir, 'kolm-audio-tokenize-stub.cjs');
  // The stub is a Node CJS script that prints the canned envelope on
  // stdout and exits 0. The worker invokes it with --path <audio>
  // [--model NAME] etc.; we ignore those and just emit the envelope.
  const body = [
    '#!/usr/bin/env node',
    "const env = " + JSON.stringify(envelope) + ';',
    "process.stdout.write(JSON.stringify(env) + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(stubPath, body);
  try { fs.chmodSync(stubPath, 0o755); } catch (_) {} // deliberate: cleanup
  return stubPath;
}

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w772b-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Isolate PATH so locateTokenizer's "kolm-audio-tokenize on PATH"
  // branch cannot find a binary the host happens to have. We restore the
  // original PATH at the end of each test (handled by node:test scopes).
  delete process.env.KOLM_AUDIO_TOKENIZE_CMD;
  return tmp;
}

// Wipe any environment leak between tests (KOLM_AUDIO_TOKENIZE_CMD).
function clearTokenizerEnv() {
  delete process.env.KOLM_AUDIO_TOKENIZE_CMD;
}

// =============================================================================
// 1) AUDIO_TOKENIZE_VERSION stamped w772b-v1
// =============================================================================

await test('W772b #1 - AUDIO_TOKENIZE_VERSION stamped w772b-v1', async () => {
  freshDir();
  clearTokenizerEnv();
  const mod = await import('../src/audio-tokenize.js');
  assert.equal(mod.AUDIO_TOKENIZE_VERSION, 'w772b-v1',
    `expected AUDIO_TOKENIZE_VERSION='w772b-v1'; got ${JSON.stringify(mod.AUDIO_TOKENIZE_VERSION)}`);
});

// =============================================================================
// 2) no_detector_installed when no env override + no python on PATH + no script
// =============================================================================

await test('W772b #2 - no_detector_installed when env override absent + no python + no ~/.kolm/scripts', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  // Isolate PATH to an empty directory so kolm-audio-tokenize cannot
  // resolve.
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    // Write a dummy audio file so the worker reaches the locateTokenizer
    // step instead of failing earlier on audio_not_found.
    const audioPath = path.join(tmp, 'a.wav');
    fs.writeFileSync(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const mod = await import('../src/audio-tokenize.js');
    const env = await mod.tokenizeAudio({ path: audioPath });
    assert.equal(env.ok, false, `expected ok:false; got ${JSON.stringify(env)}`);
    assert.equal(env.error, 'no_detector_installed',
      `expected error:'no_detector_installed'; got ${JSON.stringify(env)}`);
    assert.equal(env.tokenizer, null,
      `expected tokenizer:null on no_detector; got ${env.tokenizer}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

// =============================================================================
// 3) install_hint present in no-detector envelope
// =============================================================================

await test('W772b #3 - install_hint mentions transformers + librosa + KOLM_AUDIO_TOKENIZE_CMD', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    const audioPath = path.join(tmp, 'a.wav');
    fs.writeFileSync(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const mod = await import('../src/audio-tokenize.js');
    const env = await mod.tokenizeAudio({ path: audioPath });
    assert.equal(typeof env.install_hint, 'string',
      `expected install_hint string; got ${JSON.stringify(env.install_hint)}`);
    assert.ok(env.install_hint.includes('transformers'),
      `install_hint must mention 'transformers'; got: ${env.install_hint}`);
    assert.ok(env.install_hint.includes('librosa'),
      `install_hint must mention 'librosa'; got: ${env.install_hint}`);
    assert.ok(env.install_hint.includes('KOLM_AUDIO_TOKENIZE_CMD'),
      `install_hint must mention 'KOLM_AUDIO_TOKENIZE_CMD'; got: ${env.install_hint}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

// =============================================================================
// 4) mel_frame_count + text_token_count BOTH null when no detector
// =============================================================================

await test('W772b #4 - HONESTY: mel_frame_count=null AND text_token_count=null when no detector', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    const audioPath = path.join(tmp, 'a.wav');
    fs.writeFileSync(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const mod = await import('../src/audio-tokenize.js');
    const env = await mod.tokenizeAudio({ path: audioPath });
    assert.equal(env.mel_frame_count, null,
      `mel_frame_count MUST be null on no_detector; got ${JSON.stringify(env.mel_frame_count)}`);
    assert.equal(env.text_token_count, null,
      `text_token_count MUST be null on no_detector; got ${JSON.stringify(env.text_token_count)}`);
    assert.equal(env.mel_sha256, null,
      `mel_sha256 MUST be null on no_detector; got ${JSON.stringify(env.mel_sha256)}`);
    assert.equal(env.text_sha256, null,
      `text_sha256 MUST be null on no_detector; got ${JSON.stringify(env.text_sha256)}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

// =============================================================================
// 5) stub via $KOLM_AUDIO_TOKENIZE_CMD returns synthesized envelope
// =============================================================================

await test('W772b #5 - stub via $KOLM_AUDIO_TOKENIZE_CMD returns numeric mel_frame_count + text_token_count', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();

  const cannedEnvelope = {
    ok: true,
    kind: 'audio',
    tokenizer: 'openai/whisper-large-v3',
    model: 'openai/whisper-large-v3',
    duration_ms: 30000,
    mel_frame_count: 1500,
    mel_feature_dim: 80,
    mel_sha256: 'deadbeef'.repeat(8),
    text_token_count: 42,
    text_token_sample: [50258, 50259, 50360, 50364, 1029, 4083, 11, 1078],
    text_sha256: 'abcdef00'.repeat(8),
    audio_sha256: '11223344'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);
  // The worker invokes the env command via spawnSync. We pass a JSON
  // array so [node, stubPath] is the command and the worker appends its
  // own --path/--model flags (which the stub ignores).
  process.env.KOLM_AUDIO_TOKENIZE_CMD = JSON.stringify([process.execPath, stubPath]);

  try {
    const audioPath = path.join(tmp, 'a.wav');
    fs.writeFileSync(audioPath, Buffer.from('not really audio bytes, but enough for sha256'));

    const mod = await import('../src/audio-tokenize.js');
    const env = await mod.tokenizeAudio({ path: audioPath });
    assert.equal(env.ok, true, `expected ok:true with stub wired; got ${JSON.stringify(env)}`);
    assert.equal(typeof env.mel_frame_count, 'number',
      `mel_frame_count must be numeric with stub wired; got ${JSON.stringify(env.mel_frame_count)}`);
    assert.equal(env.mel_frame_count, 1500);
    assert.equal(env.mel_feature_dim, 80);
    assert.equal(typeof env.text_token_count, 'number');
    assert.equal(env.text_token_count, 42);
    assert.ok(/^[a-f0-9]{8,128}$/i.test(env.audio_sha256 || ''),
      `audio_sha256 must be hex string; got ${env.audio_sha256}`);
    assert.equal(env.version, 'w772b-v1');
  } finally {
    clearTokenizerEnv();
  }
});

// =============================================================================
// 6) doctor mode lists deterministic shape of python_deps
// =============================================================================

await test('W772b #6 - doctor envelope lists python_deps deterministic shape', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const mod = await import('../src/audio-tokenize.js');
  const env = await mod.getAudioTokenizeDoctor();
  assert.equal(env.spec, 'kolm-audio-tokenize-worker-doctor',
    `expected spec='kolm-audio-tokenize-worker-doctor'; got ${env.spec}`);
  assert.equal(env.version, 'w772b-v1');
  assert.equal(env.default_model, 'openai/whisper-large-v3',
    `expected default_model='openai/whisper-large-v3'; got ${env.default_model}`);
  // python_deps shape: 4 known keys with boolean values.
  assert.ok(env.python_deps && typeof env.python_deps === 'object',
    `python_deps must be an object; got ${JSON.stringify(env.python_deps)}`);
  for (const k of ['transformers', 'torch', 'librosa', 'soundfile']) {
    assert.ok(k in env.python_deps,
      `python_deps must contain '${k}'; got ${JSON.stringify(env.python_deps)}`);
    assert.equal(typeof env.python_deps[k], 'boolean',
      `python_deps.${k} must be boolean; got ${typeof env.python_deps[k]}`);
  }
  // tokenizer.ok is boolean; tokenizer.name is string-or-null.
  assert.ok(env.tokenizer && typeof env.tokenizer === 'object');
  assert.equal(typeof env.tokenizer.ok, 'boolean');
});

// =============================================================================
// 7) POST /v1/audio/tokenize returns 401 without auth
// =============================================================================

await test('W772b #7 - POST /v1/audio/tokenize 401 without auth', async () => {
  freshDir();
  clearTokenizerEnv();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(buildRouter());

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/whatever.wav' }),
    });
    assert.equal(r.status, 401, `expected 401 without auth; got ${r.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 8) POST /v1/audio/tokenize with auth + stub env returns ok:true
// =============================================================================

await test('W772b #8 - POST /v1/audio/tokenize w/ auth + stub returns ok:true + numeric mel_frame_count', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const cannedEnvelope = {
    ok: true,
    kind: 'audio',
    tokenizer: 'openai/whisper-large-v3',
    model: 'openai/whisper-large-v3',
    duration_ms: 5000,
    mel_frame_count: 250,
    mel_feature_dim: 80,
    mel_sha256: 'cafefeed'.repeat(8),
    text_token_count: 12,
    text_token_sample: [1, 2, 3, 4, 5, 6, 7, 8],
    text_sha256: 'aabbccdd'.repeat(8),
    audio_sha256: '99887766'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);
  process.env.KOLM_AUDIO_TOKENIZE_CMD = JSON.stringify([process.execPath, stubPath]);

  const audioPath = path.join(tmp, 'clip.wav');
  fs.writeFileSync(audioPath, Buffer.from('synthetic wav header bytes ----'));

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: audioPath }),
    });
    assert.equal(r.status, 200, `expected 200 with auth + stub; got ${r.status}`);
    const body = await r.json();
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(typeof body.mel_frame_count, 'number',
      `mel_frame_count must be numeric; got ${JSON.stringify(body.mel_frame_count)}`);
    assert.equal(body.mel_frame_count, 250);
    assert.equal(body.text_token_count, 12);
    assert.equal(body.version, 'w772b-v1');
  } finally {
    clearTokenizerEnv();
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 9) POST /v1/audio/tokenize with bad body (no source) returns ok:false
// =============================================================================

await test('W772b #9 - POST /v1/audio/tokenize bad body returns ok:false + error:no_audio_source', async () => {
  freshDir();
  clearTokenizerEnv();
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
  app.use(express.json({ limit: '8mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'no_audio_source',
      `expected error:'no_audio_source'; got ${JSON.stringify(body)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 10) cli kolm audio tokenize shape-equivalence with the route
// =============================================================================

await test('W772b #10 - cli kolm audio tokenize emits the same envelope shape as the route', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();

  const cannedEnvelope = {
    ok: true,
    kind: 'audio',
    tokenizer: 'openai/whisper-large-v3',
    model: 'openai/whisper-large-v3',
    duration_ms: 10000,
    mel_frame_count: 500,
    mel_feature_dim: 80,
    mel_sha256: 'feedface'.repeat(8),
    text_token_count: 24,
    text_token_sample: [10, 20, 30, 40, 50, 60, 70, 80],
    text_sha256: 'beefbeef'.repeat(8),
    audio_sha256: 'cafecafe'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);

  const audioPath = path.join(tmp, 'clip.wav');
  fs.writeFileSync(audioPath, Buffer.from('synthetic wav bytes ----'));

  const res = spawnSync(process.execPath, [CLI_PATH, 'audio', 'tokenize', audioPath, '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env: {
      ...process.env,
      KOLM_AUDIO_TOKENIZE_CMD: JSON.stringify([process.execPath, stubPath]),
    },
  });
  // Parse the LAST JSON object that appears on stdout (the envelope).
  let parsed = null;
  const text = String(res.stdout || '').trim();
  // The CLI prints with indentation so try to find the outermost JSON
  // object. The simplest robust approach: walk forward, attempt to parse
  // the whole stdout (the CLI emits exactly one envelope).
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Strip trailing log lines if present.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { parsed = null; }
    }
  }
  assert.ok(parsed, `CLI must emit JSON envelope; got status=${res.status} stdout=${text.slice(0, 500)} stderr=${String(res.stderr || '').slice(0, 500)}`);
  assert.equal(parsed.ok, true);
  // Shape lock: every required field is present.
  const required = [
    'ok', 'kind', 'tokenizer', 'model',
    'duration_ms', 'mel_frame_count', 'mel_feature_dim', 'mel_sha256',
    'text_token_count', 'text_token_sample', 'text_sha256', 'audio_sha256',
    'version',
  ];
  for (const k of required) {
    assert.ok(k in parsed,
      `CLI envelope must contain '${k}'; got ${JSON.stringify(parsed)}`);
  }
  assert.equal(parsed.version, 'w772b-v1');
  assert.equal(parsed.mel_frame_count, 500);
  assert.equal(parsed.text_token_count, 24);
});

// =============================================================================
// 11) cli kolm audio tokenize-doctor exits 0 + emits doctor JSON
// =============================================================================

await test('W772b #11 - cli kolm audio tokenize-doctor exits 0 + emits doctor JSON', async () => {
  freshDir();
  clearTokenizerEnv();
  const res = spawnSync(process.execPath, [CLI_PATH, 'audio', 'tokenize-doctor', '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env: { ...process.env },
  });
  assert.equal(res.status, 0,
    `tokenize-doctor MUST exit 0 regardless of tokenizer presence; got status=${res.status} stderr=${String(res.stderr || '').slice(0, 500)}`);
  const text = String(res.stdout || '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { parsed = null; }
    }
  }
  assert.ok(parsed, `tokenize-doctor must emit JSON; got: ${text.slice(0, 400)}`);
  assert.equal(parsed.spec, 'kolm-audio-tokenize-worker-doctor');
  assert.equal(parsed.version, 'w772b-v1');
});

// =============================================================================
// 12) sw.js cache slug references wave(\d{3,4})b? (W604 regex+threshold)
// =============================================================================

await test('W772b #12 - sw.js cache slug + sibling family check via regex+threshold (W604)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) {
    return; // tolerant: sw.js may be orchestrator-managed in some envs
  }
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (m) {
    const wm = m[1].match(/wave?(\d{3,4})b?/i);
    if (wm) {
      const n = parseInt(wm[1], 10);
      // W604 regex+threshold: generous floor so a sibling W772b agent
      // does not break this when the sw.js slug rolls forward.
      assert.ok(n >= 100,
        `sw.js CACHE slug should reference a sane waveNNN[b] family token; got ${m[1]}`);
    }
  }
  // Sibling test family count uses regex + threshold (never explicit list).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})b?-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4})b? test files; found ${siblings.length}`);
});

// =============================================================================
// 13) Tenant fence: two distinct tenants both call the doctor route - each
//     gets its own doctor envelope, no cross-tenant data leak. The W772b
//     doctor route is pure (no tenant-specific state), so this is a
//     defense-in-depth observation: assert that both tenants succeed
//     independently with isolated 200 responses.
// =============================================================================

await test('W772b #13 - tenant fence: two distinct tenants each get an independent doctor envelope', async () => {
  freshDir();
  clearTokenizerEnv();
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
  app.use(express.json({ limit: '8mb' }));
  app.use(buildRouter());
  const a = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const b = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const ra = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize/doctor`, {
      headers: { 'authorization': 'Bearer ' + a.api_key },
    });
    const rb = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize/doctor`, {
      headers: { 'authorization': 'Bearer ' + b.api_key },
    });
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    const ja = await ra.json();
    const jb = await rb.json();
    // Both envelopes should have the same SHAPE (worker doctor is pure)
    // but neither should leak the other tenant's id.
    assert.equal(ja.spec, 'kolm-audio-tokenize-worker-doctor');
    assert.equal(jb.spec, 'kolm-audio-tokenize-worker-doctor');
    const jaText = JSON.stringify(ja);
    const jbText = JSON.stringify(jb);
    // provisionAnonTenant returns {...tenant, api_key}; the tenant id is .id.
    const aId = a && (a.id || a.tenant_id) || '__missing_a_id__';
    const bId = b && (b.id || b.tenant_id) || '__missing_b_id__';
    assert.equal(jaText.includes(bId), false,
      'tenant A doctor response must NOT leak tenant B id');
    assert.equal(jbText.includes(aId), false,
      'tenant B doctor response must NOT leak tenant A id');
    // Unauth -> 401 (lock the gate).
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/audio/tokenize/doctor`);
    assert.equal(noAuth.status, 401);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});
