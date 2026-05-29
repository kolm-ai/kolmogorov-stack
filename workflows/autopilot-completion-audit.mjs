export const meta = {
  name: 'autopilot-completion-audit',
  description: 'Audit the KOLM AUTOPILOT lead plan against its Definition of Done across 6 disjoint slices, in parallel',
  phases: [
    { title: 'Map' },
  ],
}

// Each reader owns one disjoint slice of the AUTOPILOT plan's Definition of Done.
// They are READ-ONLY (grep/read; may run a focused test if the classifier allows).
// Every finding must cite a file:line as evidence so the synthesis is verifiable.

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slice', 'overall', 'items'],
  properties: {
    slice: { type: 'string' },
    overall: { type: 'string', enum: ['done', 'partial', 'missing'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'state', 'evidence'],
        properties: {
          item: { type: 'string', description: 'the specific DoD check' },
          state: { type: 'string', enum: ['done', 'partial', 'missing'] },
          evidence: { type: 'string', description: 'file:line or grep result proving the state' },
          gap: { type: 'string', description: 'if partial/missing, exactly what is needed to finish (file + change)' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'

const COMMON = `You are auditing the KOLM AUTOPILOT lead plan (the autonomous distillation agent) for completion.
Repo root: ${ROOT}. You are READ-ONLY: use Grep/Glob/Read freely. You MAY run one focused
node --test on a single test file if useful, but if the bash classifier is unavailable, fall back to
reading the test file and asserting on its contents instead — do not block on it.
For EVERY check, cite concrete evidence as file:line (from Grep -n or Read). Be precise and skeptical:
"file exists" is NOT "done" — done means wired into the surface (CLI verb dispatch / HTTP route handler /
daemon tick / rendered UI) AND covered by an assertion. If wiring is absent, mark partial/missing and state
the exact file + change needed to finish. Return ONLY the structured object.`

const SLICES = [
  {
    label: 'map:components-cli-http',
    prompt: `${COMMON}

SLICE: The 8 Autopilot intelligence components — are they wired into CLI and HTTP surfaces?
Components: src/quality-predictor.js, src/cost-optimizer.js, src/failure-analyst.js,
src/compile-simulator.js, src/adversarial-eval.js, src/temporal-analyzer.js, src/kscore-timeseries.js,
src/autopilot-lifecycle.js, src/autopilot-bootstrap.js.

For EACH component check three things and return one item per (component × surface) that matters:
 (1) CLI: is there a 'kolm' verb in cli/kolm.js that calls the component's exported fn?
     (plan names: 'kolm meta predict', 'kolm autopilot plan', 'kolm autopilot analyze',
      'kolm autopilot temporal', 'kolm eval adversarial', 'kolm kscore series')
 (2) HTTP: is there a route in src/router.js? (plan names: GET /v1/quality/predict, POST /v1/autopilot/plan,
      POST /v1/autopilot/analyze, GET /v1/autopilot/temporal, GET /v1/kscore/series, kolm eval adversarial bench)
 (3) does the route/verb actually import + invoke the component (not a stub)?
Grep cli/kolm.js and src/router.js for each component's primary export name to confirm real invocation.
overall = done only if every component is reachable from at least its planned surface.`,
  },
  {
    label: 'map:data-engine-compile-auto',
    prompt: `${COMMON}

SLICE: The 6-stage Data Engine + 'kolm compile --auto' wrapper.
Modules: src/data-ingest.js, src/data-curate.js, src/data-augment.js, src/data-evaluate.js,
src/data-feedback.js, src/data-provenance.js, plus workers/data/scripts/*.py.
Checks:
 (1) Does cli/kolm.js have 'kolm compile --auto' (or equivalent) that runs all 6 stages with cost gates?
     Grep cli/kolm.js for 'compile' + '--auto' + the data-* imports.
 (2) INGEST: are the ~10 ingest paths present (--describe/--file/--docs/--from openai-finetune,portkey,
     helicone,litellm,hf/combined)? Grep src/data-ingest.js for the path handlers.
 (3) CURATE: quality-score + dedup + cluster + CoT/PII + balance present? Grep src/data-curate.js.
 (4) AUGMENT/EVALUATE/FEEDBACK: gap-fill, failure analysis, prod-gap->recompile present?
 (5) Are the python workers referenced (workers/data/scripts/{embed_pairs,cluster_pairs,score_quality,score_failures}.py) present on disk?
Cite file:line for each.`,
  },
  {
    label: 'map:autopilot-tick-bootstrap-guardrails',
    prompt: `${COMMON}

SLICE: Full Autopilot mode — the tick lifecycle, describe-and-done bootstrap, and auto-deploy guardrails.
Checks:
 (1) Does src/autopilot-daemon.js import/call autopilot-lifecycle.js inside the tick (between drift gate and
     orchestrate)? Grep src/autopilot-daemon.js for 'lifecycle' / 'tickAutopilotFull' / require/import of it.
 (2) Does a 'tickAutopilotFull' (or lifecycle tick) exist and call components 1-6? Grep src/autopilot-lifecycle.js.
 (3) describe-and-done: does cli/kolm.js treat a non-verb first arg to 'kolm autopilot' as a description and call
     bootstrapFromDescription (src/autopilot-bootstrap.js)? Grep cli/kolm.js around the 'autopilot' verb.
 (4) Auto-deploy guardrails: propose-only default + --auto + 5 conditions (compareAndDecide promote, regressions<=N,
     adversarial+safety pass, drift green, 48h grace) + DEPLOY_PROPOSED/GRACE/EXECUTED/OBJECTED sentinels.
     Grep src/autopilot-lifecycle.js + src/improvement-orchestrator.js for these.
 (5) HTTP: is there POST /v1/autopilot/plan and the autopilot tick route wired? Grep src/router.js.
Cite file:line for each; mark missing wiring precisely (which file, which insertion point).`,
  },
  {
    label: 'map:ui-data-health-flywheel',
    prompt: `${COMMON}

SLICE: Data Flywheel UI — sparkline + Data Health panel on the account namespaces page.
Files: public/account/ks-sparkline.js, public/account/namespaces.html, public/warm-paper.css / cool-slate tokens.
Checks:
 (1) Does public/account/ks-sparkline.js render an inline-SVG <polyline> chart (dependency-free)? Read it.
 (2) Is it mounted in public/account/namespaces.html (script include + a container it targets)? Grep namespaces.html.
 (3) Is there a "Data Health" panel (quality/coverage/balance/freshness bars + one-click actions Add data/Curate/
     Fill gaps/Compile)? Grep namespaces.html for 'health' / the action buttons.
 (4) Does the new UI use cool-slate tokens (--ks-color-*) and NOT warm-paper/brown/orange carry-over?
     Grep namespaces.html + any inline style for warm hex (#c2410c, #a8b3c2, amber) or warm var names.
 (5) Does namespaces.html fetch /v1/kscore/series to populate the chart? Grep for the fetch.
Cite file:line. Flag any warm-paper carry-over as a gap (binding directive: cool-slate only).`,
  },
  {
    label: 'map:phase-e-website-cleanup',
    prompt: `${COMMON}

SLICE: Phase E website nav + page cleanup (the LAST phase of the plan).
Checks (Glob/Grep/Read only):
 (1) Was /product content moved to /about? Does public/about.html now hold the product content (check line count
     ~743 and content), and is the old 230-line /about gone? Read both if present.
 (2) Is public/manifesto.html removed? Glob for it.
 (3) nav.js footer + site links to /manifesto fixed? Grep public/nav.js for 'manifesto' (expect 0).
 (4) Referrers updated: the 9 /product referrers (index, changelog, migrate, studio, tui, wrapper,
     what-is-an-ai-compiler, kolm-auto-pilot, foundations) — Grep public for href="/product" (expect 0 or redirected).
 (5) vercel.json: /about redirect to /manifesto REMOVED, and any new redirects added? Read vercel.json relevant lines.
 (6) Retire-candidates (healthcare-v2, sla, ci, code-gen, insurance/defense/education/eu-sovereign stubs, setup):
     report which still exist (do NOT delete — just inventory for the operator).
 (7) sw.js CACHE bumped to a wave token >= 835 (currently check public/sw.js line ~57 'kolm-vNNN-...-waveNNN').
Cite file:line. This phase is explicitly LAST — report exactly what remains.`,
  },
  {
    label: 'map:tests-dod-green',
    prompt: `${COMMON}

SLICE: Tests & Definition-of-Done coverage for the autopilot components + data engine.
Checks:
 (1) Find the test files covering each component + data-engine stage. Glob tests/ for 'autopilot', 'quality-predict',
     'cost-optim', 'failure', 'compile-sim', 'adversarial', 'temporal', 'kscore', 'data-ingest', 'data-curate',
     'data-augment', 'data-evaluate', 'data-feedback'. List which exist.
 (2) For each found test file, read it and report what it actually asserts (does it test the SURFACE wiring —
     CLI/HTTP — or only the module fn in isolation?). The plan DoD wants smoke tests per component.
 (3) The vertical-slice milestone: is there a test that runs one closed propose-only tick end-to-end (backfill
     kscore-timeseries -> predict -> simulate -> failure analyst -> cost optimizer -> new K point -> DEPLOY_PROPOSED,
     never EXECUTED)? Grep tests/ for it.
 (4) If the bash classifier is available, run node --test on ONE autopilot test file and report pass/fail counts;
     otherwise skip and rely on reading.
Cite file:line. overall = done only if each component has a passing smoke test AND the vertical slice is covered.`,
  },
]

phase('Map')
const findings = await parallel(
  SLICES.map((s) => () => agent(s.prompt, { label: s.label, phase: 'Map', schema: FINDINGS_SCHEMA, agentType: 'Explore' }))
)

const clean = findings.filter(Boolean)
// Flatten to a single gap list for synthesis.
const gaps = []
for (const f of clean) {
  for (const it of (f.items || [])) {
    if (it.state !== 'done') gaps.push({ slice: f.slice, item: it.item, state: it.state, gap: it.gap || '', evidence: it.evidence })
  }
}
log(`Audit complete: ${clean.length}/6 slices reported. ${gaps.length} non-done items across slices.`)
return { slices: clean, gaps, summary: clean.map((f) => `${f.slice}: ${f.overall}`) }
