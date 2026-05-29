export const meta = {
  name: 'autopilot-wire-brain',
  description: 'Wire the 8 built-but-unplugged autopilot components into CLI + HTTP surfaces (disjoint file owners), then verify',
  phases: [
    { title: 'Wire' },
    { title: 'Verify' },
  ],
}

// ---------------------------------------------------------------------------
// SHARED CONTRACT — every owner reads this so the routes (A), the CLI (B), and
// the orchestrator (C) agree on names + shapes. Signatures below are EXACT
// (read from source). Do not invent param names.
// ---------------------------------------------------------------------------
const CONTRACT = `
EXACT component signatures (already implemented in src/, do NOT edit the components):
  src/quality-predictor.js   export async predictKScore({ tenant, namespace, features })
  src/cost-optimizer.js      export async rankStrategies({ tenant, namespace, budget_usd, target_kscore, current_features, teacher_spec })
  src/failure-analyst.js     export async analyzeFailures({ tenant, namespace, eval_path, run_dir, teacher_base, max_fix_pairs })
  src/compile-simulator.js   export async simulateCompile({ tenant, namespace, current_features, proposed_delta, min_delta_k })
  src/adversarial-eval.js    export async generateAdversarialSet({ tenant, namespace, weak_clusters, n })
  src/temporal-analyzer.js   export async analyzeTemporalCoverage({ tenant, namespace, window_days, captures })
  src/autopilot-lifecycle.js export async tickAutopilotFull({ tenant, namespace, opts })   // opts: {describe, budget_usd, auto, features, target_kscore}
  src/autopilot-bootstrap.js export async bootstrapFromDescription({ tenant, namespace, description, budget_usd, n })
Every component returns an envelope { ok: boolean, ... , version } and returns { ok:false, error } on bad input (never throws for validation).

HTTP ROUTE CONTRACT (these are the routes Agent A adds to src/router.js; Agent B's CLI calls them):
  GET  /v1/quality/predict            -> predictKScore   (features from JSON-encoded ?features= query OR req.body.features)
  POST /v1/autopilot/plan             -> rankStrategies  (body: budget_usd, target_kscore, current_features, teacher_spec)
  POST /v1/autopilot/analyze          -> analyzeFailures (body: eval_path, run_dir, teacher_base, max_fix_pairs)
  POST /v1/autopilot/simulate         -> simulateCompile (body: current_features, proposed_delta, min_delta_k)
  POST /v1/eval/adversarial/generate  -> generateAdversarialSet (body: weak_clusters, n)
  GET  /v1/autopilot/temporal         -> analyzeTemporalCoverage (?window_days=)
  POST /v1/autopilot/tick             -> tickAutopilotFull (body -> opts: {describe, budget_usd, auto, features, target_kscore}) [NEW, full lifecycle]
All routes: namespace from req.query.namespace || req.body.namespace || 'default'; tenant ALWAYS from req.tenant_record.id.

ORCHESTRATOR CONTRACT (Agent C creates src/data-engine.js; Agent B's 'kolm compile --auto' imports it):
  export async function orchestratePipeline({ tenant, namespace, opts }) -> { ok, version:'data-engine-v1', stages:{ingest,curate,augment,evaluate,feedback}, namespace }
`

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'status', 'changes', 'self_check'],
  properties: {
    file: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'location'],
        properties: {
          what: { type: 'string' },
          location: { type: 'string', description: 'file:line or function name where the edit landed' },
        },
      },
    },
    self_check: { type: 'string', description: 'result of node --check / node -e import / smoke run on the edited file' },
    tests_run: { type: 'string', description: 'which test family was run and its pass/fail counts, or why it could not run' },
    issues: { type: 'string', description: 'anything left undone, broken, or risky' },
  },
}

const OWNER_A = `You OWN exactly one file: src/router.js. No other agent will touch it. Edit ONLY src/router.js.

GOAL: wire 6 built-but-unrouted autopilot components into HTTP routes, mirroring the EXACT existing
autopilot route pattern. First Read src/router.js lines 23997-24039 (the /v1/autopilot/savings and
/v1/autopilot/tick routes) — copy that pattern precisely: auth-gate with
\`if (!req.tenant_record) return res.status(401).json({ ok:false, error:'auth_required' });\`,
then \`try { const mod = await import('./<file>.js'); ... const env = await mod.<fn>({...});
return res.status(env && env.ok === false ? 400 : 200).json(env); } catch (e) { return res.status(500)
.json({ ok:false, error:'<route>_error', detail:String(e&&e.message||e), version:'w921-v1' }); }\`.

Add these routes immediately AFTER the existing /v1/autopilot/tick route (after line 24039), before the
'=====' comment block. For each, Read the component's export signature first to pass the exact params:
${CONTRACT}

CRITICAL — do NOT break tests/wave775-autopilot.test.js. That suite asserts GET /v1/autopilot/tick returns
action:'disabled' when autopilot is not enabled. Therefore LEAVE the existing GET /v1/autopilot/tick route
UNCHANGED (it stays the heartbeat). ADD a NEW route POST /v1/autopilot/tick that calls tickAutopilotFull
(the full lifecycle) — a separate handler, so the GET test keeps passing.

For GET /v1/quality/predict: features may arrive JSON-encoded in ?features= (JSON.parse in a try/catch) or
in req.body.features. For GET /v1/autopilot/temporal: window_days from ?window_days= (Number, optional).

After editing: run \`node --check src/router.js\` and, if the bash classifier allows,
\`node --test tests/wave775-autopilot.test.js\` to confirm no regression. Report exact line numbers of each
added route. Return ONLY the structured object.`

const OWNER_B = `You OWN exactly one file: cli/kolm.js. No other agent will touch it. Edit ONLY cli/kolm.js.

GOAL: surface the autopilot brain + data engine through the CLI. First Read the existing cmdW775Autopilot
dispatcher (around cli/kolm.js:16930-17072) and the existing 'status'/'savings'/'tick' subverb handlers —
they call the HTTP API (via the gateway base + api key). MIRROR that exact HTTP-calling pattern (same helper,
same auth, same --json handling, same error printing) for the new subverbs. Also Read HELP.autopilot
(around line 4594) and COMPLETION_SUBS.autopilot and update both to include the new subverbs.

Add these to cmdW775Autopilot (each calls the route Agent A is adding in parallel — assume the routes exist):
  kolm autopilot plan      [--budget <usd>] [--target-k <k>] [--namespace ns]  -> POST /v1/autopilot/plan
  kolm autopilot analyze   [--run-dir <p>] [--eval-path <p>] [--namespace ns]  -> POST /v1/autopilot/analyze
  kolm autopilot temporal  [--window-days <n>] [--namespace ns]                -> GET  /v1/autopilot/temporal
  kolm autopilot "<free-text description>" [--namespace ns] [--budget <usd>] [--auto]
      -> when the FIRST arg is NOT one of the known verbs (start|stop|status|disable|savings|tick|plan|analyze|temporal)
         AND is a non-empty string, treat it as a description: POST /v1/autopilot/tick with
         body { namespace, describe:<that string>, budget_usd, auto }. This is the "describe and done" entry.
         Keep the known-verb dispatch working exactly as before.

Also add 'kolm meta predict' — Read cmdW832Meta (around line 16815). Add a 'predict' subverb that calls
GET /v1/quality/predict with --features <json> (and --namespace). If 'meta predict' already collides with an
existing subverb, add it as a new branch that prefers the quality-predictor route; do not remove existing meta behavior.

Also add a '--auto' flag to cmdCompile (Read around cli/kolm.js:8011-8087 for the compile arg parsing and the
early flag handlers). When --auto is passed: import orchestratePipeline from '../src/data-engine.js' (the file
Agent C is creating in parallel — assume the export exists) and call
\`await orchestratePipeline({ tenant, namespace, opts: { describe, data, docs, approve_cost_usd } })\`,
printing a per-stage summary (and JSON under --json). Pull --namespace/--describe/--data/--docs/--approve-cost
from the existing compile arg parsing. Do NOT change existing compile behavior when --auto is absent.

${CONTRACT}

After editing: run \`node --check cli/kolm.js\`. If the classifier allows, run \`node cli/kolm.js autopilot --help\`
and \`node cli/kolm.js compile --help\` to confirm no parse crash. Report exact line numbers. Return ONLY the structured object.`

const OWNER_C = `You OWN exactly one NEW file: src/data-engine.js. Create it. Also you MAY read (not edit) the existing
stage modules. Do NOT edit data-curate.js or any other existing file.

GOAL: a single orchestrator that chains the existing 6 data-engine JS stage modules with cost gates and
graceful stage-skipping, so 'kolm compile --auto' has one real entry point. Read these existing modules to learn
their EXACT exports + envelope shapes before wiring (do not guess):
  src/data-ingest.js     (readRawPairs, rawPairsPath, ingestDescribe/ingestDescribeStage, ingestFile, ingestDocs)
  src/data-curate.js     (its main curate export + CURATE_VERSION + the report envelope shape)
  src/data-augment.js    (its augment export + cost-preview gate)
  src/data-evaluate.js   (its evaluate export — needs a run_dir/model path)
  src/data-feedback.js   (identifyProdGaps, proposeRecompile)
  src/data-provenance.js (summarizeProvenance)

Implement:
  export const DATA_ENGINE_VERSION = 'data-engine-v1';
  export async function orchestratePipeline({ tenant, namespace, opts = {} } = {}) { ... }
Behavior (each stage in its own try/catch; a stage failure becomes { ok:false, error } in that stage slot and
does NOT abort later independent stages; record which stages ran/skipped and why):
  1. INGEST: if opts.describe -> ingestDescribe; else if opts.data -> ingestFile; else if opts.docs -> ingestDocs;
     else read existing raw pairs via readRawPairs. If no pairs at all, return early with a clear stage error.
  2. CURATE: run the curate stage on the ingested/loaded pairs. Respect opts.curate flags if present.
  3. AUGMENT: PREVIEW-ONLY by default (do not spend). Only apply when opts.approve_cost_usd is a number >= the
     previewed cost. Always include the cost preview in the stage result.
  4. EVALUATE: run ONLY if opts.run_dir (a trained-model dir) is provided; otherwise stage = {skipped:true, reason}.
  5. FEEDBACK: identifyProdGaps + proposeRecompile (writes a proposal row only; never trains).
Return { ok:true, version: DATA_ENGINE_VERSION, namespace, stages: { ingest, curate, augment, evaluate, feedback } }.
Tenant fences every call. Pure-ish: no wall-clock branching in control flow; accept any seed/clock as a parameter
if a stage needs one. Keep it dependency-light — only import the existing stage modules.

${CONTRACT}

After creating: run \`node --check src/data-engine.js\` and \`node -e "import('./src/data-engine.js').then(m=>console.log(typeof m.orchestratePipeline, m.DATA_ENGINE_VERSION))"\`
to confirm it imports + exports cleanly. Return ONLY the structured object.`

phase('Wire')
const wired = await parallel([
  () => agent(OWNER_A, { label: 'wire:router.js', phase: 'Wire', schema: RESULT_SCHEMA }),
  () => agent(OWNER_B, { label: 'wire:cli-kolm.js', phase: 'Wire', schema: RESULT_SCHEMA }),
  () => agent(OWNER_C, { label: 'wire:data-engine.js', phase: 'Wire', schema: RESULT_SCHEMA }),
])

const ok = wired.filter(Boolean)
log(`Wire phase: ${ok.map((w) => `${w.file}=${w.status}`).join(', ')}`)

// Verify phase — single agent, runs AFTER the barrier so all three files are in place.
phase('Verify')
const VERIFY = `Three files were just edited/created in parallel: src/router.js (6 new autopilot HTTP routes +
POST /v1/autopilot/tick), cli/kolm.js (autopilot plan/analyze/temporal + describe-and-done + meta predict +
compile --auto), and src/data-engine.js (new orchestratePipeline). Verify the integration is sound:

1. Syntax: run \`node --check src/router.js\`, \`node --check cli/kolm.js\`, \`node --check src/data-engine.js\`.
2. Import: \`node -e "import('./src/data-engine.js').then(m=>console.log('data-engine', typeof m.orchestratePipeline, m.DATA_ENGINE_VERSION))"\`.
3. Route presence: Grep src/router.js for each of the 7 route paths; confirm each imports the right component module.
4. CLI presence: Grep cli/kolm.js for the new subverb strings (plan/analyze/temporal) + the describe branch + 'compile' '--auto'.
5. Tests: run \`node --test tests/wave775-autopilot.test.js tests/wave921-autopilot-bandit-wiring.test.js tests/wave921-autopilot-stats.test.js\`
   and report pass/fail counts. If the bash classifier blocks node --test, say so and rely on grep + node --check.
Report a precise verdict: which of the 5 checks passed, exact failures with error text, and whether the GET
/v1/autopilot/tick test still passes (it must). Return ONLY the structured object.`

const verifySchema = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks'],
  properties: {
    verdict: { type: 'string', enum: ['green', 'issues'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass', 'detail'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    failures: { type: 'string' },
  },
}
const verify = await agent(VERIFY, { label: 'verify:integration', phase: 'Verify', schema: verifySchema })

return { wired: ok, verify }
