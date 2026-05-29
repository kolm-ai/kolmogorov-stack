// W921 — Autopilot vertical-slice (headline DoD) test.
//
// Proves ONE closed PROPOSE-ONLY tick of the autonomous-improvement loop end to
// end through src/autopilot-lifecycle.js tickAutopilotFull, plus the two safety
// invariants that keep the loop from silently deploying:
//   - PROPOSE-ONLY DEFAULT: a compile-worthy candidate writes a DEPLOY_PROPOSED
//     ledger row and STOPS. It never writes DEPLOY_EXECUTED when opts.auto is
//     absent.
//   - AUTO + FAILING GUARDRAIL: even with opts.auto:true and every other
//     condition satisfied, an unmet guardrail (here: the 48h grace clock has not
//     started/elapsed) holds — it never executes on the tick it first sees a
//     candidate.
//   - DAY-0 / COLD START: an empty namespace still returns ok:true with an
//     honest plan and no crash.
//
// Determinism: no wall-clock branching, no network. The full data engine is
// fenced into a fresh KOLM_DATA_DIR with the jsonl event-store driver, and the
// event store is reset per case. Every call carries a unique test tenant id
// (W411 tenant fence). Field names + envelope shapes were read from the module's
// exact return statement before any assertion was written — not guessed.
//
// W604 anti-brittleness: the heartbeat/lifecycle versions are asserted via regex
// or exact module constant, never an inline string copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  tickAutopilotFull,
  DEPLOY_WORKFLOW,
  LIFECYCLE_VERSION,
} from '../src/autopilot-lifecycle.js';

// The event-store provider tag the lifecycle persists its deploy ledger under
// (autopilot-daemon AUTOPILOT_PROVIDER). Read the proposed row back through this.
const AUTOPILOT_PROVIDER = 'kolm_autopilot';

// A feature vector whose highest-yield strategy (gap-fill) clears the compile
// simulator's 0.02 ship-gate ΔK threshold, so the deploy guardrail is actually
// exercised (a 'skip' simulator decision would never reach the propose path).
// Verified empirically against quality-predictor.js before writing assertions.
const COMPILE_WORTHY = Object.freeze({
  n_pairs: 50,
  dup_fraction: 0.6,
  coverage_score: 0.3,
  avg_quality: 0.4,
});

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921vslice-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

async function resetStore() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
}

async function readDeployRows(tenant, namespace, workflow) {
  const es = await import('../src/event-store.js');
  return es.listEvents({
    tenant_id: tenant,
    namespace,
    provider: AUTOPILOT_PROVIDER,
    workflow_id: workflow,
    limit: 0,
  });
}

// ===========================================================================
// #1 PROPOSE-ONLY DEFAULT — one closed tick: plan -> simulate compile ->
//    DEPLOY_PROPOSED written, NEVER executed (auto absent).
// ===========================================================================
test('#1 propose-only tick proposes a compile-worthy deploy and never executes', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tenant_vslice_propose';
  const ns = 'slice';

  const out = await tickAutopilotFull({
    tenant,
    namespace: ns,
    opts: {
      // Full loop inputs: a feature vector + budget + target so the cost
      // optimizer ranks a positive-ΔK strategy, plus a candidate that would pass
      // compareAndDecide — but WITHOUT auto:true (propose-only is the default).
      features: COMPILE_WORTHY,
      budget_usd: 5000,
      target_kscore: 0.95,
      base_artifact_id: 'base_vslice',
      candidate_artifact_id: 'cand_vslice',
      base_kscore: 0.60,
      candidate_kscore: 0.90,
      eval_pass: true,
    },
  });

  // Envelope contract: ok:true (heartbeat spread) + lifecycle stamp.
  assert.equal(out.ok, true);
  assert.equal(out.lifecycle_version, LIFECYCLE_VERSION);
  assert.match(out.version, /^w775-/); // W775 heartbeat version (anti-brittle).

  // Lifecycle fields present (exact names from tickAutopilotFull's return).
  assert.ok(out.plan && out.plan.ok === true, 'cost-optimizer plan must succeed');
  assert.equal(out.plan.recommended, 'gap-fill');
  assert.ok(out.simulate_decision && out.simulate_decision.ok === true);
  assert.equal(out.simulate_decision.decision, 'compile');

  // Deploy decision: propose-only mode, a propose decision, NOT executed.
  const d = out.deploy_decision;
  assert.ok(d, 'deploy_decision must be present');
  assert.equal(d.mode, 'propose_only');
  assert.equal(d.decision, 'propose');
  assert.equal(d.executed, false);
  assert.equal(d.deploy_event, DEPLOY_WORKFLOW.PROPOSED);

  // The proposed row was written with the propose-only sentinel; NO executed row.
  const proposed = await readDeployRows(tenant, ns, DEPLOY_WORKFLOW.PROPOSED);
  assert.equal(proposed.length, 1, 'exactly one DEPLOY_PROPOSED row');
  const fb = JSON.parse(proposed[0].feedback || '{}');
  assert.equal(fb.mode, 'propose_only');
  assert.equal(proposed[0].tenant_id, tenant); // W411 tenant fence on the row.

  const executed = await readDeployRows(tenant, ns, DEPLOY_WORKFLOW.EXECUTED);
  assert.equal(executed.length, 0, 'propose-only default must NEVER write DEPLOY_EXECUTED');
});

// ===========================================================================
// #2 AUTO + FAILING GUARDRAIL — auto:true but the grace clock has not elapsed
//    (it is the first tick to see this candidate). All other conditions pass,
//    yet it still does NOT execute: it proposes and starts the clock.
// ===========================================================================
test('#2 auto:true with an unmet guardrail (grace not elapsed) holds — never executes', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tenant_vslice_auto_fail';
  const ns = 'slice';

  const out = await tickAutopilotFull({
    tenant,
    namespace: ns,
    opts: {
      features: COMPILE_WORTHY,
      budget_usd: 5000,
      target_kscore: 0.95,
      auto: true,
      base_artifact_id: 'base_auto',
      candidate_artifact_id: 'cand_auto',
      // Everything EXCEPT grace is satisfied: a clear promote delta, eval pass,
      // and (default) green drift. Grace is the failing condition because no
      // DEPLOY_PROPOSED predates this tick.
      base_kscore: 0.60,
      candidate_kscore: 0.90,
      eval_pass: true,
    },
  });

  assert.equal(out.ok, true);
  const d = out.deploy_decision;
  assert.equal(d.mode, 'auto');
  // The --auto path PROPOSES first (starts the 48h clock); it does not execute
  // on the same tick it first sees a candidate.
  assert.equal(d.executed, false);
  assert.notEqual(d.deploy_event, DEPLOY_WORKFLOW.EXECUTED);
  assert.equal(d.decision, 'propose');
  assert.equal(d.reason, 'grace_started');
  // The grace condition is explicitly NOT satisfied.
  assert.equal(d.conditions.grace, false);

  // Hard invariant: no executed row exists.
  const executed = await readDeployRows(tenant, ns, DEPLOY_WORKFLOW.EXECUTED);
  assert.equal(executed.length, 0, 'unmet guardrail must NEVER write DEPLOY_EXECUTED');
});

// ===========================================================================
// #3 DAY-0 / COLD START — empty namespace, no candidate, no opts. Still returns
//    ok:true with an honest plan and a non-executing deploy decision, no crash.
// ===========================================================================
test('#3 cold start (empty history) returns ok:true with honest confidence and no crash', async () => {
  freshDir();
  await resetStore();
  const tenant = 'tenant_vslice_cold';
  const ns = 'slice';

  const out = await tickAutopilotFull({ tenant, namespace: ns, opts: {} });

  assert.equal(out.ok, true);
  assert.equal(out.lifecycle_version, LIFECYCLE_VERSION);
  // Cold namespace derives an empty feature vector — honest, not fabricated.
  assert.deepEqual(out.features, { n_pairs: 0 });
  assert.ok(out.plan && out.plan.ok === true, 'plan still computes on a cold vector');
  assert.ok(out.simulate_decision && out.simulate_decision.ok === true);
  // No candidate + cold data => nothing to deploy; never executes.
  assert.equal(out.deploy_decision.executed, false);

  // Bad-input contract: a missing tenant returns the honest false envelope.
  const bad = await tickAutopilotFull({ namespace: ns, opts: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'missing_tenant_id');
  assert.equal(bad.version, LIFECYCLE_VERSION);
});
