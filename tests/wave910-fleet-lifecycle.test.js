// W910-D — Fleet lifecycle tests.
//
// Pins the full add -> status -> deploy -> health -> undeploy -> remove cycle
// against stubbed transports. The SSH connection class and DeployPipeline are
// both injected so no real network traffic happens.
//
// Pinned items:
//   1) Fleet.status returns row for newly-registered SSH device
//   2) Fleet.deploy mode=all parallel fan-out across N=3 stubbed SSH devices
//   3) Fleet.status reflects the deployed artifact afterward
//   4) Fleet.stop --all + confirm:true kills the pid on each device
//   5) Fleet.deploy refuses when no devices match the filter
//   6) Fleet.rollback refuses without confirm:true
//   7) Fleet.rollback to previous artifact succeeds when journal has >=2 entries
//   8) Fleet.deploy mode=canary aborts on canary alert
//   9) Fleet.deploy mode=canary promotes when canary is clean
//  10) Fleet.deploy mode=rolling stops on first failure (regression guard)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Fleet } from '../src/fleet.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeCaps({ devices = [], healthByDevice = {}, alertsByDevice = {} } = {}) {
  return {
    async listDevices() { return devices.slice(); },
    async getDevice(id) { return devices.find(d => d.device_id === id) || null; },
    async testDevice(id) {
      const d = devices.find(x => x.device_id === id);
      return d ? { reachable: true } : { reachable: false, reason: 'unknown' };
    },
    async detectHardwareRemote(id) {
      const d = devices.find(x => x.device_id === id);
      return { device_id: id, source: 'stub', snapshot: d ? d.hardware_snapshot : null, error: null };
    },
    async healthCheck(id) {
      if (healthByDevice[id]) return healthByDevice[id];
      const d = devices.find(x => x.device_id === id);
      return {
        device_id: id, ok: !!d, status: d ? 'online' : 'offline',
        reachable: !!d, hardware: d ? d.hardware_snapshot : null,
        installed_artifacts: d ? d.deployed_artifacts || [] : [],
        latency_ms: 1, checked_at: new Date().toISOString(),
      };
    },
    async recordDeployment(id, payload) { return payload; },
    __alertsByDevice: alertsByDevice,
  };
}

function makeDevice(over = {}) {
  return {
    device_id: 'gpu-1',
    type: 'ssh',
    kind: 'server',
    connection: { host: 'gpu1.example.com', user: 'kolm', port: 22, key_path: '/fake/key' },
    hardware_snapshot: { gpu: 'RTX A4000', gpu_vram_mb: 16384, disk_free_mb: 200000 },
    tags: ['prod'],
    namespace: 'support',
    deployed_artifacts: [],
    ...over,
  };
}

function makePipelineClass(scriptByDevice = {}) {
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

function makeSSHClass({ killOutByDevice = {}, throwOnConnect = false } = {}) {
  return class StubSSH {
    constructor(dev) { this.dev = dev; }
    async connect() { if (throwOnConnect) throw new Error('connect refused'); }
    async exec(cmd, opts) {
      const m = String(cmd || '').match(/^kill\s+(\d+)/);
      const pid = m ? Number(m[1]) : null;
      const out = killOutByDevice[this.dev.device_id];
      return out || { stdout: pid ? `killed ${pid}` : '', stderr: '', code: 0 };
    }
    disconnect() { /* no-op */ }
  };
}

function makeMonitorClass({ alertsByTick = [[]] } = {}) {
  let i = 0;
  return class StubMonitor {
    constructor({ deviceCaps } = {}) { this.caps = deviceCaps; }
    async tick({ tag = null, namespace = null, alertSinks = [] } = {}) {
      const devs = await this.caps.listDevices();
      const filtered = devs.filter((d) => {
        if (tag && !(Array.isArray(d.tags) && d.tags.includes(tag))) return false;
        if (namespace && d.namespace && d.namespace !== namespace) return false;
        return true;
      });
      const alerts = alertsByTick[Math.min(i, alertsByTick.length - 1)] || [];
      i++;
      return {
        devices: filtered.map((d) => ({
          device: d.device_id,
          hardware: d.hardware_snapshot || null,
          deployed_artifacts: d.deployed_artifacts || [],
          health: 'online',
          last_seen: new Date().toISOString(),
        })),
        alerts,
      };
    }
    async run() { return { stop: () => {} }; }
  };
}

function makeArtifactFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w910-art-'));
  const p = path.join(dir, 'm.kolm');
  fs.writeFileSync(p, Buffer.alloc(64, 'K'));
  return { path: p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }; // deliberate: cleanup
}

// ---------------------------------------------------------------------------

test('W910-D #1 — Fleet.status returns row for newly-registered SSH device', async () => {
  const d = makeDevice({ device_id: 'edge-1', tags: ['edge'], deployed_artifacts: [] });
  const caps = makeCaps({ devices: [d] });
  const fleet = new Fleet({ deviceCaps: caps, MonitorClass: makeMonitorClass() });
  const rows = await fleet.status({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device, 'edge-1');
  assert.ok(Array.isArray(rows[0].alerts));
});

test('W910-D #2 — Fleet.deploy mode=all parallel fan-out across 3 SSH devices', async () => {
  const devs = ['a', 'b', 'c'].map((id) => makeDevice({ device_id: id, tags: ['fleet'] }));
  const caps = makeCaps({ devices: devs });
  const Pipeline = makePipelineClass();
  const fleet = new Fleet({ deviceCaps: caps, DeployPipelineClass: Pipeline, MonitorClass: makeMonitorClass() });
  const art = makeArtifactFile();
  try {
    const r = await fleet.deploy({ artifactPath: art.path, tag: 'fleet', mode: 'all' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'all');
    assert.equal(r.results.length, 3);
    assert.deepEqual(r.results.map((x) => x.device).sort(), ['a', 'b', 'c']);
    for (const res of r.results) assert.equal(res.ok, true);
  } finally { art.cleanup(); }
});

test('W910-D #3 — Fleet.status reflects the deployed artifact afterward', async () => {
  const devs = [
    makeDevice({ device_id: 'a', tags: ['t'], deployed_artifacts: [{ artifact_id: 'm', port: 8080 }] }),
  ];
  const caps = makeCaps({ devices: devs });
  const fleet = new Fleet({ deviceCaps: caps, MonitorClass: makeMonitorClass() });
  const rows = await fleet.status({ tag: 't' });
  assert.equal(rows[0].deployed_artifacts.length, 1);
  assert.equal(rows[0].deployed_artifacts[0].artifact_id, 'm');
});

test('W910-D #4 — Fleet.stop --all + confirm:true kills the recorded pid on each device', async () => {
  const devs = [
    makeDevice({ device_id: 'a', deployed_artifacts: [{ artifact_id: 'a-art', pid: 1234 }] }),
    makeDevice({ device_id: 'b', deployed_artifacts: [{ artifact_id: 'b-art', pid: 5678 }] }),
  ];
  const caps = makeCaps({ devices: devs });
  const SSH = makeSSHClass({ killOutByDevice: { a: { stdout: 'killed 1234', stderr: '', code: 0 } } });
  const fleet = new Fleet({ deviceCaps: caps, SSHConnectionClass: SSH, MonitorClass: makeMonitorClass() });
  const r = await fleet.stop({ all: true, confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].killed_pid, 1234);
  assert.equal(r.results[1].killed_pid, 5678);
});

test('W910-D #5 — Fleet.deploy refuses when no devices match filter', async () => {
  const caps = makeCaps({ devices: [makeDevice({ device_id: 'a', tags: ['prod'] })] });
  const fleet = new Fleet({ deviceCaps: caps, MonitorClass: makeMonitorClass() });
  const art = makeArtifactFile();
  try {
    const r = await fleet.deploy({ artifactPath: art.path, tag: 'no-such-tag', mode: 'rolling' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_devices_match_filter');
  } finally { art.cleanup(); }
});

test('W910-D #6 — Fleet.rollback refuses without confirm', async () => {
  const caps = makeCaps({ devices: [makeDevice({ device_id: 'a' })] });
  const fleet = new Fleet({ deviceCaps: caps, MonitorClass: makeMonitorClass() });
  const r = await fleet.rollback({ tag: 'prod' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'confirm_required');
});

test('W910-D #7 — Fleet.rollback to previous artifact when journal has >=2 entries', async () => {
  const devs = [
    makeDevice({
      device_id: 'a',
      deployed_artifacts: [
        { artifact_id: 'v2', artifact_path: '/tmp/v2.kolm', port: 8080, runtime: 'llama' },
        { artifact_id: 'v1', artifact_path: '/tmp/v1.kolm', port: 8080, runtime: 'llama' },
      ],
    }),
  ];
  const caps = makeCaps({ devices: devs });
  const Pipeline = makePipelineClass({ a: { success: true, device_id: 'a', steps: [] } });
  const fleet = new Fleet({ deviceCaps: caps, DeployPipelineClass: Pipeline, MonitorClass: makeMonitorClass() });
  const r = await fleet.rollback({ tag: 'prod', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].rolled_back_to, 'v1');
});

test('W910-D #8 — Fleet.deploy mode=canary aborts on canary alert', async () => {
  const devs = [
    makeDevice({ device_id: 'a', tags: ['fleet'] }),
    makeDevice({ device_id: 'b', tags: ['fleet'] }),
  ];
  const caps = makeCaps({ devices: devs });
  const Pipeline = makePipelineClass();
  const Monitor = makeMonitorClass({
    alertsByTick: [[{ device: 'a', kind: 'k_score_floor', detail: { observed: 0.5 } }]],
  });
  const fleet = new Fleet({ deviceCaps: caps, DeployPipelineClass: Pipeline, MonitorClass: Monitor });
  const art = makeArtifactFile();
  try {
    const r = await fleet.deploy({ artifactPath: art.path, tag: 'fleet', mode: 'canary', canaryObserveMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'canary');
    assert.equal(r.reason, 'canary_alerts_fired');
  } finally { art.cleanup(); }
});

test('W910-D #9 — Fleet.deploy mode=canary promotes when canary is clean', async () => {
  const devs = ['a', 'b', 'c'].map((id) => makeDevice({ device_id: id, tags: ['fleet'] }));
  const caps = makeCaps({ devices: devs });
  const Pipeline = makePipelineClass();
  const Monitor = makeMonitorClass({ alertsByTick: [[]] });
  const fleet = new Fleet({ deviceCaps: caps, DeployPipelineClass: Pipeline, MonitorClass: Monitor });
  const art = makeArtifactFile();
  try {
    const r = await fleet.deploy({ artifactPath: art.path, tag: 'fleet', mode: 'canary', canaryObserveMs: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'canary');
    assert.equal(r.results.length, 3);
  } finally { art.cleanup(); }
});

test('W910-D #10 — Fleet.deploy mode=rolling stops on first failure (regression guard)', async () => {
  const devs = ['a', 'b', 'c'].map((id) => makeDevice({ device_id: id, tags: ['x'] }));
  const caps = makeCaps({ devices: devs });
  const Pipeline = makePipelineClass({
    a: { success: true, device_id: 'a', steps: [] },
    b: { success: false, device_id: 'b', error: 'preflight failed', steps: [] },
    c: { success: true, device_id: 'c', steps: [] },
  });
  const fleet = new Fleet({ deviceCaps: caps, DeployPipelineClass: Pipeline, MonitorClass: makeMonitorClass() });
  const art = makeArtifactFile();
  try {
    const r = await fleet.deploy({ artifactPath: art.path, tag: 'x', mode: 'rolling' });
    assert.equal(r.ok, false);
    assert.equal(r.stopped_on, 'b');
    assert.equal(r.results.length, 2, 'must not proceed to c');
  } finally { art.cleanup(); }
});
