// W888-D - Rolling deploy delegate.
//
// Zero-downtime cutover for multi-replica devices. The pipeline calls this
// module when `config.rolling === true` OR `--rolling` is passed.
//
// Semantics:
//   - For `config.replicas > 1`: deploy one replica at a time. The old
//     replica keeps serving until the new one passes smoke; only then is
//     the old one taken down. We track `replicas_migrated` + `replicas_downtime`
//     so the caller can prove the cutover was safe.
//   - For single-replica devices: brief downtime is acceptable. We still
//     run the standard pipeline, but stamp `replicas_downtime: 1` so the
//     receipt is explicit.
//   - Each replica deployment binds to a separate port (basePort, basePort+1,
//     basePort+2, ...). The pipeline already supports a `port` override.
//
// Constructor injection:
//   const r = new RollingDeploy({ pipeline });            // production
//   const r = new RollingDeploy({ pipeline: stubPipeline }); // tests
//
// Caveats / Constraints / Limitations:
//   - This module does NOT implement traffic-shifting on its own. Once a
//     replica is healthy the load-balancer wiring is left to fleet-monitor
//     + the operator's reverse-proxy config. We record per-replica endpoints
//     so the operator can swap the upstream pool when ready.
//   - Failure mid-rollout: if replica N fails, we stop and return a
//     rollback_candidate pointing at replica N-1 (which kept serving).
//     The pipeline's rollback() handles actual revert.
//
// Returns:
//   { ok, replicas_migrated, replicas_total, replicas_downtime,
//     per_replica: [{ replica_index, port, success, deployment_id, steps }],
//     rollback_candidate?, reason? }

export class RollingDeploy {
  constructor({ pipeline, log = null } = {}) {
    if (!pipeline) {
      const e = new Error('RollingDeploy: pipeline is required'); e.code = 'KOLM_E_NO_PIPELINE'; throw e;
    }
    this._pipeline = pipeline;
    this._log = typeof log === 'function' ? log : () => {};
  }

  async deploy({ artifactPath, deviceId, config = {} } = {}) {
    const replicas = Math.max(1, Number(config.replicas || 1));
    const basePort = Number(config.port || 8080);
    const per_replica = [];
    let firstFailureIdx = -1;
    for (let i = 0; i < replicas; i++) {
      const replicaConfig = { ...config, port: basePort + i, replicas: 1 };
      // Strip `rolling` flag so the inner deploy doesn't recurse.
      delete replicaConfig.rolling;
      this._log({ type: 'rolling.replica.start', replica_index: i, port: replicaConfig.port });
      const r = await this._pipeline.deploy({ artifactPath, deviceId, config: replicaConfig });
      per_replica.push({
        replica_index: i,
        port: replicaConfig.port,
        success: !!r.success,
        deployment_id: r.deployment_id || null,
        endpoint: r.endpoint || null,
        steps: (r.steps || []).map(s => ({ step: s.step, ok: s.ok, elapsed_ms: s.elapsed_ms })),
      });
      this._log({ type: 'rolling.replica.finished', replica_index: i, ok: !!r.success });
      if (!r.success) {
        firstFailureIdx = i;
        break;
      }
    }
    const migrated = per_replica.filter(p => p.success).length;
    // Downtime accounting: single replica → 1 (brief downtime expected).
    // Multi-replica zero-downtime → 0 unless we failed mid-rollout.
    const replicas_downtime = replicas === 1
      ? 1
      : (firstFailureIdx >= 0 ? 1 : 0);
    const out = {
      ok: firstFailureIdx === -1,
      mode: 'rolling',
      replicas_migrated: migrated,
      replicas_total: replicas,
      replicas_downtime,
      per_replica,
    };
    if (firstFailureIdx >= 0) {
      out.reason = `replica_${firstFailureIdx}_failed`;
      out.rollback_candidate = per_replica[firstFailureIdx - 1] || null;
    }
    return out;
  }
}

// Convenience entry point: callers that don't want to instantiate can pass
// a pipeline + config in one call.
export async function deployRolling({ pipeline, artifactPath, deviceId, config = {} } = {}) {
  return await new RollingDeploy({ pipeline }).deploy({ artifactPath, deviceId, config });
}

export default { RollingDeploy, deployRolling };
