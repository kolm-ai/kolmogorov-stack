export const meta = {
  name: 'stack-innovation-research',
  description: 'Atomic per-component research + invention across the live kolm.ai ASR product stack, adversarially verified, synthesized into a ranked constraint-checked backlog',
  phases: [
    { title: 'Research', detail: 'one deep researcher per component: current state + SOTA scan + inventions + improvements' },
    { title: 'Verify', detail: 'adversarial reviewer per component: is each proposal real, buildable, on-brand, constraint-safe' },
    { title: 'Synthesize', detail: 'merge + dedup + rank into innovation memo and machine-readable backlog' },
  ],
}

// ---- shared context embedded into every agent prompt ----
const PRODUCT = `kolm.ai is TWO first-class product surfaces on one stack, both treated as core:
(A) AGENT SECURITY EVIDENCE: SIGNED, offline-verifiable Readiness Reports (ASR) for AI agents. Free Scan (watermarked preview) funnels to a $750 one-time Signed Readiness Report, Continuous monitoring at $299/$999 a month, and a $25,000 Reviewed Attestation (named co-signer, waitlist). The moat is cryptographic: an Ed25519 signing key (env-sourced, fingerprint fa56...), an RFC-6962-style Merkle transparency log, and public offline verification. The audit assesses permission posture, redaction, and audit-trail integrity; injection is tested and reported, not warranted.
(B) THE MODEL PLATFORM: a full pipeline to compile, distil, train, quantize, and serve ANY model and put it on ANY device (on-device + cloud + BYOC). Includes a compile IR + targets, distillation (GRPO/on-policy/preference/progressive), training + tokenizer, quantization oracle, runtime placement, a serving/inference gateway, multi-provider model portability, benchmarks/eval (kscore, bakeoffs, holdouts), a registry + marketplace, and SDKs/CLI across 8 languages. Every produced artifact should be signed + provenance-tracked, tying surface B back to the trust moat of surface A.
Backend = Node/Express monolith (src/, 528 modules), SQLite-on-volume persistence, Stripe billing, deployed on Railway. Frontend = static site (public/*.html) on Vercel apex, /v1/* rewritten to Railway. CLI/SDKs in cli/, sdk/, packages/.`

const CONSTRAINTS = `HARD CONSTRAINTS every proposal MUST respect (a proposal that needs to violate one of these is INVALID):
- NEVER the word "honesty"/"honest" in any customer/API surface; use "Caveats"/"Constraints"/"Limitations".
- dev@kolm.ai is the ONLY contact email. No personal/sales@/hello@ addresses.
- Keep the kolm name + three-bar logo. The framework is NOT "AIUC-1" (align, do not claim). No blockchain in the trust path (Ed25519 + SHA-256 Merkle only).
- The dark site backdrop/environment is PERFECT and MUST NOT change; only inline graphics may be improved.
- No em/en dashes, no smart quotes anywhere on the site; ASCII-safe punctuation only.
- LOCKED pricing (flag-only, never silently change): Scan free / Signed Readiness Report $750 one-time / Continuous $299 and $999 mo / Reviewed Attestation $25,000 flat / +Deep Red-Team +$10,000.
- EXACT scope sentence (verbatim where used): "Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted."
- NEVER echo the Ed25519 private key or any secret VALUE. No new fonts/CDNs/external requests. No git push. report.html keeps sig__ok; hero <=68px. pricing.html stays audit-free.
- FORBIDDEN substrings (case-sensitive): "pip install kolm", ".kolm bundle", "3B INT4", "Arweave", "On-chain", "Air-gap mode", "WASM runtime", "kolm WASM", "EU AI Act compliant", "Type I evidence available now", "SOC 2 Type II evidence", "Your data never moves", "data never moves", "inside your VPC", "BAA boundary", "PHI never leaves", "HIPAA-ready", "Mobile SDK", "AIUC-1".`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component','maturityScore','currentState','sotaNotes','gaps','inventions','improvements'],
  properties: {
    component: { type: 'string' },
    maturityScore: { type: 'number', description: '1-10 how state-of-the-art + complete this component is today' },
    currentState: { type: 'string', description: 'concise factual summary of what exists, grounded in files actually read' },
    filesReviewed: { type: 'array', items: { type: 'string' } },
    sotaNotes: { type: 'string', description: 'frontier scan: relevant 2026 standards/techniques/competitor approaches with brief citations' },
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title','severity','evidence'],
      properties: { title:{type:'string'}, severity:{enum:['P0','P1','P2']}, evidence:{type:'string'} } } },
    inventions: { type: 'array', description: 'genuinely novel, buildable ideas that move this component to category-best',
      items: { type:'object', additionalProperties:false, required:['title','description','noveltyWhy','buildSketch','impact','effort'],
        properties:{ title:{type:'string'}, description:{type:'string'}, noveltyWhy:{type:'string'}, buildSketch:{type:'string'},
          impact:{enum:['high','med','low']}, effort:{enum:['S','M','L']} } } },
    improvements: { type: 'array', description: 'smaller surgical fixes to existing code/copy',
      items: { type:'object', additionalProperties:false, required:['title','description','files','impact','effort'],
        properties:{ title:{type:'string'}, description:{type:'string'}, files:{type:'string'}, impact:{enum:['high','med','low']}, effort:{enum:['S','M','L']} } } },
  },
}

const VERDICT_SCHEMA = {
  type:'object', additionalProperties:false, required:['component','verdicts'],
  properties:{
    component:{type:'string'},
    verdicts:{ type:'array', items:{ type:'object', additionalProperties:false,
      required:['title','type','isReal','buildable','onBrand','constraintSafe','recommendation','priorityScore','reason'],
      properties:{
        title:{type:'string'}, type:{enum:['invention','improvement','gap']},
        isReal:{type:'boolean', description:'grounded in real code/standards, not hallucinated'},
        buildable:{type:'boolean', description:'implementable with the existing stack without disproportionate effort'},
        onBrand:{type:'boolean'}, constraintSafe:{type:'boolean', description:'violates none of the hard constraints'},
        recommendation:{enum:['ship-now','plan','reject']},
        priorityScore:{type:'number', description:'0-100 expected value = impact x confidence / effort'},
        reason:{type:'string'} } } },
  },
}

const SYNTH_SCHEMA = {
  type:'object', additionalProperties:false, required:['executiveSummary','topInventions','shipNowWins','backlog','stackMaturity'],
  properties:{
    executiveSummary:{type:'string'},
    stackMaturity:{type:'array', items:{type:'object', additionalProperties:false, required:['component','score','headline'],
      properties:{component:{type:'string'}, score:{type:'number'}, headline:{type:'string'}}}},
    topInventions:{type:'array', description:'<=12 highest-value verified inventions worth building',
      items:{type:'object', additionalProperties:false, required:['title','component','why','effort','impact'],
        properties:{title:{type:'string'}, component:{type:'string'}, why:{type:'string'}, effort:{enum:['S','M','L']}, impact:{enum:['high','med','low']}}}},
    shipNowWins:{type:'array', description:'surgical, constraint-safe fixes implementable immediately this session',
      items:{type:'object', additionalProperties:false, required:['title','component','files','change'],
        properties:{title:{type:'string'}, component:{type:'string'}, files:{type:'string'}, change:{type:'string'}}}},
    backlog:{type:'array', description:'full ranked backlog of verified items',
      items:{type:'object', additionalProperties:false, required:['rank','title','component','type','priority','recommendation'],
        properties:{rank:{type:'number'}, title:{type:'string'}, component:{type:'string'}, type:{enum:['invention','improvement','gap']},
          priority:{enum:['P0','P1','P2']}, recommendation:{enum:['ship-now','plan','reject']}}}},
    memoMarkdown:{type:'string', description:'full human-readable innovation memo in markdown, ASCII-safe, no em/en dashes'},
  },
}

// ---- the atomic component map (disjoint ownership across the live stack) ----
const COMPONENTS = [
  { name:'audit-engine-core', focus:'the scan/audit engine that produces the readiness assessment: ingestion, orchestration, scoring, deltas, exports',
    files:'src/audit.js, src/audit-orchestrator.js, src/audit-ingest.js, src/audit-event.js, src/audit-delta.js, src/audit-export.js, src/audit-trail-analyzer.js, src/case-scorer.js, src/comparators.js, src/audit-routes.js' },
  { name:'agent-security-analysis', focus:'the actual security testing substance behind the report: permission posture, redaction, audit-trail integrity, injection testing, red-team',
    files:'src/active-redteam.js, src/adversarial-eval.js, src/adversarial-prompts.js, src/agent-identity-analyzer.js, src/agent-telemetry.js, src/agent-blueprint.js' },
  { name:'attestation-report', focus:'report envelope, tier/watermark, HTML+PDF rendering, evidence presentation, assurance case',
    files:'src/attestation-report-builder.js, src/assurance-case.js, src/assurance-case-pdf.js, src/auditor-attestation.js, public/report.html, public/report-viewer.html' },
  { name:'signing-crypto-moat', focus:'signature integrity, key lifecycle/rotation/revocation, Merkle transparency log (RFC6962), tamper-evidence, pubkey directory',
    files:'src/ensure-signing-key.js, src/cid.js, src/keys.js, src/key-revocation.js, src/merkle.js, src/transparency-log.js, src/transparency-anchor.js, src/transparency-log-routes.js, src/pubkey-directory.js, src/sigstore.js, src/jws-envelope.js, src/envelope.js' },
  { name:'verify-layer', focus:'offline verifiability, the public verify flow, /v1/audit/report/verify, the /v1/trust/:slug capability URL, verify.html',
    files:'public/verify.html, src/audit-routes.js (verify + trust endpoints), src/auth.js (PUBLIC_API)' },
  { name:'billing-monetization', focus:'the paid loop: $750 one-time + Continuous $299/$999, Stripe checkout, webhook idempotency, revenue-leak prevention, dunning, chargeback',
    files:'src/asr-billing.js, src/asr-fulfillment.js, src/billing-activation.js, src/billing-breakdown.js, src/billing-upgrade.js, src/stripe.js, src/dunning.js, src/chargeback.js, src/invoices.js' },
  { name:'auth-tenancy', focus:'auth model, session security, API key management, tenant isolation, public-route allowlist',
    files:'src/auth.js, src/account-ui-routes.js, src/sessions.js' },
  { name:'persistence-store-retention', focus:'durability + the data volume, store drivers, backup, retention GC, evidence/event stores, sqlite-on-volume correctness',
    files:'src/store.js, src/store-backup.js, src/audit-retention.js, src/evidence-store.js, src/event-store.js, src/artifact-lifecycle.js, src/store-drivers' },
  { name:'server-ops-security', focus:'prod hardening: CSP + security headers, rate limiting, env handling, observability (otel/sentry), readiness/health, boot reconcile, prod-readiness guard',
    files:'server.js, src/env.js, src/env-normalize.js, src/otel.js, src/sentry-init.js, src/cloudflare.js' },
  { name:'regulatory-compliance', focus:'framework mapping accuracy + freshness, the regulatory timeline, AI Act risk/export, control mapping, claims safety',
    files:'src/ai-act-export.js, src/ai-act-risk.js, src/control-mapper.js, src/framework-export.js, src/reg-risk-classify.js, src/compliance-export.js, public/regulatory-clock.html' },
  { name:'email-notifications', focus:'deliverability, lifecycle templates (report-ready, dunning), webhook reliability, no-reply hygiene',
    files:'src/email.js, src/webhooks.js, src/dunning.js' },
  { name:'website-ia-conversion', focus:'information architecture, the conversion funnel, hero/positioning, beachhead clarity, objection handling vs competitors',
    files:'public/index.html, public/pricing.html, public/how-it-works.html, public/compare.html, public/capabilities.html, public/solutions (enterprise/ai-vendors), public/contact.html' },
  { name:'visual-design-system', focus:'the kinst figure family + design language. KEEP the dark backdrop. Ensure every remaining inline graphic is genuinely intuitive and unicorn-tier',
    files:'public/kolm-2026.css, the kinst/kfig SVG figures across public/*.html (kpipe, kspec3d, kbars, kscatter, vloop, cap, kgate, kmatrix, cspec)' },
  { name:'dashboard-console', focus:'the authenticated buyer console: list reports, buy full report, copy trust link, manage subscription. Commercial readiness',
    files:'public/dashboard.html, public/account-billing.html, src/account-ui-routes.js' },
  { name:'trust-verify-public', focus:'public trust surfaces: shareable trust page, transparency log viewer, the verifiable artifact UX, badge',
    files:'public/trust.html, public/trust-center.html, public/transparency-log.html, public/report-viewer.html, public/badge.html' },
  { name:'docs-spec-dx', focus:'developer onboarding, API docs accuracy, the spec, integrations, SDK ergonomics',
    files:'public/docs.html, public/spec.html, public/integrations.html, public/runtimes.html, public/audit-docs.html, sdk/' },
  // ---- the MODEL PLATFORM (first-class product: make/train/distil any model, put it on any device) ----
  { name:'compile-engine', focus:'the model compilation pipeline: IR, targets, simulator, eval-gate, native compile, recipes, bundling. The "compile any model" capability and its correctness/determinism',
    files:'src/compile.js, src/compile-ir.js, src/compile-pipeline.js, src/compile-targets.js, src/compile-stream.js, src/compile-simulator.js, src/compile-eval-gate.js, src/native-compile.js, src/spec-compile.js, src/tsac-compiler.js, src/build-preview.js, src/build-strategy-brain.js, src/bundle-runner.js, src/binder.js, src/recipe-class.js, src/recipe-templates.js' },
  { name:'distillation-pipeline', focus:'distil any model: GRPO/on-policy/preference/progressive distillation, provenance, approval queue, efficiency, secure training, data curation',
    files:'src/distill-pipeline.js, src/cloud-distill.js, src/distill-strategy.js, src/distill-grpo.js, src/distill-onpolicy.js, src/distill-preference.js, src/progressive-distill.js, src/vlm-distill.js, src/distill-provenance.js, src/distill-approval-queue.js, src/distill-efficiency.js, src/secure-training.js, src/data-curate.js' },
  { name:'training-model-making', focus:'train any model: training pipeline + planner, meta-trainer, tokenizer training, active learning, constrained decode, fine-tune marketplace, accelerate',
    files:'src/pipeline-train.js, src/training-planner.js, src/kolm-meta-trainer.js, src/tokenizer-train.js, src/active-learning.js, src/active-learning-queue.js, src/constrained-decode.js, src/marketplace-finetune.js, src/tool-training-format.js, src/accelerate.js' },
  { name:'device-ondevice-runtime', focus:'put any model on any device: device detection/capabilities/install/registry/ssh/daemon, quantization oracle + bakeoff, runtime placement/policy/confidence/passport/perf, BYOC, compute broker, forge hardware',
    files:'src/devices.js, src/device-capabilities.js, src/device-caps.js, src/device-install.js, src/device-registry.js, src/device-ssh.js, src/device-daemon.js, src/runtime.js, src/runtime-placement.js, src/runtime-policy.js, src/runtime-confidence-router.js, src/runtime-passport.js, src/runtime-perf-estimate.js, src/runtime-sanitizer.js, src/quantization-oracle.js, src/quantize-bakeoff.js, src/byoc.js, src/cloud-compute-broker.js, src/forge-hardware.js, public/runtimes.html' },
  { name:'serving-inference-gateway', focus:'serve + route inference: serve config/autodetect/metrics, gateway (guardrail/receipt/router/mode), mcp gateway, confidence + semantic + ab routers, route-quality, inference bench',
    files:'src/serve-config.js, src/serve-autodetect.js, src/serve-metrics-sidecar.js, src/gateway-router.js, src/gateway-guardrail.js, src/gateway-receipt.js, src/gateway-mode.js, src/mcp-gateway.js, src/mcp-gateway-routes.js, src/confidence-router.js, src/semantic-router.js, src/ab-router.js, src/route-quality-store.js, src/inference-bench.js' },
  { name:'model-portability-providers', focus:'any model from anywhere: model registry/export/merge/cards/weights/entitlements, chat templates, tokenizer, multi-provider vault/registry/health, assistant client, model provenance',
    files:'src/models.js, src/model-registry.js, src/model-export.js, src/model-merge.js, src/model-card-emit.js, src/model-card-schema.js, src/model-weights-manifest.js, src/model-weights-puller.js, src/model-entitlements.js, src/model-provenance-analyzer.js, src/chat-templates.js, src/tokenizer.js, src/provider-registry.js, src/provider-vault.js, src/provider-health.js, src/assistant.js, src/assistant-client.js' },
  { name:'benchmarks-eval-bakeoff', focus:'prove model quality: kscore (calibration/per-language/timeseries), kolmbench, bench harness + suites, bakeoffs (adversarial/multimodal/quantize/redaction), eval-* (humaneval/mmlu/mtbench/numeric), bradley-terry, thompson bandit, holdouts',
    files:'src/kscore.js, src/kscore-calibration.js, src/kscore-bench.js, src/kolmbench.js, src/bench-harness.js, src/bench-eval-suites.js, src/bakeoff.js, src/adversarial-bakeoff.js, src/quantize-bakeoff.js, src/redaction-benchmark.js, src/eval-humaneval.js, src/eval-mmlu.js, src/eval-mtbench.js, src/bradley-terry.js, src/bandit-thompson.js, src/external-holdout.js, src/benchmark-evidence.js' },
  { name:'registry-marketplace', focus:'distribution + economy: concept registry + versioning, model/moe registries, marketplace (store/routes/payouts/ratings/finetune), plan catalog, teacher versioning, export-format registry',
    files:'src/registry.js, src/model-registry.js, src/moe-registry.js, src/marketplace.js, src/marketplace-store.js, src/marketplace-routes.js, src/marketplace-payouts.js, src/marketplace-ratings.js, src/marketplace-finetune.js, src/plan-catalog.js, src/teacher-version.js, src/export-format-registry.js' },
  { name:'sdks-cli-integrations', focus:'developer reach: the CLI, SDKs across 8 languages, framework integrations (langchain/llamaindex), browser/vscode extensions, package managers (apt/homebrew/winget), the compiler/platform product pages',
    files:'cli/kolm.js, cli/kolm-tui.mjs, sdk/ (node/python/rust/go/swift/c/mcp), packages/ (langchain-kolm, llamaindex-kolm, sdk-ts, sdk-python, vscode-kolm-rag, browser-extension, homebrew, apt, winget), public/compiler-product.html, public/platform.html, public/integrations.html' },
  { name:'codebase-health-cleanup', focus:'READ-ONLY triage across the whole src/ tree (528 modules): genuinely dead/orphaned code, duplication, modules not wired into any route, and RISK: forbidden-substring leakage into SHIPPED public/*.html surfaces, secret handling, dependency hygiene. Produce a concrete cleanup plan; do NOT propose deleting live capability',
    files:'src/ (whole tree, grep for orphans + cross-check against src/router.js wiring) plus scan public/*.html for the FORBIDDEN substrings list' },
]

phase('Research')
log(`Atomic research across ${COMPONENTS.length} live-stack components (waved to avoid burst rate limits)`)

// Run in sequential waves of WAVE_SIZE to smooth the token burst that trips
// server-side rate limits when ~16 heavy agents fire at once.
const WAVE_SIZE = 5
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out }
const results = []
for(const [wi, wave] of chunk(COMPONENTS, WAVE_SIZE).entries()){
  log(`Wave ${wi+1}/${Math.ceil(COMPONENTS.length/WAVE_SIZE)}: ${wave.map(c=>c.name).join(', ')}`)
  const waveRes = await pipeline(
  wave,
  (c) => agent(
    `${PRODUCT}\n\n${CONSTRAINTS}\n\nYou are a principal engineer and product researcher. COMPONENT: "${c.name}".\nFOCUS: ${c.focus}\nFILES TO READ FIRST (use Read/Grep/Glob; also follow imports to related files): ${c.files}\n\nDo this in order:\n1. READ the listed files and assess the CURRENT STATE and a maturity score 1-10 (10 = category-best, complete, SOTA). Ground every claim in code you actually read.\n2. SCAN THE STATE OF THE ART for this component's domain as of 2026 using WebSearch/WebFetch (relevant standards, techniques, competitor/peer approaches). Cite briefly in sotaNotes.\n3. Identify GAPS (P0 = blocks a credible launch / P1 = important / P2 = nice-to-have) with file-level evidence.\n4. Propose INVENTIONS: genuinely novel, buildable ideas that would make this component category-best for an agent-security-evidence product. Be concrete (build sketch = which files/approach).\n5. Propose surgical IMPROVEMENTS to existing code/copy.\nEvery proposal must respect the HARD CONSTRAINTS. Reject your own ideas that would violate them. Prefer depth over breadth: a few strong, real proposals beat many weak ones. Return the structured object.`,
    { label:`research:${c.name}`, phase:'Research', schema:FINDINGS_SCHEMA }
  ),
  (findings, c) => {
    if(!findings) return null
    const proposals = [
      ...(findings.inventions||[]).map(p=>({...p, type:'invention'})),
      ...(findings.improvements||[]).map(p=>({...p, type:'improvement'})),
      ...(findings.gaps||[]).map(g=>({title:g.title, description:g.evidence, type:'gap'})),
    ]
    return agent(
      `${PRODUCT}\n\n${CONSTRAINTS}\n\nYou are an adversarial principal reviewer. For COMPONENT "${c.name}", a researcher produced these proposals (inventions, improvements, gaps). Your job is to be skeptical and protect quality: catch hallucinated claims, ideas that are not actually buildable on this stack, off-brand suggestions, and anything that violates the HARD CONSTRAINTS or the locked pricing/scope. Verify against the real code where you can (read the files: ${c.files}).\n\nPROPOSALS (JSON):\n${JSON.stringify(proposals, null, 1)}\n\nFor EACH proposal return a verdict: isReal (grounded, not invented), buildable (with the existing stack, sane effort), onBrand, constraintSafe (violates none of the hard constraints), a recommendation (ship-now = surgical + safe + high value, can be done immediately; plan = worth building but larger; reject), a priorityScore 0-100, and a one-line reason. Default to reject/plan when uncertain rather than waving things through. Return the structured object.`,
      { label:`verify:${c.name}`, phase:'Verify', schema:VERDICT_SCHEMA }
    ).then(v => ({ component:c.name, maturityScore:findings.maturityScore, currentState:findings.currentState,
      sotaNotes:findings.sotaNotes, findings, verdicts: v?.verdicts||[] }))
  }
  )
  results.push(...waveRes.filter(Boolean))
}

const clean = results.filter(Boolean)
log(`Research+verify complete for ${clean.length}/${COMPONENTS.length} components`)

phase('Synthesize')
// build a compact corpus: each proposal joined with its verdict
const corpus = clean.map(r => ({
  component: r.component,
  maturity: r.maturityScore,
  currentState: r.currentState,
  sota: r.sotaNotes,
  verifiedProposals: r.verdicts,
}))

const synthesis = await agent(
  `${PRODUCT}\n\n${CONSTRAINTS}\n\nYou are the chief architect synthesizing an atomic, exhaustive research pass across the ENTIRE live product stack. Below is per-component data: maturity, current state, SOTA notes, and adversarially-verified proposals (each with isReal/buildable/onBrand/constraintSafe/recommendation/priorityScore).\n\nDATA (JSON):\n${JSON.stringify(corpus).slice(0, 320000)}\n\nProduce:\n1. executiveSummary: where the stack stands overall and the single biggest leverage moves.\n2. stackMaturity: per-component score + one-line headline.\n3. topInventions: <=12 highest-value VERIFIED inventions (isReal && buildable && onBrand && constraintSafe) worth building, deduped across components.\n4. shipNowWins: surgical, constraint-safe items recommended ship-now that could be implemented immediately this session (be specific about files + change).\n5. backlog: the full ranked backlog (drop rejected items; rank by priorityScore; assign P0/P1/P2).\n6. memoMarkdown: a complete human-readable innovation memo (ASCII-safe, NO em/en dashes, NO smart quotes) covering the above with reasoning. This is internal, not customer-facing.\nReturn the structured object.`,
  { label:'synthesize:stack', phase:'Synthesize', schema:SYNTH_SCHEMA }
)

return { components: clean.length, corpus, synthesis }
