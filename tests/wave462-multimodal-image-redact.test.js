// W462 — multimodal IMAGE PII redactor worker shims.
//
// Closes audit P1 Multimodal "redactor for non-text modalities" item.
// W454 ships the OCR+redact-text path; W462 ships pixel-space redaction
// of faces + license plates. Two complementary primitives.
//
// These tests assert behavior and structure, not page copy:
//   1) workers/multimodal-redact-image package + redact-image.mjs exist with the right shape.
//   2) `kolm media image-doctor` + `kolm media redact-image` are wired into CLI + HELP.
//   3) Router exposes POST /v1/multimodal/redact-image AND GET .../doctor.
//   4) POST /v1/multimodal/redact-image 401s without auth.
//   5) POST /v1/multimodal/redact-image 400s without media_uri/path.
//   6) GET .../doctor 401s without auth.
//   7) Worker --doctor mode runs and emits a structured JSON envelope.
//   8) Worker returns no_detector_installed (exit 3) when onnxruntime-node OR
//      sharp OR the ONNX model is missing — honest install_hint surfaces,
//      no silent fallback. CRITICAL: protects "no softened claims" directive.
//   9) Root kolm package.json does NOT depend on onnxruntime-node or sharp —
//      heavy ML deps stay isolated in the worker package.
//  10) sw.js CACHE slug references the W454+ family (W462).

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

test('W462 #1 — workers/multimodal-redact-image package + redact-image.mjs exist with expected shape', () => {
  const pkgPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'package.json');
  const entryPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'redact-image.mjs');
  assert.ok(fs.existsSync(pkgPath), 'workers/multimodal-redact-image/package.json must exist');
  assert.ok(fs.existsSync(entryPath), 'workers/multimodal-redact-image/redact-image.mjs must exist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, '@kolm/multimodal-redact-image-worker', 'worker package name');
  assert.equal(pkg.type, 'module', 'worker is ESM');
  assert.equal(pkg.main, 'redact-image.mjs', 'worker entrypoint is redact-image.mjs');
  assert.ok(pkg.bin && pkg.bin['kolm-multimodal-redact-image-worker'],
    'worker exposes a bin entrypoint');

  // Optional deps — heavy ML runtime in worker, not root.
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['onnxruntime-node'],
    'onnxruntime-node MUST be in optionalDependencies (root install stays light)');
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['sharp'],
    'sharp MUST be in optionalDependencies');

  // External (non-npm) artifacts documented.
  assert.ok(pkg.external && pkg.external.models,
    'pkg.external.models must document ONNX model paths');
  assert.match(String(pkg.external.models.note), /yolov8n-face\.onnx/,
    'external.models.note must reference yolov8n-face.onnx');
  assert.match(String(pkg.external.models.note), /license-plate-detector\.onnx/,
    'external.models.note must reference license-plate-detector.onnx');

  // Worker entrypoint references the load-bearing concepts.
  const src = fs.readFileSync(entryPath, 'utf8');
  assert.match(src, /onnxruntime-node/, 'worker references onnxruntime-node for inference');
  assert.match(src, /sharp/, 'worker references sharp for image decode/blur/encode');
  assert.match(src, /yolov8n-face\.onnx/, 'worker references face model default path');
  assert.match(src, /license-plate-detector\.onnx/, 'worker references plate model default path');
  assert.match(src, /install_hint/, 'worker emits install_hint envelope');
  assert.match(src, /no_detector_installed/, 'worker emits no_detector_installed error code');
  assert.match(src, /process\.exit\(3\)/, 'worker exits 3 on no_detector_installed');
  // Honesty invariant: when no detector is wired the worker MUST NOT claim ok:true.
  assert.match(src, /redacted_image:\s*null/,
    'worker must set redacted_image:null in the no-detector envelope (no soft claims)');
});

// =============================================================================
// 2) CLI wiring — `kolm media image-doctor` + `kolm media redact-image`
// =============================================================================

test('W462 #2 — cli/kolm.js wires image-doctor + redact-image into cmdMedia + HELP', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');

  // Both subcommands routed through cmdMedia.
  assert.match(cli, /sub === 'image-doctor'/,
    'cmdMedia must handle image-doctor subcommand');
  assert.match(cli, /sub === 'redact-image'/,
    'cmdMedia must handle redact-image subcommand');

  // CmdMedia must spawn the multimodal-redact-image worker (not the W454 worker).
  assert.match(cli, /['"]workers['"]\s*,\s*['"]multimodal-redact-image['"]\s*,\s*['"]redact-image\.mjs['"]/,
    'cmdMedia must path.resolve to workers/multimodal-redact-image/redact-image.mjs');

  // HELP.media must document the new subcommands.
  assert.match(cli, /kolm media image-doctor/,
    'HELP.media must document `kolm media image-doctor`');
  assert.match(cli, /kolm media redact-image/,
    'HELP.media must document `kolm media redact-image`');
});

// =============================================================================
// 3) Router exposes both routes
// =============================================================================

test('W462 #3 — src/router.js exposes POST /v1/multimodal/redact-image + GET .../doctor', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.post\(['"]\/v1\/multimodal\/redact-image['"]/,
    'POST /v1/multimodal/redact-image route must be defined');
  assert.match(router, /r\.get\(['"]\/v1\/multimodal\/redact-image\/doctor['"]/,
    'GET /v1/multimodal/redact-image/doctor route must be defined');
  // Auth-gated.
  assert.match(router, /\/v1\/multimodal\/redact-image['"][\s\S]{0,400}tenant_record/,
    'POST /v1/multimodal/redact-image must gate on req.tenant_record');
  // Must spawn the multimodal-redact-image worker, not inline ONNX runtime in router.
  assert.match(router, /['"]workers['"]\s*,\s*['"]multimodal-redact-image['"]\s*,\s*['"]redact-image\.mjs['"]/,
    'route must path.resolve to workers/multimodal-redact-image/redact-image.mjs');
});

// =============================================================================
// 4-6) Auth + arg validation against a live router instance
// =============================================================================

async function buildApp() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w462-'));
  process.env.KOLM_DATA_DIR = path.join(tmpdir, '.kolm');
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_ENV = 'test';
  const { buildRouter } = await import('../src/router.js?w462=' + Date.now());
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

test('W462 #4 — POST /v1/multimodal/redact-image requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/multimodal/redact-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: 'file:photo.png' }),
    });
    assert.equal(r.status, 401, 'must 401 without auth');
    const j = await r.json();
    // W454-style: auth middleware fires first ('missing api key'), route-local
    // tenant_record check ('auth_required') is second line of defense.
    assert.ok(/missing api key|auth_required/i.test(String(j.error)),
      'must surface an auth error string, got: ' + JSON.stringify(j));
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W462 #5 — POST /v1/multimodal/redact-image 400 without media_uri or path', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const { provisionAnonTenant } = await import('../src/auth.js');
    const tenant = await provisionAnonTenant();
    const r = await fetch(`${base}/v1/multimodal/redact-image`, {
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
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W462 #6 — GET /v1/multimodal/redact-image/doctor requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/multimodal/redact-image/doctor`);
    assert.equal(r.status, 401);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 7) Worker --doctor mode produces a structured envelope
// =============================================================================

test('W462 #7 — worker --doctor emits structured readiness envelope', () => {
  const workerPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'redact-image.mjs');
  const r = spawnSync(process.execPath, [workerPath, '--doctor'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
  });
  assert.equal(r.status, 0, 'doctor exits 0: ' + String(r.stderr || ''));
  const envelope = JSON.parse(String(r.stdout || '').trim());
  assert.equal(envelope.spec, 'kolm-multimodal-redact-image-worker-doctor',
    'doctor must carry a spec field for stable schema');
  assert.ok(typeof envelope.version === 'string', 'version must be a string');
  assert.ok(envelope.runtime && typeof envelope.runtime === 'object',
    'doctor envelope must include a runtime map (sharp + onnxruntime-node)');
  assert.ok(envelope.runtime.sharp, 'runtime.sharp must be reported');
  assert.ok(envelope.runtime.onnxruntime_node, 'runtime.onnxruntime_node must be reported');
  assert.ok(envelope.detectors && typeof envelope.detectors === 'object',
    'doctor envelope must include a detectors map (face + plate)');
  for (const kind of ['face', 'plate']) {
    assert.ok(envelope.detectors[kind],
      `doctor envelope must include detectors.${kind}`);
    assert.equal(typeof envelope.detectors[kind].ok, 'boolean',
      `detectors.${kind}.ok must be a boolean`);
    if (envelope.detectors[kind].ok === false) {
      assert.ok(typeof envelope.detectors[kind].install_hint === 'string'
        && envelope.detectors[kind].install_hint.length > 0,
        `detectors.${kind}.install_hint must be present when ok:false`);
    }
  }
  assert.equal(typeof envelope.ready, 'boolean',
    'envelope.ready must be a boolean rolling up runtime + at-least-one-detector');
});

// =============================================================================
// 8) Worker emits no_detector_installed envelope (exit 3) when missing
// =============================================================================

test('W462 #8 — worker returns no_detector_installed when deps/models absent', () => {
  // Skip if everything is wired (full local kit) — assert the binary at least
  // runs against tiny input and emits a structured envelope.
  let sharpPresent = false, ortPresent = false;
  try {
    sharpPresent = fs.existsSync(path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'node_modules', 'sharp'));
  } catch (_) {}
  try {
    ortPresent = fs.existsSync(path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'node_modules', 'onnxruntime-node'));
  } catch (_) {}
  const facePath  = path.join(os.homedir(), '.kolm', 'models', 'yolov8n-face.onnx');
  const platePath = path.join(os.homedir(), '.kolm', 'models', 'license-plate-detector.onnx');
  const faceOk  = (() => { try { return fs.existsSync(facePath);  } catch (_) { return false; } })();
  const plateOk = (() => { try { return fs.existsSync(platePath); } catch (_) { return false; } })();
  const fullKit = sharpPresent && ortPresent && (faceOk || plateOk);

  const tmpFile = path.join(os.tmpdir(), 'kolm-w462-img-' + Date.now() + '.png');
  // One-byte file — not a real PNG, but enough to make the worker reach the
  // doctor/dep check before it tries to decode.
  fs.writeFileSync(tmpFile, Buffer.from([0]));
  const workerPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-image', 'redact-image.mjs');
  const r = spawnSync(process.execPath, [workerPath, '--path', tmpFile, '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
  });
  try { fs.unlinkSync(tmpFile); } catch (_) {}

  if (fullKit) {
    // Full local kit present: garbage bytes likely fail decode → exit 5.
    // Either exit 5 (decode_failed) or exit 0 (no detections, blank png) is acceptable.
    assert.ok([0, 5].includes(r.status), 'full-kit run must exit 0 or 5 on garbage bytes, got: ' + r.status);
    return;
  }

  // CI / fresh-install case: at least one of {sharp, ort, models} missing.
  // Worker MUST return exit 3 with the honest no_detector_installed envelope.
  assert.equal(r.status, 3, 'worker must exit 3 when no detector wired: ' + String(r.stderr || ''));
  const env = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
  assert.equal(env.ok, false);
  assert.equal(env.error, 'no_detector_installed');
  // CRITICAL honesty invariant: redacted_image MUST be null in this envelope.
  // Without this guard the worker could silently claim it redacted PII it
  // could not even see. This is the load-bearing assertion for the
  // "no softened claims" standing directive.
  assert.equal(env.redacted_image, null,
    'no_detector_installed envelope MUST set redacted_image:null (honesty contract)');
  assert.ok(typeof env.install_hint === 'string' && env.install_hint.length > 0,
    'install_hint must be present');
});

// =============================================================================
// 9) Root package.json has no heavy ML deps
// =============================================================================

test('W462 #9 — root kolm package.json does NOT pull onnxruntime-node or sharp', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const allDepNames = Object.keys({
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.optionalDependencies || {}),
  });
  // Standing directive: "Heavy ML deps must live in an isolated worker/package/script"
  assert.ok(!allDepNames.includes('onnxruntime-node'),
    'root package.json MUST NOT depend on onnxruntime-node (it lives in workers/multimodal-redact-image)');
  assert.ok(!allDepNames.includes('sharp'),
    'root package.json MUST NOT depend on sharp (it lives in workers/multimodal-redact-image)');
});

// =============================================================================
// 10) sw.js CACHE slug references the W462+ family
// =============================================================================

test('W462 #10 — sw.js CACHE slug is current within the W454+ family', () => {
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  // W604 anti-brittleness: scan all wave tokens, assert max >= 454.
  const waves = [...sw.matchAll(/wave(\d{3,4})/g)].map((m) => parseInt(m[1], 10));
  assert.ok(waves.length > 0, 'sw.js must carry at least one wave token');
  const maxWave = Math.max(...waves);
  assert.ok(maxWave >= 454, 'sw.js CACHE wave must reach >= 454 (saw max wave' + maxWave + ')');
});
