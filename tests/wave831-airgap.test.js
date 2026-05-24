// W831 — Offline / air-gapped mode integration tests.
//
// Pins (12 named in the spec; we ship 12+ for headroom):
//
//   #1   offlineDistill rejects when KOLM_TEACHER_API_KEY is set
//   #2   verifyTeacherIsLocal accepts 127.0.0.1
//   #3   verifyTeacherIsLocal accepts localhost
//   #4   verifyTeacherIsLocal rejects api.openai.com
//   #5   createSneakernetBundle writes a tarball with the expected entries
//   #6   verifySneakernetBundle round-trip with a valid Ed25519 key -> ok:true
//        (signature_ok:true AND recipient_ok:true)
//   #7   verifySneakernetBundle with a tampered bundle -> signature_ok:false
//   #8   airgapBakeoff returns ranked results
//   #9   /v1/airgap/doctor shape (network_reachable, teacher_local,
//        signing_key_present)
//   #10  docs/airgap/CLASSIFIED_DEPLOYMENT.md exists + has all 6 spec sections
//   #11  W604 regex check — all four W831 module version stamps match /^w831-/
//        (NEVER an explicit equality)
//   #12  public/sw.js carries the '-wave831-airgap' suffix
//
// W604 anti-brittleness: every version check uses /^w831-/. Sibling counts
// use regex + threshold, NEVER an explicit array.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  offlineDistill,
  getOfflineDistillStatus,
  AIRGAP_DISTILL_VERSION,
} from '../src/airgap-distill.js';

import {
  verifyTeacherIsLocal,
  PolicyBlockError,
  AIRGAP_TEACHER_VERSION,
} from '../src/airgap-teacher.js';

import {
  createSneakernetBundle,
  verifySneakernetBundle,
  generateEd25519Keypair,
  AIRGAP_SNEAKERNET_VERSION,
} from '../src/airgap-sneakernet.js';

import {
  airgapBakeoff,
  AIRGAP_BAKEOFF_VERSION,
} from '../src/airgap-bakeoff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Fresh-dir harness mirrors wave779 — wipes the airgap env vars so tests
// start from a known clean state and the dial-failure guard sees a
// deterministic shape (we inject a stub fetch in tests, never hit the wire).
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w831-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_TEACHER_API_KEY;
  delete process.env.KOLM_LOCAL_TEACHER_URL;
  delete process.env.KOLM_AIRGAP_SIGNING_KEY;
  // Make sure the trainer worker queue dir exists fresh per test.
  fs.mkdirSync(path.join(tmp, '.kolm', 'airgap-distill-runs'), { recursive: true });
  return tmp;
}

// Inject a stub fetch that ALWAYS throws — simulates a properly air-gapped
// enclave where the OS refuses network egress. Tests pass this in so they
// never actually hit the network.
function airgappedFetch() {
  return async () => {
    const err = new Error('ENOTFOUND example.com');
    err.code = 'ENOTFOUND';
    throw err;
  };
}

// Stub fetch that "succeeds" — simulates a misconfigured enclave with a live
// network connection. Tests for the violation path use this.
function reachableFetch() {
  return async () => ({ status: 200, ok: true });
}

// Seed a small valid jsonl dataset on disk; returns the path.
function seedDataset(tmp, rows) {
  const p = path.join(tmp, 'dataset.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// =============================================================================
// #1 — offlineDistill rejects when KOLM_TEACHER_API_KEY is set
// =============================================================================

test('W831 #1 — offlineDistill rejects when KOLM_TEACHER_API_KEY is present', async () => {
  const tmp = freshDir();
  process.env.KOLM_TEACHER_API_KEY = 'sk-cloud-key-leaked-into-env';
  // Seed minimum fixture files so we don't trip on the fs check before the
  // env check (env check runs FIRST per airgap-distill.js spec).
  const user = path.join(tmp, 'data.jsonl');
  const teacher = path.join(tmp, 'teacher.bin');
  const student = path.join(tmp, 'student.bin');
  const out = path.join(tmp, 'out.kolm');
  fs.writeFileSync(user, '{"prompt":"hi","response":"hello"}\n');
  fs.writeFileSync(teacher, 'teacher-bytes');
  fs.writeFileSync(student, 'student-bytes');
  const env = await offlineDistill({
    user_data_path: user,
    teacher_path_local: teacher,
    student_path_local: student,
    output_path: out,
    fetch: airgappedFetch(),
  });
  assert.equal(env.ok, false, 'envelope must be ok:false when teacher key is set');
  assert.equal(env.error, 'airgap_violation_teacher_key',
    `expected airgap_violation_teacher_key; got ${env.error}`);
  assert.match(env.detail, /KOLM_TEACHER_API_KEY/);
  assert.ok(/^w831-/.test(env.version), 'version must match /^w831-/');
  delete process.env.KOLM_TEACHER_API_KEY;
});

// =============================================================================
// #2 — verifyTeacherIsLocal accepts 127.0.0.1
// =============================================================================

test('W831 #2 — verifyTeacherIsLocal accepts 127.0.0.1', () => {
  freshDir();
  const ok = verifyTeacherIsLocal({ teacher_url: 'http://127.0.0.1:11434' });
  assert.equal(ok.ok, true);
  assert.equal(ok.host, '127.0.0.1');
  assert.equal(ok.kind, 'loopback-ipv4');
  assert.equal(ok.port, '11434');
  assert.ok(/^w831-/.test(ok.version), 'version must match /^w831-/');
});

// =============================================================================
// #3 — verifyTeacherIsLocal accepts localhost
// =============================================================================

test('W831 #3 — verifyTeacherIsLocal accepts localhost (hostname form)', () => {
  freshDir();
  const ok = verifyTeacherIsLocal({ teacher_url: 'http://localhost:8000/v1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.host, 'localhost');
  assert.equal(ok.kind, 'localhost');
  // Bonus: same call also handles IPv6 + unix-socket forms.
  assert.equal(
    verifyTeacherIsLocal({ teacher_url: 'http://[::1]:8000' }).kind,
    'loopback-ipv6'
  );
  assert.equal(
    verifyTeacherIsLocal({ teacher_url: 'unix:/var/run/llama.sock' }).kind,
    'unix-socket'
  );
});

// =============================================================================
// #4 — verifyTeacherIsLocal rejects api.openai.com
// =============================================================================

test('W831 #4 — verifyTeacherIsLocal throws PolicyBlockError on api.openai.com', () => {
  freshDir();
  let thrown;
  try {
    verifyTeacherIsLocal({ teacher_url: 'https://api.openai.com/v1' });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'must throw');
  assert.ok(thrown instanceof PolicyBlockError, 'must throw PolicyBlockError');
  assert.equal(thrown.code, 'teacher_not_local');
  assert.match(thrown.message, /api\.openai\.com/);
});

// =============================================================================
// #5 — createSneakernetBundle writes a tarball with the expected entries
// =============================================================================

test('W831 #5 — createSneakernetBundle writes tar with artifact + manifest + signature + receipt', () => {
  const tmp = freshDir();
  const keys = generateEd25519Keypair();
  const keyPath = path.join(tmp, 'signer.pem');
  fs.writeFileSync(keyPath, keys.private_key_pem);
  const art = path.join(tmp, 'artifact.kolm');
  fs.writeFileSync(art, Buffer.from('w831 fixture bytes\n'));
  const out = path.join(tmp, 'bundle.tar');
  const env = createSneakernetBundle({
    artifact_path: art,
    signing_key_path: keyPath,
    output_usb_path: out,
    artifact_id: 'art-w831-fixture',
  });
  assert.equal(env.ok, true, `pack envelope: ${JSON.stringify(env)}`);
  assert.ok(fs.existsSync(out), 'tarball must exist on disk');
  // Parse the tar and verify each expected entry is present.
  const buf = fs.readFileSync(out);
  // Quick + dirty: look for the USTAR filenames in the raw bytes; if all 4 are
  // present the tar is structurally complete (parseTarArchive in the source
  // module does the full parse — here we just confirm presence).
  const txt = buf.toString('binary');
  assert.ok(txt.includes('artifact.kolm'), 'tar must include artifact.kolm');
  assert.ok(txt.includes('manifest.json'), 'tar must include manifest.json');
  assert.ok(txt.includes('signature.bin'), 'tar must include signature.bin');
  assert.ok(txt.includes('kolm-airgap-receipt.json'),
    'tar must include kolm-airgap-receipt.json');
  assert.ok(/^w831-/.test(env.version));
});

// =============================================================================
// #6 — verifySneakernetBundle round-trip with valid Ed25519 key -> ok:true
// =============================================================================

test('W831 #6 — verifySneakernetBundle round-trip: signature_ok:true + recipient_ok:true', () => {
  const tmp = freshDir();
  const keys = generateEd25519Keypair();
  const keyPath = path.join(tmp, 'signer.pem');
  const pubPath = path.join(tmp, 'trusted-pub.pem');
  fs.writeFileSync(keyPath, keys.private_key_pem);
  fs.writeFileSync(pubPath, keys.public_key_pem);
  const art = path.join(tmp, 'artifact.kolm');
  fs.writeFileSync(art, Buffer.from('w831 round-trip fixture\n'));
  const out = path.join(tmp, 'bundle.tar');
  const packed = createSneakernetBundle({
    artifact_path: art,
    signing_key_path: keyPath,
    output_usb_path: out,
    artifact_id: 'round-trip',
  });
  assert.equal(packed.ok, true);

  const dest = path.join(tmp, 'unpacked');
  const verified = verifySneakernetBundle({
    bundle_path: out,
    trusted_pubkey_path: pubPath,
    extract_to: dest,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.signature_ok, true,
    `signature_ok must be true; got ${JSON.stringify(verified)}`);
  assert.equal(verified.recipient_ok, true,
    `recipient_ok must be true; got ${JSON.stringify(verified)}`);
  assert.equal(verified.trustworthy, true);
  assert.ok(verified.artifact_path, 'artifact must be extracted on trustworthy verify');
  assert.ok(fs.existsSync(verified.artifact_path));
  assert.ok(/^w831-/.test(verified.version));
});

// =============================================================================
// #7 — verifySneakernetBundle with a tampered bundle -> signature_ok:false
// =============================================================================

test('W831 #7 — tampered bundle -> signature_ok:false + artifact NOT extracted', () => {
  const tmp = freshDir();
  // Sender mints a key + packs a bundle.
  const senderKeys = generateEd25519Keypair();
  const senderKey = path.join(tmp, 'sender.pem');
  fs.writeFileSync(senderKey, senderKeys.private_key_pem);
  const art = path.join(tmp, 'artifact.kolm');
  fs.writeFileSync(art, Buffer.from('tampered fixture\n'));
  const out = path.join(tmp, 'bundle.tar');
  const packed = createSneakernetBundle({
    artifact_path: art,
    signing_key_path: senderKey,
    output_usb_path: out,
    artifact_id: 'tampered',
  });
  assert.equal(packed.ok, true);

  // Receiver trusts a DIFFERENT public key (key rotation attack / wrong-key
  // scenario). Verify must fail signature_ok.
  const evilKeys = generateEd25519Keypair();
  const evilPub = path.join(tmp, 'evil-pub.pem');
  fs.writeFileSync(evilPub, evilKeys.public_key_pem);

  const dest = path.join(tmp, 'unpacked');
  const verified = verifySneakernetBundle({
    bundle_path: out,
    trusted_pubkey_path: evilPub,
    extract_to: dest,
  });
  // Structural ok must be true (the verifier ran cleanly); the signature gate
  // must be false (wrong key) and the artifact must NOT be extracted.
  assert.equal(verified.ok, true);
  assert.equal(verified.signature_ok, false,
    `signature_ok must be false for a tampered bundle; got ${JSON.stringify(verified)}`);
  assert.equal(verified.trustworthy, false);
  assert.equal(verified.artifact_path, null,
    'unverified bytes MUST NOT escape past the verifier');
  assert.ok(!fs.existsSync(path.join(dest, 'tampered.kolm')),
    'no artifact file on disk for an unverified bundle');
});

// =============================================================================
// #8 — airgapBakeoff returns ranked results
// =============================================================================

test('W831 #8 — airgapBakeoff returns deterministic ranked results', async () => {
  const tmp = freshDir();
  const dataset = seedDataset(tmp, [
    { input: 'two plus two', expected_output: 'four' },
    { input: 'capital of France', expected_output: 'Paris' },
  ]);
  // Two artifacts: one whose stub output overlaps expected_output strongly,
  // one that produces gibberish. The strong overlap must rank #1.
  const ranked = await airgapBakeoff({
    artifacts: [
      { id: 'overlap-strong' },
      { id: 'overlap-weak' },
    ],
    dataset_path_local: dataset,
    invokeFn: async ({ artifact, input }) => {
      if (artifact.id === 'overlap-strong') {
        if (input === 'two plus two') return { ok: true, output: 'four' };
        return { ok: true, output: 'Paris is the capital of France' };
      }
      return { ok: true, output: 'zzz nonsense gibberish' };
    },
    fetch: airgappedFetch(),
  });
  assert.equal(ranked.ok, true, `bakeoff envelope: ${JSON.stringify(ranked)}`);
  assert.equal(ranked.airgap_verified, true);
  assert.equal(ranked.verification_method, 'no_network_dial');
  assert.equal(ranked.dataset_rows, 2);
  assert.equal(ranked.artifact_count, 2);
  assert.equal(ranked.ranked.length, 2);
  assert.equal(ranked.ranked[0].rank, 1);
  assert.equal(ranked.ranked[0].artifact_id, 'overlap-strong',
    `expected overlap-strong at rank 1; got ${JSON.stringify(ranked.ranked)}`);
  assert.equal(ranked.ranked[1].artifact_id, 'overlap-weak');
  assert.ok(ranked.ranked[0].mean_score > ranked.ranked[1].mean_score,
    'strong overlap must beat weak overlap');
  assert.ok(/^w831-/.test(ranked.version));
});

// Bonus: bakeoff aborts when network is reachable (the dial-failure guard
// catches the misconfig before any artifact is invoked).
test('W831 #8b — airgapBakeoff aborts when network is reachable', async () => {
  const tmp = freshDir();
  const dataset = seedDataset(tmp, [
    { input: 'x', expected_output: 'x' },
  ]);
  let invokeCalled = false;
  const env = await airgapBakeoff({
    artifacts: [{ id: 'a' }],
    dataset_path_local: dataset,
    invokeFn: async () => {
      invokeCalled = true;
      return { ok: true, output: 'x' };
    },
    fetch: reachableFetch(),
  });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'airgap_violation_network_reachable');
  assert.equal(invokeCalled, false,
    'invokeFn MUST NOT be called once the dial-failure guard trips');
});

// =============================================================================
// #9 — /v1/airgap/doctor shape
// =============================================================================

test('W831 #9 — GET /v1/airgap/doctor 401 w/o auth; envelope shape w/ auth', async () => {
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

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/airgap/doctor`);
    assert.equal(noAuth.status, 401, `expected 401 w/o auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/airgap/doctor`, {
      headers: { authorization: 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 w/ auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(typeof env.network_reachable, 'boolean',
      'network_reachable MUST be a boolean');
    assert.equal(typeof env.teacher_local, 'boolean',
      'teacher_local MUST be a boolean');
    assert.equal(typeof env.signing_key_present, 'boolean',
      'signing_key_present MUST be a boolean');
    assert.ok(/^w831-/.test(env.version), 'version MUST match /^w831-/');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// #10 — CLASSIFIED_DEPLOYMENT.md exists + has all 6 sections (spec list)
// =============================================================================

test('W831 #10 — docs/airgap/CLASSIFIED_DEPLOYMENT.md exists + carries all 6 sections', () => {
  freshDir();
  const docPath = path.join(REPO_ROOT, 'docs', 'airgap', 'CLASSIFIED_DEPLOYMENT.md');
  assert.ok(fs.existsSync(docPath), `expected ${docPath} to exist`);
  const text = fs.readFileSync(docPath, 'utf8').toLowerCase();
  // The spec calls out 6 required sections: threat model, hardware requirements,
  // provisioning workflow, key rotation, audit chain, decommissioning.
  // We use case-insensitive substring matching so headings can be styled freely.
  const required = [
    'threat model',
    'hardware requirements',
    'provisioning workflow',
    'key rotation',
    'audit chain',
    'decommissioning',
  ];
  for (const heading of required) {
    assert.ok(text.includes(heading.toLowerCase()),
      `CLASSIFIED_DEPLOYMENT.md MUST contain the "${heading}" section`);
  }
  // Spec asks for ~400 words. Allow slack on both sides.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount >= 200,
    `CLASSIFIED_DEPLOYMENT.md word count ${wordCount} is too short (need >=200)`);
});

// =============================================================================
// #11 — W604 regex check on all four W831 module version stamps
// =============================================================================

test('W831 #11 — all W831 version stamps match /^w831-/ (NEVER explicit equality)', () => {
  freshDir();
  for (const [label, v] of [
    ['AIRGAP_DISTILL_VERSION', AIRGAP_DISTILL_VERSION],
    ['AIRGAP_TEACHER_VERSION', AIRGAP_TEACHER_VERSION],
    ['AIRGAP_SNEAKERNET_VERSION', AIRGAP_SNEAKERNET_VERSION],
    ['AIRGAP_BAKEOFF_VERSION', AIRGAP_BAKEOFF_VERSION],
  ]) {
    assert.ok(/^w831-/.test(v),
      `expected ${label} to match /^w831-/; got ${JSON.stringify(v)}`);
  }
});

// =============================================================================
// #12 — public/sw.js bumped with '-wave831-airgap' suffix
// =============================================================================

test('W831 #12 — public/sw.js cache name carries the wave831 token', () => {
  freshDir();
  const swPath = path.join(REPO_ROOT, 'public', 'sw.js');
  assert.ok(fs.existsSync(swPath), 'public/sw.js MUST exist');
  const head = fs.readFileSync(swPath, 'utf8').slice(0, 4000);
  // W604: assert via regex + threshold, never an explicit literal. The cache
  // name MUST carry the wave831 token AND have a wave number >= 831.
  const m = head.match(/wave(\d{3,4})-airgap/);
  assert.ok(m, `expected /wave\\d{3,4}-airgap/ in sw.js head; got first 200 chars:\n${head.slice(0, 200)}`);
  const wave = parseInt(m[1], 10);
  assert.ok(wave >= 831,
    `expected wave token >= 831; got wave${wave}`);
});

// =============================================================================
// Bonus: route 401 w/o auth + 400 on bad input for POST /v1/airgap/distill/run
// (gives the test suite extra coverage on the distill route surface)
// =============================================================================

test('W831 #13 — POST /v1/airgap/distill/run: 401 w/o auth; 400 on missing paths', async () => {
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

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/airgap/distill/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noAuth.status, 401, `expected 401 w/o auth; got ${noAuth.status}`);

    const badPath = await fetch(`http://127.0.0.1:${port}/v1/airgap/distill/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(badPath.status, 400, `expected 400 on missing paths; got ${badPath.status}`);
    const badEnv = await badPath.json();
    assert.equal(badEnv.ok, false);
    assert.ok(typeof badEnv.error === 'string' && badEnv.error.length > 0);
    assert.ok(/^w831-/.test(badEnv.version));
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// Bonus: getOfflineDistillStatus round-trip — queue a run, fetch its status.
// =============================================================================

test('W831 #14 — offlineDistill round-trip queue + getOfflineDistillStatus', async () => {
  const tmp = freshDir();
  const user = path.join(tmp, 'data.jsonl');
  const teacher = path.join(tmp, 'teacher.bin');
  const student = path.join(tmp, 'student.bin');
  const out = path.join(tmp, 'out.kolm');
  fs.writeFileSync(user, '{"prompt":"hi","response":"hello"}\n');
  fs.writeFileSync(teacher, 'teacher-bytes');
  fs.writeFileSync(student, 'student-bytes');
  const queued = await offlineDistill({
    user_data_path: user,
    teacher_path_local: teacher,
    student_path_local: student,
    output_path: out,
    fetch: airgappedFetch(),
  });
  assert.equal(queued.ok, true, `queue envelope: ${JSON.stringify(queued)}`);
  assert.equal(queued.airgap_verified, true);
  assert.equal(queued.verification_method, 'no_network_dial');
  assert.equal(queued.status, 'queued');
  assert.ok(queued.run_id && queued.run_id.startsWith('airgap_'));
  // Status lookup must return the same spec.
  const looked = getOfflineDistillStatus({ run_id: queued.run_id });
  assert.equal(looked.ok, true);
  assert.equal(looked.run_id, queued.run_id);
  assert.equal(looked.status, 'queued');
  // Unknown id surfaces honest envelope.
  const missing = getOfflineDistillStatus({ run_id: 'nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'run_not_found');
});
