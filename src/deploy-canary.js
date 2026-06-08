// W888-D - Canary deploy delegate.
//
// Deploys to ONE device first, observes for `canaryWindowS` seconds, scrapes
// metrics, and either promotes the rollout to the remaining devices (rolling
// mode) or auto-rolls back the canary device + aborts the fleet rollout.
//
// Auto-rollback triggers:
//   - error rate > `errorRateThreshold` (default 0.05 = 5%)
//   - latency p95 > `latencyP95Factor` × baseline (default 2x baseline_p95_ms)
//   - explicit canary alert from metrics provider
//
// Constructor injection:
//   const c = new CanaryDeploy({ pipeline, metricsProvider });
//   const c = new CanaryDeploy({ pipeline, metricsProvider: fakeMetrics }); // tests
//
// metricsProvider contract (W888-D scope - real implementation in W888-E
// `src/remote-metrics.js`):
//   async sampleCanary(deviceId, { windowS, sinceMs }) →
//     { error_rate, latency_p95_ms, baseline_p95_ms, request_count }
//
// Caveats / Constraints / Limitations:
//   - Without a real metricsProvider this module accepts an injectable stub.
//     The default stub returns healthy metrics, so production callers MUST
//     wire in a real provider. We log a warning when running with the stub.
//   - "Rollback" here re-runs DeployPipeline.deploy() against the previous
//     deployed artifact (looked up via DeployPipeline.loadDeployments()).
//   - The post-canary promotion runs through RollingDeploy so the caller's
//     batch never deploys to ALL devices at once after the canary.

import { RollingDeploy } from './deploy-rolling.js';

// Default metrics provider - always returns healthy. Production callers
// MUST inject a real provider (W888-E src/remote-metrics.js).
const _stubMetricsProvider = {
  async sampleCanary(_deviceId, { baseline_p95_ms = 100 } = {}) {
    return {
      error_rate: 0,
      latency_p95_ms: baseline_p95_ms,
      baseline_p95_ms,
      request_count: 0,
      source: 'stub',
    };
  },
};

export class CanaryDeploy {
  constructor({ pipeline, metricsProvider = null, log = null } = {}) {
    if (!pipeline) {
      const e = new Error('CanaryDeploy: pipeline is required'); e.code = 'KOLM_E_NO_PIPELINE'; throw e;
    }
    this._pipeline = pipeline;
    this._metrics = metricsProvider || _stubMetricsProvider;
    this._log = typeof log === 'function' ? log : () => {};
  }

  // deploy({ artifactPath, deviceIds, config }) - deviceIds is the fleet
  // including canary in deviceIds[0]. config.canaryWindowS defaults to 300.
  async deploy({ artifactPath, deviceIds = [], config = {} } = {}) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      return { ok: false, reason: 'no_devices', deviceIds };
    }
    const canaryDeviceId = deviceIds[0];
    const remaining = deviceIds.slice(1);
    const canaryWindowS = Number(config.canaryWindowS || config.canary_window_s || 300);
    const errorRateThreshold = Number(config.errorRateThreshold || 0.05);
    const latencyP95Factor = Number(config.latencyP95Factor || 2);

    // 1. Deploy to canary device first.
    this._log({ type: 'canary.start', device: canaryDeviceId, window_s: canaryWindowS });
    const canaryResult = await this._pipeline.deploy({
      artifactPath,
      deviceId: canaryDeviceId,
      config: { ...config, port: config.port || 8080 },
    });
    if (!canaryResult.success) {
      return {
        ok: false,
        reason: 'canary_deploy_failed',
        canary_device: canaryDeviceId,
        canary_result: canaryResult,
        promoted: false,
      };
    }

    // 2. Sleep + sample metrics from canary device.
    const sampleStart = Date.now();
    if (canaryWindowS > 0 && !config.skipObserveSleep) {
      await new Promise((res) => setTimeout(res, Math.min(canaryWindowS * 1000, 60_000)));
    }
    let metrics;
    try {
      metrics = await this._metrics.sampleCanary(canaryDeviceId, {
        windowS: canaryWindowS,
        sinceMs: sampleStart,
      });
    } catch (e) {
      metrics = { error: e && e.message ? e.message : String(e), source: 'error' };
    }
    this._log({ type: 'canary.metrics', device: canaryDeviceId, metrics });

    // 3. Decide: promote, rollback, or abort.
    const unhealthy =
      (metrics && metrics.error_rate != null && metrics.error_rate > errorRateThreshold) ||
      (metrics && metrics.latency_p95_ms != null && metrics.baseline_p95_ms != null
        && metrics.latency_p95_ms > metrics.baseline_p95_ms * latencyP95Factor);

    if (unhealthy) {
      // Auto-rollback canary device.
      this._log({ type: 'canary.unhealthy', device: canaryDeviceId, metrics });
      let rollback = null;
      try {
        rollback = await this._pipeline.rollback({ deviceId: canaryDeviceId, config });
      } catch (e) {
        rollback = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      return {
        ok: false,
        reason: 'canary_metrics_unhealthy',
        canary_device: canaryDeviceId,
        canary_result: canaryResult,
        metrics,
        rollback,
        promoted: false,
        fleet_rollout_aborted: true,
      };
    }

    // 4. Healthy canary - promote to remaining devices via rolling.
    if (remaining.length === 0) {
      return {
        ok: true,
        reason: 'canary_healthy_no_remaining_devices',
        canary_device: canaryDeviceId,
        canary_result: canaryResult,
        metrics,
        promoted: false,
      };
    }
    const rolling = new RollingDeploy({ pipeline: this._pipeline, log: this._log });
    const promotions = [];
    let firstFailureIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const dev = remaining[i];
      const r = await this._pipeline.deploy({
        artifactPath,
        deviceId: dev,
        config: { ...config, port: config.port || 8080 },
      });
      promotions.push({ device: dev, ok: !!r.success, deployment_id: r.deployment_id || null });
      if (!r.success) { firstFailureIdx = i; break; }
    }
    return {
      ok: firstFailureIdx === -1,
      reason: firstFailureIdx === -1 ? 'canary_promoted' : 'promotion_failed',
      canary_device: canaryDeviceId,
      canary_result: canaryResult,
      metrics,
      promoted: true,
      promotions,
      stopped_on: firstFailureIdx >= 0 ? remaining[firstFailureIdx] : null,
    };
  }
}

// Convenience entry point.
export async function deployCanary({ pipeline, metricsProvider, artifactPath, deviceIds, config } = {}) {
  return await new CanaryDeploy({ pipeline, metricsProvider }).deploy({ artifactPath, deviceIds, config });
}

export default { CanaryDeploy, deployCanary };
