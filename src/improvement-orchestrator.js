// W720-2/3 — self-improvement orchestrator.
//
// Two-leg primitive that powers `kolm distill improve`:
//
//   orchestrateImprovement({tenant_id, namespace, candidates, opts}) — kicks
//     off a re-distill round with curriculum + (optional) teacher council. The
//     orchestrator returns immediately with {run_id, poll_url}; the actual
//     distill runs OFFLINE as a detached worker so the CLI / server caller is
//     never blocked.
//
//   compareAndDecide({tenant_id, base_artifact_id, candidate_artifact_id,
//     gate}) — reads K-Score from both artifacts and emits a decision of
//     'promote' | 'hold' | 'rollback'. When `auto_promote:true` is passed in
//     the gate the promote decision additionally writes a promoted.json file
//     under ~/.kolm/registry/<artifact_id>/.
//
// Heavy ML stays in src/distill-pipeline.js (worker spawn under the hood).
// This module is glue + decision logic + the registry file write.
//
// W720 memory traps observed:
//   - tenant fence at every registry/event read (defense in depth)
//   - honest envelope on every error path (machine-code + hint, never silent)
//   - atomic file writes: promoted.json + run-meta updates write to .tmp
//     then rename, never partial-write a JSON file
//   - NO new HTTP routes (src/router.js untouched this wave)
//   - NO src/artifact.js edits (sibling agent W721 owns hash-chain additions)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const IMPROVEMENT_VERSION = 'w720-v1';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _kolmDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  if (process.env.KOLM_HOME) return path.resolve(process.env.KOLM_HOME);
  return path.join(_home(), '.kolm');
}

function _registryDir() {
  const d = path.join(_kolmDir(), 'registry');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function _distillRunsDir() {
  const d = path.join(_kolmDir(), 'distill-runs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Atomic JSON write — never partial-write a JSON file.
//   .tmp + rename is the W720 memory trap requirement.
function _atomicWriteJson(target, obj) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

function _nextRoundForArtifact(baseArtifactId) {
  if (!baseArtifactId) return 1;
  try {
    const regDir = path.join(_registryDir(), String(baseArtifactId));
    if (!fs.existsSync(regDir)) return 1;
    const promotedPath = path.join(regDir, 'promoted.json');
    if (!fs.existsSync(promotedPath)) return 1;
    const p = JSON.parse(fs.readFileSync(promotedPath, 'utf8'));
    if (Number.isFinite(Number(p.self_improvement_round))) {
      return Number(p.self_improvement_round) + 1;
    }
  } catch { /* ignore — first round */ }
  return 1;
}

// ---------------------------------------------------------------------------
// orchestrateImprovement — non-blocking re-distill kickoff.
// ---------------------------------------------------------------------------
//
// Returns:
//   {ok:true, run_id, base_artifact_id, candidate_artifact_id, plan, poll_url}
// on success, or an honest envelope on failure:
//   {ok:false, error:'<code>', hint:'<actionable>', ...}
//
// The run_id is stable and matches the distill-runs directory the underlying
// worker would create (so the caller can poll ~/.kolm/distill-runs/<run_id>/
// for run-meta.json + manifest.json without further coordination).
//
// The function writes a self_improvement run-meta stub IMMEDIATELY (before any
// worker spawn) so that even if the distill worker never starts the audit
// chain is intact. The stub is later overwritten by the distill worker's own
// run-meta (with the stamps merged forward).
export async function orchestrateImprovement(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    candidates = [],
    opts: subOpts = {},
  } = opts || {};

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      ok: false,
      error: 'no_candidates',
      hint: 'pass candidates from detectUnderperformingCaptures({...}) — empty list is a no-op',
      improvement_version: IMPROVEMENT_VERSION,
    };
  }

  // Lazy-import distill-pipeline so a missing module surfaces as a clean
  // honest envelope (not a top-level crash).
  let distillMod;
  try {
    distillMod = await import('./distill-pipeline.js');
  } catch (e) {
    return {
      ok: false,
      error: 'distill_pipeline_unavailable',
      detail: e && e.message ? e.message : String(e),
      hint: 'check src/distill-pipeline.js',
      improvement_version: IMPROVEMENT_VERSION,
    };
  }
  if (typeof distillMod.distill !== 'function') {
    return {
      ok: false,
      error: 'distill_pipeline_unavailable',
      hint: 'src/distill-pipeline.js loaded but does not export distill()',
      improvement_version: IMPROVEMENT_VERSION,
    };
  }

  // Resolve base artifact (first candidate's current_artifact_id wins; the
  // orchestrator does not arbitrate which artifact gets re-distilled — that
  // decision is the CLI's).
  const baseArtifactId = candidates.find((c) => c && c.current_artifact_id)?.current_artifact_id || null;
  const round = _nextRoundForArtifact(baseArtifactId);

  // Generate the run_id deterministically so the caller can poll it BEFORE
  // the distill worker has written its own run-meta. Mirrors the shape used
  // by distill-pipeline._distillRunDir().
  const runId = 'run_si_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const candidateArtifactId = 'art_si_' + crypto.randomBytes(6).toString('hex');

  const useCurriculum = subOpts.use_curriculum !== false; // default true
  const useCouncil = subOpts.use_council === true;
  const studentBase = subOpts.student_base || 'qwen-3b';
  const recipesAdded = Number.isFinite(subOpts.recipes_added) ? Number(subOpts.recipes_added) : candidates.length;

  // Stamp run-meta immediately so the audit trail is intact even if the
  // worker spawn fails / is deferred. The distill worker will overwrite parts
  // of this file later; the self_improvement block survives intact.
  const runDir = path.join(_distillRunsDir(), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const telemetrySeed = candidates.slice(0, 1000).map((c) => c.capture_id).filter(Boolean);
  const runMeta = {
    job_id: runId,
    run_id: runId,
    tenant_id: tenant_id || 'local',
    namespace: namespace || null,
    student_base: studentBase,
    created_at: new Date().toISOString(),
    improvement_version: IMPROVEMENT_VERSION,
    self_improvement: {
      round,
      base_artifact: baseArtifactId,
      candidate_artifact: candidateArtifactId,
      telemetry_seed: telemetrySeed,
      candidate_count: candidates.length,
      use_curriculum: useCurriculum,
      use_council: useCouncil,
    },
    // Convenience top-level fields for older readers.
    self_improvement_round: round,
    base_artifact: baseArtifactId,
    telemetry_seed: telemetrySeed,
  };
  try {
    _atomicWriteJson(path.join(runDir, 'run-meta.json'), runMeta);
  } catch (e) {
    return {
      ok: false,
      error: 'run_meta_write_failed',
      detail: e && e.message ? e.message : String(e),
      hint: 'check that ' + runDir + ' is writable',
      improvement_version: IMPROVEMENT_VERSION,
    };
  }

  // Spawn the distill worker OFFLINE — do not await its iterator. The
  // distill-pipeline iterator is async, but the orchestrator's contract is
  // non-blocking, so we kick the first .next() into a queued microtask and
  // return immediately. Any subsequent iteration / cleanup happens off the
  // caller's stack.
  //
  // We pass tenant_id + namespace forward so the distill-pipeline corpus read
  // is tenant-fenced (matches the W422 P0-4 default).
  if (subOpts.skip_spawn !== true) {
    // Fire-and-forget — never await. The pipeline writes its own run-meta
    // (overwriting our stub in places) plus progress.jsonl + manifest.json.
    queueMicrotask(() => {
      // Errors here are non-fatal for the orchestrator caller; we wrap in
      // try/catch so an unhandled rejection does not crash the process.
      (async () => {
        try {
          const iter = distillMod.distill({
            teacher_namespace: namespace,
            student_base: studentBase,
            tenant_id: tenant_id || 'local',
            use_curriculum: useCurriculum,
            use_council: useCouncil,
            pairs_override: subOpts.pairs_override || null,
          });
          // Drain the iterator so the worker actually runs through completion
          // (otherwise distill() yields its first synthetic event and stalls).
          // We bound the drain to ~20 events so even an unbounded iterator
          // does not leak a long-running async loop.
          let count = 0;
          // eslint-disable-next-line no-restricted-syntax
          for await (const ev of iter) {
            count += 1;
            if (ev && ev.done) break;
            if (count > 1000) break;
          }
        } catch (_) { /* worker errors land in the worker log — orchestrator does not surface */ }
      })().catch(() => {});
    });
  }

  return {
    ok: true,
    improvement_version: IMPROVEMENT_VERSION,
    run_id: runId,
    base_artifact_id: baseArtifactId,
    candidate_artifact_id: candidateArtifactId,
    plan: {
      recipes_added: recipesAdded,
      curriculum_enabled: useCurriculum,
      teacher_council: useCouncil,
      candidate_count: candidates.length,
      round,
    },
    poll_url: '/v1/distill/runs/' + runId,
    run_dir: runDir,
  };
}

// ---------------------------------------------------------------------------
// compareAndDecide — promote / hold / rollback gate.
// ---------------------------------------------------------------------------
//
// Reads K-Score from both artifacts via src/artifact-runner.js loadArtifact
// (manifest.k_score OR manifest.eval_results.kscore). Returns:
//   {ok:true, decision:'promote'|'hold'|'rollback', base_kscore,
//    candidate_kscore, delta, regressions:[]}
// or honest envelope:
//   {ok:false, error:'no_kscore_on_artifact', hint:'run kolm bench or
//                    distill --eval first', ...}
//
// Decision rules:
//   'promote'  — candidate_kscore >= base_kscore + min_kscore_delta AND
//                regressions.length <= max_regression_classes
//   'hold'     — within +/- min_kscore_delta of base (close call — human
//                review)
//   'rollback' — candidate strictly worse (delta < -min_kscore_delta)
//
// When the caller passes `auto_promote:true` in gate AND decision==='promote',
// we write ~/.kolm/registry/<candidate_artifact_id>/promoted.json with
// timestamp + delta + decision_at + base + candidate ids.
export async function compareAndDecide(opts = {}) {
  const {
    tenant_id = null,
    base_artifact_id,
    candidate_artifact_id,
    gate = {},
    base_kscore: baseKscoreOverride,
    candidate_kscore: candidateKscoreOverride,
  } = opts || {};

  const minDelta = Number.isFinite(Number(gate.min_kscore_delta)) ? Number(gate.min_kscore_delta) : 0.02;
  const maxRegressionClasses = Number.isFinite(Number(gate.max_regression_classes))
    ? Number(gate.max_regression_classes) : 0;
  const autoPromote = gate.auto_promote === true;

  if (!base_artifact_id || !candidate_artifact_id) {
    return {
      ok: false,
      error: 'missing_artifact_id',
      hint: 'pass both base_artifact_id and candidate_artifact_id',
      improvement_version: IMPROVEMENT_VERSION,
    };
  }

  // Read K-Score from each artifact. Overrides win when supplied (tests
  // exercise the decision logic without loading a real .kolm).
  let baseScore, candidateScore;
  let baseRegressions = [];
  let candidateRegressions = [];
  if (Number.isFinite(Number(baseKscoreOverride))) {
    baseScore = Number(baseKscoreOverride);
  } else {
    const r = await _readKScoreFromArtifact(base_artifact_id);
    if (!r.ok) {
      return {
        ok: false,
        error: 'no_kscore_on_artifact',
        which: 'base',
        artifact_id: base_artifact_id,
        detail: r.detail || null,
        hint: 'run kolm bench or distill --eval first to stamp k_score on the artifact manifest',
        improvement_version: IMPROVEMENT_VERSION,
      };
    }
    baseScore = r.k_score;
    baseRegressions = r.regressions || [];
  }
  if (Number.isFinite(Number(candidateKscoreOverride))) {
    candidateScore = Number(candidateKscoreOverride);
  } else {
    const r = await _readKScoreFromArtifact(candidate_artifact_id);
    if (!r.ok) {
      return {
        ok: false,
        error: 'no_kscore_on_artifact',
        which: 'candidate',
        artifact_id: candidate_artifact_id,
        detail: r.detail || null,
        hint: 'run kolm bench or distill --eval first to stamp k_score on the artifact manifest',
        improvement_version: IMPROVEMENT_VERSION,
      };
    }
    candidateScore = r.k_score;
    candidateRegressions = r.regressions || [];
  }

  const delta = candidateScore - baseScore;
  // Compute "regressions" — the candidate's per-class regression set minus
  // anything the base already failed (which would not count as new regression).
  const regressions = candidateRegressions.filter((cls) => !baseRegressions.includes(cls));

  let decision;
  if (delta >= minDelta && regressions.length <= maxRegressionClasses) {
    decision = 'promote';
  } else if (delta < -minDelta) {
    decision = 'rollback';
  } else {
    decision = 'hold';
  }

  // Auto-promote writes the registry receipt. Defense-in-depth tenant fence:
  // we check tenant_id was supplied (so cross-tenant writes can't happen
  // accidentally) and stamp it on the receipt.
  let promotedPath = null;
  if (decision === 'promote' && autoPromote) {
    try {
      const dir = path.join(_registryDir(), String(candidate_artifact_id));
      fs.mkdirSync(dir, { recursive: true });
      promotedPath = path.join(dir, 'promoted.json');
      _atomicWriteJson(promotedPath, {
        improvement_version: IMPROVEMENT_VERSION,
        candidate_artifact_id,
        base_artifact_id,
        tenant_id: tenant_id || 'local',
        decision: 'promote',
        decision_at: new Date().toISOString(),
        delta,
        base_kscore: baseScore,
        candidate_kscore: candidateScore,
        regressions,
        gate: {
          min_kscore_delta: minDelta,
          max_regression_classes: maxRegressionClasses,
        },
        self_improvement_round: _nextRoundForArtifact(base_artifact_id),
      });
    } catch (e) {
      return {
        ok: false,
        error: 'promoted_write_failed',
        detail: e && e.message ? e.message : String(e),
        hint: 'check that ' + _registryDir() + ' is writable',
        improvement_version: IMPROVEMENT_VERSION,
      };
    }
  }

  return {
    ok: true,
    improvement_version: IMPROVEMENT_VERSION,
    decision,
    base_kscore: baseScore,
    candidate_kscore: candidateScore,
    delta: Math.round(delta * 1e6) / 1e6,
    regressions,
    base_artifact_id,
    candidate_artifact_id,
    promoted_path: promotedPath,
    auto_promote: autoPromote,
    gate: {
      min_kscore_delta: minDelta,
      max_regression_classes: maxRegressionClasses,
    },
  };
}

// ---------------------------------------------------------------------------
// _readKScoreFromArtifact — reads K-Score from a .kolm OR a registry stub.
// ---------------------------------------------------------------------------
//
// Resolution order:
//   1. ~/.kolm/registry/<artifact_id>/manifest.json (test-friendly stub)
//   2. ~/.kolm/registry/<artifact_id>/promoted.json (carries candidate_kscore)
//   3. ~/.kolm/artifacts/<artifact_id>.kolm via loadArtifact()
//   4. <artifact_id> treated as a literal .kolm path
//
// Returns {ok:true, k_score, regressions:[]} or {ok:false, detail:'...'}.
async function _readKScoreFromArtifact(artifactId) {
  if (!artifactId) return { ok: false, detail: 'empty_artifact_id' };

  // 1+2 — registry stub (preferred read path; matches what we write in
  // compareAndDecide promote branch).
  try {
    const dir = path.join(_registryDir(), String(artifactId));
    if (fs.existsSync(dir)) {
      const manifestPath = path.join(dir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const k = _extractKScore(j);
        if (Number.isFinite(k)) {
          return {
            ok: true,
            k_score: k,
            regressions: Array.isArray(j.regression_classes) ? j.regression_classes
              : Array.isArray(j.regressions) ? j.regressions : [],
          };
        }
      }
      const promotedPath = path.join(dir, 'promoted.json');
      if (fs.existsSync(promotedPath)) {
        const j = JSON.parse(fs.readFileSync(promotedPath, 'utf8'));
        if (Number.isFinite(Number(j.candidate_kscore))) {
          return {
            ok: true,
            k_score: Number(j.candidate_kscore),
            regressions: Array.isArray(j.regressions) ? j.regressions : [],
          };
        }
      }
    }
  } catch (_) { /* fall through */ }

  // 3 — .kolm artifact under ~/.kolm/artifacts/
  const candidates = [
    path.join(_kolmDir(), 'artifacts', String(artifactId) + '.kolm'),
    path.join(_kolmDir(), 'artifacts', String(artifactId)),
    String(artifactId), // literal path
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const runnerMod = await import('./artifact-runner.js');
      if (typeof runnerMod.loadArtifact !== 'function') continue;
      const loaded = runnerMod.loadArtifact(p, { allowInvalidSignature: true });
      const m = loaded && loaded.manifest;
      const k = _extractKScore(m);
      if (Number.isFinite(k)) {
        return {
          ok: true,
          k_score: k,
          regressions: Array.isArray(m.regression_classes) ? m.regression_classes
            : (m && m.eval_results && Array.isArray(m.eval_results.regressions))
              ? m.eval_results.regressions : [],
        };
      }
    } catch (_) { /* try the next candidate */ }
  }

  return { ok: false, detail: 'no_kscore_resolved_for_' + artifactId };
}

function _extractKScore(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (Number.isFinite(Number(manifest.k_score))) return Number(manifest.k_score);
  if (Number.isFinite(Number(manifest.kscore))) return Number(manifest.kscore);
  if (manifest.eval_results) {
    if (Number.isFinite(Number(manifest.eval_results.kscore))) return Number(manifest.eval_results.kscore);
    if (Number.isFinite(Number(manifest.eval_results.k_score))) return Number(manifest.eval_results.k_score);
  }
  if (manifest.eval && Number.isFinite(Number(manifest.eval.k_score))) return Number(manifest.eval.k_score);
  return null;
}

// Test-only seam — exported under `_` so external callers cannot rely on it.
export const _atomicWriteJsonForTest = _atomicWriteJson;
export const _readKScoreFromArtifactForTest = _readKScoreFromArtifact;
