// W888-E — Fleet monitor loop with pluggable alert sinks.
//
// FleetMonitor.tick({ tag, namespace }) -> { ts, devices: [{...health}], alerts: [...] }
// FleetMonitor.run({ tag, intervalMs, alertSinks, until }) -> long-running loop.
//
// Alert detection rules (intentionally simple — fancier heuristics belong in
// the W888-H e2e layer):
//   - kind: 'offline'   when a device's healthCheck returns reachable:false
//                       and the prior tick saw it online (state transition).
//   - kind: 'crash'     when the device is reachable but every artifact in
//                       deployed_artifacts has success:false on its most
//                       recent entry (i.e. the last deploy failed and stayed
//                       failed).
//   - kind: 'vram_high' when hw.gpu_vram_mb is reported and we have a
//                       passport min_vram_mb baseline; alert when the
//                       reported free VRAM falls under 10% of capacity.
//                       Heuristic only — a real probe needs nvidia-smi MEM_USED.
//   - kind: 'drift'     when the most recent deploy's sha256 does NOT match
//                       the manifest sha256 for the same artifact_id (i.e.
//                       someone hand-patched the bytes on the device).
//
// Sinks (pluggable). Each sink is `{ name, send(alert) -> Promise<envelope> }`.
//   - consoleSink (default): writes to stderr in a human-readable line.
//   - webhookSink({ url }): POSTs JSON to a webhook (stub-ready; uses fetch).
//   - emailSink({ smtp }): if smtp is not configured, returns an
//     install_hint envelope rather than silently dropping the alert.
//
// The Caveats / Constraints / Limitations of this monitor:
//   - VRAM-pressure detection is a coarse heuristic; on production GPU
//     boxes prefer nvidia-smi MEM_USED via SSHConnection.detectHardware().
//   - The crash heuristic only fires when the last deploy entry's success
//     flag is false; a process that exited cleanly post-deploy looks "ok"
//     to this layer. Pair with src/remote-metrics.js when it lands.
//   - We never persist alerts; the caller is responsible for sinks that
//     persist (e.g. ship to /v1/account/alerts).

import * as deviceCapsImpl from './device-capabilities.js';

// In-memory state across ticks, keyed by device_id. Lets us only fire an
// alert on *state transition* (online -> offline) instead of every tick.
class TickState {
  constructor() {
    this._prev = new Map(); // device_id -> { reachable: bool, last_sha: string|null }
  }
  observe(deviceId) { return this._prev.get(deviceId) || null; }
  record(deviceId, snapshot) { this._prev.set(deviceId, snapshot); }
  clear() { this._prev.clear(); }
}

// Built-in sinks --------------------------------------------------------------

export function consoleSink() {
  return {
    name: 'console',
    async send(alert) {
      const line = `[fleet-monitor] ${alert.kind}: device=${alert.device} ${alert.detail ? JSON.stringify(alert.detail) : ''}`;
      // stderr keeps stdout free for --json callers.
      process.stderr.write(line + '\n');
      return { ok: true, sink: 'console', sent_at: new Date().toISOString() };
    },
  };
}

export function webhookSink({ url, headers = {} } = {}) {
  return {
    name: 'webhook',
    async send(alert) {
      if (!url) return { ok: false, sink: 'webhook', error: 'no_webhook_url' };
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ alert, sent_at: new Date().toISOString() }),
        });
        return { ok: r.ok, sink: 'webhook', status: r.status };
      } catch (e) {
        return { ok: false, sink: 'webhook', error: e && e.message || String(e) };
      }
    },
  };
}

export function emailSink({ smtp = null, to = null } = {}) {
  return {
    name: 'email',
    async send(alert) {
      if (!smtp || !to) {
        return {
          ok: false,
          sink: 'email',
          install_hint: 'SMTP not configured. Set smtp.host + smtp.port + smtp.user + smtp.pass and `to` to enable email alerts.',
          alert_kind: alert.kind,
          device: alert.device,
        };
      }
      // Stub: in a real impl we'd lazy-import nodemailer here. We return a
      // structured "would have sent" envelope so the caller (and tests) can
      // verify the wiring without the SMTP side-effect.
      return {
        ok: true,
        sink: 'email',
        delivered: false,
        stub: true,
        to,
        smtp_host: smtp.host,
        subject: `[kolm] ${alert.kind} on ${alert.device}`,
      };
    },
  };
}

export class FleetMonitor {
  constructor({ deviceCaps = null, state = null } = {}) {
    this._caps = deviceCaps || deviceCapsImpl;
    this._state = state || new TickState();
  }

  // One observation cycle. Returns the device snapshot list + any alerts
  // generated this tick. Pure-ish: state-transition memory is the only
  // hidden mutation.
  async tick({ tag = null, namespace = null, alertSinks = [] } = {}) {
    const ts = new Date().toISOString();
    const devices = await this._caps.listDevices();
    const filtered = devices.filter((d) => {
      if (tag && !(Array.isArray(d.tags) && d.tags.includes(tag))) return false;
      if (namespace && d.namespace && d.namespace !== namespace) return false;
      return true;
    });

    const out = [];
    const alerts = [];

    for (const dev of filtered) {
      let health = null;
      try {
        health = await this._caps.healthCheck(dev.device_id);
      } catch (e) {
        health = { device_id: dev.device_id, ok: false, status: 'error', reason: e && e.message || String(e) };
      }
      const prev = this._state.observe(dev.device_id);

      // Offline transition.
      if (!health.reachable && (!prev || prev.reachable)) {
        alerts.push({ device: dev.device_id, kind: 'offline', detail: { reason: health.reason || null } });
      }

      // Crash: reachable but last deploy entry says failure.
      if (health.reachable && Array.isArray(dev.deployed_artifacts) && dev.deployed_artifacts.length > 0) {
        const last = dev.deployed_artifacts[0];
        if (last && last.success === false) {
          alerts.push({ device: dev.device_id, kind: 'crash', detail: { artifact_id: last.artifact_id, deployed_at: last.deployed_at } });
        }
      }

      // VRAM-high heuristic. We don't actually know used_vram; use the
      // passport's min_vram_mb (if any) vs capacity as a soft signal.
      if (health.hardware && health.hardware.gpu_vram_mb) {
        const cap = health.hardware.gpu_vram_mb;
        const minNeed = dev.deployed_artifacts && dev.deployed_artifacts[0] && dev.deployed_artifacts[0].min_vram_mb || null;
        if (minNeed && minNeed > cap * 0.9) {
          alerts.push({ device: dev.device_id, kind: 'vram_high', detail: { capacity_mb: cap, required_mb: minNeed } });
        }
      }

      // Drift: most recent deploy sha vs manifest sha (if both present).
      if (Array.isArray(dev.deployed_artifacts) && dev.deployed_artifacts.length > 0) {
        const last = dev.deployed_artifacts[0];
        if (last && last.expected_sha256 && last.sha256 && last.expected_sha256 !== last.sha256) {
          alerts.push({ device: dev.device_id, kind: 'drift', detail: { artifact_id: last.artifact_id, expected: last.expected_sha256, got: last.sha256 } });
        }
      }

      this._state.record(dev.device_id, { reachable: !!health.reachable });
      out.push({
        device: dev.device_id,
        hardware: health.hardware || null,
        deployed_artifacts: dev.deployed_artifacts || [],
        health: { ok: !!health.ok, status: health.status || (health.reachable ? 'online' : 'offline'), latency_ms: health.latency_ms || null },
        last_seen: dev.last_deployed_at || dev.registered_at || null,
      });
    }

    // Fan out alerts to sinks.
    const sinks = Array.isArray(alertSinks) && alertSinks.length ? alertSinks : [consoleSink()];
    const sinkResults = [];
    for (const a of alerts) {
      for (const s of sinks) {
        try {
          const r = await s.send(a);
          sinkResults.push({ alert: a, sink: s.name, result: r });
        } catch (e) {
          sinkResults.push({ alert: a, sink: s.name, result: { ok: false, error: e && e.message || String(e) } });
        }
      }
    }
    return { ts, devices: out, alerts, sink_results: sinkResults };
  }

  // Long-running monitor loop. Stops when `until` returns true or when the
  // returned `stop()` handle is called.
  async run({ tag = null, namespace = null, intervalMs = 30_000, alertSinks = [], until = null } = {}) {
    let stopped = false;
    const handle = { stop: () => { stopped = true; } };
    const start = async () => {
      while (!stopped) {
        const tick = await this.tick({ tag, namespace, alertSinks });
        if (typeof until === 'function' && until(tick)) { stopped = true; break; }
        if (stopped) break;
        await new Promise((res) => setTimeout(res, Math.max(100, intervalMs)));
      }
    };
    // Return the handle synchronously so the caller can stop the loop;
    // the actual loop runs in the background.
    handle.done = start();
    return handle;
  }

  resetState() { this._state.clear(); }
}

export default { FleetMonitor, consoleSink, webhookSink, emailSink };
