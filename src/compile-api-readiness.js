// W1004: compile-API / capture-to-distill competitor readiness contract.
//
// This module separates two facts that the product/spec must not conflate:
//   1. The local continuous optimization loop is real: capture/active-learning
//      signals feed W775 autopilot, W720 improvement orchestration, W921
//      strategy selection, W808 promotion gates, and GRPO/online-DPO trainer
//      seams.
//   2. Default Kolm-owned hosted train+serve capacity is an external operating
//      claim. It is not claimable until an operated fleet, serving endpoint,
//      artifact hosting, price receipts, and public status/evidence exist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIFECYCLE_VERSION,
  DEPLOY_WORKFLOW,
  __internals as autopilotLifecycleInternals,
} from './autopilot-lifecycle.js';
import { AUTOPILOT_VERSION } from './autopilot-daemon.js';
import { ACTIVE_LEARNING_VERSION } from './active-learning.js';
import { IMPROVEMENT_VERSION } from './improvement-orchestrator.js';
import { STRATEGY_BANDIT_VERSION } from './bandit-thompson.js';
import { W808_REGRESSION_GATE_VERSION } from './distill-pipeline.js';
import { REWARD_FAMILIES, LOSS_TYPES } from './distill-grpo.js';

export const COMPILE_API_READINESS_VERSION = 'w1004-compile-api-readiness-v1';
export const HOSTED_CAPACITY_GATE_VERSION = 'w1004-hosted-capacity-gate-v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const REQUIRED_TRAINER_FILES = Object.freeze({
  grpo_app: 'apps/trainer/grpo.py',
  online_dpo_app: 'apps/trainer/online_dpo.py',
  grpo_worker: 'workers/distill/scripts/train_grpo.py',
  preference_worker: 'workers/distill/scripts/train_preference.py',
});

function _exists(rel) {
  try { return fs.existsSync(path.join(REPO_ROOT, rel)); }
  catch { return false; }
}

function _clean(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function _boolOverride(overrides, id, fallback) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] === true;
  }
  return !!fallback;
}

function _sha256ish(v) {
  return /^[a-f0-9]{64}$/i.test(_clean(v));
}

function _req(id, ready, evidence, kind = 'local') {
  return Object.freeze({
    id,
    kind,
    ready: !!ready,
    evidence,
  });
}

export function assessContinuousOptimizationReadiness(opts = {}) {
  const overrides = opts.component_overrides || {};
  const trainerFiles = Object.fromEntries(
    Object.entries(REQUIRED_TRAINER_FILES).map(([id, rel]) => [id, _exists(rel)])
  );
  const requirements = [
    _req(
      'autopilot_lifecycle_tick',
      _boolOverride(overrides, 'autopilot_lifecycle_tick', /^apl-/.test(LIFECYCLE_VERSION)),
      { version: LIFECYCLE_VERSION, module: 'src/autopilot-lifecycle.js' }
    ),
    _req(
      'autopilot_daemon_opt_in',
      _boolOverride(overrides, 'autopilot_daemon_opt_in', /^w775-/.test(AUTOPILOT_VERSION)),
      { version: AUTOPILOT_VERSION, module: 'src/autopilot-daemon.js' }
    ),
    _req(
      'active_learning_gap_signal',
      _boolOverride(overrides, 'active_learning_gap_signal', /^w815-/.test(ACTIVE_LEARNING_VERSION)),
      { version: ACTIVE_LEARNING_VERSION, module: 'src/active-learning.js' }
    ),
    _req(
      'improvement_orchestrator',
      _boolOverride(overrides, 'improvement_orchestrator', /^w720-/.test(IMPROVEMENT_VERSION)),
      { version: IMPROVEMENT_VERSION, module: 'src/improvement-orchestrator.js' }
    ),
    _req(
      'w808_regression_promotion_gate',
      _boolOverride(overrides, 'w808_regression_promotion_gate', /^w808-/.test(W808_REGRESSION_GATE_VERSION)),
      { version: W808_REGRESSION_GATE_VERSION, module: 'src/distill-pipeline.js' }
    ),
    _req(
      'strategy_bandit_observe_loop',
      _boolOverride(
        overrides,
        'strategy_bandit_observe_loop',
        /^sb-/.test(STRATEGY_BANDIT_VERSION)
          && typeof autopilotLifecycleInternals._banditAdvisory === 'function'
          && typeof autopilotLifecycleInternals._banditObserve === 'function'
      ),
      { version: STRATEGY_BANDIT_VERSION, module: 'src/bandit-thompson.js' }
    ),
    _req(
      'propose_only_default_deploy_guard',
      _boolOverride(
        overrides,
        'propose_only_default_deploy_guard',
        DEPLOY_WORKFLOW.PROPOSED === 'autopilot:deploy_proposed'
          && DEPLOY_WORKFLOW.EXECUTED === 'autopilot:deploy_executed'
      ),
      { workflows: DEPLOY_WORKFLOW, module: 'src/autopilot-lifecycle.js' }
    ),
    _req(
      'grpo_rlvr_trainer_seam',
      _boolOverride(
        overrides,
        'grpo_rlvr_trainer_seam',
        trainerFiles.grpo_app
          && trainerFiles.grpo_worker
          && REWARD_FAMILIES.includes('kolm_verifier')
          && LOSS_TYPES.includes('dr_grpo')
      ),
      { files: ['apps/trainer/grpo.py', 'workers/distill/scripts/train_grpo.py'], rewards: REWARD_FAMILIES, losses: LOSS_TYPES }
    ),
    _req(
      'online_preference_trainer_seam',
      _boolOverride(
        overrides,
        'online_preference_trainer_seam',
        trainerFiles.online_dpo_app && trainerFiles.preference_worker
      ),
      { files: ['apps/trainer/online_dpo.py', 'workers/distill/scripts/train_preference.py'] }
    ),
  ];

  const blockers = requirements.filter((r) => !r.ready).map((r) => r.id);
  const localReady = blockers.length === 0;
  return {
    ok: localReady,
    version: COMPILE_API_READINESS_VERSION,
    status: localReady
      ? 'local_continuous_optimization_ready'
      : 'local_continuous_optimization_incomplete',
    local_ready: localReady,
    default_autonomous_deploy_claimable: false,
    default_autonomous_deploy_reason: 'autopilot is propose-only unless explicit auto gates pass',
    requirements,
    blockers,
  };
}

export function assessHostedTrainServeCapacity(opts = {}) {
  const trainEndpoint = _clean(opts.cloud_distill_endpoint || process.env.KOLM_CLOUD_DISTILL_ENDPOINT);
  const serveEndpoint = _clean(opts.hosted_serve_endpoint || process.env.KOLM_HOSTED_SERVE_ENDPOINT);
  const artifactBucket = _clean(opts.artifact_bucket || opts.artifact_download_base || process.env.KOLM_HOSTED_ARTIFACT_BUCKET);
  const priceReceiptHash = _clean(opts.price_receipt_hash || process.env.KOLM_HOSTED_PRICE_RECEIPT_SHA256);
  const fleetEvidenceHash = _clean(opts.operated_fleet_evidence_hash || opts.fleet_evidence_hash || process.env.KOLM_HOSTED_FLEET_EVIDENCE_SHA256);
  const publicStatusUrl = _clean(opts.public_status_url || process.env.KOLM_HOSTED_STATUS_URL);

  const requirements = [
    _req('kolm_owned_train_pool_endpoint', !!trainEndpoint, { env: 'KOLM_CLOUD_DISTILL_ENDPOINT', value_present: !!trainEndpoint }, 'external'),
    _req('kolm_owned_serve_endpoint', !!serveEndpoint, { env: 'KOLM_HOSTED_SERVE_ENDPOINT', value_present: !!serveEndpoint }, 'external'),
    _req('artifact_download_hosting', !!artifactBucket, { env: 'KOLM_HOSTED_ARTIFACT_BUCKET', value_present: !!artifactBucket }, 'external'),
    _req('provider_price_receipt_hash', _sha256ish(priceReceiptHash), { env: 'KOLM_HOSTED_PRICE_RECEIPT_SHA256', sha256_present: _sha256ish(priceReceiptHash) }, 'external'),
    _req('operated_fleet_evidence_hash', _sha256ish(fleetEvidenceHash), { env: 'KOLM_HOSTED_FLEET_EVIDENCE_SHA256', sha256_present: _sha256ish(fleetEvidenceHash) }, 'external'),
    _req('public_status_and_claim_page', !!publicStatusUrl, { env: 'KOLM_HOSTED_STATUS_URL', value_present: !!publicStatusUrl }, 'external'),
  ];
  const blockers = requirements.filter((r) => !r.ready).map((r) => r.id);
  const claimable = blockers.length === 0;
  return {
    ok: true,
    version: HOSTED_CAPACITY_GATE_VERSION,
    local_contract_ready: true,
    default_hosted_train_serve_claimable: claimable,
    status: claimable
      ? 'claimable_default_hosted_train_serve'
      : 'external_hosted_capacity_unclaimable',
    requirements,
    blockers,
    note: claimable
      ? 'all operated hosted-capacity evidence is present'
      : 'local dispatch contracts exist, but default Kolm-owned hosted capacity remains unclaimable without operated train/serve evidence',
  };
}

export function assessCompileApiCompetitorReadiness(opts = {}) {
  const continuous = assessContinuousOptimizationReadiness(opts.continuous || opts);
  const hosted = assessHostedTrainServeCapacity(opts.hosted_capacity || opts);
  const localReady = continuous.local_ready && hosted.local_contract_ready;
  return {
    ok: localReady,
    version: COMPILE_API_READINESS_VERSION,
    status: localReady && hosted.default_hosted_train_serve_claimable
      ? 'frontier_product_claimable'
      : localReady
        ? 'local_frontier_ready_external_hosted_capacity_gate_open'
        : 'local_frontier_incomplete',
    major_frontier_work_closed_locally: continuous.local_ready,
    external_gate_open: !hosted.default_hosted_train_serve_claimable,
    continuous_optimization: continuous,
    hosted_capacity: hosted,
  };
}

export default {
  COMPILE_API_READINESS_VERSION,
  HOSTED_CAPACITY_GATE_VERSION,
  assessContinuousOptimizationReadiness,
  assessHostedTrainServeCapacity,
  assessCompileApiCompetitorReadiness,
};
