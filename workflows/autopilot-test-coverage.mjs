export const meta = {
  name: 'autopilot-test-coverage',
  description: 'Author the missing autopilot DoD tests — vertical slice + 6 dedicated component/orchestrator tests (disjoint new files)',
  phases: [
    { title: 'Author' },
  ],
}

// Each agent OWNS exactly one NEW test file (disjoint). No agent edits an existing file.
// The component sources already exist and are unchanged; tests exercise them + the new wiring.
// Tests must be deterministic (node:test), tenant-fenced, and runnable standalone:
//   node --test tests/<file>  must pass on its own.

const COMMON = `Repo: C:/Users/user/Desktop/kolmogorov-stack. Write a Node.js test file using the built-in
'node:test' + 'node:assert/strict'. It MUST be deterministic (no real wall-clock branching, no network — pass any
seed/clock/captures as explicit fixtures). Tenant-fence every call with a unique test tenant id. Read the target
module's EXACT export signature + return envelope shape BEFORE writing assertions (do not guess field names).
Assert the real envelope contract ({ ok, version, ... } and { ok:false, error } on bad input). After writing,
run \`node --test <your-file>\` and confirm it passes; if the bash classifier blocks, say so and at least
\`node --check\` the file. Keep it focused (6-15 assertions). Return ONLY the structured object.`

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'status', 'n_tests', 'ran'],
  properties: {
    file: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    n_tests: { type: 'number' },
    ran: { type: 'string', description: 'node --test result (pass/fail counts) or why it could not run' },
    asserts: { type: 'string', description: 'one line per key assertion the file makes' },
    issues: { type: 'string' },
  },
}

const SPECS = [
  {
    label: 'test:vertical-slice',
    file: 'tests/wave921-autopilot-vertical-slice.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-autopilot-vertical-slice.test.js — THE headline DoD test (currently missing).
Target: src/autopilot-lifecycle.js export tickAutopilotFull({ tenant, namespace, opts }). Read it first
(esp. the deploy-guardrail block + the DEPLOY_WORKFLOW enum PROPOSED/GRACE/EXECUTED/OBJECTED + _evaluateDeploy).
Prove one closed PROPOSE-ONLY tick end-to-end:
  - Call tickAutopilotFull with opts that exercise the full loop (features, budget_usd, target_kscore, and a
    candidate that would pass compareAndDecide) but WITHOUT auto:true (propose-only is the default).
  - Assert the returned envelope is ok:true and carries the lifecycle fields (plan, simulate_decision, and a
    deploy decision/proposal). Read the exact field names from tickAutopilotFull's return statement.
  - Assert the deploy path wrote a DEPLOY_PROPOSED outcome and did NOT execute (never DEPLOY_EXECUTED) when auto
    is absent. If the lifecycle uses the event-store, read the proposed row back and assert its sentinel.
  - Add a second case with auto:true but a FAILING guardrail condition (e.g. regression present OR drift not green
    OR grace not elapsed) and assert it still does NOT execute (stays proposed/holds).
  - Add a day-0/cold-start case: minimal history still returns ok:true with honest confidence, no crash.
This guards the autonomous-improvement loop against silent regression. Tenant-fence with a unique id per case.`,
  },
  {
    label: 'test:quality-predictor',
    file: 'tests/wave921-quality-predictor.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-quality-predictor.test.js. Target: src/quality-predictor.js export
predictKScore({ tenant, namespace, features }). Read it first (the heuristic-vs-learned basis switch + confidence).
Assert: (1) bad input — features missing/array/empty-object => { ok:false, error:'features_required' } (read exact);
(2) cold-start (no/low training rows) => ok:true with basis === 'heuristic' (or the module's exact value) and an
honest confidence field + n_train_rows; (3) a higher-quality feature vector predicts a higher kscore than a poor
one (monotonic sanity); (4) the predicted score is within the valid K range (e.g. 0..1 or the module's range);
(5) ci/confidence present in the envelope. Use the module's real field names.`,
  },
  {
    label: 'test:cost-optimizer',
    file: 'tests/wave921-cost-optimizer.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-cost-optimizer.test.js. Target: src/cost-optimizer.js export
rankStrategies({ tenant, namespace, budget_usd, target_kscore, current_features, teacher_spec }). Read it first
(the strategy set {ingest-more,dedup,gap-fill,preference,evol}, the delta_k_per_dollar ranking, fits_budget flag).
Assert: (1) current_features missing => { ok:false, error:'current_features_required' }; (2) a free/cheap strategy
(e.g. dedup) ranks above a costly one (e.g. gap-fill) by delta_k_per_dollar when both help; (3) with a tiny
budget_usd, costly strategies are flagged fits_budget:false and the recommended one fits the budget; (4) the
envelope carries ranked[] (each with strategy, est_cost_usd, predicted_delta_k, delta_k_per_dollar, fits_budget)
and a recommended. Use the module's real field names.`,
  },
  {
    label: 'test:failure-analyst',
    file: 'tests/wave921-failure-analyst.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-failure-analyst.test.js. Target: src/failure-analyst.js export
analyzeFailures({ tenant, namespace, eval_path, run_dir, teacher_base, max_fix_pairs }). Read it first (how it
ingests eval JSON, clusters misses, emits fix_pairs). Build a temp eval-*.json fixture on disk (os.tmpdir, unique
dir, clean up in after()) representing one cluster that is ~80% wrong. Assert: (1) it identifies a worst_category
(the wrong cluster); (2) it returns >= 1 targeted fix_pair with {input, output, rationale} (read exact keys);
(3) bad/missing eval_path => the module's exact { ok:false, error } envelope; (4) clusters[] present. Templated
(no teacher) path is fine — do not require a live teacher.`,
  },
  {
    label: 'test:compile-simulator',
    file: 'tests/wave921-compile-simulator.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-compile-simulator.test.js. Target: src/compile-simulator.js export
simulateCompile({ tenant, namespace, current_features, proposed_delta, min_delta_k }). Read it first (k_current,
k_proposed, delta_k, decision 'compile'|'skip', reason; DEFAULT_MIN_DELTA_K). Assert: (1) current_features or
proposed_delta missing => exact { ok:false, error }; (2) a marginal proposed_delta (below min_delta_k) => decision
'skip' with a reason; (3) a strong proposed_delta (clearly above threshold) => decision 'compile'; (4) k_proposed
reflects the delta direction (improvement raises it); (5) the envelope carries k_current/k_proposed/delta_k/
decision/reason. Use real field names.`,
  },
  {
    label: 'test:temporal-analyzer',
    file: 'tests/wave921-temporal-analyzer.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-temporal-analyzer.test.js. Target: src/temporal-analyzer.js export
analyzeTemporalCoverage({ tenant, namespace, window_days, captures }). Read it first (it accepts a direct
\`captures\` array — the testable path — and buckets by weekday/weekend/hour/season, then flags under-represented
gaps). Build an all-weekday captures fixture (objects with the timestamp field the module reads — confirm the
exact key via _extractTimestamp). Assert: (1) buckets present (weekday/weekend/by_hour[24]/by_season per the
module); (2) the weekend bucket is flagged as an under-represented gap (share below expected); (3) a balanced
fixture surfaces no weekend gap; (4) empty captures => a sane envelope (no crash). Use real field names.`,
  },
  {
    label: 'test:data-engine-orchestrator',
    file: 'tests/wave921-data-engine-orchestrator.test.js',
    prompt: `${COMMON}

OWN: tests/wave921-data-engine-orchestrator.test.js. Target: src/data-engine.js export
orchestratePipeline({ tenant, namespace, opts }) (DATA_ENGINE_VERSION === 'data-engine-v1'). Read it first.
Assert: (1) version === 'data-engine-v1' and stages object carries ingest/curate/augment/evaluate/feedback keys;
(2) with NO opts.run_dir, the evaluate stage is skipped (skipped:true with a reason) and the pipeline still
returns ok:true; (3) AUGMENT is preview-only by default (no spend / apply:false) unless approve_cost_usd >= cost;
(4) a describe-seeded run (opts.describe) populates the ingest stage (templated, no teacher spend). Use a unique
KOLM_DATA_DIR via process.env in a temp dir (set in before(), restore in after()) so the test does not touch real
user data; clean up. Read the exact stage envelope shapes before asserting.`,
  },
]

phase('Author')
const results = await parallel(
  SPECS.map((s) => () => agent(s.prompt, { label: s.label, phase: 'Author', schema: RESULT_SCHEMA }))
)
const clean = results.filter(Boolean)
log(`Authored ${clean.length}/${SPECS.length} test files: ${clean.map((r) => `${r.file.split('/').pop()}=${r.status}(${r.n_tests})`).join(', ')}`)
return { tests: clean }
