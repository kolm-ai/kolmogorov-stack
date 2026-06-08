export const meta = {
  name: 'w921-wire-offpath',
  description: 'Wire the off-hot-path W921 modules (autopilot decision layer; data-curate) into their existing files — ADDITIVE/conservative, keeping existing tests green',
  phases: [{ title: 'Wire' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const COMMON = `REPO: ${REPO} (run from there; node_modules present).
You wire ALREADY-BUILT, ALREADY-TESTED W921 modules into existing files. FIND the spec(s): read audit/w921/specs-index.json, open the matching audit/w921/specs/*.spec.json, and skim KOLM_W921_RESEARCH.md.
HARD RULES:
- ADDITIVE + conservative. Do NOT change existing default behavior. New capability is opt-in (a flag/threshold/new field) or a drop-in engine BEHIND the current API with a fallback to today's path. The autopilot/data flows must behave identically by default.
- Edit ONLY your listed files. Do NOT touch src/router.js, cli/kolm.js, or src/gateway-receipt.js (other lanes own those).
- Reuse the new modules (already on disk + tested). Match the repo's ESM 'export function' style.
- VERIFY: run the EXISTING test(s) covering each file you edit AND the new module's test; BOTH must stay 0-fail. node --check every file you touch. Report final fail counts honestly. If wiring would break an existing test in a way that isn't a trivial additive update, STOP and report it rather than weakening the test.`

const SCHEMA = {
  type: 'object', required: ['group', 'files_edited', 'verify', 'summary'],
  properties: {
    group: { type: 'string' }, files_edited: { type: 'array', items: { type: 'string' } },
    verify: { type: 'string' }, status: { enum: ['done', 'partial', 'blocked'] },
    open_issues: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
  },
}

const GROUPS = [
  {
    label: 'wire-autopilot',
    task: `GROUP: autopilot decision layer. Wire the new src/gbm-regressor.js, src/conformal.js, and the mSPRT/GAVI additions in src/stat-sig.js into the autopilot's offline decision layer. You OWN: src/kolm-meta-trainer.js, src/quality-predictor.js, src/autopilot-lifecycle.js, src/ab-router.js (edit only those).
- kolm-meta-trainer: use src/gbm-regressor.js as the regression engine BEHIND the existing train/predict API, with a fallback to the current stump when there is too little data (keep the existing API + outputs shape; existing callers + tests unchanged by default).
- quality-predictor: attach a conformal prediction INTERVAL (via src/conformal.js) to the K-score prediction as an ADDITIVE field (e.g. predicted_interval / ci) — do not change the existing point-estimate field.
- autopilot-lifecycle / ab-router: add the mSPRT/GAVI always-valid A/B decision (src/stat-sig.js) as an ADDITIVE guardrail signal the deploy gate can consult, without removing the existing gate.
VERIFY: run the existing tests for these files (grep tests/ for kolm-meta-trainer / quality-predictor / autopilot / meta / ab-router) + tests/wave921-gbm-regressor.test.js + tests/wave921-autopilot-stats.test.js — all 0-fail.`,
  },
  {
    label: 'wire-data-curate',
    task: `GROUP: data-engine curation. Wire the new src/minhash-dedup.js (MinHash/LSH near-dup) and src/data-select.js (DSIR/DEITA distribution-matched selection) into src/data-curate.js. You OWN: src/data-curate.js (edit only it; the workers/data/scripts/*.py + new modules already exist).
- Route curation through MinHash/LSH near-dup clustering and add an informative-subset SELECTION stage, ADDITIVELY: surface new report fields (e.g. n_clusters, selection, backend_used) and gate the new behavior behind an opt-in option so the default curate path is unchanged.
VERIFY: run the existing data-curate test(s) (grep tests/ for data-curate / curate) + tests/wave921-data-curate-modules.test.js — all 0-fail.`,
  },
]

const results = await parallel(GROUPS.map((g) => () =>
  agent(`${g.task}\n\n${COMMON}`, { schema: SCHEMA, label: g.label, phase: 'Wire' })))
return { groups: results.filter(Boolean) }
