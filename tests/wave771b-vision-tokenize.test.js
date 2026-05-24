// W771b -- VLM tokenizer worker (CLIP/SigLIP patches).
//
// W771 shipped the VLM capture + bake-off + trainer SCAFFOLDING. The
// trainer (apps/trainer/vlm_distill.py) is stdlib-only --dry-run and
// never actually tokenizes images into patch embeddings.
//
// W771b ships the REAL tokenizer as an opt-in worker, modeled exactly
// on the W462 (workers/multimodal-redact-image) + W464 (workers/
// multimodal-redact-audio) pattern: heavy ML deps live OUTSIDE Node in
// an opt-in Python process; root kolm install stays light. When the
// Python toolchain or the requested CLIPProcessor model is not on
// disk the worker returns an honest no_detector_installed envelope --
// it NEVER silently invents patch_token_count.
//
// Atomic items pinned:
//
//   1)  VISION_TOKENIZE_VERSION === 'w771b-v1'
//   2)  no_detector_installed envelope when env override absent + no
//       python on PATH + no ~/.kolm/scripts/vision-tokenize.py present
//   3)  install_hint present in no-detector envelope, mentions
//       'transformers' AND 'torch' AND 'KOLM_VISION_TOKENIZE_CMD'
//   4)  tokens=null when no_detector (HONESTY: never fabricate counts)
//   5)  stub via $KOLM_VISION_TOKENIZE_CMD returns synthesized envelope
//       with numeric patch_token_count + hex image_sha256
//   6)  doctor mode lists which Python deps are wired vs missing
//       (deterministic shape)
//   7)  POST /v1/vlm/tokenize 401 without auth
//   8)  POST /v1/vlm/tokenize with auth + stub env returns ok:true +
//       numeric patch_token_count
//   9)  POST /v1/vlm/tokenize with bad body (no source) returns
//       ok:false + error:'no_image_source'
//  10)  cli `kolm vlm tokenize` emits the same envelope shape as the
//       route (shape-equivalence lock-in)
//  11)  cli `kolm vlm tokenize-doctor` exits 0 + emits the doctor JSON
//  12)  sw.js cache slug references the W604+/W771+ family (regex +
//       threshold, NEVER explicit-array)
//  13)  cross-tenant POST /v1/vlm/tokenize: each tenant's request runs
//       in isolation and sees its own envelope (tenant-fence sanity)
//  14)  package.json shape: name, type, main, bin, external.processors
//       documents transformers/torch/Pillow
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(REPO_ROOT, 'workers', 'vision-tokenize', 'tokenize.mjs');
const SHIM_PATH = path.join(REPO_ROOT, 'src', 'vision-tokenize.js');
const PKG_PATH = path.join(REPO_ROOT, 'workers', 'vision-tokenize', 'package.json');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w771b-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// Isolate the environment so probe scans cannot reach the real
// host's python3 / ~/.kolm/scripts. Strips PATH so whichSync misses
// kolm-vision-tokenize + python3. Returns a restore() fn.
function isolateNoDetectorEnv() {
  const tmp = freshDir();
  const saved = {
    PATH: process.env.PATH,
    KOLM_VISION_TOKENIZE_CMD: process.env.KOLM_VISION_TOKENIZE_CMD,
  };
  process.env.PATH = '';
  delete process.env.KOLM_VISION_TOKENIZE_CMD;
  return {
    tmp,
    restore() {
      if (saved.PATH != null) process.env.PATH = saved.PATH; else delete process.env.PATH;
      if (saved.KOLM_VISION_TOKENIZE_CMD != null) {
        process.env.KOLM_VISION_TOKENIZE_CMD = saved.KOLM_VISION_TOKENIZE_CMD;
      } else {
        delete process.env.KOLM_VISION_TOKENIZE_CMD;
      }
    },
  };
}

// Write a Node-based stub tokenizer to disk and point
// $KOLM_VISION_TOKENIZE_CMD at it via a JSON array.
function installStubTokenizer(tmpDir, opts = {}) {
  const stubPath = path.join(tmpDir, 'stub-vision-tokenize.mjs');
  // Reads --path, computes a deterministic envelope, prints it.
  const src = `
import fs from 'node:fs';
import crypto from 'node:crypto';
import process from 'node:process';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf('--' + name);
  return (i >= 0 && i + 1 < args.length) ? args[i + 1] : null;
}
const p = flag('path');
const model = flag('model') || 'openai/clip-vit-large-patch14';
let buf = null;
try { buf = fs.readFileSync(p); } catch (_) { buf = Buffer.from([]); }
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const env = {
  ok: true,
  kind: 'vision',
  model,
  patch_token_count: ${opts.patch_token_count || 256},
  patch_token_dim: ${opts.patch_token_dim || 1024},
  cls_token_present: true,
  patches_sha256: sha,
};
process.stdout.write(JSON.stringify(env) + '\\n');
process.exit(0);
`;
  fs.writeFileSync(stubPath, src, 'utf8');
  // Point env at [node, stubPath].
  process.env.KOLM_VISION_TOKENIZE_CMD = JSON.stringify([process.execPath, stubPath]);
  return stubPath;
}

// =============================================================================
// 1) VISION_TOKENIZE_VERSION
// =============================================================================

test('W771b #1 - VISION_TOKENIZE_VERSION === "w771b-v1"', async () => {
  freshDir();
  const mod = await import('../src/vision-tokenize.js?w771b1=' + Date.now());
  assert.equal(mod.VISION_TOKENIZE_VERSION, 'w771b-v1',
    `expected VISION_TOKENIZE_VERSION='w771b-v1'; got ${JSON.stringify(mod.VISION_TOKENIZE_VERSION)}`);
});

// =============================================================================
// 2) no_detector_installed envelope when nothing is wired
// =============================================================================

test('W771b #2 - worker returns no_detector_installed when env override + python + ~/.kolm/scripts are all absent', () => {
  const ctx = isolateNoDetectorEnv();
  try {
    // Write a tiny "image" file so the worker reaches the dep-probe path.
    const imgPath = path.join(ctx.tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    const r = spawnSync(process.execPath, [WORKER_PATH, '--path', imgPath, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * 1000,
      env: { ...process.env },
    });
    assert.equal(r.status, 3,
      `worker MUST exit 3 when no tokenizer wired; got status=${r.status} stderr=${String(r.stderr || '').slice(0, 400)}`);
    const env = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    assert.equal(env.ok, false);
    assert.equal(env.error, 'no_detector_installed',
      `expected error:'no_detector_installed'; got ${JSON.stringify(env)}`);
  } finally {
    ctx.restore();
  }
});

// =============================================================================
// 3) install_hint mentions transformers + torch + KOLM_VISION_TOKENIZE_CMD
// =============================================================================

test('W771b #3 - no-detector envelope install_hint mentions transformers + torch + KOLM_VISION_TOKENIZE_CMD', () => {
  const ctx = isolateNoDetectorEnv();
  try {
    const imgPath = path.join(ctx.tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const r = spawnSync(process.execPath, [WORKER_PATH, '--path', imgPath, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * 1000,
      env: { ...process.env },
    });
    const env = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    assert.equal(typeof env.install_hint, 'string',
      `install_hint must be a string; got ${typeof env.install_hint}`);
    assert.ok(env.install_hint.length > 0, 'install_hint must be non-empty');
    assert.ok(/transformers/.test(env.install_hint),
      `install_hint must mention 'transformers'; got: ${env.install_hint}`);
    assert.ok(/torch/.test(env.install_hint),
      `install_hint must mention 'torch'; got: ${env.install_hint}`);
    assert.ok(/KOLM_VISION_TOKENIZE_CMD/.test(env.install_hint),
      `install_hint must mention 'KOLM_VISION_TOKENIZE_CMD'; got: ${env.install_hint}`);
  } finally {
    ctx.restore();
  }
});

// =============================================================================
// 4) tokens=null + patch_token_count=null when no_detector (HONESTY)
// =============================================================================

test('W771b #4 - no_detector envelope sets patch_token_count=null (HONESTY: never fabricate)', async () => {
  const ctx = isolateNoDetectorEnv();
  try {
    // Direct module path -- the shim must propagate the worker envelope.
    const mod = await import('../src/vision-tokenize.js?w771b4=' + Date.now());
    const imgPath = path.join(ctx.tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const env = await mod.tokenizeImage({ path: imgPath });
    assert.equal(env.ok, false, `expected ok:false; got ${JSON.stringify(env)}`);
    assert.equal(env.patch_token_count, null,
      `HONESTY: patch_token_count MUST be null when no detector wired; got ${env.patch_token_count}`);
    assert.equal(env.patch_token_dim, null,
      `patch_token_dim MUST be null when no detector wired; got ${env.patch_token_dim}`);
    assert.equal(env.cls_token_present, null,
      `cls_token_present MUST be null when no detector wired; got ${env.cls_token_present}`);
    assert.equal(env.patches_sha256, null,
      `patches_sha256 MUST be null when no detector wired; got ${env.patches_sha256}`);
  } finally {
    ctx.restore();
  }
});

// =============================================================================
// 5) stub via $KOLM_VISION_TOKENIZE_CMD returns synthesized envelope
// =============================================================================

test('W771b #5 - stub tokenizer via $KOLM_VISION_TOKENIZE_CMD returns numeric patch_token_count + hex image_sha256', async () => {
  const tmp = freshDir();
  const saved = { KOLM_VISION_TOKENIZE_CMD: process.env.KOLM_VISION_TOKENIZE_CMD };
  installStubTokenizer(tmp, { patch_token_count: 257, patch_token_dim: 1024 });
  try {
    const imgPath = path.join(tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const mod = await import('../src/vision-tokenize.js?w771b5=' + Date.now());
    const env = await mod.tokenizeImage({ path: imgPath, model: 'openai/clip-vit-large-patch14' });
    assert.equal(env.ok, true, `expected ok:true with stub wired; got ${JSON.stringify(env)}`);
    assert.equal(env.kind, 'vision');
    assert.equal(typeof env.patch_token_count, 'number',
      `patch_token_count must be numeric; got ${typeof env.patch_token_count}`);
    assert.equal(env.patch_token_count, 257);
    assert.equal(env.patch_token_dim, 1024);
    assert.equal(env.cls_token_present, true);
    assert.ok(/^[0-9a-f]{64}$/.test(env.image_sha256),
      `image_sha256 must be 64-hex; got ${env.image_sha256}`);
    assert.equal(env.version, 'w771b-v1');
    assert.ok(env.tokenizer && env.tokenizer.startsWith('env_override:'),
      `tokenizer should reflect env_override; got ${env.tokenizer}`);
  } finally {
    if (saved.KOLM_VISION_TOKENIZE_CMD != null) {
      process.env.KOLM_VISION_TOKENIZE_CMD = saved.KOLM_VISION_TOKENIZE_CMD;
    } else {
      delete process.env.KOLM_VISION_TOKENIZE_CMD;
    }
  }
});

// =============================================================================
// 6) doctor mode emits deterministic shape envelope
// =============================================================================

test('W771b #6 - doctor mode emits structured shape envelope (transformers/torch/pillow keys)', async () => {
  freshDir();
  const mod = await import('../src/vision-tokenize.js?w771b6=' + Date.now());
  const env = await mod.getVisionTokenizeDoctor();
  assert.equal(env.spec, 'kolm-vision-tokenize-worker-doctor',
    `doctor spec must equal 'kolm-vision-tokenize-worker-doctor'; got ${env.spec}`);
  assert.equal(env.version, 'w771b-v1');
  assert.ok(env.runtime && typeof env.runtime === 'object',
    'doctor envelope must include a runtime map');
  // Must enumerate the documented Python deps.
  for (const dep of ['transformers', 'torch', 'pillow']) {
    assert.ok(env.runtime[dep], `runtime.${dep} must be reported`);
    assert.equal(typeof env.runtime[dep].ok, 'boolean',
      `runtime.${dep}.ok must be a boolean`);
  }
  assert.ok(env.tokenizer && typeof env.tokenizer === 'object',
    'doctor envelope must include a tokenizer field');
  assert.equal(typeof env.tokenizer.ok, 'boolean');
  assert.equal(typeof env.ready, 'boolean',
    'envelope.ready must be a boolean roll-up');
});

// =============================================================================
// 7) POST /v1/vlm/tokenize requires auth
// =============================================================================

test('W771b #7 - POST /v1/vlm/tokenize 401 without auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js?w771b7=' + Date.now());
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/whatever.png' }),
    });
    assert.equal(r.status, 401, `expected 401 without auth; got ${r.status}`);
    const j = await r.json();
    assert.ok(/missing api key|auth_required/i.test(String(j.error)),
      `must surface an auth error string; got ${JSON.stringify(j)}`);

    // Doctor route should also 401.
    const r2 = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize/doctor`);
    assert.equal(r2.status, 401, `expected 401 on doctor without auth; got ${r2.status}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 8) POST /v1/vlm/tokenize with auth + stub env returns ok:true + numeric count
// =============================================================================

test('W771b #8 - POST /v1/vlm/tokenize with auth + stub returns ok:true + numeric patch_token_count', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  installStubTokenizer(tmp, { patch_token_count: 257, patch_token_dim: 1024 });

  const { buildRouter } = await import('../src/router.js?w771b8=' + Date.now());
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const imgPath = path.join(tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    const r = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: imgPath, model: 'openai/clip-vit-large-patch14' }),
    });
    assert.equal(r.status, 200, `expected 200; got ${r.status}`);
    const env = await r.json();
    assert.equal(env.ok, true,
      `expected ok:true with stub wired; got ${JSON.stringify(env)}`);
    assert.equal(typeof env.patch_token_count, 'number');
    assert.equal(env.patch_token_count, 257);
    assert.equal(env.patch_token_dim, 1024);
    assert.equal(env.version, 'w771b-v1');
    assert.ok(/^[0-9a-f]{64}$/.test(env.image_sha256));
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    delete process.env.KOLM_VISION_TOKENIZE_CMD;
  }
});

// =============================================================================
// 9) POST /v1/vlm/tokenize with bad body returns no_image_source
// =============================================================================

test('W771b #9 - POST /v1/vlm/tokenize with no source returns ok:false error:no_image_source', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js?w771b9=' + Date.now());
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + t.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400, `expected 400; got ${r.status}`);
    const env = await r.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'no_image_source',
      `expected error:'no_image_source'; got ${JSON.stringify(env)}`);
    assert.equal(env.version, 'w771b-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 10) cli kolm vlm tokenize shape-equivalence with the route envelope
// =============================================================================

test('W771b #10 - cli `kolm vlm tokenize` emits the same envelope shape as the route', () => {
  const tmp = freshDir();
  installStubTokenizer(tmp, { patch_token_count: 256, patch_token_dim: 1024 });
  try {
    const imgPath = path.join(tmp, 'img.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const r = spawnSync(process.execPath, [CLI_PATH, 'vlm', 'tokenize', imgPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60 * 1000,
      env: { ...process.env, KOLM_VISION_TOKENIZE_CMD: process.env.KOLM_VISION_TOKENIZE_CMD },
    });
    assert.equal(r.status, 0,
      `kolm vlm tokenize MUST exit 0 with stub wired; got status=${r.status} stderr=${String(r.stderr || '').slice(0, 400)}`);
    const out = String(r.stdout || '').trim();
    // Output should be pretty-printed JSON envelope.
    const env = JSON.parse(out);
    assert.equal(env.ok, true);
    assert.equal(env.kind, 'vision');
    assert.equal(typeof env.patch_token_count, 'number');
    assert.equal(env.patch_token_count, 256);
    assert.equal(env.version, 'w771b-v1');
    assert.ok(/^[0-9a-f]{64}$/.test(env.image_sha256),
      'image_sha256 must be 64-hex');
    // Shape equivalence: must carry the same keys we expose over HTTP.
    for (const k of ['ok', 'kind', 'tokenizer', 'model', 'patch_token_count',
                     'patch_token_dim', 'cls_token_present', 'image_sha256',
                     'patches_sha256', 'version']) {
      assert.ok(Object.prototype.hasOwnProperty.call(env, k),
        `cli envelope MUST include key ${k}; missing in ${JSON.stringify(Object.keys(env))}`);
    }
  } finally {
    delete process.env.KOLM_VISION_TOKENIZE_CMD;
  }
});

// =============================================================================
// 11) cli kolm vlm tokenize-doctor exits 0 + emits the doctor JSON
// =============================================================================

test('W771b #11 - cli `kolm vlm tokenize-doctor` exits 0 + emits the doctor envelope', () => {
  freshDir();
  const r = spawnSync(process.execPath, [CLI_PATH, 'vlm', 'tokenize-doctor'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60 * 1000,
    env: { ...process.env },
  });
  assert.equal(r.status, 0,
    `tokenize-doctor MUST exit 0 regardless of toolchain state; got ${r.status}, stderr=${String(r.stderr || '').slice(0, 400)}`);
  const env = JSON.parse(String(r.stdout || '').trim());
  assert.equal(env.spec, 'kolm-vision-tokenize-worker-doctor');
  assert.equal(env.version, 'w771b-v1');
  assert.ok(env.runtime && typeof env.runtime === 'object');
  assert.ok(env.tokenizer && typeof env.tokenizer === 'object');
  assert.equal(typeof env.ready, 'boolean');
});

// =============================================================================
// 12) sw.js cache slug uses wave(\d{3,4})b? regex (W604 anti-brittleness)
// =============================================================================

test('W771b #12 - sw.js cache slug references wave(\\d{3,4})b? family (W604 regex + threshold)', () => {
  freshDir();
  if (!fs.existsSync(SW_PATH)) return;
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return;
  // W604 anti-brittleness: regex + threshold (NEVER explicit-array family check).
  const wm = m[1].match(/wave?(\d{3,4})b?/i);
  if (wm) {
    const n = parseInt(wm[1], 10);
    assert.ok(n >= 100,
      `sw.js CACHE slug should reference a sane waveNNN[b?] token; got ${m[1]}`);
  }
  // Sibling count uses regex + threshold (never hard-coded list).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})b?-.+\.test\.js$/i;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4})b? test files; found ${siblings.length}`);
});

// =============================================================================
// 13) cross-tenant POST /v1/vlm/tokenize -- isolation sanity
// =============================================================================

test('W771b #13 - cross-tenant POST /v1/vlm/tokenize: each tenant sees its own envelope', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  installStubTokenizer(tmp, { patch_token_count: 256, patch_token_dim: 1024 });

  const { buildRouter } = await import('../src/router.js?w771b13=' + Date.now());
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  const tA = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const tB = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const imgPathA = path.join(tmp, 'imgA.png');
    const imgPathB = path.join(tmp, 'imgB.png');
    // Distinct image bytes -> distinct image_sha256 envelopes.
    fs.writeFileSync(imgPathA, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x01]));
    fs.writeFileSync(imgPathB, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x02]));

    const rA = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + tA.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ path: imgPathA }),
    });
    const rB = await fetch(`http://127.0.0.1:${port}/v1/vlm/tokenize`, {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + tB.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ path: imgPathB }),
    });
    assert.equal(rA.status, 200);
    assert.equal(rB.status, 200);
    const envA = await rA.json();
    const envB = await rB.json();
    assert.equal(envA.ok, true);
    assert.equal(envB.ok, true);
    assert.notEqual(envA.image_sha256, envB.image_sha256,
      'distinct image bytes -> distinct image_sha256 (sanity isolation)');
    // patches_sha256 is computed by the stub from the same bytes, so it also must differ.
    assert.notEqual(envA.patches_sha256, envB.patches_sha256,
      'distinct image bytes -> distinct patches_sha256');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
    delete process.env.KOLM_VISION_TOKENIZE_CMD;
  }
});

// =============================================================================
// 14) package.json shape: name, type, main, bin, external.processors
// =============================================================================

test('W771b #14 - workers/vision-tokenize/package.json has expected shape + external.processors note', () => {
  assert.ok(fs.existsSync(PKG_PATH), 'workers/vision-tokenize/package.json must exist');
  assert.ok(fs.existsSync(WORKER_PATH), 'workers/vision-tokenize/tokenize.mjs must exist');
  assert.ok(fs.existsSync(SHIM_PATH), 'src/vision-tokenize.js must exist');

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(pkg.name, '@kolm/vision-tokenize-worker');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'tokenize.mjs');
  assert.ok(pkg.bin && pkg.bin['kolm-vision-tokenize-worker'],
    'worker exposes a bin entrypoint');
  assert.ok(pkg.external && pkg.external.processors,
    'pkg.external.processors must document the default processor');
  const note = String(pkg.external.processors.note || '');
  assert.ok(/transformers/.test(note),
    'external.processors.note must mention transformers');
  assert.ok(/torch/.test(note),
    'external.processors.note must mention torch');
  assert.ok(/Pillow/.test(note),
    'external.processors.note must mention Pillow');
  assert.ok(/openai\/clip-vit-large-patch14/.test(note),
    'external.processors.note must reference the default CLIP model id');

  // Root package.json must NOT pull heavy ML deps.
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const allDepNames = Object.keys({
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.optionalDependencies || {}),
  });
  assert.ok(!allDepNames.includes('transformers'),
    'root package.json MUST NOT depend on transformers (lives in workers/vision-tokenize)');
  assert.ok(!allDepNames.includes('torch'),
    'root package.json MUST NOT depend on torch (lives in workers/vision-tokenize)');
});
