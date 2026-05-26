// W888-C — Device Registry + adapters + CLI/HTTP lock-ins (18 tests).
//
// These tests cover the W888-C surface added in this wave:
//   - src/device-registry.js                (single-file JSON registry)
//   - src/device-caps.js                    (hardware probe over ssh|local)
//   - src/device-adapters/{ssh,local,ollama,k8s,runpod,modal}-adapter.js
//   - cli/kolm.js cmdDevices                (add / list / show / probe / remove)
//   - src/router.js /v1/devices/* W888-C    (register / list / probe /
//                                             heartbeat / delete / get)
//
// Constraints:
//   - node --test --test-concurrency=1 (top-level tests serialize naturally;
//     we never spawn parallel servers inside one test).
//   - No real SSH connections. Adapter and deviceCaps tests inject a mock
//     SSHConnectionClass; the HTTP test stands up a real server only against
//     the registry endpoints (no SSH calls).
//   - kubectl may not be on PATH — the k8s test asserts only on the "missing"
//     branch + the printOnly render path, never on a real apply.
//   - Tests must run on Windows + Linux + macOS; no /bin/bash, no &&-chaining.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DeviceRegistry, DEVICE_TYPES_LIST, DEVICE_STATUSES } from '../src/device-registry.js';
import { deviceCaps } from '../src/device-caps.js';
import * as sshAdapter from '../src/device-adapters/ssh-adapter.js';
import * as ollamaAdapter from '../src/device-adapters/ollama-adapter.js';
import * as k8sAdapter from '../src/device-adapters/k8s-adapter.js';
import * as runpodAdapter from '../src/device-adapters/runpod-adapter.js';
import * as modalAdapter from '../src/device-adapters/modal-adapter.js';

import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

function freshScratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w888c-${label}-`));
}

// Build a registry isolated to a freshly-minted scratch dir, so each test
// gets a clean data/devices.json.
function makeIsolatedRegistry(label) {
  const scratch = freshScratch(label);
  const registry = new DeviceRegistry({ dataDir: scratch });
  return { registry, scratch, cleanup: () => rmSyncBestEffort(scratch) };
}

function makeFakeArtifact(label) {
  const scratch = freshScratch(label);
  const artifactPath = path.join(scratch, 'demo.kolm');
  fs.writeFileSync(artifactPath, Buffer.from('FAKE_GGUF_BYTES_' + label + '_' + crypto.randomBytes(4).toString('hex')));
  return { artifactPath, scratch, cleanup: () => rmSyncBestEffort(scratch) };
}

//
// In-memory SSHConnection shim — drives the ssh-adapter + deviceCaps SSH path
// without touching the network. It records every exec()/upload()/sha256() call
// so the test can assert on the call sequence.
//
class MockSSHConnection {
  constructor(device, opts = {}) {
    this.device = device;
    this.opts = opts;
    this.calls = [];
    this._connected = false;
    // execScript: ordered list of (cmdRegex|cmdString) → {stdout,stderr,code} mappings.
    this._execScript = opts.execScript || [];
    // Files "uploaded" + their sha256. Used by sha256() so the mock can return
    // either the matching digest or a deliberately-bad one.
    this._uploaded = new Map(); // remotePath → { localPath, sha256 }
    this._forceBadSha = !!opts.forceBadSha;
  }
  async connect() { this._connected = true; return this; }
  async exec(cmd, _opts = {}) {
    this.calls.push({ kind: 'exec', cmd });
    for (const entry of this._execScript) {
      if (entry.match instanceof RegExp ? entry.match.test(cmd) : entry.match === cmd) {
        return { stdout: entry.stdout || '', stderr: entry.stderr || '', code: typeof entry.code === 'number' ? entry.code : 0 };
      }
    }
    // Default: a successful empty result so `mkdir`, `command -v`, etc. pass.
    return { stdout: '', stderr: '', code: 0 };
  }
  async upload(localPath, remotePath, _opts = {}) {
    this.calls.push({ kind: 'upload', localPath, remotePath });
    if (!fs.existsSync(localPath)) {
      const e = new Error('local file missing: ' + localPath); e.code = 'KOLM_E_LOCAL_FILE_MISSING'; throw e;
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
    this._uploaded.set(remotePath, { localPath, sha256: sha });
    return { ok: true, bytes: fs.statSync(localPath).size, remote_path: remotePath };
  }
  async sha256(remotePath) {
    this.calls.push({ kind: 'sha256', remotePath });
    if (this._forceBadSha) return 'deadbeef'.repeat(8); // 64 hex chars but wrong
    const u = this._uploaded.get(remotePath);
    return u ? u.sha256 : 'deadbeef'.repeat(8);
  }
  async detectHardware() { return {}; }
  async download() { return { ok: true, bytes: 0, local_path: '' }; }
  disconnect() { this._connected = false; }
}

function makeMockSSHFactory(opts = {}) {
  // Returns a factory function suitable for deviceCaps(device, factory).
  return async (device) => {
    const conn = new MockSSHConnection(device, opts);
    await conn.connect();
    return conn;
  };
}

//
// Test 1 — DeviceRegistry CRUD round-trip (register → get → list → update →
// heartbeat → remove).
//
test('W888-C #1 — DeviceRegistry CRUD round-trip: register/get/list/update/heartbeat/remove', async () => {
  const { registry, cleanup } = makeIsolatedRegistry('t1');
  try {
    // register
    const rec = await registry.register({ id: 'gpu-1', type: 'ssh', host: 'example.com', user: 'kolm', keyPath: '/dev/null', tags: ['prod'] });
    assert.equal(rec.id, 'gpu-1');
    assert.equal(rec.type, 'ssh');
    assert.equal(rec.host, 'example.com');
    assert.equal(rec.user, 'kolm');
    assert.equal(rec.port, 22);
    assert.deepEqual(rec.tags, ['prod']);
    assert.equal(rec.status, 'unknown');
    assert.ok(rec.created_at, 'created_at populated');
    // get
    const got = await registry.get('gpu-1');
    assert.equal(got.id, 'gpu-1');
    // list (no filters → 1 result)
    const list = await registry.list();
    assert.equal(list.length, 1);
    // update
    const upd = await registry.update('gpu-1', { name: 'prod-gpu-east', tags: ['prod', 'east'] });
    assert.equal(upd.name, 'prod-gpu-east');
    assert.deepEqual(upd.tags, ['prod', 'east']);
    // heartbeat
    const hb = await registry.heartbeat('gpu-1', { status: 'online', observed_hardware: { gpu_present: true } });
    assert.equal(hb.status, 'online');
    assert.ok(hb.last_seen);
    assert.deepEqual(hb.observed_hardware, { gpu_present: true });
    // remove (soft)
    const rm = await registry.remove('gpu-1');
    assert.equal(rm.ok, true);
    assert.equal(rm.mode, 'soft');
    const listAfter = await registry.list();
    assert.equal(listAfter.length, 0, 'soft-removed must be hidden from default list');
  } finally { cleanup(); }
});

//
// Test 2 — Duplicate id rejected
//
test('W888-C #2 — register() rejects duplicate id with KOLM_E_DUPLICATE_ID', async () => {
  const { registry, cleanup } = makeIsolatedRegistry('t2');
  try {
    await registry.register({ id: 'edge-1', type: 'local' });
    await assert.rejects(
      () => registry.register({ id: 'edge-1', type: 'local' }),
      (err) => err.code === 'KOLM_E_DUPLICATE_ID',
    );
  } finally { cleanup(); }
});

//
// Test 3 — Soft delete preserves the row with removed_at tombstone
//
test('W888-C #3 — soft delete preserves row with removed_at tombstone', async () => {
  const { registry, scratch, cleanup } = makeIsolatedRegistry('t3');
  try {
    await registry.register({ id: 'edge-tomb', type: 'local' });
    const r = await registry.remove('edge-tomb');
    assert.equal(r.mode, 'soft');
    // Raw file contents must still have the row.
    const raw = JSON.parse(fs.readFileSync(path.join(scratch, 'devices.json'), 'utf8'));
    const row = raw.devices.find(d => d.id === 'edge-tomb');
    assert.ok(row, 'soft-removed row must still exist on disk');
    assert.ok(row.removed_at, 'removed_at tombstone must be set');
    // includeRemoved exposes it.
    const incl = await registry.list({ includeRemoved: true });
    assert.equal(incl.length, 1);
    assert.equal(incl[0].id, 'edge-tomb');
  } finally { cleanup(); }
});

//
// Test 4 — Hard delete physically removes the row
//
test('W888-C #4 — remove({hard:true}) physically splices the row out', async () => {
  const { registry, scratch, cleanup } = makeIsolatedRegistry('t4');
  try {
    await registry.register({ id: 'gpu-zap', type: 'local' });
    const r = await registry.remove('gpu-zap', { hard: true });
    assert.equal(r.mode, 'hard');
    assert.equal(r.ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(scratch, 'devices.json'), 'utf8'));
    assert.equal(raw.devices.length, 0, 'hard delete must physically remove the row');
  } finally { cleanup(); }
});

//
// Test 5 — Filter by type / tag / status
//
test('W888-C #5 — list({type|tag|status}) filters work in combination', async () => {
  const { registry, cleanup } = makeIsolatedRegistry('t5');
  try {
    await registry.register({ id: 'gpu-a', type: 'ssh', host: 'a.example.com', tags: ['prod', 'gpu'] });
    await registry.register({ id: 'gpu-b', type: 'ssh', host: 'b.example.com', tags: ['staging', 'gpu'] });
    await registry.register({ id: 'cpu-1', type: 'local', tags: ['dev'] });
    await registry.heartbeat('gpu-a', { status: 'online' });
    await registry.heartbeat('gpu-b', { status: 'offline' });

    const ssh = await registry.list({ type: 'ssh' });
    assert.equal(ssh.length, 2);

    const prodOnly = await registry.list({ tag: 'prod' });
    assert.equal(prodOnly.length, 1);
    assert.equal(prodOnly[0].id, 'gpu-a');

    const online = await registry.list({ status: 'online' });
    assert.equal(online.length, 1);
    assert.equal(online[0].id, 'gpu-a');

    const combo = await registry.list({ type: 'ssh', status: 'offline' });
    assert.equal(combo.length, 1);
    assert.equal(combo[0].id, 'gpu-b');
  } finally { cleanup(); }
});

//
// Test 6 — Mock SSHConnection records calls + upload-sha-mismatch propagates
//
test('W888-C #6 — MockSSHConnection records exec/upload calls + forceBadSha surfaces mismatch through ssh-adapter', async () => {
  // First half: drive the mock directly.
  const conn = new MockSSHConnection({ id: 'm', host: 'm.example.com' });
  await conn.connect();
  const r1 = await conn.exec('uname -a');
  assert.equal(r1.code, 0);
  const { artifactPath, cleanup: cleanArt } = makeFakeArtifact('t6-art');
  try {
    await conn.upload(artifactPath, '/remote/demo.kolm');
    const sha = await conn.sha256('/remote/demo.kolm');
    assert.equal(sha.length, 64, 'sha256 hex digest must be 64 chars');
    assert.deepEqual(conn.calls.map(c => c.kind), ['exec', 'upload', 'sha256']);

    // Second half: thread a forceBadSha mock through ssh-adapter.deploy and
    // verify the sha-mismatch surfaces as ok:false.
    const badShaResult = await sshAdapter.deploy(
      { id: 'm', type: 'ssh', host: 'm.example.com', keyPath: '/dev/null' },
      artifactPath,
      { SSHConnectionClass: class extends MockSSHConnection {
          constructor(d) { super(d, { forceBadSha: true }); }
        },
        autoInstall: false,
        runtime: 'unknown-runtime', // skip the start step
      },
    );
    assert.equal(badShaResult.ok, false);
    assert.match(String(badShaResult.message), /sha mismatch/i);
  } finally { cleanArt(); }
});

//
// Test 7 — deviceCaps over ssh path uses the injected factory + returns shape
//
test('W888-C #7 — deviceCaps ssh path uses injected factory + returns {ok, hardware, raw}', async () => {
  const fakeNv = 'NVIDIA GeForce RTX 5090, 32607';
  const fakeCpu = 'processor\t: 0\nmodel name\t: Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz\nprocessor\t: 1\nmodel name\t: Intel(R) Core(TM) i9-13900K CPU @ 5.50GHz';
  const fakeFree = '               total used free\nMem:           64 2 58\n';
  const fakeDf = 'Filesystem  Size  Used  Avail  Use%  Mounted\n/dev/x       100G  20G   80G   20%   /home/user/.kolm';
  const fakeUname = 'Linux gpu-host 6.8.0-31-generic x86_64\n';
  const factory = makeMockSSHFactory({
    execScript: [
      { match: /nvidia-smi/, stdout: fakeNv, code: 0 },
      { match: /\/proc\/cpuinfo/, stdout: fakeCpu, code: 0 },
      { match: /^free\b/, stdout: fakeFree, code: 0 },
      { match: /^df\b/, stdout: fakeDf, code: 0 },
      { match: /^uname\b/, stdout: fakeUname, code: 0 },
    ],
  });
  const device = { id: 'remote-1', type: 'ssh', host: 'remote.example.com', keyPath: '/dev/null' };
  const r = await deviceCaps(device, factory);
  assert.equal(r.ok, true);
  assert.ok(r.hardware, 'hardware key required on success');
  assert.equal(r.hardware.gpu_present, true);
  assert.equal(r.hardware.gpu_model, 'NVIDIA GeForce RTX 5090');
  assert.equal(r.hardware.gpu_vram_gb, 32); // 32607 MiB → 32 GB rounded
  assert.match(String(r.hardware.cpu_model || ''), /i9-13900K/);
  assert.equal(r.hardware.cpu_cores, 2);
  assert.equal(r.hardware.ram_gb, 64);
  assert.equal(r.hardware.disk_free_gb, 80);
  assert.match(String(r.hardware.os || ''), /Linux/);
  assert.ok(r.raw && typeof r.raw === 'object', 'raw fixture buffer must be returned');
});

//
// Test 8 — deviceCaps local path returns the shape; record as t.skip when
// nvidia-smi is absent (parity branch for CI runners without a GPU).
//
test('W888-C #8 — deviceCaps local path returns {ok, hardware, raw} (GPU fields nullable)', async (t) => {
  // Probe nvidia-smi presence purely to log the test environment; we do NOT
  // skip — local probe MUST work even when no GPU is installed (gpu_present
  // simply becomes false on CPU-only hosts).
  const which = process.platform === 'win32' ? spawnSync('where', ['nvidia-smi']) : spawnSync('which', ['nvidia-smi']);
  if (which.status !== 0) {
    t.diagnostic('nvidia-smi not on PATH — gpu_present will be false (expected)');
  }
  const r = await deviceCaps({ id: 'local', type: 'local' });
  assert.equal(r.ok, true);
  assert.ok(r.hardware, 'hardware key required');
  // Required shape (values may be null on hosts that hide the data):
  for (const k of ['gpu_present', 'gpu_model', 'gpu_vram_gb', 'cpu_model', 'cpu_cores', 'ram_gb', 'os', 'disk_free_gb']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.hardware, k), `hardware.${k} field missing`);
  }
  // cpu_cores must always be a positive integer on any real machine.
  assert.ok(r.hardware.cpu_cores > 0, 'cpu_cores must be > 0 on a real machine');
  // ram_gb must be >0 on a real machine.
  assert.ok(r.hardware.ram_gb > 0, 'ram_gb must be > 0 on a real machine');
});

//
// Test 9 — ssh-adapter.deploy uploads + runs install via the mocked SSH conn
//
test('W888-C #9 — ssh-adapter.deploy uploads + starts runtime under mocked SSH; returns {ok, deployment_id}', async () => {
  const { artifactPath, cleanup } = makeFakeArtifact('t9-art');
  try {
    const recorded = [];
    class Recording extends MockSSHConnection {
      constructor(d) {
        super(d, {
          execScript: [
            // Pretend `command -v llama-server` returns the binary path.
            { match: /command -v llama-server/, stdout: '/usr/local/bin/llama-server\n', code: 0 },
            // Pretend the start command produced a PID.
            { match: /nohup llama-server/, stdout: '12345\n', code: 0 },
          ],
        });
      }
      async exec(cmd, opts) {
        recorded.push(cmd);
        return super.exec(cmd, opts);
      }
    }
    const r = await sshAdapter.deploy(
      { id: 'remote-9', type: 'ssh', host: 'gpu.example.com', keyPath: '/dev/null' },
      artifactPath,
      { SSHConnectionClass: Recording, autoInstall: true, runtime: 'llama.cpp', port: 8080 },
    );
    assert.equal(r.ok, true, 'deploy must succeed under mocked conn — actual: ' + JSON.stringify(r));
    assert.ok(/^dep_[0-9a-f]+$/.test(r.deployment_id), 'deployment_id must be `dep_<hex>`');
    // Step ordering: mkdir → upload → sha256_verify → install_runtime → start
    const stepNames = r.raw.steps.map(s => s.step);
    assert.ok(stepNames.includes('mkdir'), 'mkdir step recorded');
    assert.ok(stepNames.includes('upload'), 'upload step recorded');
    assert.ok(stepNames.includes('sha256_verify'), 'sha256_verify step recorded');
    assert.ok(stepNames.includes('start'), 'start step recorded');
    // mkdir command was issued.
    assert.ok(recorded.some(c => /mkdir -p/.test(c)), 'mkdir command must be sent');
  } finally { cleanup(); }
});

//
// Test 10 — ollama-adapter.deploy against a mocked fetch returns ok:true
//
test('W888-C #10 — ollama-adapter.deploy against a mocked fetch returns ok:true', async () => {
  const { artifactPath, cleanup } = makeFakeArtifact('t10-art');
  try {
    let createCalled = false;
    let tagsCalled = 0;
    const fetchImpl = async (url, init = {}) => {
      if (url.includes('/api/create')) {
        createCalled = true;
        assert.equal(init.method, 'POST', 'create must be POST');
        const body = JSON.parse(init.body || '{}');
        assert.match(body.modelfile || '', /^FROM /);
        return { ok: true, status: 200, async text() { return ''; } };
      }
      if (url.includes('/api/tags')) {
        tagsCalled++;
        return { ok: true, status: 200, async json() { return { models: [{ name: 'demo:latest' }] }; } };
      }
      return { ok: false, status: 404, async text() { return 'unknown'; }, async json() { return {}; } };
    };
    const r = await ollamaAdapter.deploy(
      { id: 'olla-1', type: 'ollama', host: '127.0.0.1', port: 11434 },
      artifactPath,
      { fetchImpl, modelName: 'demo' },
    );
    assert.equal(r.ok, true);
    assert.equal(createCalled, true, 'POST /api/create must be invoked');
    assert.ok(tagsCalled >= 1, 'GET /api/tags must be polled at least once');
  } finally { cleanup(); }
});

//
// Test 11 — k8s-adapter dry-run renders YAML without applying when kubectl
// is absent, OR when printOnly:true is passed.
//
test('W888-C #11 — k8s-adapter renders YAML manifest under printOnly + skips gracefully when kubectl absent', async () => {
  const { artifactPath, cleanup } = makeFakeArtifact('t11-art');
  try {
    // printOnly never invokes kubectl — verifies the render path independently
    // of whether kubectl is on PATH (which it is NOT on this Windows runner).
    const r = await k8sAdapter.deploy(
      { id: 'k8s-1', type: 'k8s', host: 'cluster.example.com' },
      artifactPath,
      { printOnly: true, namespace: 'kolm', port: 8080, image: 'ghcr.io/ggml-org/llama.cpp:server' },
    );
    assert.equal(r.ok, true);
    assert.match(String(r.raw.manifest || ''), /kind: Deployment/);
    assert.match(String(r.raw.manifest || ''), /kind: Service/);
    assert.match(String(r.raw.manifest || ''), /namespace: kolm/);
    assert.match(String(r.raw.manifest || ''), /containerPort: 8080/);
    // kubectl-driven branch — should report missing (or apply, if kubectl is
    // somehow on PATH). Either way must not throw and must return a structured
    // envelope.
    const kubectlExists = process.platform === 'win32'
      ? spawnSync('where', ['kubectl']).status === 0
      : spawnSync('which', ['kubectl']).status === 0;
    const r2 = await k8sAdapter.deploy(
      { id: 'k8s-2', type: 'k8s', host: 'cluster.example.com' },
      artifactPath,
      { dryRun: true, namespace: 'kolm', port: 8080 },
    );
    if (!kubectlExists) {
      assert.equal(r2.ok, false, 'must surface ok:false when kubectl is absent');
      assert.match(String(r2.message || ''), /kubectl not on PATH/i);
    } else {
      // If kubectl actually is on PATH on this host, dry-run client should succeed.
      assert.ok(r2.raw && r2.raw.manifest, 'manifest must still be emitted in dry-run mode');
    }
  } finally { cleanup(); }
});

//
// Test 12 — runpod + modal stubs return not_yet_wired
//
test('W888-C #12 — runpod + modal stub adapters return {ok:false, error:"not_yet_wired"}', async () => {
  const r1 = await runpodAdapter.deploy({ type: 'runpod' }, '/dev/null', {});
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'not_yet_wired');
  assert.match(String(r1.hint || ''), /runpod\.js/i);
  const r2 = await modalAdapter.deploy({ type: 'modal' }, '/dev/null', {});
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'not_yet_wired');
  assert.match(String(r2.hint || ''), /modal\.js/i);
});

//
// Test 13 — CLI: `kolm devices list --from-registry --json` against an
// isolated registry (KOLM_DATA_DIR=<scratch>). Tests the W888-C list branch.
//
test('W888-C #13 — CLI `kolm devices list --from-registry --json` reads from isolated registry', async () => {
  const scratch = freshScratch('t13');
  try {
    // Seed the registry by writing devices.json directly (deterministic, no
    // racy CLI add).
    fs.mkdirSync(scratch, { recursive: true });
    const seed = {
      devices: [
        { id: 'gpu-cli', name: 'gpu-cli', type: 'ssh', host: 'cli.example.com', port: 22, user: 'kolm', keyPath: '/dev/null', tags: ['cli'], created_at: new Date().toISOString(), last_seen: null, status: 'unknown', observed_hardware: null },
      ],
    };
    fs.writeFileSync(path.join(scratch, 'devices.json'), JSON.stringify(seed, null, 2));
    const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, 'devices', 'list', '--from-registry', '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, KOLM_DATA_DIR: scratch, KOLM_API_KEY: '', HOME: scratch, USERPROFILE: scratch },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0) {
      throw new Error(`kolm devices list exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
    const parsed = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(parsed), 'CLI --json must emit an array');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 'gpu-cli');
  } finally { rmSyncBestEffort(scratch); }
});

//
// Test 14 — CLI: `kolm devices add` then `kolm devices show <id>` round-trip
//
test('W888-C #14 — CLI `devices add` + `devices show` round-trip', async () => {
  const scratch = freshScratch('t14');
  try {
    fs.mkdirSync(scratch, { recursive: true });
    const env = { ...process.env, KOLM_DATA_DIR: scratch, KOLM_API_KEY: '', HOME: scratch, USERPROFILE: scratch };
    const add = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, 'devices', 'add', '--id', 'mac-1', '--type', 'local', '--name', 'My Mac', '--json'], {
      cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(add.status, 0, `add failed: ${add.stderr}`);
    const added = JSON.parse(add.stdout.trim());
    assert.equal(added.id, 'mac-1');
    assert.equal(added.type, 'local');
    const show = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, 'devices', 'show', 'mac-1', '--json'], {
      cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(show.status, 0, `show failed: ${show.stderr}`);
    const shown = JSON.parse(show.stdout.trim());
    assert.equal(shown.id, 'mac-1');
    assert.equal(shown.name, 'My Mac');
    assert.equal(shown.type, 'local');
  } finally { rmSyncBestEffort(scratch); }
});

//
// HTTP scaffold (tests 15-18). Concurrency=1 means tests within this file run
// strictly serially, so a single shared server boot at the top is the safest
// shape — we tear it down after lock-in #18 via the test.after() hook.
//
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
async function waitForHealth(base, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {} // deliberate: cleanup
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + base);
}

// Shared server context built lazily by the first HTTP lock-in (#15). Teardown
// is registered at file scope via `after()` from node:test so it fires once
// after ALL tests in this file have finished, not when individual tests end.
let _httpCtx = null;
async function _ensureHttpServer() {
  if (_httpCtx) return _httpCtx;
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const scratch = path.join(os.tmpdir(), `kolm-w888c-http-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const tenantId = 't_w888c_http';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: tenantId, name: 'w888c-http', plan: 'enterprise', quota: 1000000, created_at: new Date().toISOString() },
  ]), 'utf8');
  const apiKey = 'ks_w888c_http_smoke_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_w888c_http', tenant_id: tenantId, hash, kind: 'user', revoked_at: null, created_at: new Date().toISOString() },
  ]), 'utf8');

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: scratch,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  await waitForHealth(BASE);
  _httpCtx = { BASE, apiKey, dataDir, scratch, proc };
  return _httpCtx;
}

// File-scope teardown — fires once after every test in this file completes.
after(async () => {
  if (!_httpCtx) return;
  try { await killAndWait(_httpCtx.proc); } catch {} // deliberate: cleanup
  try { rmSyncBestEffort(_httpCtx.scratch); } catch {} // deliberate: cleanup
  _httpCtx = null;
});

// Lock-in #15 — POST /v1/devices/register WITH auth returns 200 + device.
test('W888-C #15 — HTTP POST /v1/devices/register with auth returns 200 + device', async () => {
  const { BASE, apiKey } = await _ensureHttpServer();
  const reg = await fetch(BASE + '/v1/devices/register', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'http-1', type: 'ssh', host: 'http.example.com', user: 'kolm', keyPath: '/dev/null', tags: ['http'] }),
  });
  assert.equal(reg.status, 200, 'POST /v1/devices/register must return 200 with valid auth');
  const regJson = await reg.json();
  assert.equal(regJson.ok, true);
  assert.equal(regJson.device.id, 'http-1');
  assert.equal(regJson.device.type, 'ssh');
});

// Lock-in #16 — POST /v1/devices/register WITHOUT auth returns 401.
test('W888-C #16 — HTTP POST /v1/devices/register without auth returns 401', async () => {
  const { BASE } = await _ensureHttpServer();
  const noauth = await fetch(BASE + '/v1/devices/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'should-not-be-created', type: 'local' }),
  });
  assert.equal(noauth.status, 401, 'no-auth POST must return 401');
});

// Lock-in #17 — GET /v1/devices/list returns an array with the registered device.
test('W888-C #17 — HTTP GET /v1/devices/list returns devices array', async () => {
  const { BASE, apiKey } = await _ensureHttpServer();
  const list = await fetch(BASE + '/v1/devices/list', {
    headers: { authorization: 'Bearer ' + apiKey },
  });
  assert.equal(list.status, 200, 'GET /v1/devices/list must return 200');
  const listJson = await list.json();
  assert.equal(listJson.ok, true);
  assert.ok(Array.isArray(listJson.devices), 'devices key must be an array');
  assert.ok(listJson.devices.some(d => d.id === 'http-1'), 'previously-registered device must be present');
});

// Lock-in #18 — DELETE /v1/devices/:id soft-deletes.
test('W888-C #18 — HTTP DELETE /v1/devices/:id soft-deletes the device', async () => {
  const { BASE, apiKey } = await _ensureHttpServer();
  const del = await fetch(BASE + '/v1/devices/http-1', {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + apiKey },
  });
  assert.equal(del.status, 200, 'DELETE must return 200');
  const delJson = await del.json();
  assert.equal(delJson.ok, true);
  assert.equal(delJson.mode, 'soft', 'default delete must be soft');
  // Verify list no longer surfaces it (default excludes soft-removed).
  const after = await fetch(BASE + '/v1/devices/list', {
    headers: { authorization: 'Bearer ' + apiKey },
  });
  const afterJson = await after.json();
  assert.ok(!afterJson.devices.some(d => d.id === 'http-1'), 'soft-removed device must be hidden from default list');
});

//
// Bonus: structural lock-ins on the exported constants — pins the surface so
// future refactors can't silently shrink the device-type set.
//
test('W888-C — DEVICE_TYPES_LIST contains all 6 canonical device types', () => {
  assert.deepEqual([...DEVICE_TYPES_LIST].sort(), ['k8s', 'local', 'modal', 'ollama', 'runpod', 'ssh']);
  assert.ok(DEVICE_STATUSES.includes('unknown'));
  assert.ok(DEVICE_STATUSES.includes('online'));
  assert.ok(DEVICE_STATUSES.includes('offline'));
  assert.ok(DEVICE_STATUSES.includes('error'));
});
