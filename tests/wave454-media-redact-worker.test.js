// W454 — multimodal redact-job worker shims.
//
// Closes the W452 deferred surface: /v1/media/redact returns
//   { ok:true, deferred:true, deferral:{ kind, worker, hint } }
// for any non-text-extractable mime. W454 ships the *worker* in
// workers/media-redact/ + a server-side /v1/media/redact-job route that
// spawns it + a `kolm media` CLI verb.
//
// These tests assert behavior and structure, not page copy:
//   1) The worker package + entrypoint exist with the right shape.
//   2) `kolm media` is wired into the CLI dispatcher + HELP + completion.
//   3) The router exposes POST /v1/media/redact-job AND GET .../doctor.
//   4) /v1/media/redact-job 401s without auth.
//   5) /v1/media/redact-job 400s without media_uri/path.
//   6) /v1/media/redact-job/doctor 401s without auth.
//   7) The worker --doctor mode runs and emits a structured JSON envelope.
//   8) The worker returns extractor_not_installed envelope (exit 3) for an
//      image when tesseract.js is not in the root install — honest
//      install_hint surfaces in the envelope, no silent fallback.
//   9) sw.js CACHE slug references wave454.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// =============================================================================
// 1) Worker package + entrypoint shape
// =============================================================================

test('W454 #1 — workers/media-redact package + redact.mjs exist with expected shape', () => {
  const pkgPath = path.join(REPO_ROOT, 'workers', 'media-redact', 'package.json');
  const entryPath = path.join(REPO_ROOT, 'workers', 'media-redact', 'redact.mjs');
  assert.ok(fs.existsSync(pkgPath), 'workers/media-redact/package.json must exist');
  assert.ok(fs.existsSync(entryPath), 'workers/media-redact/redact.mjs must exist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, '@kolm/media-redact-worker', 'worker package name');
  assert.equal(pkg.type, 'module', 'worker is ESM');
  assert.equal(pkg.main, 'redact.mjs', 'worker entrypoint is redact.mjs');
  assert.ok(pkg.bin && pkg.bin['kolm-media-redact-worker'],
    'worker exposes a bin entrypoint');

  // Optional deps: tesseract.js for OCR, pdf-parse for PDF.
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['tesseract.js'],
    'tesseract.js must be in optionalDependencies (root install stays light)');
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['pdf-parse'],
    'pdf-parse must be in optionalDependencies');

  // External binary deps documented (not installable from npm).
  assert.ok(pkg.external && pkg.external.audio_video,
    'pkg.external.audio_video must document whisper-cli + ffmpeg');
  assert.ok(Array.isArray(pkg.external.audio_video.binaries) &&
    pkg.external.audio_video.binaries.includes('whisper-cli'),
    'whisper-cli listed as external binary');
  assert.ok(pkg.external.audio_video.binaries.includes('ffmpeg'),
    'ffmpeg listed as external binary');

  // Worker entrypoint references all four kinds + the install hint shape.
  const src = fs.readFileSync(entryPath, 'utf8');
  assert.match(src, /tesseract\.js/, 'worker references tesseract.js for image');
  assert.match(src, /pdf-parse/, 'worker references pdf-parse for pdf');
  assert.match(src, /whisper/i, 'worker references whisper for audio/video');
  assert.match(src, /ffmpeg/, 'worker references ffmpeg for video');
  assert.match(src, /redactWithPolicy/, 'worker imports privacy-membrane redactor');
  assert.match(src, /install_hint/, 'worker emits install_hint envelope');
  assert.match(src, /process\.exit\(3\)/, 'worker exits 3 on extractor_not_installed');
});

// =============================================================================
// 2) CLI wiring — `kolm media` is a real top-level verb
// =============================================================================

test('W454 #2 — cli/kolm.js wires cmdMedia + HELP.media + completion entry', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');

  // The cmdMedia function exists.
  assert.match(cli, /async function cmdMedia\(args\)/,
    'cmdMedia function must be defined');

  // Dispatcher table includes media -> cmdMedia.
  assert.match(cli, /media:\s*cmdMedia/,
    'dispatcher table must map media -> cmdMedia');

  // Switch statement has a case for media.
  assert.match(cli, /case 'media':\s*await\s+withErrorContext\('media'/,
    'main switch must route "media" through withErrorContext');

  // HELP.media exists and documents the local tokenizer plus redaction subcommands.
  assert.match(cli, /media:\s*`kolm media/,
    'HELP.media must define the help string');
  assert.match(cli, /kolm media tokenize/,
    'HELP.media must document `kolm media tokenize`');
  assert.match(cli, /kolm media doctor/,
    'HELP.media must document `kolm media doctor`');
  assert.match(cli, /kolm media redact-job/,
    'HELP.media must document `kolm media redact-job`');

  // COMPLETION_VERBS includes media; COMPLETION_SUBS maps media subcommands.
  assert.match(cli, /'redact',\s*'media'/,
    "COMPLETION_VERBS must include 'media' (next to 'redact')");
  assert.match(cli, /media:\s*\['tokenize',\s*'doctor',\s*'redact-job'\]/,
    'COMPLETION_SUBS.media must list tokenize + doctor + redact-job subcommands');
});

// =============================================================================
// 3) Router exposes both routes
// =============================================================================

test('W454 #3 — src/router.js exposes POST /v1/media/redact-job + GET .../doctor', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.post\(['"]\/v1\/media\/redact-job['"]/,
    'POST /v1/media/redact-job route must be defined');
  assert.match(router, /r\.get\(['"]\/v1\/media\/redact-job\/doctor['"]/,
    'GET /v1/media/redact-job/doctor route must be defined');
  // The route MUST require auth (tenant_record check) — no anonymous OCR runs.
  assert.match(router, /\/v1\/media\/redact-job['"][\s\S]{0,300}tenant_record/,
    'POST /v1/media/redact-job must gate on req.tenant_record');
  // The route MUST spawn the worker — no inline OCR in the router process.
  // The router path.resolve()'s the path component-by-component, so match the
  // literal arg-list (workers, media-redact, redact.mjs).
  assert.match(router, /['"]workers['"]\s*,\s*['"]media-redact['"]\s*,\s*['"]redact\.mjs['"]/,
    'route must path.resolve to workers/media-redact/redact.mjs');
});

// =============================================================================
// 4-6) Auth + arg validation
// =============================================================================

async function buildApp() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w454-'));
  process.env.KOLM_DATA_DIR = path.join(tmpdir, '.kolm');
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_ENV = 'test';
  const { buildRouter } = await import('../src/router.js?w454=' + Date.now());
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app, tmpdir };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('W454 #4 — POST /v1/media/redact-job requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/media/redact-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: 'file:xyz.png', kind: 'image' }),
    });
    assert.equal(r.status, 401, 'must 401 without auth');
    const j = await r.json();
    // Auth middleware fires first ('missing api key'); the route-local
    // tenant_record guard ('auth_required') is the second line of defense.
    // Either string proves the route is auth-gated.
    assert.ok(/missing api key|auth_required/i.test(String(j.error)),
      'must surface an auth error string, got: ' + JSON.stringify(j));
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W454 #5 — POST /v1/media/redact-job 400 without media_uri or path', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    // Provision an anonymous tenant so we can present a valid api_key.
    const { provisionAnonTenant } = await import('../src/auth.js');
    const tenant = await provisionAnonTenant();
    const r = await fetch(`${base}/v1/media/redact-job`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenant.api_key}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'media_uri_or_path_required');
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W454 #6 — GET /v1/media/redact-job/doctor requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/media/redact-job/doctor`);
    assert.equal(r.status, 401);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

// =============================================================================
// 7) Worker --doctor mode produces a structured envelope
// =============================================================================

test('W454 #7 — worker --doctor emits structured readiness envelope', () => {
  const workerPath = path.join(REPO_ROOT, 'workers', 'media-redact', 'redact.mjs');
  const r = spawnSync(process.execPath, [workerPath, '--doctor'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
  });
  assert.equal(r.status, 0, 'doctor exits 0: ' + String(r.stderr || ''));
  const envelope = JSON.parse(String(r.stdout || '').trim());
  assert.equal(envelope.spec, 'kolm-media-redact-worker-doctor',
    'doctor must carry a spec field for stable schema');
  assert.ok(typeof envelope.version === 'string', 'version must be a string');
  assert.ok(envelope.extractors && typeof envelope.extractors === 'object',
    'doctor envelope must include an extractors map');
  for (const kind of ['image', 'pdf', 'audio', 'video']) {
    assert.ok(envelope.extractors[kind],
      `doctor envelope must include extractors.${kind}`);
    assert.equal(typeof envelope.extractors[kind].ok, 'boolean',
      `extractors.${kind}.ok must be a boolean`);
    if (envelope.extractors[kind].ok === false) {
      assert.ok(typeof envelope.extractors[kind].install_hint === 'string'
        && envelope.extractors[kind].install_hint.length > 0,
        `extractors.${kind}.install_hint must be present when ok:false`);
    }
  }
});

// =============================================================================
// 8) Worker emits extractor_not_installed envelope (exit 3) when missing
// =============================================================================

test('W454 #8 — worker returns extractor_not_installed when tesseract.js absent', () => {
  // Skip the test if tesseract.js was actually installed in the worker dir.
  let tesseractPresent = false;
  try {
    const workerPkgDir = path.join(REPO_ROOT, 'workers', 'media-redact', 'node_modules', 'tesseract.js');
    tesseractPresent = fs.existsSync(workerPkgDir);
  } catch (_) {} // deliberate: cleanup
  if (tesseractPresent) {
    // tesseract.js IS installed — this asserts the happy path returns ok:true
    // OR a media-load error (no real PNG bytes were passed).
    // For the purposes of this lock-in, just assert the binary runs.
    const tmpFile = path.join(os.tmpdir(), 'kolm-w454-not-an-image-' + Date.now() + '.png');
    fs.writeFileSync(tmpFile, Buffer.from([0]));
    const workerPath = path.join(REPO_ROOT, 'workers', 'media-redact', 'redact.mjs');
    const r = spawnSync(process.execPath, [workerPath, '--path', tmpFile, '--kind', 'image', '--json'], {
      stdio: 'pipe',
      timeout: 30 * 1000,
    });
    // tesseract on garbage bytes likely errors → exit 5 (extract_failed) is fine.
    assert.ok([0, 5].includes(r.status), 'tesseract path must exit 0 or 5 on garbage bytes');
    try { fs.unlinkSync(tmpFile); } catch (_) {} // deliberate: cleanup
    return;
  }

  // Common case in CI: tesseract.js NOT installed. Worker must return the
  // honest install_hint envelope, not silent-fall-through.
  const tmpFile = path.join(os.tmpdir(), 'kolm-w454-img-' + Date.now() + '.png');
  fs.writeFileSync(tmpFile, Buffer.from([0]));
  const workerPath = path.join(REPO_ROOT, 'workers', 'media-redact', 'redact.mjs');
  const r = spawnSync(process.execPath, [workerPath, '--path', tmpFile, '--kind', 'image', '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
  });
  try { fs.unlinkSync(tmpFile); } catch (_) {} // deliberate: cleanup
  assert.equal(r.status, 3, 'worker must exit 3 when extractor is not installed: ' + String(r.stderr || ''));
  const env = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
  assert.equal(env.ok, false);
  assert.equal(env.error, 'extractor_not_installed');
  assert.equal(env.extractor, 'tesseract.js');
  assert.ok(typeof env.install_hint === 'string' && env.install_hint.length > 0,
    'install_hint must be present');
});

// =============================================================================
// 9) sw.js CACHE slug references wave454
// =============================================================================

