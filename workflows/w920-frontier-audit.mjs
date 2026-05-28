export const meta = {
  name: 'w920-frontier-audit',
  description: 'Read-only: audit every kolm surface + research the frontier, verify findings adversarially, synthesize a prioritized fix-list',
  phases: [
    { title: 'Map & audit' },
    { title: 'Research' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const OUT  = REPO + '/audit/w920'

// Optional xAI/Grok second opinion. Agents include this verbatim in research.
const GROK_HINT = `
OPTIONAL second opinion: if the env var XAI_API_KEY is set, you MAY ask Grok to
name frontier techniques you might have missed, via Bash:
  curl -s https://api.x.ai/v1/chat/completions \\
    -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \\
    -d '{"model":"grok-4","messages":[{"role":"user","content":"<your frontier question>"}]}'
If XAI_API_KEY is unset or the call fails, SKIP it silently and rely on
WebSearch/WebFetch. Never block on it. Treat any Grok output as a lead to verify,
not as truth.`

const SAVE = (key, stage) => `
BEFORE returning, Write your full result as JSON to ${OUT}/${key}.${stage}.json
(create the audit/w920 dir if needed). This is the durability guarantee — do it
even if you are uncertain. Then return the same object.`

const READONLY = `
You are READ-ONLY on product code. Do NOT edit anything under ${REPO} except
files under ${OUT}. Use absolute paths rooted at ${REPO}.`

// ---- Surfaces (real paths verified this session) ----
const SURFACES = [
  { key: 'gateway', name: 'Gateway / Route & Capture',
    files: ['src/gateway-router.js','src/confidence-router.js','src/lake.js','src/services/redactor.js','src/poisoning-orchestrator.js','src/auth.js','src/gateway-receipt.js','src/capture.js'],
    competitors: 'Portkey, Kong AI Gateway, Cloudflare AI Gateway, LiteLLM, Helicone, OpenRouter',
    research: 'LLM routing (cost/latency/quality, semantic routing), PII detection (Microsoft Presidio vs NER vs regex), LLM observability/capture (OpenTelemetry GenAI semconv, OpenLLMetry, OpenInference), prompt-injection detection benchmarks, multi-provider failover, streaming proxy perf, semantic caching, MCP gateway for agents' },
  { key: 'studio', name: 'Studio / Distill & Compile',
    files: ['workers/distill/distill.mjs','workers/distill/scripts/train_lora.py','workers/distill/scripts/train_lora_unsloth.py','src/distill-preference.js','src/distill-recipe-loader.js','src/kscore.js','src/teacher-council.js','src/compile.js','src/synthetic-data.js'],
    competitors: 'distil labs, Lamini (MoME), Snorkel, Unsloth, Axolotl, OpenPipe, Predibase, Together fine-tuning',
    research: 'distillation (online/offline, multi-teacher, DistiLLM-2 contrastive SKL/SRKL), LoRA variants (DoRA, PiSSA, LoRA+, rsLoRA, VeRA, AdaLoRA), training efficiency (Unsloth/Liger kernels, GaLore, FSDP2), data curation (influence functions, data maps), synthetic data (Magpie, Evol-Instruct, Persona Hub, GLAN, Self-Instruct), preference opt (DPO, SimPO, KTO, ORPO, IPO, SPPO), eval (MixEval-Hard, IFEval, Arena-Hard-Auto, AlpacaEval 2), quant ladder (GGUF/EXL2/AWQ/HQQ/AQLM/QuIP#), model merging (TIES, DARE, SLERP)' },
  { key: 'run', name: 'Run / Serve & Deploy',
    files: ['src/runtime-passport.js','src/serve-autodetect.js','src/deploy-generators.js','src/forge-hardware.js','src/runtime.js','src/remote-compute.js','workers/quantize/quantize.mjs'],
    competitors: 'Cerebras, Groq, Fireworks, vLLM, SGLang, llama.cpp, Ollama, TensorRT-LLM, MLX, LMDeploy',
    research: 'speculative decoding (Medusa, EAGLE-2/3, Lookahead), KV cache opt (H2O, StreamingLLM, SnapKV, PyramidKV, KIVI), continuous batching, prefix caching, tensor/pipeline parallelism, quantized serving (FP8, NVFP4/FP4, W4A16 vs W4A4, Marlin/Machete kernels), Multi-LoRA serving, edge (Jetson, CoreML, WebGPU, WASM), fleet orchestration, hardware auto-detect' },
  { key: 'govern', name: 'Govern / Receipts & Compliance',
    files: ['src/gateway-receipt.js','src/receipt-schema.js','src/evidence-dag.js','src/assurance-case.js','src/drift-detector.js','src/cost-displacement.js','src/artifact-lifecycle.js','src/provenance.js','src/audit.js'],
    competitors: 'Mostly unique territory. Adjacent: W&B, MLflow, Fiddler, Arthur, Arize, Credo AI',
    research: 'governance standards (EU AI Act technical standards, NIST AI RMF, ISO/IEC 42001), cryptographic signing for ML (Sigstore/cosign for models, in-toto attestation, SLSA for ML), model cards (HF spec, Google Model Cards), audit trails (SOC 2 AI controls), drift detection (PSI, KL, MMD, CUSUM, ADWIN), model risk mgmt (SR 11-7, OCC), reproducibility (deterministic training, env pinning)' },
  { key: 'data-engine', name: 'Data Engine / Ingest, Curate, Augment',
    files: ['src/data-ingest.js','src/data-curate.js','src/data-augment.js','src/active-learning.js','src/seeds-augment.js','src/seeds-sanitize.js','src/synthetic-data.js'],
    competitors: 'Snorkel, Scale AI, Labelbox, Argilla, Lilac, Cleanlab, DataComp',
    research: 'data quality scoring (DataComp, DSIR, D4), dedup (MinHash, SimHash, SemDeDup), data mixing (DoReMi, mixing laws), active learning (BADGE, uncertainty sampling, diversity, QBC), synthetic generation, filtering (perplexity, quality classifiers, toxicity), curriculum learning. CROSS-REFERENCE the existing KOLM_DATA_ENGINE_PLAN.md — this is a known priority gap.' },
  { key: 'autopilot', name: 'Autopilot / Autonomous Agent',
    files: ['src/autopilot-daemon.js','src/improvement-orchestrator.js','src/kolm-meta-trainer.js','src/quality-predictor.js','src/compile-simulator.js','src/failure-analyst.js','src/ab-router.js','src/bakeoff.js'],
    competitors: 'Mostly unique (full autonomous improve loop). Adjacent: adaptive-inference / continuous-improvement agents',
    research: 'continual learning (EWC, LwF, catastrophic forgetting), AutoML/NAS for small models, HPO, quality prediction (scaling laws, Chinchilla-optimal, learning curves), model A/B (multi-armed bandits, Thompson sampling), autonomous improvement-agent patterns' },
  { key: 'cli-tui', name: 'CLI / TUI / Developer Experience',
    files: ['cli/kolm.js','cli/kolm-tui.mjs'],
    competitors: 'Vercel CLI, Railway CLI, flyctl, Supabase CLI, Stripe CLI, gh CLI, Cloudflare Wrangler',
    research: 'shell completion (fig, tabtab), interactive prompts (clack, prompts), progress (ora, listr2), diagnostic error formatting, natural-language commands (ai-shell patterns), TUI frameworks (ink, ratatui-style), offline-first design, plugin systems. NOTE: dispatch is a single switch in cli/kolm.js ~line 46,644; TUI is the ~9-command kolm-tui.mjs.' },
  { key: 'account-ui', name: 'Account UI / No-Code',
    files: ['public/account/','public/account-shell.css','public/ks.css','public/design-tokens.css'],
    competitors: 'Vercel dashboard, Linear, Stripe dashboard, Supabase studio, Railway, Retool',
    research: 'onboarding (product tours, checklists, empty states), data viz (sparklines, real-time charts), action-driven dashboards (next-actions vs metrics-first), drag-drop upload, real-time (SSE/WebSocket), progressive disclosure, command palette (cmdk), keyboard shortcuts, dark mode, accessibility. AUDIT: for the 60 account pages, which fetch real data from existing routes vs which are stubs.' },
  { key: 'website', name: 'Website / Marketing / Conversion',
    files: ['public/index.html','public/pricing.html','public/compare.html'],
    competitors: 'Vercel.com, Linear.app, Stripe.com, Supabase.com, Railway.app, Modal.com',
    research: 'hero patterns (interactive demos, terminal animations, live playgrounds), social proof, pricing pages (tier compare, calculators, annual toggle), comparison pages (candid side-by-side tables), docs (Mintlify/GitBook/Docusaurus), SEO for dev tools, conversion (CTA placement, signup friction), OSS credibility signals' },
  { key: 'routes-api', name: 'Routes & API surface',
    files: ['src/router.js','public/openapi.json','public/api-routes.json'],
    competitors: 'n/a (internal completeness audit)',
    research: 'Of the 728 routes: how many are real handlers vs 501/stub vs handlers that crash. OpenAPI sync (openapi.json vs api-routes.json). Orphaned/undocumented routes. This is an AUDIT-heavy, research-light surface.' },
  { key: 'tests-gate', name: 'Tests & ship-gate',
    files: ['scripts/ship-gate.cjs','scripts/release-verify.cjs','tests/','package.json'],
    competitors: 'n/a (internal completeness audit)',
    research: 'Which of the 52 ship-gate checks currently pass/fail. Which of the 13 release-verify gates are green. Which src/ modules have ZERO test coverage. Which critical CLI verbs have no tests. AUDIT-heavy, research-light.' },
]

// ---- Schemas ----
const CHECK = { type:'object', required:['name','status'], properties:{
  name:{type:'string'}, status:{enum:['pass','fail','partial','stub','unknown']},
  evidence:{type:'string'}, file:{type:'string'} } }

const AUDIT_SCHEMA = { type:'object', required:['surface','checks','gaps','summary'], properties:{
  surface:{type:'string'}, summary:{type:'string'},
  checks:{type:'array', items:CHECK},
  gaps:{type:'array', items:{type:'string'}} } }

const FINDING = { type:'object',
  required:['title','category','technique','source','current_state','proposed_change','files','effort_days','impact','confidence','already_partially_present','rationale'],
  properties:{
    title:{type:'string'},
    category:{enum:['gap','frontier','upgrade','bug']},
    technique:{type:'string'},
    source:{type:'string', description:'paper title / arxiv id / repo / product URL'},
    current_state:{type:'string', description:'what kolm does today for this'},
    proposed_change:{type:'string'},
    files:{type:'array', items:{type:'string'}, description:'real kolm paths to change'},
    effort_days:{type:'number'},
    impact:{enum:['critical','high','medium','low']},
    confidence:{type:'number'},
    already_partially_present:{type:'boolean'},
    rationale:{type:'string'} } }

const FINDINGS_SCHEMA = { type:'object', required:['findings'], properties:{
  findings:{type:'array', items:FINDING} } }

const VERDICT_SCHEMA = { type:'object', required:['isReal','alreadyPresent','reason'], properties:{
  isReal:{type:'boolean'},
  alreadyPresent:{type:'boolean', description:'does kolm ALREADY implement this? check the actual code'},
  adjusted_effort_days:{type:'number'},
  adjusted_impact:{enum:['critical','high','medium','low']},
  reason:{type:'string'} } }

const PLAN_SCHEMA = { type:'object', required:['executive_summary','top_leverage','by_surface','sequence'], properties:{
  executive_summary:{type:'string'},
  top_leverage:{type:'array', items:{type:'object', properties:{
    title:{type:'string'}, surface:{type:'string'}, why:{type:'string'} }}},
  by_surface:{type:'array', items:{type:'object', properties:{
    surface:{type:'string'},
    items:{type:'array', items:{type:'object', properties:{
      title:{type:'string'}, files:{type:'array',items:{type:'string'}},
      change:{type:'string'}, effort_days:{type:'number'},
      impact:{type:'string'}, depends_on:{type:'string'} }}} }}},
  sequence:{type:'array', items:{type:'object', properties:{
    phase:{type:'string'}, items:{type:'array', items:{type:'string'}} }}},
  open_questions:{type:'array', items:{type:'string'}} } }

// ---- Pipeline: map+audit -> research -> verify (per surface, no barrier) ----
const results = await pipeline(
  SURFACES,

  // Stage 1: map current state + run completeness audit
  (s) => agent(
    `Audit kolm's "${s.name}" surface in ${REPO}.${READONLY}
     Read these files: ${s.files.join(', ')}.
     Also read any relevant docs/research/*.md and docs/product-frontier-*.json
     for this surface so you don't re-flag known items.
     Report concrete checks with status (pass/fail/partial/stub) and EVIDENCE
     (quote a line + file). Cover: what works, what's partial (code exists but
     untested/incomplete), what's missing, and known tech debt.${SAVE(s.key,'audit')}`,
    { schema: AUDIT_SCHEMA, label: `audit:${s.key}`, phase: 'Map & audit' }),

  // Stage 2: research the frontier given the audit
  (audit, s) => agent(
    `Research the cutting edge for kolm's "${s.name}" surface, then compare to
     what we have.${READONLY}
     CURRENT STATE (from audit): ${JSON.stringify(audit).slice(0, 6000)}
     COMPETITORS: ${s.competitors}
     RESEARCH AREAS: ${s.research}
     Use WebSearch + WebFetch heavily (papers, repos, product docs). ${GROK_HINT}
     For each technique worth adopting: is it actually better than what kolm has?
     How hard to implement? Which REAL kolm files change? Expected impact?
     Be ruthlessly practical — skip research-only ideas with no production impl.
     Return 8-15 findings ordered by impact, each with a verifiable source.${SAVE(s.key,'frontier')}`,
    { schema: FINDINGS_SCHEMA, label: `research:${s.key}`, phase: 'Research' })
      .then(r => ({ surface: s.key, audit, findings: (r && r.findings) || [] })),

  // Stage 3: adversarially verify each finding
  (bundle, s) => parallel(bundle.findings.map(f => () =>
    agent(
      `Try to REFUTE this finding for kolm's "${s.name}" surface. Default to
       refuted if uncertain.${READONLY}
       Finding: ${JSON.stringify(f).slice(0, 4000)}
       Check the ACTUAL code in ${REPO}:
       1. Does kolm ALREADY implement this? (many features exist but aren't
          obvious — search src/ and docs/. This repo's #1 failure mode is
          flagging shipped/intentional things as missing.)
       2. Is the effort estimate realistic (usually underestimated)?
       3. Is the impact accurate (usually overblown)?
       4. Unstated dependencies/prerequisites?
       5. Would kolm's actual users care?`,
      { schema: VERDICT_SCHEMA, label: `verify:${s.key}`, phase: 'Verify' })
      .then(v => ({ ...f, verdict: v }))))
    .then(verified => ({ surface: s.key, audit: bundle.audit,
                         findings: verified.filter(Boolean) }))
)

// ---- Synthesize (barrier: needs all surfaces) ----
phase('Synthesize')
const confirmed = results.filter(Boolean).map(r => ({
  surface: r.surface,
  audit: r.audit,
  findings: (r.findings || []).filter(f => f.verdict && f.verdict.isReal && !f.verdict.alreadyPresent),
}))

const totalFindings = confirmed.reduce((n, r) => n + r.findings.length, 0)
log(`Synthesizing ${totalFindings} verified findings across ${confirmed.length} surfaces`)

const plan = await agent(
  `You have ${totalFindings} verified, deduped frontier findings + per-surface
   completeness audits across kolm. Each finding survived adversarial refutation
   and is NOT already present.${READONLY}
   DATA: ${JSON.stringify(confirmed).slice(0, 90000)}
   Write a prioritized fix-list that:
   1. Groups by surface.
   2. Orders by impact (critical first), then effort (quick wins first).
   3. For each item: exact real files to change, what to do, effort_days, impact,
      and any depends_on.
   4. Calls out the 5-8 highest-leverage items that most differentiate kolm.
   5. Proposes a phased execution sequence.
   6. Lists open questions for the human.
   Also Write this plan to ${OUT}/PLAN.json before returning.`,
  { schema: PLAN_SCHEMA, label: 'synthesize', phase: 'Synthesize' })

return { confirmed, plan, surfaces: SURFACES.length, totalFindings }
