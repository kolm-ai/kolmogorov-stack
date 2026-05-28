// scripts/autopilot-lifecycle-smoke.mjs
//
// DI-stubbed end-to-end smoke for Full Autopilot Mode (the capstone).
//
// Verifies the plan's Definition-of-Done for Component 8:
//   "DI-stubbed end-to-end ⇒ description bootstraps recipe, tick yields plan +
//    simulate decision, propose-only writes DEPLOY_PROPOSED (never EXECUTED)."
// plus the --auto guardrail: an elapsed-grace tick with all 5 conditions met
// reaches DEPLOY_EXECUTED, and an objection inside grace holds it.
//
// Pure-JS: no GPU, no network, no teacher spend. State is isolated in a fresh
// temp KOLM_DATA_DIR set BEFORE any module import so the event store + registry
// writes never touch the real ~/.kolm.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- isolate state BEFORE importing anything that touches the event store ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-aplife-'));
process.env.KOLM_DATA_DIR = TMP;
process.env.KOLM_HOME = TMP;

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const TENANT = 'tenant_smoke_aplife';

const boot = await import('../src/autopilot-bootstrap.js');
const life = await import('../src/autopilot-lifecycle.js');
const daemon = await import('../src/autopilot-daemon.js');

const { bootstrapFromDescription } = boot;
const { tickAutopilotFull, objectToDeploy, DEPLOY_WORKFLOW, __internals } = life;
const { _evaluateDeploy } = __internals;
const dwrite = daemon.__internals._writeAutopilotEvent;
const dread = daemon.__internals._readLatestAutopilotEvent;

const HOURS = 3600 * 1000;

// ---------------------------------------------------------------------------
// [1] bootstrap a namespace from a plain-English description
// ---------------------------------------------------------------------------
console.log('\n[1] bootstrapFromDescription');
const NS1 = 'support_acme';
const b = await bootstrapFromDescription({
  tenant: TENANT,
  namespace: NS1,
  description: 'customer support for Acme Corp billing, returns, and shipping questions',
  budget_usd: '$50/month',
  n: 40,
});
ok('bootstrap ok', b.ok === true, JSON.stringify(b).slice(0, 200));
ok('recipe_path written to disk', !!(b.recipe_path && fs.existsSync(b.recipe_path)), String(b.recipe_path));
ok('recipe re-validates (hash present)', !!b.recipe_hash);
ok('seeded raw-pairs', Number(b.n_seeded) > 0, 'n_seeded=' + b.n_seeded);
ok('budget parsed to 50', b.budget_usd === 50, 'budget=' + b.budget_usd);
ok('recipe name namespaced', b.recipe_name === 'autopilot-' + NS1, b.recipe_name);

// ---------------------------------------------------------------------------
// [2] a full tick is PROPOSE-ONLY by default — yields plan + simulate, never
//     executes a deploy, never writes a DEPLOY_EXECUTED row.
// ---------------------------------------------------------------------------
console.log('\n[2] tickAutopilotFull propose-only default');
const full = await tickAutopilotFull({
  tenant: TENANT,
  namespace: NS1,
  opts: { budget_usd: '$50/month' },
});
ok('tick returns lifecycle_version', full.lifecycle_version === 'apl-v1');
ok('tick yields a plan', !!(full.plan && full.plan.ok === true), JSON.stringify(full.plan).slice(0, 160));
ok('tick yields a simulate decision', !!(full.simulate_decision && typeof full.simulate_decision.decision === 'string'), JSON.stringify(full.simulate_decision).slice(0, 160));
ok('tick yields features', !!(full.features && Number.isFinite(Number(full.features.n_pairs))), JSON.stringify(full.features).slice(0, 120));
ok('deploy never executes by default', !!(full.deploy_decision && full.deploy_decision.executed === false), JSON.stringify(full.deploy_decision).slice(0, 160));
ok('no EXECUTED row from default tick', (await dread({ tenant: TENANT, namespace: NS1, workflow: DEPLOY_WORKFLOW.EXECUTED })) === null);

// ---------------------------------------------------------------------------
// [3] propose-only path writes DEPLOY_PROPOSED for a compile-worthy candidate,
//     and NEVER an EXECUTED row.
// ---------------------------------------------------------------------------
console.log('\n[3] _evaluateDeploy propose-only writes DEPLOY_PROPOSED');
const NS3 = 'propose_only_ns';
const dec3 = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS3,
  opts: {}, // no auto
  simulate: { ok: true, decision: 'compile', delta_k: 0.05 },
});
ok('decision is propose', dec3.decision === 'propose', JSON.stringify(dec3).slice(0, 160));
ok('event is PROPOSED', dec3.deploy_event === DEPLOY_WORKFLOW.PROPOSED);
ok('not executed', dec3.executed === false);
ok('PROPOSED row persisted', !!(await dread({ tenant: TENANT, namespace: NS3, workflow: DEPLOY_WORKFLOW.PROPOSED })));
ok('still no EXECUTED row', (await dread({ tenant: TENANT, namespace: NS3, workflow: DEPLOY_WORKFLOW.EXECUTED })) === null);

// A skip-worthy candidate under propose-only writes nothing and never executes.
const dec3b = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS3,
  opts: {},
  simulate: { ok: true, decision: 'skip', delta_k: 0.001 },
});
ok('skip-worthy propose-only is skip', dec3b.decision === 'skip' && dec3b.executed === false);

// ---------------------------------------------------------------------------
// [4] --auto FIRST sight proposes (starts the 48h grace clock) — it must NOT
//     execute on the same tick it first sees a candidate.
// ---------------------------------------------------------------------------
console.log('\n[4] --auto first-sight proposes, no same-tick execute');
const NS4 = 'auto_grace_ns';
const dec4 = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS4,
  opts: {
    auto: true, eval_pass: true,
    base_artifact_id: 'base_x', candidate_artifact_id: 'cand_x',
    base_kscore: 0.70, candidate_kscore: 0.82,
  },
  simulate: { ok: true, decision: 'compile', delta_k: 0.12 },
});
ok('auto first-sight proposes', dec4.decision === 'propose', JSON.stringify(dec4).slice(0, 220));
ok('auto first-sight not executed', dec4.executed === false);
ok('reason grace_started', dec4.reason === 'grace_started');
ok('no EXECUTED row on first sight', (await dread({ tenant: TENANT, namespace: NS4, workflow: DEPLOY_WORKFLOW.EXECUTED })) === null);

// ---------------------------------------------------------------------------
// [5] --auto with an ELAPSED grace + all 5 conditions met EXECUTES via the
//     tested compareAndDecide promote path (writes DEPLOY_EXECUTED).
// ---------------------------------------------------------------------------
console.log('\n[5] --auto elapsed grace executes (DEPLOY_EXECUTED)');
const NS5 = 'auto_exec_ns';
const longAgo = new Date(Date.now() - 49 * HOURS).toISOString();
await dwrite({
  tenant: TENANT, namespace: NS5, workflow: DEPLOY_WORKFLOW.PROPOSED,
  feedback: { proposed_at: longAgo, mode: 'auto', simulate_decision: 'compile', delta_k: 0.12 },
});
const dec5 = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS5,
  opts: {
    auto: true, eval_pass: true,
    base_artifact_id: 'base_y', candidate_artifact_id: 'cand_y',
    base_kscore: 0.70, candidate_kscore: 0.82,
  },
  simulate: { ok: true, decision: 'compile', delta_k: 0.12 },
});
ok('auto elapsed grace executes', dec5.decision === 'execute', JSON.stringify(dec5).slice(0, 280));
ok('executed true', dec5.executed === true);
ok('event is EXECUTED', dec5.deploy_event === DEPLOY_WORKFLOW.EXECUTED);
ok('all 5 conditions held', !!(dec5.conditions && dec5.conditions.promote && dec5.conditions.regressions_ok && dec5.conditions.eval_pass && dec5.conditions.drift_green && dec5.conditions.grace), JSON.stringify(dec5.conditions));
ok('promote envelope is promote', !!(dec5.promote && dec5.promote.decision === 'promote'), JSON.stringify(dec5.promote).slice(0, 200));
ok('EXECUTED row persisted', !!(await dread({ tenant: TENANT, namespace: NS5, workflow: DEPLOY_WORKFLOW.EXECUTED })));

// Without eval_pass, the SAME elapsed-grace state HOLDS (fail-closed on eval).
const NS5b = 'auto_noeval_ns';
await dwrite({
  tenant: TENANT, namespace: NS5b, workflow: DEPLOY_WORKFLOW.PROPOSED,
  feedback: { proposed_at: longAgo, mode: 'auto' },
});
const dec5b = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS5b,
  opts: {
    auto: true, eval_pass: false,
    base_artifact_id: 'base_q', candidate_artifact_id: 'cand_q',
    base_kscore: 0.70, candidate_kscore: 0.82,
  },
  simulate: { ok: true, decision: 'compile', delta_k: 0.12 },
});
ok('no eval_pass holds (fail-closed)', dec5b.decision === 'hold' && dec5b.executed === false, JSON.stringify(dec5b.failed_conditions));
ok('eval listed as failed condition', Array.isArray(dec5b.failed_conditions) && dec5b.failed_conditions.includes('eval'));

// ---------------------------------------------------------------------------
// [6] a DEPLOY_OBJECTED after the proposal HOLDS the auto deploy even with an
//     elapsed grace and all other conditions green.
// ---------------------------------------------------------------------------
console.log('\n[6] objection inside grace holds the auto deploy');
const NS6 = 'auto_object_ns';
await dwrite({
  tenant: TENANT, namespace: NS6, workflow: DEPLOY_WORKFLOW.PROPOSED,
  feedback: { proposed_at: new Date(Date.now() - 49 * HOURS).toISOString(), mode: 'auto' },
});
const obj = await objectToDeploy({ tenant: TENANT, namespace: NS6, reason: 'manual veto in smoke' });
ok('objectToDeploy ok', obj.ok === true);
const dec6 = await _evaluateDeploy({
  tenant: TENANT,
  namespace: NS6,
  opts: {
    auto: true, eval_pass: true,
    base_artifact_id: 'base_z', candidate_artifact_id: 'cand_z',
    base_kscore: 0.70, candidate_kscore: 0.82,
  },
  simulate: { ok: true, decision: 'compile', delta_k: 0.12 },
});
ok('objection holds (not execute)', dec6.decision === 'hold', JSON.stringify(dec6).slice(0, 260));
ok('objection not executed', dec6.executed === false);
ok('grace.objected true', !!(dec6.grace && dec6.grace.objected === true));
ok('no EXECUTED row after objection', (await dread({ tenant: TENANT, namespace: NS6, workflow: DEPLOY_WORKFLOW.EXECUTED })) === null);

// ---------------------------------------------------------------------------
// [7] guards
// ---------------------------------------------------------------------------
console.log('\n[7] guards');
const g1 = await tickAutopilotFull({ namespace: 'x' });
ok('tick missing tenant guarded', g1.ok === false && g1.error === 'missing_tenant_id');
const g2 = await objectToDeploy({ namespace: 'x' });
ok('object missing tenant guarded', g2.ok === false && g2.error === 'missing_tenant_id');

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
process.exit(failed === 0 ? 0 : 1);
