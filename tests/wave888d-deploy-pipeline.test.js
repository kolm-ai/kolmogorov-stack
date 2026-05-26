// W888-D — Deploy pipeline tests.
//
// Pinned items:
//   1) DeployPipeline exists + is a class
//   2) deploy() returns { success, endpoint, steps, device_id, artifact_id }
//   3) preflight rejects oversized model (insufficient VRAM)
//   4) preflight rejects insufficient disk
//   5) preflight rejects unknown device
//   6) preflight rejects missing artifact file
//   7) Happy path runs all 6 steps in order
//   8) Happy path returns endpoint URL of the form http://host:port
//   9) dry-run stops after preflight (no upload/serve)
//   10) Smoke test failure does not mask success of earlier steps
//   11) sha mismatch after upload is caught + raised as upload failure
//   12) Auto-install bootstraps a missing runtime when --auto-install set
//   13) Missing runtime without --auto-install raises a clear error
//   14) recordDeployment is called with the artifact + sha + pid + endpoint
//   15) deployRolling reports rolling:true + sidecar
//   16) deployCanary reports canary:true + canary_monitor_ms
//   17) src/deploy-pipeline.js stays under 600 lines (constraint)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { DeployPipeline } from '../src/deploy-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PIPELINE_PATH = path.join(REPO_ROOT, 'src', 'deploy-pipeline.js');

// ----------------------------------------------------------------------------
// Fixtures + mocks
// ----------------------------------------------------------------------------
function makeTempArtifact(sizeBytes = 1024) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888d-art-'));
  const p = path.join(dir, 'test.kolm');
  // Deterministic content so sha checks are stable.
  const buf = Buffer.alloc(sizeBytes, 'A');
  fs.writeFileSync(p, buf);
  return { artifactPath: p, dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }; // deliberate: cleanup
}

function sha256(buf) {
  const h = crypto.createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

// Stub SSHConnection class — captures every exec / upload / sha256 call so
// tests can assert on the pipeline's behavior. Each test can override
// exec/sha responses via the `responses` map.
function makeStubSSHClass({
  execResponses = {},        // pattern -> { stdout, stderr, code }
  uploadResult = { ok: true, bytes: 1024, remote_path: '/remote/test.kolm' },
  sha256Override = null,     // function(path) -> string
  failConnect = false,
  log = [],
} = {}) {
  return class StubSSHConnection {
    constructor(device) {
      this.device = device;
      this.deviceId = device.device_id || 'stub';
      this._connected = false;
    }
    async connect() {
      log.push({ op: 'connect' });
      if (failConnect) throw new Error('stub: connect refused');
      this._connected = true;
      return this;
    }
    async exec(command, opts = {}) {
      log.push({ op: 'exec', command, opts });
      // First match wins. Patterns can be strings (substring match) or RegExp.
      for (const [pat, resp] of Object.entries(execResponses)) {
        if (command.includes(pat)) return resp;
      }
      // Default: command runs OK with empty output.
      return { stdout: '', stderr: '', code: 0 };
    }
    async upload(localPath, remotePath, opts = {}) {
      log.push({ op: 'upload', localPath, remotePath });
      return { ...uploadResult, remote_path: remotePath };
    }
    async sha256(remotePath) {
      log.push({ op: 'sha256', remotePath });
      if (sha256Override) return sha256Override(remotePath);
      // Default: hash whatever the upload sent (read it locally if we know).
      return 'aaaa'.repeat(16); // 64 hex chars
    }
    async download() { return { ok: true, bytes: 0 }; }
    async detectHardware() {
      return {
        gpu: 'NVIDIA Stub GPU', gpu_vram_mb: 24576, cpu: 'Stub CPU', cpu_cores: 8,
        ram_mb: 65536, disk_free_mb: 500000, os: 'Linux 5.0', arch: 'x86_64', cuda_version: '12.6',
      };
    }
    disconnect() { log.push({ op: 'disconnect' }); this._connected = false; }
  };
}

// Stub deviceCaps so we don't touch ~/.kolm/devices/ on disk.
function makeStubDeviceCaps({ device = null, recordEntries = [] } = {}) {
  return {
    async getDevice(id) { return device && device.device_id === id ? device : null; },
    async testDevice(id) {
      if (device && device.device_id === id) return { reachable: true, runtime_status: { ssh: true } };
      return { reachable: false, reason: 'no such device' };
    },
    async detectHardwareRemote(id) {
      return {
        device_id: id, source: 'ssh', snapshot: device && device.hardware_snapshot || null, error: null,
      };
    },
    async recordDeployment(id, payload) {
      recordEntries.push({ id, payload });
      return payload;
    },
  };
}

function makeStubDevice(overrides = {}) {
  return {
    device_id: 'prod-gpu-1',
    type: 'ssh',
    kind: 'server',
    connection: { host: 'prod1.example.com', user: 'kolm', port: 22, key_path: '/fake/key' },
    hardware_snapshot: {
      gpu: 'NVIDIA RTX 5090', gpu_vram_mb: 32768, cpu: 'Intel i9', cpu_cores: 24,
      ram_mb: 128000, disk_free_mb: 500000, os: 'Linux 6.0', arch: 'x86_64', cuda_version: '12.6',
    },
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// 1) Class shape
// ----------------------------------------------------------------------------
test('W888-D #1 — DeployPipeline is a class with deploy/deployRolling/deployCanary', () => {
  assert.equal(typeof DeployPipeline, 'function');
  const p = new DeployPipeline();
  assert.equal(typeof p.deploy, 'function');
  assert.equal(typeof p.deployRolling, 'function');
  assert.equal(typeof p.deployCanary, 'function');
});

// ----------------------------------------------------------------------------
// 2) Result envelope
// ----------------------------------------------------------------------------
test('W888-D #2 — deploy() returns envelope { success, endpoint, steps, device_id, artifact_id }', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const log = [];
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      log,
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server\n', code: 0 },
        'nohup': { stdout: '12345\n', code: 0 },
        'curl -sS -o': { stdout: 'response body\n___STATUS:200___', code: 0 },
        'nc -z': { stdout: '', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({
      artifactPath, deviceId: 'prod-gpu-1',
      config: { runtime: 'llama.cpp', port: 8080, bindHost: '0.0.0.0' },
    });
    assert.equal(typeof r.success, 'boolean');
    assert.equal(typeof r.endpoint, 'string');
    assert.ok(Array.isArray(r.steps));
    assert.equal(r.device_id, 'prod-gpu-1');
    assert.equal(r.artifact_id, 'test');
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 3) Preflight: oversized model rejected
// ----------------------------------------------------------------------------
test('W888-D #3 — preflight rejects oversized model (insufficient VRAM)', async () => {
  const { artifactPath, dir, cleanup } = makeTempArtifact();
  try {
    // Drop a passport sibling claiming 64 GB min vram.
    fs.writeFileSync(artifactPath + '.passport.json', JSON.stringify({ min_vram_mb: 64 * 1024 }));
    const device = makeStubDevice({
      hardware_snapshot: { gpu: 'Tiny', gpu_vram_mb: 8 * 1024, disk_free_mb: 500000, os: 'Linux', arch: 'x86_64' },
    });
    const SSHClass = makeStubSSHClass();
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: {} });
    assert.equal(r.success, false);
    const preflight = r.steps.find(s => s.step === 'preflight');
    assert.ok(preflight);
    assert.equal(preflight.ok, false);
    assert.match(preflight.error || '', /insufficient vram/i);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 4) Preflight: insufficient disk
// ----------------------------------------------------------------------------
test('W888-D #4 — preflight rejects insufficient disk', async () => {
  const { artifactPath, cleanup } = makeTempArtifact(5 * 1024 * 1024); // 5 MB
  try {
    const device = makeStubDevice({
      hardware_snapshot: { gpu: 'X', gpu_vram_mb: 32768, disk_free_mb: 2, os: 'Linux', arch: 'x86_64' }, // 2 MB free
    });
    const SSHClass = makeStubSSHClass();
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: {} });
    assert.equal(r.success, false);
    const preflight = r.steps.find(s => s.step === 'preflight');
    assert.match(preflight.error || '', /insufficient disk/i);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 5) Preflight: unknown device
// ----------------------------------------------------------------------------
test('W888-D #5 — preflight rejects unknown device', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const SSHClass = makeStubSSHClass();
    const caps = makeStubDeviceCaps({ device: null });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'ghost-device', config: {} });
    assert.equal(r.success, false);
    const preflight = r.steps.find(s => s.step === 'preflight');
    assert.match(preflight.error || '', /unknown device/i);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 6) Preflight: missing artifact
// ----------------------------------------------------------------------------
test('W888-D #6 — preflight rejects missing artifact file', async () => {
  const SSHClass = makeStubSSHClass();
  const caps = makeStubDeviceCaps({ device: makeStubDevice() });
  const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
  const r = await p.deploy({ artifactPath: '/tmp/does-not-exist-w888d.kolm', deviceId: 'prod-gpu-1', config: {} });
  assert.equal(r.success, false);
  const preflight = r.steps.find(s => s.step === 'preflight');
  assert.match(preflight.error || '', /not found/i);
});

// ----------------------------------------------------------------------------
// 7) Happy path runs all 6 steps in order
// ----------------------------------------------------------------------------
test('W888-D #7 — happy path runs all 6 steps in order', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '54321', code: 0 },
        'curl -sS -o': { stdout: 'body\n___STATUS:200___TT:0.5___TOTAL:1.0___', code: 0 },
        'nc -z': { stdout: '', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { runtime: 'llama.cpp' } });
    const stepNames = r.steps.map(s => s.step);
    assert.deepEqual(stepNames, ['preflight', 'upload', 'ensureRuntime', 'start', 'smokeTest', 'record']);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 8) Endpoint URL shape
// ----------------------------------------------------------------------------
test('W888-D #8 — happy path returns endpoint URL of form http://host:port', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '111', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { port: 8888 } });
    assert.equal(r.endpoint, 'http://prod1.example.com:8888');
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 9) dry-run stops after preflight
// ----------------------------------------------------------------------------
test('W888-D #9 — dry-run stops after preflight (no upload/serve)', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const log = [];
    const SSHClass = makeStubSSHClass({ log });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { dryRun: true } });
    assert.equal(r.success, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.steps.length, 1, 'only preflight runs');
    assert.equal(r.steps[0].step, 'preflight');
    // No ssh ops should have happened (preflight uses caps.testDevice, not SSHConnection)
    assert.equal(log.filter(e => e.op === 'upload').length, 0);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 10) Smoke test failure surfaces, prior steps still ok
// ----------------------------------------------------------------------------
test('W888-D #10 — smoke test failure does not mask success of earlier steps', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '222', code: 0 },
        'curl -sS -o': { stdout: 'oops\n___STATUS:500___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: {} });
    assert.equal(r.success, false);
    const upload = r.steps.find(s => s.step === 'upload');
    const start = r.steps.find(s => s.step === 'start');
    const smoke = r.steps.find(s => s.step === 'smokeTest');
    assert.equal(upload.ok, true, 'upload should still report ok');
    assert.equal(start.ok, true, 'start should still report ok');
    assert.equal(smoke.ok, false, 'smokeTest should be marked failed');
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 11) sha mismatch is caught
// ----------------------------------------------------------------------------
test('W888-D #11 — sha mismatch after upload is raised as upload failure', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const SSHClass = makeStubSSHClass({
      sha256Override: () => 'deadbeef'.repeat(8), // wrong hash
      execResponses: { 'mkdir -p': { stdout: '', code: 0 } },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: {} });
    assert.equal(r.success, false);
    const upload = r.steps.find(s => s.step === 'upload');
    assert.equal(upload.ok, false);
    assert.match(upload.error || '', /sha mismatch/i);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 12) Auto-install bootstraps missing runtime
// ----------------------------------------------------------------------------
test('W888-D #12 — auto-install bootstraps a missing runtime when --auto-install set', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    let probeCount = 0;
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: { 'mkdir -p': { stdout: '', code: 0 } },
    });
    // Override exec to model "first probe = fail, then install OK, then probe OK".
    const PatchedClass = class extends SSHClass {
      async exec(command, opts = {}) {
        if (command.includes('command -v llama-server')) {
          probeCount += 1;
          return probeCount === 1
            ? { stdout: '', code: 1 }            // not installed
            : { stdout: '/usr/local/bin/llama-server', code: 0 };  // post-install
        }
        if (command.includes('curl -fsSL') && command.includes('llama-server')) {
          return { stdout: 'installed', code: 0 };
        }
        if (command.includes('nohup')) return { stdout: '333', code: 0 };
        if (command.includes('curl -sS -o')) return { stdout: 'b\n___STATUS:200___', code: 0 };
        if (command.includes('mkdir -p')) return { stdout: '', code: 0 };
        return { stdout: '', code: 0 };
      }
    };
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: PatchedClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { autoInstall: true } });
    const ensure = r.steps.find(s => s.step === 'ensureRuntime');
    assert.equal(ensure.ok, true);
    assert.equal(ensure.detail.installed, true);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 13) Missing runtime without --auto-install raises a clear error
// ----------------------------------------------------------------------------
test('W888-D #13 — missing runtime without --auto-install raises clear error', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '', code: 1 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: {} });
    assert.equal(r.success, false);
    const ensure = r.steps.find(s => s.step === 'ensureRuntime');
    assert.match(ensure.error || '', /not installed/i);
    assert.match(ensure.error || '', /auto-install/i);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 14) recordDeployment is called with the artifact + sha + pid + endpoint
// ----------------------------------------------------------------------------
test('W888-D #14 — recordDeployment is called with full payload', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const recordEntries = [];
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '4242', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device, recordEntries });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { port: 9000 } });
    assert.equal(recordEntries.length, 1);
    const entry = recordEntries[0];
    assert.equal(entry.id, 'prod-gpu-1');
    assert.equal(entry.payload.pid, 4242);
    assert.equal(entry.payload.port, 9000);
    assert.equal(entry.payload.endpoint, 'http://prod1.example.com:9000');
    assert.equal(entry.payload.sha256, sha256(localBuf));
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 15) deployRolling
// ----------------------------------------------------------------------------
test('W888-D #15 — deployRolling reports rolling:true + sidecar', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '555', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deployRolling({ artifactPath, deviceId: 'prod-gpu-1', config: { port: 8080 } });
    assert.equal(r.rolling, true);
    assert.equal(typeof r.sidecar, 'object');
    assert.ok(r.sidecar.endpoint);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 16) deployCanary
// ----------------------------------------------------------------------------
test('W888-D #16 — deployCanary reports canary:true + canary_monitor_ms', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '666', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const p = new DeployPipeline({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps });
    const r = await p.deployCanary({ artifactPath, deviceId: 'prod-gpu-1', config: {}, monitorMs: 30_000 });
    assert.equal(r.canary, true);
    assert.equal(r.canary_monitor_ms, 30_000);
  } finally { cleanup(); }
});

// ----------------------------------------------------------------------------
// 17) Pipeline file size constraint
// ----------------------------------------------------------------------------
test('W888-D #17 — src/deploy-pipeline.js stays under 600 lines', () => {
  const lines = fs.readFileSync(PIPELINE_PATH, 'utf8').split(/\r?\n/).length;
  assert.ok(lines < 600, `src/deploy-pipeline.js must be <600 lines; got ${lines}`);
});

// ----------------------------------------------------------------------------
// 18) Deployments journal — happy path appends a 'deployed' line
// ----------------------------------------------------------------------------
test('W888-D #18 — happy deploy appends one journal entry with status=deployed', async () => {
  const { artifactPath, cleanup } = makeTempArtifact();
  const tmpJournal = path.join(os.tmpdir(), `kolm-w888d-journal-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  try {
    const device = makeStubDevice();
    const localBuf = fs.readFileSync(artifactPath);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localBuf),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '777', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const { DeployPipeline: DP, loadDeployments } = await import('../src/deploy-pipeline.js');
    const p = new DP({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps, deploymentsPath: tmpJournal });
    const r = await p.deploy({ artifactPath, deviceId: 'prod-gpu-1', config: { port: 8888 } });
    assert.equal(r.success, true);
    assert.ok(r.deployment_id && r.deployment_id.startsWith('dep_'));
    assert.ok(fs.existsSync(tmpJournal), 'journal file must exist');
    const entries = loadDeployments(tmpJournal);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].deployment_id, r.deployment_id);
    assert.equal(entries[0].device_id, 'prod-gpu-1');
    assert.equal(entries[0].status, 'deployed');
    assert.equal(entries[0].port, 8888);
    assert.equal(entries[0].artifact_sha256, sha256(localBuf));
    assert.ok(Array.isArray(entries[0].steps));
  } finally { cleanup(); try { fs.rmSync(tmpJournal, { force: true }); } catch {} } // deliberate: cleanup
});

// ----------------------------------------------------------------------------
// 19) RollingDeploy — 3-replica zero-downtime cutover
// ----------------------------------------------------------------------------
test('W888-D #19 — RollingDeploy migrates N replicas on basePort+i with replicas_downtime=0', async () => {
  const rolling = await import('../src/deploy-rolling.js');
  let callCount = 0;
  const seenPorts = [];
  const stubPipeline = {
    async deploy({ artifactPath, deviceId, config }) {
      callCount += 1;
      seenPorts.push(config.port);
      return {
        success: true,
        deployment_id: `dep_${callCount}`,
        endpoint: `http://h:${config.port}`,
        steps: [{ step: 'preflight', ok: true, elapsed_ms: 1 }, { step: 'start', ok: true, elapsed_ms: 1 }],
      };
    },
  };
  const r = new rolling.RollingDeploy({ pipeline: stubPipeline });
  const out = await r.deploy({ artifactPath: '/x.kolm', deviceId: 'dev1', config: { replicas: 3, port: 9000 } });
  assert.equal(out.ok, true);
  assert.equal(out.replicas_migrated, 3);
  assert.equal(out.replicas_total, 3);
  assert.equal(out.replicas_downtime, 0);
  assert.deepEqual(seenPorts, [9000, 9001, 9002]);
  assert.equal(out.per_replica.length, 3);
  assert.equal(callCount, 3);
});

// ----------------------------------------------------------------------------
// 20) RollingDeploy — single-replica stamps replicas_downtime=1
// ----------------------------------------------------------------------------
test('W888-D #20 — RollingDeploy single-replica records replicas_downtime=1', async () => {
  const rolling = await import('../src/deploy-rolling.js');
  const stubPipeline = {
    async deploy() { return { success: true, deployment_id: 'd1', steps: [] }; },
  };
  const r = new rolling.RollingDeploy({ pipeline: stubPipeline });
  const out = await r.deploy({ artifactPath: '/x.kolm', deviceId: 'dev1', config: { replicas: 1, port: 9000 } });
  assert.equal(out.ok, true);
  assert.equal(out.replicas_downtime, 1);
});

// ----------------------------------------------------------------------------
// 21) CanaryDeploy — auto-rollback when error_rate > threshold
// ----------------------------------------------------------------------------
test('W888-D #21 — CanaryDeploy auto-rolls back when error_rate exceeds threshold', async () => {
  const canaryMod = await import('../src/deploy-canary.js');
  const calls = [];
  const stubPipeline = {
    async deploy({ deviceId }) {
      calls.push({ op: 'deploy', deviceId });
      return { success: true, deployment_id: 'd1', steps: [{ step: 'preflight', ok: true }], endpoint: 'http://h:8080' };
    },
    async rollback({ deviceId }) {
      calls.push({ op: 'rollback', deviceId });
      return { ok: true, rolled_back_to: 'd_prev' };
    },
  };
  const stubMetrics = {
    async sampleCanary() {
      return { error_rate: 0.15, latency_p95_ms: 200, baseline_p95_ms: 100, request_count: 100 };
    },
  };
  const c = new canaryMod.CanaryDeploy({ pipeline: stubPipeline, metricsProvider: stubMetrics });
  const out = await c.deploy({
    artifactPath: '/x.kolm',
    deviceIds: ['canary-dev', 'fleet-1', 'fleet-2'],
    config: { skipObserveSleep: true, canaryWindowS: 1 },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'canary_metrics_unhealthy');
  assert.equal(out.promoted, false);
  assert.equal(out.fleet_rollout_aborted, true);
  assert.ok(out.rollback && out.rollback.ok, 'rollback was triggered');
  // Pipeline.deploy called ONCE (canary only — no promotion to fleet-1/2).
  assert.equal(calls.filter(c => c.op === 'deploy').length, 1);
  assert.equal(calls.filter(c => c.op === 'rollback').length, 1);
});

// ----------------------------------------------------------------------------
// 22) CanaryDeploy — healthy canary promotes to remaining devices
// ----------------------------------------------------------------------------
test('W888-D #22 — CanaryDeploy healthy promotes through to remaining devices', async () => {
  const canaryMod = await import('../src/deploy-canary.js');
  const deployedDevices = [];
  const stubPipeline = {
    async deploy({ deviceId }) {
      deployedDevices.push(deviceId);
      return { success: true, deployment_id: `d_${deviceId}`, steps: [], endpoint: `http://${deviceId}:8080` };
    },
  };
  const stubMetrics = {
    async sampleCanary() {
      return { error_rate: 0.001, latency_p95_ms: 90, baseline_p95_ms: 100, request_count: 50 };
    },
  };
  const c = new canaryMod.CanaryDeploy({ pipeline: stubPipeline, metricsProvider: stubMetrics });
  const out = await c.deploy({
    artifactPath: '/x.kolm',
    deviceIds: ['canary-dev', 'fleet-1', 'fleet-2'],
    config: { skipObserveSleep: true },
  });
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'canary_promoted');
  assert.equal(out.promoted, true);
  assert.deepEqual(deployedDevices, ['canary-dev', 'fleet-1', 'fleet-2']);
  assert.equal(out.promotions.length, 2);
});

// ----------------------------------------------------------------------------
// 23) testQuants — Pareto frontier marking + recommendation
// ----------------------------------------------------------------------------
test('W888-D #23 — _markPareto marks frontier rows and skips dominated ones', async () => {
  const tq = await import('../src/test-quants.js');
  // Construct hand-crafted rows so frontier is deterministic.
  const rows = [
    { quant: 'Q8_0',   size_mb: 800, fits_vram: true, tok_s: 50, k_score: 0.90 }, // large but high-K
    { quant: 'Q4_K_M', size_mb: 400, fits_vram: true, tok_s: 80, k_score: 0.85 }, // smaller, slightly lower K
    { quant: 'Q3_K_M', size_mb: 300, fits_vram: true, tok_s: 90, k_score: 0.70 }, // smaller, lower K — also frontier
    { quant: 'Q2_K',   size_mb: 200, fits_vram: true, tok_s: 95, k_score: 0.50 }, // smallest, lowest K — frontier
    { quant: 'BAD',    size_mb: 600, fits_vram: true, tok_s: 60, k_score: 0.60 }, // dominated by Q4_K_M (smaller AND higher k)
    { quant: 'NOFIT',  size_mb: 9999, fits_vram: false, tok_s: null, k_score: null }, // not on frontier
  ];
  tq.default._markPareto(rows);
  const frontier = rows.filter(r => r.on_frontier).map(r => r.quant);
  assert.ok(frontier.includes('Q8_0'));
  assert.ok(frontier.includes('Q4_K_M'));
  assert.ok(frontier.includes('Q3_K_M'));
  assert.ok(frontier.includes('Q2_K'));
  assert.ok(!frontier.includes('BAD'));
  assert.ok(!frontier.includes('NOFIT'));
});

// ----------------------------------------------------------------------------
// 24) test-quants W888D ladder exports
// ----------------------------------------------------------------------------
test('W888-D #24 — test-quants exports the W888-D 5-quant ladder + W888d wrapper', async () => {
  const tq = await import('../src/test-quants.js');
  assert.deepEqual(tq.W888D_QUANT_LADDER, ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'IQ4_XS', 'fp16']);
  assert.equal(typeof tq.testQuantsW888d, 'function');
  assert.equal(typeof tq.testQuants, 'function');
});

// ----------------------------------------------------------------------------
// 25) testDevice exports suiteFor with smoke (3) / full (20) presets
// ----------------------------------------------------------------------------
test('W888-D #25 — test-device suite presets: smoke=3 / full=20', async () => {
  const td = await import('../src/test-device.js');
  assert.equal(typeof td.suiteFor, 'function');
  const smoke = td.suiteFor('smoke');
  const full = td.suiteFor('full');
  const regression = td.suiteFor('regression');
  const bogus = td.suiteFor('bogus-name');
  assert.equal(smoke.length, 3);
  assert.equal(full.length, 20);
  assert.equal(regression.length, 3);
  assert.equal(bogus, null);
  // Each prompt has an `id` and `prompt` field.
  for (const ex of smoke) { assert.equal(typeof ex.id, 'string'); assert.equal(typeof ex.prompt, 'string'); }
  for (const ex of full)  { assert.equal(typeof ex.id, 'string'); assert.equal(typeof ex.prompt, 'string'); }
});

// ----------------------------------------------------------------------------
// 26) Pipeline rollback() finds previous deployed entry + replays
// ----------------------------------------------------------------------------
test('W888-D #26 — DeployPipeline.rollback() replays the previous deployed entry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888d-rollback-'));
  const tmpJournal = path.join(tmpDir, 'deployments.jsonl');
  const artA = path.join(tmpDir, 'v1.kolm'); fs.writeFileSync(artA, 'A');
  const artB = path.join(tmpDir, 'v2.kolm'); fs.writeFileSync(artB, 'B');
  try {
    // Manually seed journal: v1 deployed, v2 deployed (most recent).
    fs.writeFileSync(tmpJournal,
      JSON.stringify({ deployment_id: 'dep_v1', device_id: 'dev1', artifact_path: artA, status: 'deployed', port: 8080, runtime: 'llama.cpp', steps: [] }) + '\n' +
      JSON.stringify({ deployment_id: 'dep_v2', device_id: 'dev1', artifact_path: artB, status: 'deployed', port: 8080, runtime: 'llama.cpp', steps: [] }) + '\n');
    const device = makeStubDevice({ device_id: 'dev1' });
    const localA = fs.readFileSync(artA);
    const SSHClass = makeStubSSHClass({
      sha256Override: () => sha256(localA),
      execResponses: {
        'command -v llama-server': { stdout: '/usr/local/bin/llama-server', code: 0 },
        'nohup': { stdout: '900', code: 0 },
        'curl -sS -o': { stdout: 'b\n___STATUS:200___', code: 0 },
        'mkdir -p': { stdout: '', code: 0 },
      },
    });
    const caps = makeStubDeviceCaps({ device });
    const { DeployPipeline: DP } = await import('../src/deploy-pipeline.js');
    const p = new DP({ SSHConnectionClass: SSHClass, deviceCapsImpl: caps, deploymentsPath: tmpJournal });
    const out = await p.rollback({ deviceId: 'dev1', config: { replay: false } });
    assert.equal(out.ok, true);
    assert.equal(out.target_entry.deployment_id, 'dep_v1');
    assert.equal(out.target_entry.artifact_path, artA);
    assert.equal(out.rollback_info.rolling_back_from, 'dep_v2');
    assert.equal(out.rollback_info.rolling_back_to, 'dep_v1');
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// 27) Module ceiling constraint — all 5 modules respect their LoC budget
// ----------------------------------------------------------------------------
test('W888-D #27 — all 5 W888-D modules stay under their LoC ceilings', () => {
  const moduleCeilings = {
    'src/deploy-pipeline.js': 600,  // hard ceiling; spec target 500
    'src/deploy-rolling.js':  300,
    'src/deploy-canary.js':   400,
    'src/test-device.js':     400,
    'src/test-quants.js':     300,
  };
  for (const [rel, max] of Object.entries(moduleCeilings)) {
    const full = path.join(REPO_ROOT, rel);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= max, `${rel} must be <=${max} lines; got ${lines}`);
  }
});
