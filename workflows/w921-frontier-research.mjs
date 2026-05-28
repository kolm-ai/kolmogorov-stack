export const meta = {
  name: 'w921-frontier-research',
  description: 'Per surface->technique deep research (Claude+WebSearch+Grok), end-to-end mapping to kolm, verified execution-ready specs + a 100x demo spec',
  phases: [
    { title: 'Discover techniques' },
    { title: 'Deep-dive techniques' },
    { title: 'Verify specs' },
    { title: 'Demo research' },
    { title: 'Synthesize roadmap' },
  ],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const OUT = REPO + '/audit/w921'
const RELEVANCE_GATE = 4 // 1-5; deep-dive only candidates >= this

const GROK = `
CO-RESEARCHER (required when XAI_API_KEY is set): in addition to WebSearch/WebFetch,
get Grok's view and CROSS-CHECK it against the web. Run via Bash:
  curl -s https://api.x.ai/v1/chat/completions \\
    -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \\
    -d '{"model":"grok-4","messages":[{"role":"user","content":"<your question>"}]}'
Ask Grok specifically: which frontier techniques/papers/repos am I missing here,
and what's the strongest production implementation? Treat its output as leads to
VERIFY against primary sources, never as truth. If XAI_API_KEY is unset or the
call fails, skip silently and rely on the web. Record what Grok added in the
grok_corroboration field.`

const SAVE = (p) => `
BEFORE returning, Write your full result as JSON to ${OUT}/${p}
(create dirs as needed). Durability guarantee — do it even if uncertain. Then
return the same object.`

const READONLY = `
READ-ONLY on product code. Do NOT edit anything under ${REPO} except files under
${OUT}. Use absolute paths rooted at ${REPO}. The completeness audit is already
done — read audit/w920/*.audit.json for context; do NOT re-audit, focus on the
FRONTIER and the IMPROVEMENT.`

const SURFACES = [
  { key: 'gateway', name: 'Gateway / Route & Capture',
    files: ['src/gateway-router.js', 'src/confidence-router.js', 'src/lake.js', 'src/services/redactor.js', 'src/poisoning-orchestrator.js', 'src/gateway-receipt.js', 'src/capture.js'],
    competitors: 'Portkey, Kong AI Gateway, Cloudflare AI Gateway, LiteLLM, Helicone, OpenRouter',
    areas: 'semantic/cost/latency routing, PII detection (Presidio/NER), LLM observability (OTel GenAI semconv, OpenLLMetry, OpenInference), prompt-injection defense, multi-provider failover, semantic caching, MCP gateway' },
  { key: 'studio', name: 'Studio / Distill & Compile',
    files: ['workers/distill/distill.mjs', 'workers/distill/scripts/train_lora.py', 'workers/distill/scripts/train_lora_unsloth.py', 'src/distill-preference.js', 'src/distill-recipe-loader.js', 'src/kscore.js', 'src/teacher-council.js', 'src/compile.js', 'src/synthetic-data.js'],
    competitors: 'distil labs, Lamini, Snorkel, Unsloth, Axolotl, OpenPipe, Predibase',
    areas: 'distillation (DistiLLM-2, multi-teacher, on/off-policy), LoRA variants (DoRA/PiSSA/LoRA+/rsLoRA/VeRA/AdaLoRA), training efficiency (Unsloth/Liger kernels, GaLore, FSDP2), synthetic data (Magpie, Evol-Instruct, Persona Hub, GLAN), preference opt (DPO/SimPO/KTO/ORPO/IPO/SPPO), eval (MixEval-Hard, IFEval, Arena-Hard-Auto), quant ladder, model merging (TIES/DARE/SLERP)' },
  { key: 'run', name: 'Run / Serve & Deploy',
    files: ['src/runtime-passport.js', 'src/serve-autodetect.js', 'src/deploy-generators.js', 'src/forge-hardware.js', 'src/runtime.js', 'src/remote-compute.js', 'workers/quantize/quantize.mjs'],
    competitors: 'Cerebras, Groq, Fireworks, vLLM, SGLang, llama.cpp, TensorRT-LLM, MLX, LMDeploy',
    areas: 'speculative decoding (Medusa, EAGLE-2/3, Lookahead), KV cache (H2O, StreamingLLM, SnapKV, PyramidKV, KIVI), continuous batching, prefix caching, quantized serving (FP8, NVFP4/FP4, W4A16/W4A4, Marlin/Machete), Multi-LoRA serving, edge (Jetson, CoreML, WebGPU, WASM)' },
  { key: 'govern', name: 'Govern / Receipts & Compliance',
    files: ['src/gateway-receipt.js', 'src/receipt-schema.js', 'src/evidence-dag.js', 'src/assurance-case.js', 'src/drift-detector.js', 'src/cost-displacement.js', 'src/artifact-lifecycle.js', 'src/provenance.js', 'src/audit.js'],
    competitors: 'W&B, MLflow, Fiddler, Arthur, Arize, Credo AI (adjacent; kolm leads here)',
    areas: 'governance standards (EU AI Act, NIST AI RMF, ISO 42001), crypto signing for ML (Sigstore/cosign, in-toto, SLSA), model cards, audit trails, drift (PSI/KL/MMD/CUSUM/ADWIN), model risk (SR 11-7), reproducibility' },
  { key: 'data-engine', name: 'Data Engine / Ingest, Curate, Augment',
    files: ['src/data-ingest.js', 'src/data-curate.js', 'src/data-augment.js', 'src/active-learning.js', 'src/seeds-augment.js', 'src/seeds-sanitize.js', 'src/synthetic-data.js'],
    competitors: 'Snorkel, Scale AI, Argilla, Lilac, Cleanlab, DataComp',
    areas: 'quality scoring (DataComp, DSIR, D4), dedup (MinHash, SemDeDup), mixing (DoReMi), active learning (BADGE, uncertainty, diversity), synthetic gen, filtering (perplexity, quality classifiers), curriculum. CROSS-REF KOLM_DATA_ENGINE_PLAN.md.' },
  { key: 'autopilot', name: 'Autopilot / Autonomous Agent',
    files: ['src/autopilot-daemon.js', 'src/improvement-orchestrator.js', 'src/kolm-meta-trainer.js', 'src/quality-predictor.js', 'src/compile-simulator.js', 'src/failure-analyst.js', 'src/ab-router.js', 'src/bakeoff.js'],
    competitors: 'adaptive-inference / continuous-improvement agents (kolm leads)',
    areas: 'continual learning (EWC, LwF, forgetting mitigation), AutoML/NAS for small models, HPO, quality prediction (scaling laws, Chinchilla-optimal), model A/B (bandits, Thompson sampling), autonomous improvement loops' },
  { key: 'cli-tui', name: 'CLI / TUI / Developer Experience',
    files: ['cli/kolm.js', 'cli/kolm-tui.mjs'],
    competitors: 'Vercel CLI, Railway CLI, flyctl, Supabase CLI, Stripe CLI, gh CLI, Wrangler',
    areas: 'shell completion, interactive prompts (clack), progress (ora/listr2), diagnostic errors, NL commands, TUI frameworks (ink), offline-first, plugin systems' },
  { key: 'account-ui', name: 'Account UI / No-Code',
    files: ['public/account/', 'public/account-shell.css', 'public/ks.css', 'public/design-tokens.css'],
    competitors: 'Vercel dashboard, Linear, Stripe dashboard, Supabase studio, Retool',
    areas: 'onboarding (tours/checklists/empty states), data viz, action-driven dashboards, real-time (SSE/WS), command palette (cmdk), a11y, dark mode' },
  { key: 'website', name: 'Website / Marketing / Conversion',
    files: ['public/index.html', 'public/pricing.html', 'public/compare.html'],
    competitors: 'Vercel.com, Linear.app, Stripe.com, Supabase.com, Modal.com',
    areas: 'interactive hero demos, social proof, pricing/comparison pages, docs (Mintlify/GitBook), SEO, conversion, OSS credibility' },
]

const CANDIDATE = { type: 'object', required: ['technique', 'area', 'why_relevant', 'current_kolm_state', 'relevance'], properties: {
  technique: { type: 'string' }, area: { type: 'string' }, why_relevant: { type: 'string' },
  current_kolm_state: { type: 'string' }, relevance: { type: 'number' },
  files_likely: { type: 'array', items: { type: 'string' } } } }
const DISCOVERY = { type: 'object', required: ['surface', 'candidates'], properties: {
  surface: { type: 'string' }, candidates: { type: 'array', items: CANDIDATE } } }

const SPEC = { type: 'object',
  required: ['technique', 'surface', 'how_it_works', 'kolm_current', 'gap', 'improvement', 'frontier_functions', 'files_to_touch', 'signatures', 'dependencies', 'test_plan', 'acceptance_criteria', 'effort_days', 'impact'],
  properties: {
    technique: { type: 'string' }, surface: { type: 'string' },
    how_it_works: { type: 'string', description: 'end-to-end: algorithm, math, data flow, where it sits in the pipeline' },
    reference_impls: { type: 'array', items: { type: 'string' }, description: 'repos/papers with URLs or arxiv ids' },
    benchmarks: { type: 'string', description: 'target numbers to beat/match' },
    kolm_current: { type: 'string', description: 'how kolm does this today + real file refs' },
    gap: { type: 'string' },
    improvement: { type: 'string', description: 'the concrete change' },
    frontier_functions: { type: 'array', items: { type: 'string' }, description: 'named functions/APIs/kernels to implement' },
    files_to_touch: { type: 'array', items: { type: 'string' } },
    signatures: { type: 'array', items: { type: 'string' }, description: 'proposed function signatures' },
    dependencies: { type: 'array', items: { type: 'string' } },
    test_plan: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    effort_days: { type: 'number' }, impact: { enum: ['critical', 'high', 'medium', 'low'] },
    risk: { type: 'string' },
    grok_corroboration: { type: 'string', description: 'what Grok added or contradicted' } } }

const VERDICT = { type: 'object', required: ['isReal', 'alreadyPresent', 'scopeCorrect', 'reason'], properties: {
  isReal: { type: 'boolean' }, alreadyPresent: { type: 'boolean' },
  scopeCorrect: { type: 'boolean' }, depsComplete: { type: 'boolean' },
  adjusted_effort_days: { type: 'number' }, adjusted_impact: { enum: ['critical', 'high', 'medium', 'low'] },
  reason: { type: 'string' } } }

const DEMO_SPEC = { type: 'object', required: ['diagnosis', 'target_experience', 'data_strategy', 'build_steps', 'polish_checklist', 'acceptance_criteria', 'files_to_touch'], properties: {
  diagnosis: { type: 'array', items: { type: 'string' }, description: 'every inauthentic/canned aspect of demo-live.html today' },
  benchmarks: { type: 'array', items: { type: 'string' }, description: 'best-in-class demos studied + what to steal' },
  target_experience: { type: 'string' },
  data_strategy: { type: 'string', description: 'how every value becomes real+verifiable (real kolm run capture + real receipts)' },
  build_steps: { type: 'array', items: { type: 'string' } },
  polish_checklist: { type: 'array', items: { type: 'string' }, description: 'motion, a11y, reduced-motion, mobile, no dead links, reviewed' },
  acceptance_criteria: { type: 'array', items: { type: 'string' } },
  files_to_touch: { type: 'array', items: { type: 'string' } } } }

const ROADMAP = { type: 'object', required: ['executive_summary', 'top_leverage', 'sequence', 'groups'], properties: {
  executive_summary: { type: 'string' },
  top_leverage: { type: 'array', items: { type: 'object', properties: { technique: { type: 'string' }, surface: { type: 'string' }, why: { type: 'string' } } } },
  sequence: { type: 'array', items: { type: 'object', properties: { phase: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } } },
  groups: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, label: { type: 'string' },
    specPaths: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    sharesBigFile: { type: 'boolean', description: 'true if touches cli/kolm.js or src/router.js -> sequential lane' } } } },
  open_questions: { type: 'array', items: { type: 'string' } } } }

// ---- Stage 1: discover techniques per surface (barrier) ----
phase('Discover techniques')
const discoveries = await parallel(SURFACES.map((s) => () => agent(
  `Discover the frontier TECHNIQUES worth deep research for kolm's "${s.name}".${READONLY}
   Skim files: ${s.files.join(', ')} and audit/w920/${s.key}.audit.json.
   Competitors: ${s.competitors}. Areas: ${s.areas}.
   Also read docs/product-frontier-*.json so you don't re-list known items.
   Return a ranked candidate list (relevance 1-5) of techniques that, if adopted,
   would move kolm toward best-in-class. For each: why it's relevant, kolm's
   current state, and likely files.${SAVE(`${s.key}.discovery.json`)}`,
  { schema: DISCOVERY, label: `discover:${s.key}`, phase: 'Discover techniques' })))

const candidates = discoveries.filter(Boolean).flatMap((d) =>
  (d.candidates || []).filter((c) => c.relevance >= RELEVANCE_GATE).map((c) => ({ ...c, surface: d.surface })))
log(`${candidates.length} high-value techniques (relevance >= ${RELEVANCE_GATE}) to deep-dive`)

// ---- Stage 2+3 (technique track) and Demo track run concurrently ----
const [specsRaw, demo] = await Promise.all([
  pipeline(candidates,
    (c) => agent(
      `Deep-dive ONE frontier technique for kolm's "${c.surface}" surface: "${c.technique}".${READONLY}
       Research it exhaustively. ${GROK}
       Produce an EXECUTION-READY spec:
       1) how_it_works end-to-end (algorithm + math + data flow + pipeline placement),
       2) reference_impls (repos/papers w/ URLs), benchmarks to target,
       3) kolm_current (how we do it now, cite real files), the gap,
       4) improvement: the concrete change + the named frontier_functions to build,
          proposed function signatures, files_to_touch, dependencies,
       5) test_plan + acceptance_criteria + effort_days + impact + risk.
       Be ruthlessly concrete and implementable — no vague "consider X".${SAVE(`specs/${c.surface}.${(c.technique || 'x').slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.spec.json`)}`,
      { schema: SPEC, label: `dive:${c.surface}`, phase: 'Deep-dive techniques' }),
    (spec) => agent(
      `Try to REFUTE this implementation spec. Default to refuted if uncertain.${READONLY}
       Spec: ${JSON.stringify(spec).slice(0, 5000)}
       Check the ACTUAL code in ${REPO}: (1) does kolm ALREADY implement this?
       (repo's #1 failure mode is flagging shipped/intentional things as missing —
       search src/ and docs/); (2) is the scope/signatures correct against the real
       files? (3) are dependencies complete? (4) is the effort estimate realistic?
       (5) is the impact accurate? Use Grok as a second skeptic if XAI_API_KEY is set.`,
      { schema: VERDICT, label: `verify:${spec.surface}`, phase: 'Verify specs' })
      .then((v) => ({ ...spec, verdict: v }))
  ),

  (async () => {
    const best = await agent(
      `Research best-in-class product demos and what makes them feel AUTHENTIC vs
       canned: Linear, Vercel, Stripe, Warp, Charm VHS, asciinema, terminalizer,
       Arcade, Supademo, and great dev-tool live demos.${GROK}
       Return concrete patterns kolm should steal for a 100x terminal-product demo.${SAVE('demo.bestinclass.json')}`,
      { schema: { type: 'object', properties: { patterns: { type: 'array', items: { type: 'string' } } }, required: ['patterns'] },
        label: 'demo:bestinclass', phase: 'Demo research' })
    const cur = await agent(
      `Audit kolm's current demo at ${REPO}/public/demo-live.html and the recorder
       ${REPO}/scripts/record-demo-w905.mjs.${READONLY}
       It is a hardcoded scripted animation (fake CHAPTERS data). List EVERY
       inauthentic/canned aspect (invented ids, fake metrics, no real receipts,
       any dead links, a11y/mobile gaps).${SAVE('demo.audit.json')}`,
      { schema: { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] },
        label: 'demo:audit', phase: 'Demo research' })
    return await agent(
      `Write the 100x DEMO spec for ${REPO}/public/demo-live.html.${READONLY}
       Best-in-class patterns: ${JSON.stringify(best).slice(0, 4000)}
       Current issues: ${JSON.stringify(cur).slice(0, 4000)}
       Requirement: it must FEEL like an authentic, state-of-the-art real-life
       recording, super intuitive end-to-end, finished and reviewed. Every visible
       value must be REAL and verifiable — driven by an actual kolm run captured to
       the timeline, with real signed receipts resolvable at /verify/<id>. Reuse the
       existing cinematic engine; replace its data source from invented -> captured.
       Give a data_strategy, concrete build_steps, a polish_checklist (motion, a11y,
       reduced-motion, mobile, no dead links, review pass), acceptance_criteria,
       and files_to_touch.${SAVE('demo.spec.json')}`,
      { schema: DEMO_SPEC, label: 'demo:spec', phase: 'Demo research' })
  })(),
])

// ---- Stage 5: synthesize the execution roadmap (barrier) ----
phase('Synthesize roadmap')
const confirmed = specsRaw.filter(Boolean).filter((s) =>
  s.verdict && s.verdict.isReal && !s.verdict.alreadyPresent)
log(`Synthesizing ${confirmed.length} verified specs + demo spec`)

const roadmap = await agent(
  `Build the execution roadmap from these verified, deduped specs + the demo spec.${READONLY}
   SPECS: ${JSON.stringify(confirmed).slice(0, 80000)}
   DEMO: ${JSON.stringify(demo).slice(0, 8000)}
   1) executive_summary, 2) top_leverage 5-8 items that most differentiate kolm,
   3) a phased sequence, 4) GROUP specs for parallel execution by file-independence:
      set sharesBigFile=true for any group touching cli/kolm.js or src/router.js
      (those run in a SEQUENTIAL lane); independent new-module/isolated-file groups
      and the demo are parallel-safe. Each group lists specPaths (under audit/w921/)
      + files. 5) open_questions.
   Write this to ${OUT}/ROADMAP.json before returning.`,
  { schema: ROADMAP, label: 'synthesize', phase: 'Synthesize roadmap' })

return { confirmed, demo, roadmap, candidates: candidates.length, specs: confirmed.length }
