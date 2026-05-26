// W888-E — Fleet management surface.
//
// Wraps src/deploy-pipeline.js + src/device-capabilities.js with multi-device
// orchestration: status / deploy (rolling|canary|all) / monitor / rollback /
// stop. All methods take a {tag, namespace} pair so callers can target slices
// of the fleet (e.g. tag='edge-canary' or namespace='support').
//
// Constructor injection mirrors DeployPipeline so the test suite can pass:
//   new Fleet({ deviceCaps: stub, DeployPipelineClass: StubPipeline })
//
// Caveats / Constraints / Limitations:
//   - "rolling" here means strictly sequential per-device with stop-on-failure.
//     For zero-downtime sidecar-style rollout on ONE device, use
//     DeployPipeline.deployRolling() directly.
//   - "canary" deploys to the first device, sleeps `canaryObserveMs`, polls
//     FleetMonitor for alerts on that device, then promotes to the rest.
//     If alerts fire during the observe window the rollout aborts (the canary
//     device keeps the new artifact; no auto-rollback to keep the surface
//     predictable for operators).
//   - rollback() reverts to deployed_artifacts[1] (the entry one position
//     older than current). If no previous entry exists we emit an error
//     receipt for that device.
//   - stop() actually issues a kill of the recorded pid via SSH; emergency
//     paths take precedence over graceful drains.

import * as deviceCapsImpl from './device-capabilities.js';
import { DeployPipeline as RealPipeline } from './deploy-pipeline.js';
import { FleetMonitor } from './fleet-monitor.js';

export class Fleet {
  constructor({ deviceCaps = null, DeployPipelineClass = null, MonitorClass = null, SSHConnectionClass = null } = {}) {
    this._caps = deviceCaps || deviceCapsImpl;
    this._DeployPipelineClass = DeployPipelineClass || RealPipeline;
    this._MonitorClass = MonitorClass || FleetMonitor;
    // SSH class is only loaded when stop() needs it. We hold the reference
    // here so tests can inject a stub.
    this._SSHConnectionClass = SSHConnectionClass;
  }

  // status({tag, namespace}) -> [{device, hardware, deployed_artifacts, health, last_seen, alerts}]
  // Runs one monitor tick (with no sinks so no console noise) to derive
  // per-device alerts.
  async status({ tag = null, namespace = null } = {}) {
    const monitor = new this._MonitorClass({ deviceCaps: this._caps });
    const tick = await monitor.tick({ tag, namespace, alertSinks: [{ name: 'noop', async send() { return { ok: true }; } }] });
    // Group alerts by device.
    const alertsByDevice = new Map();
    for (const a of tick.alerts) {
      const arr = alertsByDevice.get(a.device) || [];
      arr.push({ kind: a.kind, detail: a.detail || null });
      alertsByDevice.set(a.device, arr);
    }
    return tick.devices.map((d) => ({
      device: d.device,
      hardware: d.hardware,
      deployed_artifacts: d.deployed_artifacts,
      health: d.health,
      last_seen: d.last_seen,
      alerts: alertsByDevice.get(d.device) || [],
    }));
  }

  // deploy({artifactPath, tag, namespace, mode}) -> { mode, ok, devices, results }
  // mode in {rolling, canary, all}.
  //   - rolling: sequential, stop-on-failure.
  //   - canary:  first device, observe N seconds, then promote to rest.
  //   - all:     parallel fan-out (no ordering guarantees).
  async deploy({ artifactPath, tag = null, namespace = null, mode = 'rolling', canaryObserveMs = 60_000, alertSinks = [], pipelineConfig = {} } = {}) {
    if (!['rolling', 'canary', 'all'].includes(mode)) {
      throw Object.assign(new Error(`unknown fleet deploy mode: ${mode}`), { code: 'KOLM_E_BAD_MODE' });
    }
    const devices = await this._targetDevices({ tag, namespace });
    if (!devices.length) {
      return { ok: false, mode, devices: [], results: [], reason: 'no_devices_match_filter' };
    }
    const pipeline = new this._DeployPipelineClass({ SSHConnectionClass: this._SSHConnectionClass, deviceCapsImpl: this._caps });

    const runOne = async (dev) => {
      const t0 = Date.now();
      let result;
      try {
        result = await pipeline.deploy({ artifactPath, deviceId: dev.device_id, config: pipelineConfig });
      } catch (e) {
        result = { success: false, device_id: dev.device_id, error: e && e.message || String(e), steps: [] };
      }
      return { device: dev.device_id, ok: !!result.success, elapsed_ms: Date.now() - t0, result };
    };

    if (mode === 'rolling') {
      const results = [];
      for (const d of devices) {
        const r = await runOne(d);
        results.push(r);
        if (!r.ok) {
          return { ok: false, mode: 'rolling', devices: devices.map(d => d.device_id), results, stopped_on: d.device_id, reason: 'per_device_failure' };
        }
      }
      return { ok: true, mode: 'rolling', devices: devices.map(d => d.device_id), results };
    }

    if (mode === 'canary') {
      const canary = devices[0];
      const rest = devices.slice(1);
      const canaryR = await runOne(canary);
      if (!canaryR.ok) {
        return { ok: false, mode: 'canary', devices: devices.map(d => d.device_id), results: [canaryR], stopped_on: canary.device_id, reason: 'canary_deploy_failed' };
      }
      // Observe window.
      const monitor = new this._MonitorClass({ deviceCaps: this._caps });
      const observeStart = Date.now();
      const observeAlerts = [];
      while (Date.now() - observeStart < canaryObserveMs) {
        const tick = await monitor.tick({ alertSinks });
        const relevant = tick.alerts.filter(a => a.device === canary.device_id);
        observeAlerts.push(...relevant);
        if (relevant.length) break;
        // Sleep up to the remaining window (but check every 5s).
        const remaining = canaryObserveMs - (Date.now() - observeStart);
        if (remaining <= 0) break;
        await new Promise((res) => setTimeout(res, Math.min(5_000, remaining)));
      }
      if (observeAlerts.length) {
        return { ok: false, mode: 'canary', devices: devices.map(d => d.device_id), results: [canaryR], canary_alerts: observeAlerts, reason: 'canary_alerts_fired' };
      }
      // Promote: deploy to the rest in rolling mode.
      const promoteResults = [canaryR];
      for (const d of rest) {
        const r = await runOne(d);
        promoteResults.push(r);
        if (!r.ok) {
          return { ok: false, mode: 'canary', devices: devices.map(d => d.device_id), results: promoteResults, stopped_on: d.device_id, reason: 'promotion_per_device_failure' };
        }
      }
      return { ok: true, mode: 'canary', devices: devices.map(d => d.device_id), results: promoteResults, canary_observe_ms: canaryObserveMs };
    }

    // mode === 'all'
    const results = await Promise.all(devices.map(runOne));
    const allOk = results.every(r => r.ok);
    return { ok: allOk, mode: 'all', devices: devices.map(d => d.device_id), results };
  }

  // monitor({tag, intervalMs, alertSinks}) -> handle
  monitor({ tag = null, namespace = null, intervalMs = 30_000, alertSinks = [], until = null } = {}) {
    const monitor = new this._MonitorClass({ deviceCaps: this._caps });
    return monitor.run({ tag, namespace, intervalMs, alertSinks, until });
  }

  // rollback({namespace, tag, confirm}) -> { ok, results }
  // Refuses without confirm:true. Reverts each matching device to the
  // previous deployed_artifacts entry.
  async rollback({ tag = null, namespace = null, confirm = false, pipelineConfig = {} } = {}) {
    if (!confirm) {
      return { ok: false, refused: true, reason: 'confirm_required', hint: 'Pass confirm:true (or --confirm via CLI).' };
    }
    const devices = await this._targetDevices({ tag, namespace });
    if (!devices.length) return { ok: false, results: [], reason: 'no_devices_match_filter' };
    const pipeline = new this._DeployPipelineClass({ SSHConnectionClass: this._SSHConnectionClass, deviceCapsImpl: this._caps });
    const results = [];
    for (const d of devices) {
      const journal = Array.isArray(d.deployed_artifacts) ? d.deployed_artifacts : [];
      if (journal.length < 2) {
        results.push({ device: d.device_id, ok: false, error: 'no_previous_artifact', current: journal[0] || null });
        continue;
      }
      const previous = journal[1];
      if (!previous || !previous.artifact_path) {
        results.push({ device: d.device_id, ok: false, error: 'previous_artifact_missing_path', previous });
        continue;
      }
      // Re-deploy the previous artifact. We use artifact_path which the
      // pipeline can resolve from the local artifact registry; if the
      // operator has discarded the old binary the pipeline will return a
      // preflight failure receipt.
      let r;
      try {
        r = await pipeline.deploy({ artifactPath: previous.artifact_path, deviceId: d.device_id, config: { ...pipelineConfig, port: previous.port || pipelineConfig.port, runtime: previous.runtime || pipelineConfig.runtime } });
      } catch (e) {
        r = { success: false, error: e && e.message || String(e), steps: [] };
      }
      results.push({ device: d.device_id, ok: !!r.success, rolled_back_to: previous.artifact_id, receipt: r });
    }
    const allOk = results.every(r => r.ok);
    return { ok: allOk, results };
  }

  // stop({tag, all, confirm}) -> { ok, results }
  // Refuses --all without confirm. Issues `kill <pid>` over SSH for the
  // most recent deploy's pid on each matched device.
  async stop({ tag = null, namespace = null, all = false, confirm = false } = {}) {
    if (all && !confirm) {
      return { ok: false, refused: true, reason: 'confirm_required_for_all', hint: 'Pass confirm:true (or --confirm via CLI) to stop all matching devices.' };
    }
    const devices = all ? await this._caps.listDevices() : await this._targetDevices({ tag, namespace });
    if (!devices.length) return { ok: false, results: [], reason: 'no_devices_match_filter' };
    const SSHConnectionClass = this._SSHConnectionClass || (await import('./device-ssh.js')).SSHConnection;
    const results = [];
    for (const d of devices) {
      const journal = Array.isArray(d.deployed_artifacts) ? d.deployed_artifacts : [];
      const last = journal[0];
      if (!last || !last.pid) {
        results.push({ device: d.device_id, ok: false, error: 'no_running_pid' });
        continue;
      }
      let killOut = null;
      try {
        const conn = new SSHConnectionClass(d);
        try {
          await conn.connect();
          const r = await conn.exec(`kill ${Number(last.pid)} 2>&1 || true`, { timeoutMs: 10_000 });
          killOut = { stdout: r.stdout, stderr: r.stderr, code: r.code };
        } finally { conn.disconnect(); }
      } catch (e) {
        results.push({ device: d.device_id, ok: false, error: e && e.message || String(e), pid: last.pid });
        continue;
      }
      results.push({ device: d.device_id, ok: true, killed_pid: last.pid, artifact_id: last.artifact_id, output: killOut });
    }
    const allOk = results.every(r => r.ok);
    return { ok: allOk, results, mode: all ? 'all' : 'filter' };
  }

  // Internal: resolve the list of device records that match (tag, namespace).
  async _targetDevices({ tag = null, namespace = null } = {}) {
    const all = await this._caps.listDevices();
    return all.filter((d) => {
      if (tag && !(Array.isArray(d.tags) && d.tags.includes(tag))) return false;
      if (namespace && d.namespace && d.namespace !== namespace) return false;
      return true;
    });
  }
}

export default { Fleet };
