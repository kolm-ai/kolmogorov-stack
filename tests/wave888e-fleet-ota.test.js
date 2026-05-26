// W888-E — Fleet management + OTA tests.
//
// Pinned items:
//   1)  src/fleet.js Fleet class exists with status/deploy/monitor/rollback/stop
//   2)  Fleet.status returns array with required fields
//   3)  Fleet.deploy rolling mode stops on first per-device failure
//   4)  Fleet.deploy canary mode requires observe window before promote
//   5)  Fleet.deploy 'all' mode is parallel + aggregates results
//   6)  Fleet.deploy rejects unknown mode
//   7)  Fleet.rollback refuses without confirm
//   8)  Fleet.rollback errors when no previous artifact exists
//   9)  Fleet.stop --all refuses without confirm
//   10) FleetMonitor.tick emits offline alert on first reachable=false sighting
//   11) OTA policy=manual is no-op
//   12) OTA policy=notify writes data/ota-pending.json (KOLM_DATA_DIR)
//   13) OTA setPolicy rejects unknown policy
//   14) OTA promote with policy=canary calls Fleet.deploy with mode=canary
//   15) `kolm fleet status --json` shape valid
//   16) `kolm fleet monitor --once --json` returns one tick
//
// Mocks are injected via the constructor of Fleet / FleetMonitor / OTA promote
// so the test never opens a real SSH socket or writes to the user's ~/.kolm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Fleet } from '../src/fleet.js';
import { FleetMonitor, consoleSink } from '../src/fleet-monitor.js';
import * as ota from '../src/ota.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeStubDeviceCaps({ devices = [], healthByDevice = {} } = {}) {
  return {
    async listDevices() { return devices.slice(); },
    async getDevice(id) { return devices.find(d => d.device_id === id) || null; },
    async testDevice(id) {
      const d = devices.find(x => x.device_id === id);
      if (!d) return { reachable: false, reason: 'no such device' };
      return { reachable: true };
    },
    async detectHardwareRemote(id) {
      const d = devices.find(x => x.device_id === id);
      return { device_id: id, source: 'stub', snapshot: d && d.hardware_snapshot || null, error: null };
    },
    async healthCheck(id) {
      if (healthByDevice[id]) return healthByDevice[id];
      const d = devices.find(x => x.device_id === id);
      return {
        device_id: id,
        ok: !!d,
        status: d ? 'online' : 'offline',
        reachable: !!d,
        reason: d ? null : 'unknown',
        hardware: d && d.hardware_snapshot || null,
        installed_artifacts: [],
        latency_ms: 1,
        checked_at: new Date().toISOString(),
      };
    },
    async recordDeployment(id, payload) { return payload; },
  };
}

function makeStubDevice(overrides = {}) {
  return {
    device_id: 'gpu-1',
    type: 'ssh',
    kind: 'server',
    connection: { host: 'gpu1.example.com', user: 'kolm', port: 22, key_path: '/fake/key' },
    hardware_snapshot: { gpu_vram_mb: 32768, disk_free_mb: 500000 },
    tags: ['prod'],
    namespace: 'support',
    ...overrides,
  };
}

// Stub DeployPipeline: returns scripted results indexed by device_id.
function makeStubPipelineClass(scriptByDevice = {}) {
  return class StubPipeline {
    constructor() { this.calls = []; }
    async deploy({ artifactPath, deviceId, config }) {
      this.calls.push({ artifactPath, deviceId, config });
      const r = scriptByDevice[deviceId];
      if (r) return r;
      return {
        success: true,
        device_id: deviceId,
        artifact_id: path.basename(String(artifactPath || '')).replace(/\.kolm$/, ''),
        endpoint: `http://${deviceId}:8080`,
        steps: [{ ok: true, step: 'preflight' }, { ok: true, step: 'record' }],
      };
    }
  };
}

function makeArtifact() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888e-art-'));
  const p = path.join(dir, 'model.kolm');
  fs.writeFileSync(p, Buffer.alloc(1024, 'A'));
  return { artifactPath: p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }; // deliberate: cleanup
}

// Sandbox HOME / KOLM_DATA_DIR for OTA tests so we don't touch user state.
function withSandboxDataDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888e-data-'));
    const prevHome = process.env.HOME;
    const prevUserProf = process.env.USERPROFILE;
    const prevDataDir = process.env.KOLM_DATA_DIR;
    process.env.KOLM_DATA_DIR = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try {
      ota._clearAll();
      await fn(dir);
    } finally {
      if (prevHome != null) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUserProf != null) process.env.USERPROFILE = prevUserProf; else delete process.env.USERPROFILE;
      if (prevDataDir != null) process.env.KOLM_DATA_DIR = prevDataDir; else delete process.env.KOLM_DATA_DIR;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
    }
  };
}

// ---------------------------------------------------------------------------
// 1) Fleet class shape
// ---------------------------------------------------------------------------
test('W888-E #1 — Fleet exposes status/deploy/monitor/rollback/stop', () => {
  const f = new Fleet({ deviceCaps: makeStubDeviceCaps() });
  assert.equal(typeof f.status, 'function');
  assert.equal(typeof f.deploy, 'function');
  assert.equal(typeof f.monitor, 'function');
  assert.equal(typeof f.rollback, 'function');
  assert.equal(typeof f.stop, 'function');
});

// ---------------------------------------------------------------------------
// 2) Fleet.status shape
// ---------------------------------------------------------------------------
test('W888-E #2 — Fleet.status returns array with required fields', async () => {
  const dev = makeStubDevice({ device_id: 'a', deployed_artifacts: [{ artifact_id: 'm', success: true }], last_deployed_at: '2026-05-26T00:00:00Z' });
  const caps = makeStubDeviceCaps({ devices: [dev] });
  const f = new Fleet({ deviceCaps: caps });
  const rows = await f.status({});
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  const r = rows[0];
  for (const k of ['device', 'hardware', 'deployed_artifacts', 'health', 'last_seen', 'alerts']) {
    assert.ok(k in r, `missing key ${k}`);
  }
  assert.equal(r.device, 'a');
  assert.equal(Array.isArray(r.alerts), true);
});

// ---------------------------------------------------------------------------
// 3) Rolling mode stops on first failure
// ---------------------------------------------------------------------------
test('W888-E #3 — Fleet.deploy rolling mode stops on first per-device failure', async () => {
  const devs = [
    makeStubDevice({ device_id: 'a', tags: ['x'] }),
    makeStubDevice({ device_id: 'b', tags: ['x'] }),
    makeStubDevice({ device_id: 'c', tags: ['x'] }),
  ];
  const PipelineClass = makeStubPipelineClass({
    a: { success: true, device_id: 'a', endpoint: 'http://a:8080', steps: [] },
    b: { success: false, device_id: 'b', error: 'boom', steps: [] }, // fails
    c: { success: true, device_id: 'c', endpoint: 'http://c:8080', steps: [] },
  });
  const { artifactPath, cleanup } = makeArtifact();
  try {
    const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: devs }), DeployPipelineClass: PipelineClass });
    const r = await f.deploy({ artifactPath, tag: 'x', mode: 'rolling' });
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'rolling');
    assert.equal(r.stopped_on, 'b');
    assert.equal(r.results.length, 2, 'should not deploy to c after b fails');
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[1].ok, false);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 4) Canary requires observe window
// ---------------------------------------------------------------------------
test('W888-E #4 — Fleet.deploy canary mode observes before promoting', async () => {
  const devs = [
    makeStubDevice({ device_id: 'canary', tags: ['c'] }),
    makeStubDevice({ device_id: 'prod-1', tags: ['c'] }),
    makeStubDevice({ device_id: 'prod-2', tags: ['c'] }),
  ];
  const caps = makeStubDeviceCaps({ devices: devs });
  const PipelineClass = makeStubPipelineClass();
  const { artifactPath, cleanup } = makeArtifact();
  try {
    const t0 = Date.now();
    const f = new Fleet({ deviceCaps: caps, DeployPipelineClass: PipelineClass });
    const r = await f.deploy({ artifactPath, tag: 'c', mode: 'canary', canaryObserveMs: 200 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'canary');
    assert.equal(r.devices[0], 'canary');
    assert.equal(r.results.length, 3, 'canary + 2 promote');
    assert.ok(elapsed >= 200, `observe window not honored: ${elapsed}ms`);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5) 'all' mode
// ---------------------------------------------------------------------------
test('W888-E #5 — Fleet.deploy all mode aggregates parallel results', async () => {
  const devs = [
    makeStubDevice({ device_id: 'a', tags: ['x'] }),
    makeStubDevice({ device_id: 'b', tags: ['x'] }),
  ];
  const { artifactPath, cleanup } = makeArtifact();
  try {
    const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: devs }), DeployPipelineClass: makeStubPipelineClass() });
    const r = await f.deploy({ artifactPath, tag: 'x', mode: 'all' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'all');
    assert.equal(r.results.length, 2);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 6) unknown mode rejected
// ---------------------------------------------------------------------------
test('W888-E #6 — Fleet.deploy rejects unknown mode', async () => {
  const { artifactPath, cleanup } = makeArtifact();
  try {
    const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: [makeStubDevice()] }), DeployPipelineClass: makeStubPipelineClass() });
    await assert.rejects(() => f.deploy({ artifactPath, mode: 'whoosh' }), /unknown fleet deploy mode/i);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 7) Rollback refuses without confirm
// ---------------------------------------------------------------------------
test('W888-E #7 — Fleet.rollback refuses without confirm', async () => {
  const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: [makeStubDevice()] }), DeployPipelineClass: makeStubPipelineClass() });
  const r = await f.rollback({ namespace: 'support' });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.reason, /confirm/);
});

// ---------------------------------------------------------------------------
// 8) Rollback errors when no previous artifact
// ---------------------------------------------------------------------------
test('W888-E #8 — Fleet.rollback errors when no previous artifact exists', async () => {
  // Device has only ONE deployed artifact — no history to roll back to.
  const dev = makeStubDevice({ deployed_artifacts: [{ artifact_id: 'only', artifact_path: '/tmp/x.kolm' }] });
  const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: [dev] }), DeployPipelineClass: makeStubPipelineClass() });
  const r = await f.rollback({ namespace: 'support', confirm: true });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].error, /no_previous_artifact/);
});

// ---------------------------------------------------------------------------
// 9) Stop --all refuses without confirm
// ---------------------------------------------------------------------------
test('W888-E #9 — Fleet.stop --all refuses without confirm', async () => {
  const f = new Fleet({ deviceCaps: makeStubDeviceCaps({ devices: [makeStubDevice()] }) });
  const r = await f.stop({ all: true });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.reason, /confirm/);
});

// ---------------------------------------------------------------------------
// 10) FleetMonitor offline alert on transition
// ---------------------------------------------------------------------------
test('W888-E #10 — FleetMonitor.tick emits offline alert on first reachable=false sighting', async () => {
  const dev = makeStubDevice({ device_id: 'gone' });
  const caps = makeStubDeviceCaps({
    devices: [dev],
    healthByDevice: { gone: { device_id: 'gone', ok: false, status: 'offline', reachable: false, reason: 'timed out', hardware: null } },
  });
  const mon = new FleetMonitor({ deviceCaps: caps });
  // Pass a no-op sink so we don't write to stderr during tests.
  const tick = await mon.tick({ alertSinks: [{ name: 'noop', async send() { return { ok: true }; } }] });
  assert.equal(tick.alerts.length, 1);
  assert.equal(tick.alerts[0].kind, 'offline');
  assert.equal(tick.alerts[0].device, 'gone');
});

// ---------------------------------------------------------------------------
// 11) OTA manual is no-op
// ---------------------------------------------------------------------------
test('W888-E #11 — OTA policy=manual is a no-op', withSandboxDataDir(async () => {
  // No prior policy -> default is manual.
  const cfg = ota.getPolicy({ namespace: 'support' });
  assert.equal(cfg.policy, 'manual');
  const r = await ota.promote({ namespace: 'support', artifactPath: '/tmp/x.kolm' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'noop');
}));

// ---------------------------------------------------------------------------
// 12) OTA notify writes ota-pending.json
// ---------------------------------------------------------------------------
test('W888-E #12 — OTA policy=notify writes ota-pending.json', withSandboxDataDir(async (dir) => {
  const set = ota.setPolicy({ namespace: 'support', policy: 'notify' });
  assert.equal(set.ok, true);
  const r = await ota.promote({ namespace: 'support', artifactPath: '/tmp/x.kolm' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'pending_written');
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'ota-pending.json'), 'utf8'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].namespace, 'support');
  assert.equal(pending[0].artifact_path, '/tmp/x.kolm');
}));

// ---------------------------------------------------------------------------
// 13) OTA setPolicy rejects unknown policy
// ---------------------------------------------------------------------------
test('W888-E #13 — OTA setPolicy rejects unknown policy', withSandboxDataDir(async () => {
  const r = ota.setPolicy({ namespace: 'support', policy: 'whoosh' });
  assert.equal(r.ok, false);
  assert.match(r.error, /policy must be one of/);
}));

// ---------------------------------------------------------------------------
// 14) OTA canary -> Fleet.deploy(mode:canary)
// ---------------------------------------------------------------------------
test('W888-E #14 — OTA promote with policy=canary calls Fleet.deploy with mode=canary', withSandboxDataDir(async () => {
  const set = ota.setPolicy({ namespace: 'support', policy: 'canary', options: { canary_observe_s: 1, tag: 'canary' } });
  assert.equal(set.ok, true);
  // Stub fleet captures the deploy() call.
  const calls = [];
  const stubFleet = {
    async deploy(opts) { calls.push(opts); return { ok: true, mode: opts.mode, devices: [], results: [] }; },
  };
  const r = await ota.promote({ namespace: 'support', artifactPath: '/tmp/x.kolm', fleet: stubFleet });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'canary_deploy');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'canary');
  assert.equal(calls[0].tag, 'canary');
  assert.equal(calls[0].namespace, 'support');
  assert.equal(calls[0].canaryObserveMs, 1000);
}));

// ---------------------------------------------------------------------------
// 15) CLI: kolm fleet status --json shape
// ---------------------------------------------------------------------------
test('W888-E #15 — kolm fleet status --json shape valid', async () => {
  // Sandbox so a real ~/.kolm/devices/ doesn't bleed into the test result.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888e-cli-'));
  const env = { ...process.env, KOLM_DATA_DIR: sandbox, HOME: sandbox, USERPROFILE: sandbox };
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, 'fleet', 'status', '--json'], { encoding: 'utf8', env, timeout: 30_000 });
    assert.equal(r.status, 0, 'expected exit 0; stderr=' + (r.stderr || '').slice(0, 400));
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.fleet));
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 16) CLI: kolm fleet monitor --once --json returns one tick
// ---------------------------------------------------------------------------
test('W888-E #16 — kolm fleet monitor --once --json returns one tick', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888e-mon-'));
  const env = { ...process.env, KOLM_DATA_DIR: sandbox, HOME: sandbox, USERPROFILE: sandbox };
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, 'fleet', 'monitor', '--once', '--json'], { encoding: 'utf8', env, timeout: 30_000 });
    assert.equal(r.status, 0, 'expected exit 0; stderr=' + (r.stderr || '').slice(0, 400));
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.tick);
    assert.ok(Array.isArray(parsed.tick.devices));
    assert.ok(Array.isArray(parsed.tick.alerts));
    assert.equal(typeof parsed.tick.ts, 'string');
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});
