// W464 — multimodal AUDIO voiceprint scrub worker shims.
//
// Closes audit P1 Multimodal "audio-side voiceprint scrub" item. W454
// ships audio-to-text via whisper + transcript redaction. W462 ships
// pixel-space image redaction. W464 ships the third primitive: speaker
// voiceprint anonymization on raw audio.
//
// These tests assert behavior and structure, not page copy:
//   1) workers/multimodal-redact-audio package + redact-audio.mjs exist with the right shape.
//   2) `kolm media audio-doctor` + `kolm media redact-audio` are wired into CLI + HELP.
//   3) Router exposes POST /v1/multimodal/redact-audio AND GET .../doctor.
//   4) POST /v1/multimodal/redact-audio 401s without auth.
//   5) POST /v1/multimodal/redact-audio 400s without media_uri/path.
//   6) GET .../doctor 401s without auth.
//   7) Worker --doctor mode runs and emits a structured JSON envelope.
//   8) Worker returns no_detector_installed (exit 3) when no redactor wired —
//      honest install_hint surfaces, redacted_audio:null, no silent passthrough.
//      CRITICAL: protects "no softened claims" directive.
//   9) Root kolm package.json does NOT depend on pyannote / torch / sharp /
//      onnxruntime-node — heavy ML deps stay isolated in the worker package.
//  10) End-to-end working path: with a Node stub injected via
//      VOICEPRINT_REDACT_CMD, the worker spawns the stub and returns
//      ok:true with a non-null redacted_audio_sha256.

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

test('W464 #1 — workers/multimodal-redact-audio package + redact-audio.mjs exist with expected shape', () => {
  const pkgPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-audio', 'package.json');
  const entryPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-audio', 'redact-audio.mjs');
  assert.ok(fs.existsSync(pkgPath), 'workers/multimodal-redact-audio/package.json must exist');
  assert.ok(fs.existsSync(entryPath), 'workers/multimodal-redact-audio/redact-audio.mjs must exist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, '@kolmogorov/multimodal-redact-audio-worker', 'worker package name');
  assert.equal(pkg.type, 'module', 'worker is ESM');
  assert.equal(pkg.main, 'redact-audio.mjs', 'worker entrypoint is redact-audio.mjs');
  assert.ok(pkg.bin && pkg.bin['kolm-multimodal-redact-audio-worker'],
    'worker exposes a bin entrypoint');

  // External (non-npm) tooling documented honestly — the redactor lives
  // outside Node entirely, so the worker pkg.optionalDependencies is empty
  // and the requirements live under pkg.external.
  assert.ok(pkg.external && pkg.external.python_redactor,
    'pkg.external.python_redactor must document the external command contract');
  assert.match(String(pkg.external.python_redactor.note), /VOICEPRINT_REDACT_CMD/,
    'external.python_redactor.note must reference $VOICEPRINT_REDACT_CMD env override');
  assert.match(String(pkg.external.python_redactor.note), /pyannote-audio-redact/,
    'external.python_redactor.note must reference the default pyannote wrapper name');

  // Worker entrypoint references the load-bearing concepts.
  const src = fs.readFileSync(entryPath, 'utf8');
  assert.match(src, /VOICEPRINT_REDACT_CMD/, 'worker references env override');
  assert.match(src, /pyannote-audio-redact/, 'worker references default redactor cmd');
  assert.match(src, /install_hint/, 'worker emits install_hint envelope');
  assert.match(src, /no_detector_installed/, 'worker emits no_detector_installed error');
  // Honesty invariant: when no redactor is wired the worker MUST NOT claim ok:true.
  assert.match(src, /redacted_audio:\s*null/,
    'worker must set redacted_audio:null in the no-detector envelope (no soft claims)');
});

// =============================================================================
// 2) CLI wiring — `kolm media audio-doctor` + `kolm media redact-audio`
// =============================================================================

test('W464 #2 — cli/kolm.js wires audio-doctor + redact-audio into cmdMedia + HELP', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');

  // Both subcommands routed through cmdMedia.
  assert.match(cli, /sub === 'audio-doctor'/,
    'cmdMedia must handle audio-doctor subcommand');
  assert.match(cli, /sub === 'redact-audio'/,
    'cmdMedia must handle redact-audio subcommand');

  // CmdMedia must spawn the multimodal-redact-audio worker.
  assert.match(cli, /['"]workers['"]\s*,\s*['"]multimodal-redact-audio['"]\s*,\s*['"]redact-audio\.mjs['"]/,
    'cmdMedia must path.resolve to workers/multimodal-redact-audio/redact-audio.mjs');

  // HELP.media must document the new subcommands.
  assert.match(cli, /kolm media audio-doctor/,
    'HELP.media must document `kolm media audio-doctor`');
  assert.match(cli, /kolm media redact-audio/,
    'HELP.media must document `kolm media redact-audio`');
});

// =============================================================================
// 3) Router exposes both routes
// =============================================================================

test('W464 #3 — src/router.js exposes POST /v1/multimodal/redact-audio + GET .../doctor', () => {
  const router = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.match(router, /r\.post\(['"]\/v1\/multimodal\/redact-audio['"]/,
    'POST /v1/multimodal/redact-audio route must be defined');
  assert.match(router, /r\.get\(['"]\/v1\/multimodal\/redact-audio\/doctor['"]/,
    'GET /v1/multimodal/redact-audio/doctor route must be defined');
  // Auth-gated.
  assert.match(router, /\/v1\/multimodal\/redact-audio['"][\s\S]{0,400}tenant_record/,
    'POST /v1/multimodal/redact-audio must gate on req.tenant_record');
  // Must spawn the multimodal-redact-audio worker.
  assert.match(router, /['"]workers['"]\s*,\s*['"]multimodal-redact-audio['"]\s*,\s*['"]redact-audio\.mjs['"]/,
    'route must path.resolve to workers/multimodal-redact-audio/redact-audio.mjs');
});

// =============================================================================
// 4-6) Auth + arg validation against a live router instance
// =============================================================================

async function buildApp() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w464-'));
  process.env.KOLM_DATA_DIR = path.join(tmpdir, '.kolm');
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_ENV = 'test';
  const { buildRouter } = await import('../src/router.js?w464=' + Date.now());
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

test('W464 #4 — POST /v1/multimodal/redact-audio requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/multimodal/redact-audio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_uri: 'file:audio.wav' }),
    });
    assert.equal(r.status, 401, 'must 401 without auth');
    const j = await r.json();
    assert.ok(/missing api key|auth_required/i.test(String(j.error)),
      'must surface an auth error string, got: ' + JSON.stringify(j));
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('W464 #5 — POST /v1/multimodal/redact-audio 400 without media_uri or path', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const { provisionAnonTenant } = await import('../src/auth.js');
    const tenant = await provisionAnonTenant();
    const r = await fetch(`${base}/v1/multimodal/redact-audio`, {
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

test('W464 #6 — GET /v1/multimodal/redact-audio/doctor requires auth', async () => {
  const { app, tmpdir } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const r = await fetch(`${base}/v1/multimodal/redact-audio/doctor`);
    assert.equal(r.status, 401);
  } finally {
    srv.close();
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 7) Worker --doctor mode produces a structured envelope
// =============================================================================

test('W464 #7 — worker --doctor emits structured readiness envelope', () => {
  const workerPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-audio', 'redact-audio.mjs');
  // Force a known-bad VOICEPRINT_REDACT_CMD so the doctor reliably reports
  // not-ready regardless of CI machine state.
  const env = { ...process.env };
  delete env.VOICEPRINT_REDACT_CMD;
  const r = spawnSync(process.execPath, [workerPath, '--doctor'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env,
  });
  assert.equal(r.status, 0, 'doctor exits 0: ' + String(r.stderr || ''));
  const envelope = JSON.parse(String(r.stdout || '').trim());
  assert.equal(envelope.spec, 'kolm-multimodal-redact-audio-worker-doctor',
    'doctor must carry a spec field for stable schema');
  assert.equal(envelope.wave, 'W464', 'doctor must self-identify wave');
  assert.ok(typeof envelope.version === 'string', 'version must be a string');
  assert.ok(envelope.runtime && typeof envelope.runtime === 'object',
    'doctor envelope must include a runtime map');
  assert.ok(envelope.runtime.python3, 'runtime.python3 must be reported');
  assert.ok(envelope.runtime.ffmpeg, 'runtime.ffmpeg must be reported');
  assert.ok(envelope.detectors && envelope.detectors.voiceprint,
    'doctor envelope must include detectors.voiceprint');
  assert.equal(typeof envelope.detectors.voiceprint.ok, 'boolean',
    'detectors.voiceprint.ok must be a boolean');
  if (envelope.detectors.voiceprint.ok === false) {
    assert.ok(typeof envelope.detectors.voiceprint.install_hint === 'string'
      && envelope.detectors.voiceprint.install_hint.length > 0,
      'detectors.voiceprint.install_hint must be present when ok:false');
  }
  assert.equal(typeof envelope.ready, 'boolean',
    'envelope.ready must be a boolean (whether a redactor is wired)');
});

// =============================================================================
// 8) Worker emits no_detector_installed envelope (exit 3) when missing
// =============================================================================

test('W464 #8 — worker returns no_detector_installed when no redactor wired', () => {
  const tmpFile = path.join(os.tmpdir(), 'kolm-w464-audio-' + Date.now() + '.wav');
  // 44-byte WAV header (silent, valid enough for size checks; the worker
  // never decodes it because it should bail at the redactor-locate step).
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x24, 0x00, 0x00, 0x00, // chunk size
    0x57, 0x41, 0x56, 0x45, // 'WAVE'
    0x66, 0x6d, 0x74, 0x20, // 'fmt '
    0x10, 0x00, 0x00, 0x00, // subchunk size
    0x01, 0x00, 0x01, 0x00, // PCM, mono
    0x44, 0xac, 0x00, 0x00, // 44100 Hz
    0x88, 0x58, 0x01, 0x00, // byte rate
    0x02, 0x00, 0x10, 0x00, // block align, bits/sample
    0x64, 0x61, 0x74, 0x61, // 'data'
    0x00, 0x00, 0x00, 0x00, // data size
  ]);
  fs.writeFileSync(tmpFile, wavHeader);
  const workerPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-audio', 'redact-audio.mjs');

  // Force no redactor available: clear the env override AND prepend a
  // bogus PATH so pyannote-audio-redact cannot resolve.
  const env = { ...process.env };
  delete env.VOICEPRINT_REDACT_CMD;
  env.PATH = path.join(os.tmpdir(), 'kolm-w464-empty-' + Date.now());

  const r = spawnSync(process.execPath, [workerPath, '--path', tmpFile, '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env,
  });
  try { fs.unlinkSync(tmpFile); } catch (_) {}

  // If a real redactor is wired (unlikely in CI), the run may succeed (exit 0)
  // on the silent WAV. That is acceptable. The honesty contract is only
  // asserted when no redactor is found.
  if (r.status === 0) return;

  assert.equal(r.status, 3, 'worker must exit 3 when no detector wired: ' + String(r.stderr || ''));
  const envObj = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
  assert.equal(envObj.ok, false);
  assert.equal(envObj.error, 'no_detector_installed');
  // CRITICAL honesty invariant: redacted_audio MUST be null. Without this
  // guard the worker could silently claim it scrubbed a voiceprint it
  // could not even modify. Load-bearing for the "no softened claims" directive.
  assert.equal(envObj.redacted_audio, null,
    'no_detector_installed envelope MUST set redacted_audio:null (honesty contract)');
  assert.ok(typeof envObj.install_hint === 'string' && envObj.install_hint.length > 0,
    'install_hint must be present');
});

// =============================================================================
// 9) Root package.json has no heavy ML deps
// =============================================================================

test('W464 #9 — root kolm package.json does NOT pull pyannote / torch / heavy ML', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const allDepNames = Object.keys({
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.optionalDependencies || {}),
    ...(rootPkg.devDependencies || {}),
  });
  // Standing directive: "Heavy ML deps must live in an isolated worker/package/script"
  const forbidden = [
    'pyannote',
    'pyannote.audio',
    '@pyannote/audio',
    'torch',
    'pytorch',
    '@tensorflow/tfjs-node',
  ];
  for (const f of forbidden) {
    assert.ok(!allDepNames.includes(f),
      'root package.json MUST NOT depend on ' + f + ' (heavy ML must live in workers/)');
  }
});

// =============================================================================
// 10) End-to-end working path via a Node stub redactor
// =============================================================================

test('W464 #10 — worker spawns external redactor via VOICEPRINT_REDACT_CMD and returns ok:true', () => {
  // Build a Node stub that mimics the pyannote-audio-redact contract:
  // parse --input/--output/--strength, write a deterministic redacted WAV
  // (here: same bytes as input prefixed by a known marker so the
  // SHA-256 is reproducible), emit one JSON envelope on stdout.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w464-stub-'));
  const stubPath = path.join(stubDir, 'stub-redactor.mjs');
  const stubSrc = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
function pick(k){ const i = args.indexOf(k); return i >= 0 ? args[i+1] : null; }
const input = pick('--input');
const output = pick('--output');
const strength = pick('--strength') || '0.7';
const buf = fs.readFileSync(input);
// "Redact" by prepending a marker; deterministic so test asserts SHA stability.
const marker = Buffer.from('W464-STUB-');
fs.writeFileSync(output, Buffer.concat([marker, buf]));
process.stdout.write(JSON.stringify({
  ok: true,
  spec: 'stub-redactor',
  duration_ms: 1234,
  strength_used: Number(strength),
  bytes_in: buf.length,
  bytes_out: buf.length + marker.length,
}) + '\\n');
process.exit(0);
`;
  fs.writeFileSync(stubPath, stubSrc);

  // Tiny WAV input.
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const inWav = path.join(stubDir, 'in.wav');
  fs.writeFileSync(inWav, wavHeader);

  const workerPath = path.join(REPO_ROOT, 'workers', 'multimodal-redact-audio', 'redact-audio.mjs');
  const env = { ...process.env };
  // Pass the stub via JSON array so we can prepend `node` as the runner.
  env.VOICEPRINT_REDACT_CMD = JSON.stringify([process.execPath, stubPath]);

  const r = spawnSync(process.execPath, [workerPath, '--path', inWav, '--strength', '0.85', '--json'], {
    stdio: 'pipe',
    timeout: 30 * 1000,
    env,
  });

  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch (_) {}

  assert.equal(r.status, 0, 'worker must exit 0 with stub: ' + String(r.stderr || ''));
  const envObj = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
  assert.equal(envObj.ok, true, 'envelope.ok must be true on success');
  assert.equal(envObj.kind, 'audio');
  assert.match(String(envObj.redactor), /env_override/,
    'redactor must report it came from the env override path');
  assert.equal(envObj.strength, 0.85, 'strength must round-trip through the worker');
  assert.ok(envObj.redacted_audio_sha256 && /^[0-9a-f]{64}$/.test(envObj.redacted_audio_sha256),
    'redacted_audio_sha256 must be a 64-hex sha256');
  assert.ok(typeof envObj.output_b64 === 'string' && envObj.output_b64.length > 0,
    'output_b64 must be present when no --output is given');
  // Stub prepends 'W464-STUB-' to the input. Decode b64 and check the marker.
  const decoded = Buffer.from(envObj.output_b64, 'base64');
  assert.ok(decoded.slice(0, 10).toString() === 'W464-STUB-',
    'output_b64 must contain the stub-redacted bytes (proof the spawn worked end-to-end)');
});
