// scripts/failure-analyst-smoke.mjs
//
// Smoke test for src/failure-analyst.js (KOLM autopilot FAILURE ANALYST).
//
// Verifies: ok envelope; worst_category = the ~80%-failing cluster; at least
// one fix pair targeting the worst cluster; fix pairs actually landed in
// <ROOT>/.kolm/data/<ns>/augment-pairs.jsonl with strategy:'failure-fix'; and
// a missing eval input fails calmly (ok:false, no throw).
//
// CRITICAL: set KOLM_DATA_DIR to a fresh temp dir BEFORE importing any module
// that touches the event store, so persistence + the augment-pairs write land
// in an isolated sandbox and the readback is deterministic.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-fa-'));

const { analyzeFailures, FAILURE_ANALYST_VERSION } = await import('../src/failure-analyst.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const ROOT = process.env.KOLM_DATA_DIR;
const NS = 'fa-smoke';
const TENANT = 'tenant_smoke';

// ---------------------------------------------------------------------------
// Build a synthetic eval-*.json matching data-evaluate.js's shape. We use an
// explicit cluster_id per item so the analyst's clustering is deterministic and
// the assertions are exact:
//   - "refunds"  : 5 items, 4 failing  → 80% fail rate  (THE WORST CATEGORY)
//   - "shipping" : 5 items, 1 failing  → 20% fail rate
//   - "billing"  : 4 items, 0 failing  → 0%  fail rate
// Failing items carry a verdict.score below the 0.5 pass floor; passing items
// carry a high score. Items also carry a reference_answer so the analyst emits
// a reference-backed corrective output.
// ---------------------------------------------------------------------------

function item(cluster_id, idx, score) {
  return {
    id: `${cluster_id}_${idx}`,
    question: `${cluster_id} question number ${idx}: what should the agent do?`,
    reference_answer: `Canonical correct answer for ${cluster_id} #${idx}.`,
    student_answer: `Some student answer for ${cluster_id} #${idx}.`,
    cluster_id,
    verdict: { score },
  };
}

const results = [
  // refunds: 4 fail (0.1) + 1 pass (0.9) = 80% fail
  item('refunds', 1, 0.10),
  item('refunds', 2, 0.15),
  item('refunds', 3, 0.05),
  item('refunds', 4, 0.20),
  item('refunds', 5, 0.90),
  // shipping: 1 fail + 4 pass = 20% fail
  item('shipping', 1, 0.10),
  item('shipping', 2, 0.85),
  item('shipping', 3, 0.92),
  item('shipping', 4, 0.88),
  item('shipping', 5, 0.95),
  // billing: 0 fail
  item('billing', 1, 0.80),
  item('billing', 2, 0.91),
  item('billing', 3, 0.87),
  item('billing', 4, 0.93),
];

const evalObj = {
  bench: 'support-bench',
  mean_score: 0.6,
  n: results.length,
  cot_contaminated: 0,
  results,
};

const runDir = path.join(ROOT, 'runs', 'smoke-run');
const studentDir = path.join(runDir, 'student');
fs.mkdirSync(studentDir, { recursive: true });
const evalFile = path.join(studentDir, 'eval-support-bench.json');
fs.writeFileSync(evalFile, JSON.stringify(evalObj, null, 2), 'utf8');

console.log(`failure-analyst smoke (version=${FAILURE_ANALYST_VERSION}) — ROOT=${ROOT}`);

// ---------------------------------------------------------------------------
// 1. analyzeFailures over the run dir → ok:true
// ---------------------------------------------------------------------------
const res = await analyzeFailures({ tenant: TENANT, namespace: NS, run_dir: runDir });
check('analyzeFailures returns ok:true', res && res.ok === true, JSON.stringify(res && res.error));
check('version is fa-v1', res && res.version === 'fa-v1');
check('clusters array present', res && Array.isArray(res.clusters) && res.clusters.length === 3,
  res && res.clusters ? `got ${res.clusters.length} clusters` : 'no clusters');

// ---------------------------------------------------------------------------
// 2. worst_category is the ~80%-failing "refunds" cluster
// ---------------------------------------------------------------------------
const worst = res && res.worst_category;
// cluster_id is whatever _bucketKey returns; with explicit cluster_id it is the
// raw id "refunds". Assert via the cluster summary too.
const refundsCluster = (res && res.clusters || []).find((c) => c.n_failed === 4);
check('worst_category is non-null', !!worst, JSON.stringify(worst));
check('worst_category n_failed === 4', worst && worst.n_failed === 4, JSON.stringify(worst));
check('worst_category fail_rate === 0.8', worst && Math.abs(worst.fail_rate - 0.8) < 1e-6, JSON.stringify(worst));
check('worst_category cluster_id matches the 4-fail cluster',
  worst && refundsCluster && worst.cluster_id === refundsCluster.cluster_id,
  worst ? `worst=${worst.cluster_id} refunds=${refundsCluster && refundsCluster.cluster_id}` : 'no worst');
check('worst cluster_id resolves to refunds', worst && String(worst.cluster_id).includes('refunds'),
  worst && worst.cluster_id);

// ---------------------------------------------------------------------------
// 3. at least one fix pair, and it targets the worst category
// ---------------------------------------------------------------------------
const fixPairs = (res && res.fix_pairs) || [];
check('>=1 fix pair generated', fixPairs.length >= 1, `got ${fixPairs.length}`);
// All emitted pairs should be for the worst cluster (refunds). Their input is a
// refunds question, and the rationale names the worst cluster_id.
const allTargetWorst = fixPairs.length > 0 && fixPairs.every((fp) =>
  /refunds question/.test(String(fp.input)) &&
  String(fp.rationale).includes(String(worst.cluster_id)));
check('every fix pair targets the worst category', allTargetWorst,
  fixPairs[0] ? JSON.stringify({ input: fixPairs[0].input, rationale: fixPairs[0].rationale }) : 'none');
check('fix pair count equals worst n_failed (4)', fixPairs.length === 4, `got ${fixPairs.length}`);
check('fix pair output uses the canonical reference',
  fixPairs.length > 0 && /Canonical correct answer for refunds/.test(String(fixPairs[0].output)),
  fixPairs[0] && fixPairs[0].output);
check('n_fix_pairs_written === 4', res && res.n_fix_pairs_written === 4, JSON.stringify(res && res.n_fix_pairs_written));

// ---------------------------------------------------------------------------
// 4. fix pairs actually appended to augment-pairs.jsonl with failure-fix prov.
// ---------------------------------------------------------------------------
const augmentPath = path.join(ROOT, '.kolm', 'data', NS, 'augment-pairs.jsonl');
let lines = [];
try {
  lines = fs.readFileSync(augmentPath, 'utf8').split('\n').filter((l) => l.trim());
} catch (e) {
  // leave lines empty; checks below will fail with a useful message
}
check('augment-pairs.jsonl exists + has 4 rows', lines.length === 4,
  `path=${augmentPath} lines=${lines.length}`);
let parsed = [];
try { parsed = lines.map((l) => JSON.parse(l)); } catch (_) { /* assertion below */ }
const allFailureFix = parsed.length === 4 && parsed.every((r) =>
  r && r.provenance && r.provenance.strategy === 'failure-fix');
check('all appended rows have strategy:failure-fix', allFailureFix,
  parsed[0] ? JSON.stringify(parsed[0].provenance) : 'no rows parsed');
const allHaveRefundsInput = parsed.length === 4 && parsed.every((r) => /refunds question/.test(String(r.input)));
check('all appended rows carry a refunds input', allHaveRefundsInput);
const allHaveRationale = parsed.length === 4 && parsed.every((r) =>
  r && r.provenance && typeof r.provenance.rationale === 'string' && r.provenance.rationale.length > 0);
check('all appended rows carry a rationale in provenance', allHaveRationale);

// ---------------------------------------------------------------------------
// 5. missing eval input → ok:false with an error code, no throw
// ---------------------------------------------------------------------------
let missingThrew = false;
let missing;
try {
  missing = await analyzeFailures({ tenant: TENANT, namespace: NS });
} catch (e) {
  missingThrew = true;
}
check('missing eval input did not throw', !missingThrew);
check('missing eval input → ok:false', missing && missing.ok === false, JSON.stringify(missing));
check('missing eval input → snake_case error code',
  missing && typeof missing.error === 'string' && /^[a-z0-9_]+$/.test(missing.error),
  missing && missing.error);

// Bonus: a non-existent eval_path also fails calmly (no throw).
let badPathThrew = false;
let badPath;
try {
  badPath = await analyzeFailures({ tenant: TENANT, namespace: NS, eval_path: path.join(ROOT, 'does-not-exist.json') });
} catch (e) {
  badPathThrew = true;
}
check('non-existent eval_path did not throw', !badPathThrew);
check('non-existent eval_path → ok:false', badPath && badPath.ok === false, JSON.stringify(badPath));

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
