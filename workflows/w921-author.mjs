export const meta = {
  name: 'w921-author',
  description: 'W921 Phase-1: author the top-leverage NEW isolated modules + their tests (no big-file edits); report the router/cli wiring for the sequential lane',
  phases: [{ title: 'Author modules' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const COMMON = `REPO: ${REPO} (run commands from there).
You author a NEW module to its verified W921 spec. FIND your spec: read audit/w921/specs-index.json, locate the entry whose files_to_touch includes your primary file, open that audit/w921/specs/*.spec.json and also skim KOLM_W921_RESEARCH.md for context.
RULES:
- Implement the spec's named frontier_functions with the proposed signatures. Real, production-grade logic — not stubs. Reuse existing utilities (read the modules you import: src/embedding.js, src/cost-estimator.js, src/lake.js, src/provider-registry.js, src/event-store.js, etc. — match their export style: this repo uses ESM 'export function').
- Create ONLY your listed files (the new module(s) + a focused new test tests/wave921-<slug>.test.js using node:test). Do NOT edit src/router.js or cli/kolm.js or any other existing file — instead RETURN the exact wiring needed (file, where, what call) in wiring_needed.
- Zero new runtime npm deps unless the spec says so and it's already in package.json; prefer dependency-free (the repo norm).
- VERIFY: run \`node --check <yourModule>\` and \`node --test tests/wave921-<slug>.test.js\` from ${REPO}; iterate until your test is 0-fail. Do NOT run the full suite. Report the final fail count honestly.`

const SCHEMA = {
  type: 'object', required: ['module', 'files_created', 'test_result', 'wiring_needed', 'summary'],
  properties: {
    module: { type: 'string' },
    files_created: { type: 'array', items: { type: 'string' } },
    test_result: { type: 'string' },
    wiring_needed: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, where: { type: 'string' }, change: { type: 'string' } } } },
    new_deps: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const MODULES = [
  { label: 'semantic-router', primary: 'src/semantic-router.js', slug: 'semantic-router',
    hint: 'Gateway cost/latency/quality semantic router (Avengers-Pro cluster/KNN over kolm captured outcomes). Implement scoreRoute(...) + a ClusterRouterStats class + trainClustersFromLake(...). Reuse src/embedding.js (embed/cosine/topK) + src/cost-estimator.js + src/lake.js. Pure-JS, training-free, cold-start guard reverts to static. No router edits.' },
  { label: 'gateway-guardrail', primary: 'src/gateway-guardrail.js', slug: 'gateway-guardrail',
    hint: 'Inline prompt-injection/jailbreak detector (OWASP LLM01). Author src/gateway-guardrail.js (detectInjection(text)->{verdict,score,matched_rules,categories}) + src/adversarial-prompts.js (curated rule/pattern + heuristic set). Dependency-free heuristic+regex classifier with calibrated score. No router edits.' },
  { label: 'provider-health', primary: 'src/provider-health.js', slug: 'provider-health',
    hint: 'Health-aware adaptive failover: per-provider circuit breaker (Resilience4j 3-state CLOSED/OPEN/HALF_OPEN) + exponential ejection + fail-open panic invariant. Author src/provider-health.js (CircuitBreaker class, recordSuccess/recordFailure, shouldAllow(provider), snapshot). Pure-JS, time injected for testability. No router edits.' },
  { label: 'semantic-cache', primary: 'src/semantic-cache.js', slug: 'semantic-cache',
    hint: 'Embedding-similarity prompt cache: lookup(prompt,threshold)->{hit,entry,similarity}; put(prompt,response,meta). Reuse src/embedding.js cosine. LRU + cosine>threshold. Pure-JS. No router edits.' },
  { label: 'ner-pii', primary: 'src/ner-recognizer.js', slug: 'ner-pii',
    hint: 'ML/NER-style PII recognition behind the regex unifier: src/ner-recognizer.js (recognize(text)->spans[]) + src/span-merge.js (mergeSpans overlapping/adjacent, confidence-max). Dependency-free gazetteer+context-rule recognizer (onnxruntime optional/lazy, not required). No router edits — pii-redactor wiring goes in wiring_needed.' },
  { label: 'otel-genai', primary: 'src/otel.js', slug: 'otel-genai',
    hint: 'OpenTelemetry GenAI semantic-conventions emitter: src/otel.js building gen_ai.* spans/metrics (gen_ai.system, gen_ai.request.model, gen_ai.usage.input_tokens, etc.) with a no-op exporter when OTEL not configured. Dependency-free shape (no SDK dep); buildGenAiSpan(...)/recordGenAiMetrics(...). No router edits.' },
  { label: 'autopilot-stats', primary: 'src/stat-sig.js', slug: 'autopilot-stats',
    hint: 'Sequential always-valid A/B + calibrated intervals for the autopilot deploy guardrail. Author src/stat-sig.js (mSPRT / GAVI always-valid test: update(a,b)->{decision,e_value,ci}) and src/conformal.js (split-conformal predictInterval(residuals, alpha)). Pure-JS, deterministic. No edits to quality-predictor/kolm-meta-trainer — report those in wiring_needed.' },
  { label: 'gbm-regressor', primary: 'src/gbm-regressor.js', slug: 'gbm-regressor',
    hint: 'Real gradient-boosted regression-tree meta-model to replace the depth-1 stump in kolm-meta-trainer: src/gbm-regressor.js (fit(X,y,opts)->model; predict(model,x); serialize/deserialize). Pure-JS, depth-configurable regression trees + shrinkage. No edits to kolm-meta-trainer — report wiring.' },
  { label: 'govern-crypto', primary: 'src/merkle.js', slug: 'govern-crypto',
    hint: 'Receipt anchoring primitives: src/merkle.js (buildTree(leaves), root, proof, verifyProof — RFC6962-style) + src/intoto-slsa.js (build an in-toto/SLSA provenance statement for a .kolm artifact). Use node:crypto. No router edits — Sigstore/Rekor anchoring + receipt wiring go in wiring_needed.' },
  { label: 'data-curate-modules', primary: 'src/minhash-dedup.js', slug: 'data-curate-modules',
    hint: 'Data-engine curation primitives: src/minhash-dedup.js (MinHash + LSH near-dup clustering, pure-JS) + src/data-select.js (DSIR/DEITA-style distribution-matched selection: selectInformativeSubset(items, target_n, opts)). No edits to data-curate.js — report wiring.' },
]

const results = await parallel(MODULES.map((m) => () =>
  agent(`Author the NEW kolm module **${m.primary}** (W921 Phase-1).
${m.hint}
slug for the test file: tests/wave921-${m.slug}.test.js

${COMMON}`, { schema: SCHEMA, label: m.label, phase: 'Author modules' })))

const ok = results.filter(Boolean)
return {
  modules: ok.length,
  files_created: ok.flatMap(r => r.files_created || []),
  all_tests: ok.map(r => `${r.module}: ${r.test_result}`),
  wiring_needed: ok.flatMap(r => (r.wiring_needed || []).map(w => ({ module: r.module, ...w }))),
  new_deps: ok.flatMap(r => r.new_deps || []),
}
