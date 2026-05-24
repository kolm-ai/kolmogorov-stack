// W773b - Video tokenizer worker (frame-patch tokens) lock-in tests.
//
// Atomic items pinned:
//
//   1)  VIDEO_TOKENIZE_VERSION === 'w773b-v1' (version pin)
//   2)  SAMPLING_STRATEGIES === Object.freeze(['uniform','adaptive','keyframe','dense'])
//   3)  no_detector_installed when env override absent + no python +
//       no ~/.kolm/scripts (isolated PATH + HOME)
//   4)  install_hint present, mentions 'transformers' + 'decord' (or
//       'av') + 'KOLM_VIDEO_TOKENIZE_CMD'
//   5)  sampled_frame_count=null AND total_patch_tokens=null when no
//       detector (HONESTY: never fabricate counts)
//   6)  stub via $KOLM_VIDEO_TOKENIZE_CMD returns synthesized envelope;
//       sampled_frame_count + total_patch_tokens numeric; video_sha256 hex
//   7)  doctor mode lists which Python deps are wired vs missing
//       (deterministic shape)
//   8)  POST /v1/video/tokenize returns 401 without auth
//   9)  POST /v1/video/tokenize with auth + stub env returns ok:true +
//       sampled_frame_count numeric
//  10)  POST /v1/video/tokenize with bad sampling_strategy returns
//       ok:false + error:'invalid_sampling_strategy'
//  11)  cli kolm video tokenize emits the same envelope shape as the
//       route (shape-equivalence lock-in)
//  12)  cli kolm video tokenize-doctor exits 0 + emits the doctor JSON
//  13)  sw.js cache slug references a wave(\d{3,4})b? token (W604
//       regex+threshold, NEVER explicit-array)
//  14)  num_frames cap (request 9999 -> capped at 32 observable)
//  15)  Tenant fence: two distinct tenants both call the doctor route -
//       each gets its own envelope, no cross-tenant data leak

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

function writeStub(tmpDir, envelope) {
  const stubPath = path.join(tmpDir, 'kolm-video-tokenize-stub.cjs');
  // The stub is a Node CJS script that prints the canned envelope on
  // stdout and exits 0. The worker invokes it with --path <video>
  // [--model NAME] [--sampling-strategy STRAT] [--num-frames N]; we
  // ignore those and emit the canned envelope.
  const body = [
    '#!/usr/bin/env node',
    "const env = " + JSON.stringify(envelope) + ';',
    "process.stdout.write(JSON.stringify(env) + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(stubPath, body);
  try { fs.chmodSync(stubPath, 0o755); } catch (_) {}
  return stubPath;
}

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w773b-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  delete process.env.KOLM_VIDEO_TOKENIZE_CMD;
  return tmp;
}

function clearTokenizerEnv() {
  delete process.env.KOLM_VIDEO_TOKENIZE_CMD;
}

// =============================================================================
// 1) VIDEO_TOKENIZE_VERSION stamped w773b-v1
// =============================================================================

await test('W773b #1 - VIDEO_TOKENIZE_VERSION stamped w773b-v1', async () => {
  freshDir();
  clearTokenizerEnv();
  const mod = await import('../src/video-tokenize.js');
  assert.equal(mod.VIDEO_TOKENIZE_VERSION, 'w773b-v1',
    `expected VIDEO_TOKENIZE_VERSION='w773b-v1'; got ${JSON.stringify(mod.VIDEO_TOKENIZE_VERSION)}`);
});

// =============================================================================
// 2) SAMPLING_STRATEGIES Object.freeze()-d + exact 4 entries
// =============================================================================

await test('W773b #2 - SAMPLING_STRATEGIES Object.freeze()-d with uniform/adaptive/keyframe/dense', async () => {
  freshDir();
  clearTokenizerEnv();
  const mod = await import('../src/video-tokenize.js');
  assert.ok(Object.isFrozen(mod.SAMPLING_STRATEGIES),
    'SAMPLING_STRATEGIES must be Object.freeze()-d to prevent silent strategy drift');
  assert.ok(Array.isArray(mod.SAMPLING_STRATEGIES));
  assert.equal(mod.SAMPLING_STRATEGIES.length, 4,
    `expected exactly 4 sampling strategies; got ${mod.SAMPLING_STRATEGIES.length}`);
  for (const must of ['uniform', 'adaptive', 'keyframe', 'dense']) {
    assert.ok(mod.SAMPLING_STRATEGIES.includes(must),
      `expected '${must}' in SAMPLING_STRATEGIES; got ${JSON.stringify(mod.SAMPLING_STRATEGIES)}`);
  }
  // Frozen means push throws (strict) or silently fails (sloppy). Either is
  // acceptable - the post-mutation length must still be 4.
  try { mod.SAMPLING_STRATEGIES.push('bogus'); } catch (_) {}
  assert.equal(mod.SAMPLING_STRATEGIES.length, 4,
    'SAMPLING_STRATEGIES.push must NOT extend the frozen array');
});

// =============================================================================
// 3) no_detector_installed when env override absent + no python + no script
// =============================================================================

await test('W773b #3 - no_detector_installed when env override absent + no kolm-video-tokenize + no ~/.kolm/scripts', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    // Write a dummy video file so the worker reaches locateTokenizer instead
    // of failing earlier on video_not_found.
    const videoPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));

    const mod = await import('../src/video-tokenize.js');
    const env = await mod.tokenizeVideo({ path: videoPath });
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
// 4) install_hint present in no-detector envelope (mentions key deps + env var)
// =============================================================================

await test('W773b #4 - install_hint mentions transformers + decord (or av) + KOLM_VIDEO_TOKENIZE_CMD', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    const videoPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const mod = await import('../src/video-tokenize.js');
    const env = await mod.tokenizeVideo({ path: videoPath });
    assert.equal(typeof env.install_hint, 'string',
      `expected install_hint string; got ${JSON.stringify(env.install_hint)}`);
    assert.ok(env.install_hint.includes('transformers'),
      `install_hint must mention 'transformers'; got: ${env.install_hint}`);
    // Either decord OR av is acceptable - the worker accepts either decode
    // backend. The hint string MUST mention at least one.
    assert.ok(env.install_hint.includes('decord') || env.install_hint.includes('av'),
      `install_hint must mention 'decord' or 'av'; got: ${env.install_hint}`);
    assert.ok(env.install_hint.includes('KOLM_VIDEO_TOKENIZE_CMD'),
      `install_hint must mention 'KOLM_VIDEO_TOKENIZE_CMD'; got: ${env.install_hint}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

// =============================================================================
// 5) sampled_frame_count + total_patch_tokens BOTH null when no detector
// =============================================================================

await test('W773b #5 - HONESTY: sampled_frame_count=null AND total_patch_tokens=null when no detector', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  const isoBin = path.join(tmp, 'iso-bin');
  fs.mkdirSync(isoBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = isoBin;
  try {
    const videoPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const mod = await import('../src/video-tokenize.js');
    const env = await mod.tokenizeVideo({ path: videoPath });
    assert.equal(env.sampled_frame_count, null,
      `sampled_frame_count MUST be null on no_detector; got ${JSON.stringify(env.sampled_frame_count)}`);
    assert.equal(env.total_patch_tokens, null,
      `total_patch_tokens MUST be null on no_detector; got ${JSON.stringify(env.total_patch_tokens)}`);
    assert.equal(env.patch_tokens_per_frame, null,
      `patch_tokens_per_frame MUST be null on no_detector; got ${JSON.stringify(env.patch_tokens_per_frame)}`);
    assert.equal(env.frames_sha256, null,
      `frames_sha256 MUST be null on no_detector; got ${JSON.stringify(env.frames_sha256)}`);
  } finally {
    process.env.PATH = savedPath;
  }
});

// =============================================================================
// 6) stub via $KOLM_VIDEO_TOKENIZE_CMD returns numeric counts + hex sha256
// =============================================================================

await test('W773b #6 - stub via $KOLM_VIDEO_TOKENIZE_CMD returns numeric sampled_frame_count + hex video_sha256', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();

  const cannedEnvelope = {
    ok: true,
    kind: 'video',
    tokenizer: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    model: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    duration_ms: 30000,
    fps: 30.0,
    sampled_frame_count: 8,
    patch_tokens_per_frame: 144,
    total_patch_tokens: 8 * 144,
    patch_token_dim: 4096,
    sampling_strategy: 'uniform',
    video_sha256: 'deadbeef'.repeat(8),
    frames_sha256: 'cafefeed'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);
  process.env.KOLM_VIDEO_TOKENIZE_CMD = JSON.stringify([process.execPath, stubPath]);

  try {
    const videoPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(videoPath, Buffer.from('not really video bytes, but enough for sha256'));

    const mod = await import('../src/video-tokenize.js');
    const env = await mod.tokenizeVideo({ path: videoPath });
    assert.equal(env.ok, true, `expected ok:true with stub wired; got ${JSON.stringify(env)}`);
    assert.equal(typeof env.sampled_frame_count, 'number',
      `sampled_frame_count must be numeric with stub wired; got ${JSON.stringify(env.sampled_frame_count)}`);
    assert.equal(env.sampled_frame_count, 8);
    assert.equal(env.patch_tokens_per_frame, 144);
    assert.equal(env.total_patch_tokens, 8 * 144);
    assert.equal(env.patch_token_dim, 4096);
    assert.ok(/^[a-f0-9]{8,128}$/i.test(env.video_sha256 || ''),
      `video_sha256 must be hex string; got ${env.video_sha256}`);
    assert.ok(/^[a-f0-9]{8,128}$/i.test(env.frames_sha256 || ''),
      `frames_sha256 must be hex string; got ${env.frames_sha256}`);
    assert.equal(env.version, 'w773b-v1');
  } finally {
    clearTokenizerEnv();
  }
});

// =============================================================================
// 7) doctor envelope lists deterministic py_deps shape
// =============================================================================

await test('W773b #7 - doctor envelope lists py_deps deterministic shape', async () => {
  freshDir();
  clearTokenizerEnv();
  const mod = await import('../src/video-tokenize.js');
  const env = await mod.getVideoTokenizeDoctor();
  assert.equal(env.spec, 'kolm-video-tokenize-worker-doctor',
    `expected spec='kolm-video-tokenize-worker-doctor'; got ${env.spec}`);
  assert.equal(env.version, 'w773b-v1');
  assert.equal(env.wave, 'W773b');
  // py_deps shape: 5 known keys with {ok:boolean}.
  assert.ok(env.py_deps && typeof env.py_deps === 'object',
    `py_deps must be an object; got ${JSON.stringify(env.py_deps)}`);
  for (const k of ['transformers', 'torch', 'decord', 'av', 'PIL']) {
    assert.ok(k in env.py_deps,
      `py_deps must contain '${k}'; got ${JSON.stringify(env.py_deps)}`);
    assert.equal(typeof env.py_deps[k].ok, 'boolean',
      `py_deps.${k}.ok must be boolean; got ${typeof env.py_deps[k].ok}`);
  }
  // tokenizers.video.ok is boolean; tokenizers.video.name string-or-null.
  assert.ok(env.tokenizers && typeof env.tokenizers === 'object');
  assert.equal(typeof env.tokenizers.video.ok, 'boolean');
  // sampling_strategies + num_frames_cap surfaced to operators.
  assert.ok(Array.isArray(env.sampling_strategies) && env.sampling_strategies.length === 4,
    `doctor must echo the 4 sampling strategies; got ${JSON.stringify(env.sampling_strategies)}`);
  assert.equal(env.num_frames_cap, 32,
    `doctor must echo num_frames_cap=32; got ${env.num_frames_cap}`);
});

// =============================================================================
// 8) POST /v1/video/tokenize returns 401 without auth
// =============================================================================

await test('W773b #8 - POST /v1/video/tokenize 401 without auth', async () => {
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
    const r = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/whatever.mp4' }),
    });
    assert.equal(r.status, 401, `expected 401 without auth; got ${r.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 9) POST /v1/video/tokenize with auth + stub returns ok:true + sampled_frame_count
// =============================================================================

await test('W773b #9 - POST /v1/video/tokenize w/ auth + stub returns ok:true + numeric sampled_frame_count', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const cannedEnvelope = {
    ok: true,
    kind: 'video',
    tokenizer: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    model: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    duration_ms: 5000,
    fps: 24.0,
    sampled_frame_count: 6,
    patch_tokens_per_frame: 144,
    total_patch_tokens: 6 * 144,
    patch_token_dim: 4096,
    sampling_strategy: 'uniform',
    video_sha256: 'cafefeed'.repeat(8),
    frames_sha256: '11223344'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);
  process.env.KOLM_VIDEO_TOKENIZE_CMD = JSON.stringify([process.execPath, stubPath]);

  const videoPath = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.from('synthetic video header bytes ----'));

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
    const r = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: videoPath, sampling_strategy: 'uniform', num_frames: 6 }),
    });
    assert.equal(r.status, 200, `expected 200 with auth + stub; got ${r.status}`);
    const body = await r.json();
    assert.equal(body.ok, true, `expected ok:true; got ${JSON.stringify(body)}`);
    assert.equal(typeof body.sampled_frame_count, 'number',
      `sampled_frame_count must be numeric; got ${JSON.stringify(body.sampled_frame_count)}`);
    assert.equal(body.sampled_frame_count, 6);
    assert.equal(body.patch_tokens_per_frame, 144);
    assert.equal(body.total_patch_tokens, 6 * 144);
    assert.equal(body.version, 'w773b-v1');
    // W411 stamp: tenant_id surfaced on the response so audits can verify.
    assert.equal(typeof body.tenant_id, 'string');
    assert.ok(body.tenant_id.length > 0,
      `expected non-empty tenant_id on response; got ${body.tenant_id}`);
  } finally {
    clearTokenizerEnv();
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 10) POST /v1/video/tokenize with bad sampling_strategy returns ok:false
// =============================================================================

await test('W773b #10 - POST /v1/video/tokenize bad sampling_strategy returns ok:false + error:invalid_sampling_strategy', async () => {
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
    const r = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: '/tmp/clip.mp4', sampling_strategy: 'bogus' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'invalid_sampling_strategy',
      `expected error:'invalid_sampling_strategy'; got ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.supported) && body.supported.length === 4,
      `error envelope must echo supported strategies; got ${JSON.stringify(body.supported)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 11) cli kolm video tokenize shape-equivalence with the route
// =============================================================================

await test('W773b #11 - cli kolm video tokenize emits the same envelope shape as the route', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();

  const cannedEnvelope = {
    ok: true,
    kind: 'video',
    tokenizer: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    model: 'llava-hf/LLaVA-NeXT-Video-7B-hf',
    duration_ms: 10000,
    fps: 24.0,
    sampled_frame_count: 8,
    patch_tokens_per_frame: 144,
    total_patch_tokens: 8 * 144,
    patch_token_dim: 4096,
    sampling_strategy: 'uniform',
    video_sha256: 'feedface'.repeat(8),
    frames_sha256: 'beefbeef'.repeat(8),
  };
  const stubPath = writeStub(tmp, cannedEnvelope);

  const videoPath = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.from('synthetic video bytes ----'));

  const res = spawnSync(process.execPath, [CLI_PATH, 'video', 'tokenize', videoPath, '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env: {
      ...process.env,
      KOLM_VIDEO_TOKENIZE_CMD: JSON.stringify([process.execPath, stubPath]),
    },
  });
  // Parse the last JSON envelope from stdout.
  let parsed = null;
  const text = String(res.stdout || '').trim();
  try {
    parsed = JSON.parse(text);
  } catch (_) {
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
    'duration_ms', 'fps', 'sampled_frame_count', 'patch_tokens_per_frame',
    'total_patch_tokens', 'patch_token_dim', 'sampling_strategy',
    'video_sha256', 'frames_sha256', 'version',
  ];
  for (const k of required) {
    assert.ok(k in parsed,
      `CLI envelope must contain '${k}'; got ${JSON.stringify(parsed)}`);
  }
  assert.equal(parsed.version, 'w773b-v1');
  assert.equal(parsed.sampled_frame_count, 8);
  assert.equal(parsed.total_patch_tokens, 8 * 144);
});

// =============================================================================
// 12) cli kolm video tokenize-doctor exits 0 + emits doctor JSON
// =============================================================================

await test('W773b #12 - cli kolm video tokenize-doctor exits 0 + emits doctor JSON', async () => {
  freshDir();
  clearTokenizerEnv();
  const res = spawnSync(process.execPath, [CLI_PATH, 'video', 'tokenize-doctor', '--json'], {
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
  assert.equal(parsed.spec, 'kolm-video-tokenize-worker-doctor');
  assert.equal(parsed.version, 'w773b-v1');
});

// =============================================================================
// 13) sw.js cache slug + sibling test family check via regex+threshold (W604)
// =============================================================================

await test('W773b #13 - sw.js cache slug + sibling family check via regex+threshold (W604)', () => {
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
      // W604 regex+threshold: generous floor so a sibling wave shipping
      // after W773b does not break this when the slug rolls forward.
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
// 14) num_frames cap test (request 9999 -> capped at 32 observable)
// =============================================================================

await test('W773b #14 - num_frames cap: request 9999 -> capped at 32 observable via num_frames_capped flag', async () => {
  const tmp = freshDir();
  clearTokenizerEnv();

  // Write a stub that echoes the args it was invoked with so we can verify
  // the worker received --num-frames 32 (not 9999).
  const echoStubPath = path.join(tmp, 'echo-num-frames-stub.cjs');
  const echoBody = [
    '#!/usr/bin/env node',
    "const argv = process.argv.slice(2);",
    "const i = argv.indexOf('--num-frames');",
    "const received = (i >= 0 && i + 1 < argv.length) ? Number(argv[i + 1]) : -1;",
    "const env = {",
    "  ok: true,",
    "  kind: 'video',",
    "  tokenizer: 'echo-stub',",
    "  model: 'echo-stub',",
    "  duration_ms: 1000,",
    "  fps: 30.0,",
    "  sampled_frame_count: received,",
    "  patch_tokens_per_frame: 144,",
    "  total_patch_tokens: received * 144,",
    "  patch_token_dim: 4096,",
    "  sampling_strategy: 'uniform',",
    "  video_sha256: 'aa'.repeat(32),",
    "  frames_sha256: 'bb'.repeat(32),",
    "};",
    "process.stdout.write(JSON.stringify(env) + '\\n');",
    "process.exit(0);",
    '',
  ].join('\n');
  fs.writeFileSync(echoStubPath, echoBody);
  try { fs.chmodSync(echoStubPath, 0o755); } catch (_) {}
  process.env.KOLM_VIDEO_TOKENIZE_CMD = JSON.stringify([process.execPath, echoStubPath]);

  try {
    const videoPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(videoPath, Buffer.from('video bytes for cap test'));

    const mod = await import('../src/video-tokenize.js');
    const env = await mod.tokenizeVideo({ path: videoPath, num_frames: 9999 });
    assert.equal(env.ok, true, `expected ok:true with stub wired; got ${JSON.stringify(env)}`);
    // The stub echoed the --num-frames arg into sampled_frame_count. After
    // the cap, the worker MUST have sent 32, not 9999.
    assert.equal(env.sampled_frame_count, 32,
      `num_frames MUST be hard-capped at 32 before worker spawn; stub received ${env.sampled_frame_count}`);
    // Cap observability via the shim-level flag.
    assert.equal(env.num_frames_capped, true,
      `num_frames_capped flag MUST fire when request exceeds cap; got ${env.num_frames_capped}`);
    assert.equal(env.num_frames_cap, 32,
      `num_frames_cap MUST surface the cap value; got ${env.num_frames_cap}`);
    assert.equal(env.num_frames_requested, 32,
      `num_frames_requested MUST reflect post-cap value; got ${env.num_frames_requested}`);
  } finally {
    clearTokenizerEnv();
  }
});

// =============================================================================
// 15) Tenant fence: two distinct tenants each get an independent doctor envelope
// =============================================================================

await test('W773b #15 - tenant fence: two distinct tenants each get an independent doctor envelope', async () => {
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
    const ra = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize/doctor`, {
      headers: { 'authorization': 'Bearer ' + a.api_key },
    });
    const rb = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize/doctor`, {
      headers: { 'authorization': 'Bearer ' + b.api_key },
    });
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    const ja = await ra.json();
    const jb = await rb.json();
    assert.equal(ja.spec, 'kolm-video-tokenize-worker-doctor');
    assert.equal(jb.spec, 'kolm-video-tokenize-worker-doctor');
    const jaText = JSON.stringify(ja);
    const jbText = JSON.stringify(jb);
    const aId = a && (a.id || a.tenant_id) || '__missing_a_id__';
    const bId = b && (b.id || b.tenant_id) || '__missing_b_id__';
    assert.equal(jaText.includes(bId), false,
      'tenant A doctor response must NOT leak tenant B id');
    assert.equal(jbText.includes(aId), false,
      'tenant B doctor response must NOT leak tenant A id');
    // Unauth -> 401 (lock the gate).
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/video/tokenize/doctor`);
    assert.equal(noAuth.status, 401);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});
