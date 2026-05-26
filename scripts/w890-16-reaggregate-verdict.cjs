#!/usr/bin/env node
/**
 * W890-16 final verdict re-aggregator.
 *
 * Reads each `data/w890-16-step-N-*.json` step file and re-builds
 * `data/w890-16-final-verdict.json` from current step truth. Used after a
 * re-run of any individual step (currently steps 1 + 6 via
 * `scripts/w890-16-rerun-1-and-6.cjs`).
 *
 * Mirrors the aggregator logic in scripts/w890-16-final-verification.cjs:
 *   - all_passed = all 9 steps green
 *   - only_expected_fails = blockers ⊆ {5, 8, 9} (the pre-commit expected set)
 *   - step5_pending_redeploy / step89_pending_commit flags
 *   - recommendation routed across 5 branches
 *
 * Run: node scripts/w890-16-reaggregate-verdict.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
}
function writeJSON(rel, obj) {
  const fp = path.join(DATA, rel);
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
  process.stdout.write(`  -> wrote ${path.relative(ROOT, fp)}\n`);
}

function main() {
  const s1 = readJSON('w890-16-step-1-test-all.json');
  const s2 = readJSON('w890-16-step-2-ship-gate.json');
  const s3 = readJSON('w890-16-step-3-npm-audit.json');
  const s4 = readJSON('w890-16-step-4-secrets.json');
  const s5 = readJSON('w890-16-step-5-prod-health.json');
  const s6 = readJSON('w890-16-step-6-cold-start.json');
  const s7 = readJSON('w890-16-step-7-doctor.json');
  const s8 = readJSON('w890-16-step-8-git-status.json');
  const s9 = readJSON('w890-16-step-9-git-log.json');

  const results = {
    '1': s1.passed_check === true,
    '2': s2.green_52_52 === true,
    '3': s3.passed_check === true,
    '4': s4.passed_check === true,
    '5': s5.passed_check === true,
    '6': s6.passed_check === true,
    '7': s7.passed_check === true,
    '8': s8.passed_check === true,
    '9': s9.passed_check === true,
  };
  const blocker_step_ids = Object.entries(results)
    .filter(([_, v]) => !v)
    .map(([k]) => Number(k));
  const all_passed = blocker_step_ids.length === 0;
  const EXPECTED_FAIL_SET = new Set([5, 8, 9]);
  const only_expected_fails = blocker_step_ids.length > 0
    && blocker_step_ids.every(id => EXPECTED_FAIL_SET.has(id));
  const step5_pending_redeploy = blocker_step_ids.includes(5);
  const step89_pending_commit = blocker_step_ids.includes(8) || blocker_step_ids.includes(9);

  let recommendation;
  if (all_passed) {
    recommendation = 'V1 SHIP. All 9 ship-gate checks pass. Recommend user authorize the W890-1..15 batched commit + redeploy.';
  } else if (only_expected_fails && step5_pending_redeploy && step89_pending_commit) {
    recommendation = 'CONDITIONAL SHIP after commit batch + redeploy. Steps 1-4 + 6-7 all pass; steps 5 + 8 + 9 are red and ALL three are expected-fail pre-commit — step 5 (prod /health lacks ok:true because the W890-13 upgrade is undeployed) + step 8 (working tree carries the W890-1..15 uncommitted changes) + step 9 (last commit is pre-W890 batch). Authorize the W890-1..15 batched commit; Vercel auto-deploys; then re-run W890-16 to confirm green-on-green.';
  } else if (only_expected_fails && step89_pending_commit && !step5_pending_redeploy) {
    recommendation = 'CONDITIONAL SHIP after commit batch. Steps 1-7 all pass; only 8 (git status clean) and/or 9 (last commit describes final state) are red — both expected-fail until the user authorizes the W890-1..15 batched commit. After commit, re-run W890-16 to confirm.';
  } else if (only_expected_fails && step5_pending_redeploy && !step89_pending_commit) {
    recommendation = 'CONDITIONAL SHIP after redeploy. Steps 1-4 + 6-9 all pass; step 5 (prod smoke) is red because https://kolm.ai/health does not yet return ok:true — the W890-13 health-shape upgrade is uncommitted/undeployed. Authorize commit + redeploy then re-run.';
  } else {
    recommendation = `BLOCK. ${blocker_step_ids.length} red step(s): ${blocker_step_ids.join(', ')}. Fix-forward into the relevant W890-X then re-run W890-16.`;
  }

  const verdict = {
    generated_at: new Date().toISOString(),
    rebuilt_after_rerun: true,
    rerun_steps: ['1', '6'],
    duration_s: null,
    steps: results,
    step_summaries: {
      '1': { name: 'test-all', total: s1.total, pass: s1.pass, fail: s1.fail, duration_s: s1.duration_s, passed_check: s1.passed_check, scope: s1.scope || 'full' },
      '2': { name: 'ship-gate', total: s2.total, passed: s2.passed, failed: s2.failed, green_52_52: s2.green_52_52, duration_s: s2.duration_s },
      '3': { name: 'npm-audit', critical: s3.critical, high: s3.high, moderate: s3.moderate, low: s3.low, passed_check: s3.passed_check },
      '4': { name: 'secrets', secret_pattern_hits: s4.secret_pattern_hits, files_scanned: s4.files_scanned, passed_check: s4.passed_check },
      '5': { name: 'prod-health', health_ok: s5.health_ok, gateway_health_ok: s5.gateway_health_ok, passed_check: s5.passed_check },
      '6': { name: 'cold-start', sample_n: s6.sample_n, mean_ms: s6.mean_ms, p95_ms: s6.p95_ms, under_1s: s6.under_1s },
      '7': { name: 'doctor', ok: s7.ok, blockers: s7.blockers, warnings: s7.warnings, passed_check: s7.passed_check },
      '8': { name: 'git-status', clean: s8.clean, total_changes: s8.total_changes, expected_to_fail_until_commit_authorized: s8.expected_to_fail_until_commit_authorized },
      '9': { name: 'git-log', describes_final_state: s9.describes_final_state, last_commit_subject: s9.last_commit_subject, expected_to_fail_until_commit_authorized: s9.expected_to_fail_until_commit_authorized },
    },
    all_passed,
    blocker_step_ids,
    only_expected_fails,
    step5_pending_redeploy,
    recommendation,
  };
  writeJSON('w890-16-final-verdict.json', verdict);
  process.stdout.write(`\nblocker_step_ids=[${blocker_step_ids.join(', ')}]\n`);
  process.stdout.write(`all_passed=${all_passed}\n`);
  process.stdout.write(`only_expected_fails=${only_expected_fails}\n`);
  process.stdout.write(`recommendation: ${recommendation}\n`);
}
main();
