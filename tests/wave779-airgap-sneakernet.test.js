// W779 - Air-gapped formal mode + sneakernet deployment.
//
// Atomic items pinned (matches src/airgap-mode.js + src/sneakernet.js):
//
//   1)  AIRGAP_MODE_VERSION + SNEAKERNET_VERSION match /^w779-/ (W604)
//   2)  isAirgapped() honors KOLM_AIRGAP env (true when '1', false otherwise)
//   3)  wrapFetch blocks non-loopback URLs when airgapped
//   4)  wrapFetch allows localhost/127.0.0.1/0.0.0.0 even when airgapped
//   5)  wrapFetch allows KOLM_LOCAL_TEACHER_URL even when airgapped
//   6)  wrapFetch is transparent when not airgapped
//   7)  captureFromLocalOllama returns honest envelope on missing
//       KOLM_LOCAL_TEACHER_URL (never silent passthrough)
//   8)  captureFromLocalOllama happy path via stubbed local HTTP server
//   9)  testNetworkLeak honest envelope when not airgapped
//       (returns {ok:true, leaked:false, hits:[]})
//   10) packSneakernet creates the archive file at dest_path
//   11) packSneakernet records sha256 over the archive bytes
//   12) packSneakernet returns artifact_not_found envelope when source missing
//   13) unpackSneakernet roundtrip: pack then unpack returns same artifact_id
//       with verified:true
//   14) unpackSneakernet rejects mismatched signature (verified:false)
//   15) Route GET /v1/airgap/status: 401 w/o auth; 200 w/ auth
//   16) Route POST /v1/sneakernet/pack: 401 w/o auth; 200/400 w/ auth
//   17) CLI `kolm airgap --help` exits 0
//   18) CLI `kolm pack --sneakernet --help` exits 0
//   19) W604 sibling: tests/wave(\d{3,4})-*.test.js >= 5 found
//   20) airgapStatus() shape lock (read-only envelope)
//   21) AIRGAP_LOOPBACK_HOSTS frozen + carries 'localhost' + '127.0.0.1'
//
// W604 anti-brittleness: every version check uses /^w779-/ (NEVER an
// explicit equality on a literal). Sibling count uses regex + threshold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AIRGAP_MODE_VERSION,
  AIRGAP_LOOPBACK_HOSTS,
  isAirgapped,
  localTeacherUrl,
  wrapFetch,
  testNetworkLeak,
  captureFromLocalOllama,
  airgapStatus,
} from '../src/airgap-mode.js';

import {
  SNEAKERNET_VERSION,
  packSneakernet,
  unpackSneakernet,
} from '../src/sneakernet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w779-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  // Wipe both env switches so tests start from a known clean state.
  delete process.env.KOLM_AIRGAP;
  delete process.env.KOLM_LOCAL_TEACHER_URL;
  delete process.env.KOLM_LOCAL_TEACHER_MODEL;
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps (W604 regex - never explicit equality)
// =============================================================================

test('W779 #1 - AIRGAP_MODE_VERSION + SNEAKERNET_VERSION match /^w779-/', () => {
  freshDir();
  assert.ok(/^w779-/.test(AIRGAP_MODE_VERSION),
    `expected AIRGAP_MODE_VERSION to match /^w779-/; got ${JSON.stringify(AIRGAP_MODE_VERSION)}`);
  assert.ok(/^w779-/.test(SNEAKERNET_VERSION),
    `expected SNEAKERNET_VERSION to match /^w779-/; got ${JSON.stringify(SNEAKERNET_VERSION)}`);
});

// =============================================================================
// 2) isAirgapped() honors env
// =============================================================================

test('W779 #2 - isAirgapped() honors KOLM_AIRGAP env (true only when "1")', () => {
  freshDir();
  // Default - off.
  assert.equal(isAirgapped(), false, 'unset KOLM_AIRGAP must read as false');
  // '1' - on.
  process.env.KOLM_AIRGAP = '1';
  assert.equal(isAirgapped(), true, 'KOLM_AIRGAP=1 must read as true');
  // 'true' / 'yes' / 'on' MUST NOT be coerced - we are strict.
  process.env.KOLM_AIRGAP = 'true';
  assert.equal(isAirgapped(), false, 'KOLM_AIRGAP=true MUST NOT be coerced to true');
  process.env.KOLM_AIRGAP = '0';
  assert.equal(isAirgapped(), false, 'KOLM_AIRGAP=0 must read as false');
  delete process.env.KOLM_AIRGAP;
});

// =============================================================================
// 3) wrapFetch blocks non-loopback URLs when airgapped
// =============================================================================

test('W779 #3 - wrapFetch blocks non-loopback URLs when airgapped', async () => {
  freshDir();
  process.env.KOLM_AIRGAP = '1';
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { status: 200 }; };
  const wrapped = wrapFetch(fakeFetch);
  let threw = null;
  try {
    await wrapped('https://api.openai.com/v1/models');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'wrapFetch must throw on non-loopback URL when airgapped');
  assert.equal(threw.airgap_blocked, true,
    'thrown error MUST carry airgap_blocked:true marker');
  assert.equal(threw.envelope && threw.envelope.error, 'airgap_blocks_network',
    'envelope.error MUST be airgap_blocks_network');
  assert.ok(/^w779-/.test(threw.envelope.version),
    'envelope.version MUST match /^w779-/');
  assert.equal(calls, 0, 'real fetch MUST NOT have been called');
  delete process.env.KOLM_AIRGAP;
});

// =============================================================================
// 4) wrapFetch allows loopback hosts even when airgapped
// =============================================================================

test('W779 #4 - wrapFetch allows localhost/127.0.0.1/0.0.0.0/::1 when airgapped', async () => {
  freshDir();
  process.env.KOLM_AIRGAP = '1';
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { status: 200 }; };
  const wrapped = wrapFetch(fakeFetch);
  const allowedUrls = [
    'http://localhost:8080/v1/health',
    'http://127.0.0.1:11434/api/generate',
    'http://0.0.0.0:9000/ping',
    'http://[::1]:8080/v1/health',
  ];
  for (const url of allowedUrls) {
    const resp = await wrapped(url);
    assert.equal(resp.status, 200, `loopback URL ${url} must pass through`);
  }
  assert.equal(calls, allowedUrls.length,
    `expected ${allowedUrls.length} pass-throughs; got ${calls}`);
  delete process.env.KOLM_AIRGAP;
});

// =============================================================================
// 5) wrapFetch allows KOLM_LOCAL_TEACHER_URL even when airgapped
// =============================================================================

test('W779 #5 - wrapFetch allows KOLM_LOCAL_TEACHER_URL host when airgapped', async () => {
  freshDir();
  process.env.KOLM_AIRGAP = '1';
  process.env.KOLM_LOCAL_TEACHER_URL = 'http://10.0.0.5:11434';
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { status: 200 }; };
  const wrapped = wrapFetch(fakeFetch);
  const resp = await wrapped('http://10.0.0.5:11434/api/generate');
  assert.equal(resp.status, 200, 'teacher URL must pass through');
  assert.equal(calls, 1);
  // Different host on same LAN MUST still be blocked.
  let threw = null;
  try {
    await wrapped('http://10.0.0.6:11434/api/generate');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'non-teacher LAN host MUST be blocked even on same subnet');
  assert.equal(threw.envelope.error, 'airgap_blocks_network');
  delete process.env.KOLM_AIRGAP;
  delete process.env.KOLM_LOCAL_TEACHER_URL;
});

// =============================================================================
// 6) wrapFetch transparent when not airgapped
// =============================================================================

test('W779 #6 - wrapFetch passes through to real fetch when NOT airgapped', async () => {
  freshDir();
  // KOLM_AIRGAP unset by freshDir().
  let calls = 0;
  let lastUrl = null;
  const fakeFetch = async (u) => { calls += 1; lastUrl = u; return { status: 418 }; };
  const wrapped = wrapFetch(fakeFetch);
  const r = await wrapped('https://api.anthropic.com/v1/messages');
  assert.equal(r.status, 418);
  assert.equal(calls, 1, 'wrapped fetch MUST call through when not airgapped');
  assert.equal(lastUrl, 'https://api.anthropic.com/v1/messages',
    'wrapped fetch MUST NOT mutate URL');
});

// =============================================================================
// 7) captureFromLocalOllama honest envelope on missing teacher URL
// =============================================================================

test('W779 #7 - captureFromLocalOllama returns honest envelope when KOLM_LOCAL_TEACHER_URL unset', async () => {
  freshDir();
  // KOLM_LOCAL_TEACHER_URL deleted by freshDir.
  const env = await captureFromLocalOllama({ prompt: 'hello' });
  assert.equal(env.ok, false, 'missing teacher URL MUST yield ok:false');
  assert.equal(env.error, 'local_teacher_unconfigured');
  assert.ok(typeof env.hint === 'string' && env.hint.includes('KOLM_LOCAL_TEACHER_URL'),
    'hint MUST mention KOLM_LOCAL_TEACHER_URL');
  assert.ok(/^w779-/.test(env.version));
});

// =============================================================================
// 8) captureFromLocalOllama happy path via stubbed local HTTP server
// =============================================================================

test('W779 #8 - captureFromLocalOllama happy path via stubbed local HTTP server', async () => {
  freshDir();
  // Spin up a tiny HTTP server that mimics Ollama /api/generate.
  let sawRequest = null;
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sawRequest = { method: req.method, url: req.url, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'llama3-fixture',
          response: 'hello, world',
          done: true,
        }));
      });
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    process.env.KOLM_LOCAL_TEACHER_URL = `http://127.0.0.1:${port}`;
    const env = await captureFromLocalOllama({
      prompt: 'hi',
      model: 'llama3-fixture',
      tenant: 't_fix',
    });
    assert.equal(env.ok, true, `expected ok:true; got ${JSON.stringify(env)}`);
    assert.equal(env.response_text, 'hello, world');
    assert.equal(env.model_used, 'llama3-fixture');
    assert.equal(env.tenant, 't_fix');
    assert.ok(/^w779-/.test(env.version));
    assert.equal(sawRequest.method, 'POST');
    assert.equal(sawRequest.url, '/api/generate');
    const sent = JSON.parse(sawRequest.body);
    assert.equal(sent.prompt, 'hi');
    assert.equal(sent.model, 'llama3-fixture');
    assert.equal(sent.stream, false);
  } finally {
    await new Promise((r) => srv.close(r));
    delete process.env.KOLM_LOCAL_TEACHER_URL;
  }
});

// =============================================================================
// 9) testNetworkLeak honest envelope (shape-only by default)
// =============================================================================

test('W779 #9 - testNetworkLeak shape envelope when not airgapped (no real network call)', async () => {
  freshDir();
  const env = await testNetworkLeak();
  assert.equal(env.ok, true);
  assert.equal(env.leaked, false);
  assert.deepEqual(env.hits, []);
  assert.deepEqual(env.probed_urls, []);
  assert.equal(env.airgap_active, false);
  assert.equal(env.local_teacher_url, null);
  assert.ok(/^w779-/.test(env.version));
});

// =============================================================================
// 10) packSneakernet writes archive at dest_path
// =============================================================================

test('W779 #10 - packSneakernet creates archive file at dest_path', () => {
  const tmp = freshDir();
  const srcPath = path.join(tmp, 'artifact.kolm');
  fs.writeFileSync(srcPath, Buffer.from('fixture .kolm contents - any bytes work\n'));
  const destPath = path.join(tmp, 'bundle.tar');
  const env = packSneakernet({
    artifact_id: 'art_fix_01',
    artifact_path: srcPath,
    dest_path: destPath,
    tenant: 't_fix',
  });
  assert.equal(env.ok, true, `expected ok:true; got ${JSON.stringify(env)}`);
  assert.equal(env.path, destPath);
  assert.ok(fs.existsSync(destPath), 'archive file MUST exist on disk');
  const written = fs.readFileSync(destPath);
  assert.ok(written.length > 0, 'archive MUST have non-zero bytes');
  assert.equal(env.bytes, written.length, 'env.bytes MUST match on-disk length');
  assert.equal(env.tenant, 't_fix');
  assert.ok(/^w779-/.test(env.version));
});

// =============================================================================
// 11) packSneakernet records sha256 over archive bytes
// =============================================================================

test('W779 #11 - packSneakernet records sha256 of the archive bytes', () => {
  const tmp = freshDir();
  const srcPath = path.join(tmp, 'a.kolm');
  fs.writeFileSync(srcPath, Buffer.from('payload for sha256 lock-in\n'));
  const destPath = path.join(tmp, 'bundle.tar');
  const env = packSneakernet({
    artifact_id: 'art_sha',
    artifact_path: srcPath,
    dest_path: destPath,
  });
  assert.equal(env.ok, true);
  const archiveBytes = fs.readFileSync(destPath);
  const expected = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  assert.equal(env.sha256, expected,
    `env.sha256 MUST match sha256 of the on-disk archive; got ${env.sha256} expected ${expected}`);
  // The artifact sha256 is independent + also exposed.
  const artExpected = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
  assert.equal(env.sha256_artifact, artExpected,
    'env.sha256_artifact MUST match sha256 of the source .kolm');
});

// =============================================================================
// 12) packSneakernet honest envelope when artifact missing
// =============================================================================

test('W779 #12 - packSneakernet returns artifact_not_found envelope when source missing', () => {
  const tmp = freshDir();
  const destPath = path.join(tmp, 'bundle.tar');
  const env = packSneakernet({
    artifact_id: 'art_missing',
    artifact_path: path.join(tmp, 'does-not-exist.kolm'),
    dest_path: destPath,
  });
  assert.equal(env.ok, false, 'missing artifact MUST yield ok:false');
  assert.equal(env.error, 'artifact_not_found');
  assert.ok(/^w779-/.test(env.version));
  assert.ok(!fs.existsSync(destPath), 'destPath MUST NOT be written on failure');
});

// =============================================================================
// 13) unpackSneakernet roundtrip happy path
// =============================================================================

test('W779 #13 - unpackSneakernet roundtrip returns verified:true + matching artifact_id', () => {
  const tmp = freshDir();
  const srcPath = path.join(tmp, 'round.kolm');
  fs.writeFileSync(srcPath, Buffer.from('roundtrip bytes ' + crypto.randomBytes(8).toString('hex')));
  const tarPath = path.join(tmp, 'bundle.tar');
  const packed = packSneakernet({
    artifact_id: 'art_round_01',
    artifact_path: srcPath,
    dest_path: tarPath,
    tenant: 't_round',
  });
  assert.equal(packed.ok, true);

  const destDir = path.join(tmp, 'unpacked');
  const unpacked = unpackSneakernet({ src_path: tarPath, dest_dir: destDir });
  assert.equal(unpacked.ok, true, `unpack envelope: ${JSON.stringify(unpacked)}`);
  assert.equal(unpacked.artifact_id, 'art_round_01');
  assert.equal(unpacked.verified, true, 'roundtrip MUST verify');
  assert.equal(unpacked.sha_matches, true, 'sha256 MUST match across roundtrip');
  assert.equal(unpacked.trustworthy, true,
    'trustworthy MUST be (verified && sha_matches)');
  assert.ok(unpacked.artifact_path && fs.existsSync(unpacked.artifact_path),
    'verified unpack MUST write artifact under dest_dir');
  // Body bytes preserved exactly.
  const restored = fs.readFileSync(unpacked.artifact_path);
  const original = fs.readFileSync(srcPath);
  assert.deepEqual(restored, original, 'restored artifact bytes MUST equal source');
  assert.ok(/^w779-/.test(unpacked.version));
});

// =============================================================================
// 14) unpackSneakernet rejects mismatched signature
// =============================================================================

test('W779 #14 - unpackSneakernet rejects mismatched signature (verified:false, no write)', () => {
  const tmp = freshDir();
  const srcPath = path.join(tmp, 'tamper.kolm');
  fs.writeFileSync(srcPath, Buffer.from('original honest bytes\n'));
  const tarPath = path.join(tmp, 'bundle.tar');
  const packed = packSneakernet({
    artifact_id: 'art_tamper',
    artifact_path: srcPath,
    dest_path: tarPath,
  });
  assert.equal(packed.ok, true);

  // Tamper: re-pack with a DIFFERENT secret so the signature embedded in the
  // archive cannot match the verifier's HMAC under the default secret.
  const tarPath2 = path.join(tmp, 'bundle-tampered.tar');
  const packedWithEvilKey = packSneakernet({
    artifact_id: 'art_tamper',
    artifact_path: srcPath,
    dest_path: tarPath2,
    secret: 'a-different-evil-secret',
  });
  assert.equal(packedWithEvilKey.ok, true);

  // Try to unpack the tampered archive with the default (correct) secret.
  const destDir = path.join(tmp, 'unpacked-tampered');
  const unpacked = unpackSneakernet({
    src_path: tarPath2,
    dest_dir: destDir,
    secret: 'kolm-public-fixture-v0-1-0',
  });
  assert.equal(unpacked.ok, true, 'envelope returns ok:true (signal lives in verified)');
  assert.equal(unpacked.verified, false,
    `tampered bundle MUST NOT verify; envelope=${JSON.stringify(unpacked)}`);
  assert.equal(unpacked.trustworthy, false,
    'trustworthy MUST be false when verified is false');
  // Crucial honesty invariant: unverified bytes MUST NOT escape past unpack.
  assert.equal(unpacked.artifact_path, null,
    'unverified unpack MUST NOT write artifact to dest_dir');
  assert.ok(!fs.existsSync(path.join(destDir, 'art_tamper.kolm')),
    'no artifact file on disk under dest_dir for unverified unpack');
});

// =============================================================================
// 15) Route GET /v1/airgap/status (401 w/o auth; 200 w/ auth)
// =============================================================================

test('W779 #15 - GET /v1/airgap/status 401 w/o auth; 200 envelope w/ auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/airgap/status`);
    assert.equal(noAuth.status, 401, `expected 401; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/airgap/status`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(typeof env.enabled, 'boolean');
    assert.ok(env.mode === 'airgapped' || env.mode === 'networked',
      `mode MUST be airgapped|networked; got ${env.mode}`);
    assert.ok(/^w779-/.test(env.version), 'version MUST match /^w779-/');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) Route POST /v1/sneakernet/pack (401 w/o auth; happy w/ auth)
// =============================================================================

test('W779 #16 - POST /v1/sneakernet/pack 401 w/o auth; 200 envelope w/ auth', async () => {
  const tmp = freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  // Seed a fixture artifact on disk so pack has something real to bundle.
  const srcPath = path.join(tmp, 'route-art.kolm');
  fs.writeFileSync(srcPath, Buffer.from('route fixture bytes\n'));
  const destPath = path.join(tmp, 'route-bundle.tar');

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth - 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/sneakernet/pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: 'a1', artifact_path: srcPath, dest_path: destPath }),
    });
    assert.equal(noAuth.status, 401, `expected 401; got ${noAuth.status}`);

    // Auth + happy - 200.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/sneakernet/pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        artifact_id: 'a1',
        artifact_path: srcPath,
        dest_path: destPath,
      }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true, `pack envelope: ${JSON.stringify(env)}`);
    assert.equal(env.path, destPath);
    assert.ok(/^w779-/.test(env.version));
    assert.ok(fs.existsSync(destPath), 'route MUST have written archive to disk');

    // Auth + invalid (missing artifact_path) - 400 honest envelope.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/sneakernet/pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ artifact_id: 'a2' }),
    });
    assert.equal(bad.status, 400, `expected 400 on missing artifact_path; got ${bad.status}`);
    const badEnv = await bad.json();
    assert.equal(badEnv.ok, false);
    assert.ok(typeof badEnv.error === 'string' && badEnv.error.length > 0);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 17) CLI `kolm airgap --help` exits 0
// =============================================================================

test('W779 #17 - CLI `kolm airgap --help` exits 0', () => {
  freshDir();
  const out = spawnSync(process.execPath, [CLI_PATH, 'airgap', '--help'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(out.status, 0,
    `expected exit 0; got ${out.status}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  assert.ok((out.stdout + out.stderr).toLowerCase().includes('airgap'),
    'help output MUST mention airgap');
});

// =============================================================================
// 18) CLI `kolm pack --sneakernet --help` exits 0
// =============================================================================

test('W779 #18 - CLI `kolm pack --sneakernet --help` exits 0', () => {
  freshDir();
  const out = spawnSync(process.execPath, [CLI_PATH, 'pack', '--sneakernet', '--help'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(out.status, 0,
    `expected exit 0; got ${out.status}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  assert.ok((out.stdout + out.stderr).toLowerCase().includes('sneakernet'),
    'help output MUST mention sneakernet');
});

// =============================================================================
// 19) W604 sibling: tests/wave(\d{3,4})-*.test.js >= 5 found
// =============================================================================

test('W779 #19 - tests/ has >= 5 wave(\\d{3,4})-*.test.js siblings (W604 regex + threshold)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => re.test(n));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// =============================================================================
// 20) airgapStatus() envelope shape (read-only - no auth needed)
// =============================================================================

test('W779 #20 - airgapStatus() envelope shape (enabled bool, mode str, env object, version /^w779-/)', () => {
  freshDir();
  const s = airgapStatus();
  assert.equal(s.ok, true);
  assert.equal(typeof s.enabled, 'boolean');
  assert.ok(s.mode === 'airgapped' || s.mode === 'networked');
  assert.equal(typeof s.env, 'object');
  // env block surfaces the canonical airgap-related env vars - keys MUST be
  // present (values may be null).
  for (const key of [
    'KOLM_AIRGAP',
    'TRANSFORMERS_OFFLINE',
    'HF_DATASETS_OFFLINE',
    'HF_HUB_OFFLINE',
    'KOLM_LOCAL_TEACHER_URL',
  ]) {
    assert.ok(key in s.env, `airgapStatus().env MUST surface ${key}`);
  }
  assert.ok(/^w779-/.test(s.version));
});

// =============================================================================
// 21) AIRGAP_LOOPBACK_HOSTS frozen + carries canonical entries
// =============================================================================

test('W779 #21 - AIRGAP_LOOPBACK_HOSTS frozen + carries localhost + 127.0.0.1', () => {
  freshDir();
  assert.ok(Object.isFrozen(AIRGAP_LOOPBACK_HOSTS),
    'AIRGAP_LOOPBACK_HOSTS MUST be Object.freeze()-d');
  assert.ok(AIRGAP_LOOPBACK_HOSTS.includes('localhost'),
    'AIRGAP_LOOPBACK_HOSTS MUST include "localhost"');
  assert.ok(AIRGAP_LOOPBACK_HOSTS.includes('127.0.0.1'),
    'AIRGAP_LOOPBACK_HOSTS MUST include "127.0.0.1"');
  assert.ok(AIRGAP_LOOPBACK_HOSTS.includes('0.0.0.0'),
    'AIRGAP_LOOPBACK_HOSTS MUST include "0.0.0.0"');
});

// =============================================================================
// 22) localTeacherUrl() reads env fresh (no caching)
// =============================================================================

test('W779 #22 - localTeacherUrl() reads env fresh on every call (no caching)', () => {
  freshDir();
  assert.equal(localTeacherUrl(), null, 'unset MUST yield null');
  process.env.KOLM_LOCAL_TEACHER_URL = 'http://127.0.0.1:11434';
  assert.equal(localTeacherUrl(), 'http://127.0.0.1:11434',
    'after-set MUST return the new value (no caching)');
  process.env.KOLM_LOCAL_TEACHER_URL = '   '; // whitespace-only
  assert.equal(localTeacherUrl(), null,
    'whitespace-only MUST be treated as unset');
  delete process.env.KOLM_LOCAL_TEACHER_URL;
});
