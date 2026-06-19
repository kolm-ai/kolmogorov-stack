// W1004: compile-API competitor readiness.
//
// Locks the OpenPipe-ART-parity local continuous optimization contract while
// keeping default Kolm-owned hosted train+serve capacity behind external
// operated-fleet evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assessCompileApiCompetitorReadiness,
  assessContinuousOptimizationReadiness,
  assessHostedTrainServeCapacity,
  COMPILE_API_READINESS_VERSION,
} from '../src/compile-api-readiness.js';
import { tickAutopilotFull } from '../src/autopilot-lifecycle.js';

const GOOD_SHA = 'a'.repeat(64);
const FEATURES = Object.freeze({
  n_pairs: 240,
  dup_fraction: 0.12,
  coverage_score: 0.52,
  avg_quality: 0.68,
});

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1004-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  return tmp;
}

async function resetStore() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
}

test('W1004 continuous optimization contract is locally ready and names every load-bearing seam', () => {
  const r = assessContinuousOptimizationReadiness();
  assert.equal(r.ok, true);
  assert.equal(r.local_ready, true);
  assert.equal(r.version, COMPILE_API_READINESS_VERSION);
  assert.equal(r.status, 'local_continuous_optimization_ready');
  assert.deepEqual(r.blockers, []);
  for (const id of [
    'autopilot_lifecycle_tick',
    'autopilot_daemon_opt_in',
    'active_learning_gap_signal',
    'improvement_orchestrator',
    'w808_regression_promotion_gate',
    'strategy_bandit_observe_loop',
    'propose_only_default_deploy_guard',
    'grpo_rlvr_trainer_seam',
    'online_preference_trainer_seam',
  ]) {
    assert.ok(r.requirements.some((x) => x.id === id && x.ready === true), id);
  }
  assert.equal(r.default_autonomous_deploy_claimable, false);
});

test('W1004 readiness contract fails locally if a continuous optimization seam disappears', () => {
  const r = assessContinuousOptimizationReadiness({
    component_overrides: {
      strategy_bandit_observe_loop: false,
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'local_continuous_optimization_incomplete');
  assert.ok(r.blockers.includes('strategy_bandit_observe_loop'));
});

test('W1004 hosted train+serve remains external-gated by default', () => {
  const r = assessHostedTrainServeCapacity({});
  assert.equal(r.ok, true);
  assert.equal(r.local_contract_ready, true);
  assert.equal(r.default_hosted_train_serve_claimable, false);
  assert.equal(r.status, 'external_hosted_capacity_unclaimable');
  assert.ok(r.blockers.includes('kolm_owned_train_pool_endpoint'));
  assert.ok(r.blockers.includes('kolm_owned_serve_endpoint'));
  assert.ok(r.blockers.includes('operated_fleet_evidence_hash'));
});

test('W1004 hosted train+serve claim requires operated fleet, serving, artifact, price, and status evidence', () => {
  const r = assessHostedTrainServeCapacity({
    cloud_distill_endpoint: 'https://train.kolm.example',
    hosted_serve_endpoint: 'https://serve.kolm.example',
    artifact_bucket: 'r2://kolm-hosted-artifacts',
    price_receipt_hash: GOOD_SHA,
    operated_fleet_evidence_hash: GOOD_SHA,
    public_status_url: 'https://status.kolm.example',
  });
  assert.equal(r.default_hosted_train_serve_claimable, true);
  assert.equal(r.status, 'claimable_default_hosted_train_serve');
  assert.deepEqual(r.blockers, []);
});

test('W1004 compile API summary closes local major work but keeps external hosted-capacity gate open', () => {
  const r = assessCompileApiCompetitorReadiness({});
  assert.equal(r.ok, true);
  assert.equal(r.major_frontier_work_closed_locally, true);
  assert.equal(r.external_gate_open, true);
  assert.equal(r.status, 'local_frontier_ready_external_hosted_capacity_gate_open');
  assert.equal(r.continuous_optimization.local_ready, true);
  assert.equal(r.hosted_capacity.default_hosted_train_serve_claimable, false);
});

test('W1004 autopilot lifecycle executes a continuous optimization tick with bandit observe and propose-only guard', async () => {
  freshDir();
  await resetStore();
  const out = await tickAutopilotFull({
    tenant: 'tenant_w1004',
    namespace: 'compile_api',
    opts: {
      features: FEATURES,
      budget_usd: 100,
      target_kscore: 0.9,
      use_bandit: true,
      base_artifact_id: 'art_base_w1004',
      candidate_artifact_id: 'art_candidate_w1004',
      base_kscore: 0.62,
      candidate_kscore: 0.91,
      eval_pass: true,
    },
  });

  assert.equal(out.ok, true);
  assert.match(out.version, /^w775-/);
  assert.ok(out.plan && out.plan.ok === true);
  assert.ok(out.bandit && out.bandit.applicable === true);
  assert.ok(out.bandit_observe && out.bandit_observe.recorded === true);
  assert.equal(out.deploy_decision.mode, 'propose_only');
  assert.equal(out.deploy_decision.executed, false);
});
