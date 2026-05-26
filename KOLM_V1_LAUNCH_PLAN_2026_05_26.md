# KOLM v1.0 Launch Plan — atomic checklist
> Source of truth on disk so it survives context compacting. Last edit: 2026-05-26.
> Read ME FIRST on resume. Tracked task IDs at the bottom; one TaskCreate per block.

User directive (2026-05-26, verbatim):
> "do all of them everything atomically surgically exhaustively adn ddocument all of the research so it survives compacting and treat it as a to do list you finish in waves. do everything EXCEPT the about page, everything else for all products is MANDATORY AS THE DOC SAYS"
> "in as many waves with as many parallel local agents as necessary"
> "(NO ABOUT PAGE) WE DONT WANT ONE"

Standing constraints in force (do not violate):
- Never use the word "honesty" or "honest" — use Caveats / Constraints / Limitations.
- No git commit/push unless the user explicitly asks. Push frontend (public remote) BEFORE origin when authorized.
- Never stage `.env*`, `*.pem`, `*.key`, `secrets/`, `%TEMP%/tid.txt`. Prefer specific file paths over `git add -A`/`.`.
- Never `--no-verify`, never bypass signing.
- No browns/beiges/oranges anywhere in UI.
- Production target: live kolm.ai with real kolm key. Test in prod when done; compile benchmark.

---

## SCOPE — 35 blocks, ~215 tasks
Surfaces: Studio (distill+compile) · Wrapper (route+capture) · Run & Govern (deploy+evidence) · Cross-cutting.
X-1 (about page) is **EXCLUDED** by user directive.

---

## STUDIO (S-1 … S-10)

### S-1: GGUF export chain
- [ ] Clone llama.cpp, build `convert-hf-to-gguf.py` + `llama-quantize`
- [ ] Wire into ExportForge as GGUF backend
- [ ] Quant ladder: Q2_K / Q3_K_M / Q4_0 / Q4_K_S / Q4_K_M / Q5_K_M / Q6_K / Q8_0
- [ ] IQ quants: IQ2_S / IQ3_S / IQ4_XS / IQ4_NL (with imatrix from eval set)
- [ ] Embed chat template + tokenizer in GGUF metadata
- [ ] GGUF metadata fields: `general.name`, `general.quantized_by=kolm-forge`, `general.license`, `kolm.kscore`, `kolm.artifact_hash`, `llm.context_length`
- [ ] Split-file output for >50GB
- [ ] Post-export coherence test (100 tokens, llama-cpp-python)
- [ ] Quality delta vs FP16 baseline in runtime passport
- [ ] CLI: `kolm compile --target gguf-q4km` (+ siblings)
- [ ] Smoke S02 passes

### S-2: Ollama integration
- [ ] Modelfile generator from GGUF (`FROM`/`TEMPLATE`/`SYSTEM`/`PARAMETER`)
- [ ] `kolm export artifact.kolm --format ollama-modelfile`
- [ ] `kolm serve artifact.kolm --runtime ollama`
- [ ] `/docs/run/ollama` doc

### S-3: HuggingFace model card
- [ ] Auto-generate `README.md` from passport (name, base, method, teacher council, K-Score, hardware, examples for transformers/vLLM/llama.cpp/Ollama, `kolm verify`, license, citation)
- [ ] `kolm export artifact.kolm --format hf-model-card`

### S-4: Benchmark harness
- [ ] Multi-model eval on same set (`.kolm` / Ollama / API)
- [ ] K-Score axes scoring
- [ ] `kolm bench --models a.kolm,base,claude-haiku,gpt-4o-mini --eval holdout.jsonl`
- [ ] `kolm bench --compare v1.kolm v2.kolm`
- [ ] JSON + markdown comparison table

### S-5: Trinity publication
- [ ] Export Trinity-500 to Q4_K_M / Q5_K_M / Q8_0 / IQ4_XS
- [ ] Bench Trinity vs Qwen-7B-base vs Haiku vs gpt-4o-mini
- [ ] HF card + publish `kolm-ai/trinity-support-7b`
- [ ] kolm.ai/blog/trinity post
- [ ] r/LocalLLaMA draft

### S-6: Additional export formats
- [ ] EXL2 via exllamav2 + DAQ
- [ ] GPTQ via auto-gptq + Hessian calibration
- [ ] AWQ via autoawq
- [ ] FP8 (Hopper E4M3/E5M2)
- [ ] NVFP4 (Blackwell)
- [ ] HQQ (calibration-free)
- [ ] MLX via `mlx-lm convert`
- [ ] Post-quant eval per format with quality delta
- [ ] `kolm compile --target exl2-4.0bpw|gptq-4bit|awq-4bit|fp8|nvfp4|mlx-4bit`

### S-7: MoE model support
- [ ] Detect MoE from config.json (`num_experts`, `num_experts_per_tok`)
- [ ] MoE-aware LoRA targeting (shared layers + routing)
- [ ] MoE-aware quant (router higher precision)
- [ ] Expert activation profiling on eval set
- [ ] Expert pruning (<1% activations) with K-Score impact
- [ ] MoE memory estimation
- [ ] `kolm inspect model --json` reports `architecture: "moe"`, expert count, active params
- [ ] `kolm experts artifact.kolm` activation distribution

### S-8: Cloud compile (Modal)
- [ ] Modal integration: `kolm compile --cloud modal`
- [ ] Account UI "Compile on cloud"
- [ ] `CloudCompileProvider` interface (submit_job/check_status/download_artifact)
- [ ] kolm.ai/colab notebook
- [ ] `/docs/cloud/overview|modal|colab`

### S-9: Studio UI completion
- [ ] `/studio/namespaces` list with readiness bars
- [ ] `/studio/namespaces/:id` detail
- [ ] `/studio/namespaces/:id/compile` wizard
- [ ] `/studio/namespaces/:id/captures` browser
- [ ] `/studio/artifacts` inventory
- [ ] `/studio/artifacts/:id` passport viewer (overview/provenance/eval/runtime/receipts/deploy tabs)
- [ ] `/studio/artifacts/:id/compare`
- [ ] `/studio/merge` wizard (if merge built)
- [ ] `/studio/hardware` detection + memory fit

### S-10: Studio docs (15 pages)
- [ ] /docs/studio/overview · /compile · /namespaces · /captures · /artifacts
- [ ] /docs/forge/overview · /spec-toml
- [ ] /docs/compile/formats · /gguf
- [ ] /docs/k-score/overview · /axes · /calibration
- [ ] /docs/teacher-council
- [ ] /docs/progressive-distill
- [ ] /docs/active-learning

---

## WRAPPER (W-1 … W-7)

### W-1: Streaming SSE end-to-end
- [ ] SSE works through gateway
- [ ] Receipt generated after stream completes
- [ ] Capture written with assembled response
- [ ] PII redaction on assembled stream
- [ ] Test: curl `stream:true` returns SSE chunks AND receipt

### W-2: Tier rate limiting
- [ ] Enforce 50k free / 500k pro / 5M team / 25M business / custom enterprise
- [ ] 429 with retry-after on overage
- [ ] Headers: `X-RateLimit-Limit|Remaining|Reset`
- [ ] 10% grace buffer
- [ ] `kolm gateway status` shows quota
- [ ] Account UI usage bar
- [ ] Test: exceed free → 429 with clear error

### W-3: Cost tracking per provider per namespace
- [ ] Per-call cost in receipt (tokens × price)
- [ ] Per-provider aggregation
- [ ] Per-namespace aggregation
- [ ] Savings calc: frontier_cost - actual_cost
- [ ] `kolm receipts stats --namespace support` cost breakdown
- [ ] Account UI cost card on gateway dashboard
- [ ] Monthly cost report exportable

### W-4: Capture export — Parquet + HF
- [ ] Parquet via parquetjs (pure-JS, avoids Python dep)
- [ ] HF datasets format (arrow + dataset_info.json)
- [ ] `kolm captures export --format parquet|hf`
- [ ] Test: loads in pandas/datasets.load_from_disk

### W-5: Receipt CSV export
- [ ] CSV with all 19 fields as columns
- [ ] Filtered: date range, namespace, route type
- [ ] `kolm receipts export --format csv --last 30d`
- [ ] Test: opens cleanly in Excel/Sheets

### W-6: Wrapper tax optimization (profiling + decomposition)
- [ ] Decompose 423ms into: gateway routing / PII scan / signing / capture write / Vercel hop
- [ ] Identify largest contributor (Vercel hop ≈ 400ms)
- [ ] Railway direct path target < 10ms overhead
- [ ] Document Vercel-proxy tradeoff
- [ ] Update benchmark with decomposed numbers

### W-7: Provider adapter robustness
- [ ] Anthropic: Messages API content blocks
- [ ] Google: Gemini parts/candidates/safetyRatings
- [ ] All: 429 with exponential backoff
- [ ] All: configurable timeout
- [ ] All: graceful partial/malformed handling
- [ ] All: pass-through temperature/top_p/max_tokens/tools

---

## RUN & GOVERN (R-1 … R-11)

### R-1: Runtime passport
- [ ] Schema `{target_id, status, runtime, runtime_version, precision, memory_mb, latency_p50_ms, latency_p95_ms, tok_s, quality_delta, fallback}`
- [ ] `runtime_passports[]` in every `.kolm` manifest.json
- [ ] Populated during ExportForge per format
- [ ] `tested|estimated|unsupported` statuses
- [ ] `kolm inspect artifact.kolm --runtime-passport --json`
- [ ] Account UI target matrix

### R-2: Artifact lifecycle
- [ ] States: created → signed → deployed → monitored → superseded → revoked → archived
- [ ] State transitions recorded with `{timestamp, actor, reason, evidence_id}`
- [ ] CLI: `lifecycle`, `deploy`, `undeploy`, `rollback`, `revoke`
- [ ] Account UI lifecycle timeline + rollback button
- [ ] Superseded links to successor; revoked blocks new pulls

### R-3: kolm serve auto-detection
- [ ] Detect format + hardware → pick runtime
- [ ] GGUF+CUDA → llama.cpp w/ offload; GGUF+CPU → CPU; GGUF+Apple → Metal
- [ ] safetensors+CUDA → vLLM; safetensors+Apple → MLX; MLX+Apple → MLX
- [ ] Expose OpenAI-compatible `/v1/chat/completions`
- [ ] `/health` + `/metrics`
- [ ] Flags: `--port --host --runtime --context-length --gpu-layers`
- [ ] `--dry-run`, `--runtime ollama`, `--docker`, `--k8s`

### R-4: Deployment configs
- [ ] Docker Compose generator
- [ ] Kubernetes manifests (Deployment / Service / HPA / ConfigMap / PVC / Init)
- [ ] vLLM config generator
- [ ] Air-gap bundle (tar: artifact + runtime + verifier + sha256 manifest)

### R-5: Evidence DAG
- [ ] Node schema: `{id, kind, hash, created_at, owner}` (kinds: capture/eval/teacher/student/runtime/signature/policy/rights)
- [ ] Edge schema: `{from, to, relationship}` (derived_from/validated_by/invalidates/supersedes)
- [ ] Every artifact carries `evidence_dag`
- [ ] Revocation propagation marks dependents `needs_review`
- [ ] CLI: `kolm evidence trace`, `kolm evidence show`
- [ ] Account UI evidence graph drawer

### R-6: Assurance case export
- [ ] Schema: claims [{claim, status, evidence_ids, limitations}], controls [{framework, control_id, implementation_status, evidence_id}]
- [ ] Status taxonomy: implemented / package-gated / certification-gated / external-proof-needed
- [ ] CLI: `kolm assurance export --artifact|--workspace --format json|pdf`
- [ ] "Export trust packet" button on artifact + workspace settings

### R-7: Drift detection
- [ ] Embedding similarity / KL-divergence prod vs training
- [ ] Frontier fallback rate trend
- [ ] Threshold alerts
- [ ] CLI: `kolm drift status --namespace`
- [ ] Account UI drift indicator on namespace cards
- [ ] Recommend re-distill with capture priorities on alert

### R-8: Cost displacement reporting
- [ ] Per-namespace frontier baseline vs actual
- [ ] Monthly savings + cumulative
- [ ] Payback period (compile cost / monthly savings)
- [ ] CLI: `kolm savings --namespace --period`
- [ ] Account UI savings card on overview

### R-9: Run & Govern docs (15 pages)
- [ ] /docs/run/{overview,serve,vllm,llama-cpp,ollama,docker,kubernetes,airgap,hardware}
- [ ] /docs/govern/{lifecycle,drift,evidence,assurance,receipts,compliance}

### R-10: Run & Govern account UI
- [ ] Artifact detail (passport tabs, lifecycle timeline, runtime target matrix, deploy options, export trust packet)
- [ ] Namespace card (deployed indicator, drift status)
- [ ] Overview (cost displacement, artifact summary)
- [ ] Settings (signing key management)

### R-11: Run & Govern tests
- [ ] Smoke: serve+health, runtime passport present, lifecycle transitions, evidence DAG valid
- [ ] Integration: serve auto-detect, docker-compose valid, k8s dry-run, airgap offline, drift fires on shift, assurance has evidence, revoke propagates, savings calc matches

---

## CROSS-CUTTING (X-2 … X-7, X-1 EXCLUDED)

### X-2: Blog
- [ ] /blog list
- [ ] Post 1: "Introducing kolm: compile your AI workload into a model you own"
- [ ] Post 2: "How K-Score works: measuring distillation quality"
- [ ] Post 3: "Teacher Council: distilling from multiple teachers simultaneously"
- [ ] Post 4: "The .kolm format: a proof-carrying AI artifact"
- [ ] Post 5: "Trinity: a 7B that beats each of its three teachers"
- [ ] RSS feed
- [ ] Per post: reading time, date, author

### X-3: Changelog backfill
- [ ] /changelog page (rev-chrono)
- [ ] W707–W887 entries (grouped by surface/week)
- [ ] Per entry: date, title, description, tag (feature/improvement/fix)
- [ ] RSS

### X-4: Homepage fixes
- [ ] ROI calc pre-fills "Support copilot 1.2M/mo" preset
- [ ] Free tier card says 50k
- [ ] Trim pipeline 3→2 explanations

### X-5: Website claim verification
- [ ] Every number traces to test/benchmark (full list in plan)
- [ ] Remove or verify any unverifiable claim

### X-6: SEO basics
- [ ] GSC verified
- [ ] sitemap.xml + robots.txt
- [ ] PNG og:image on every page
- [ ] Unique meta-description per page
- [ ] JSON-LD: Organization, SoftwareApplication

### X-7: Security hardening
- [ ] HTTPS + HSTS
- [ ] CSP headers
- [ ] Rate limiting on public API
- [ ] Input validation
- [ ] No secrets client-side
- [ ] CORS not wildcard in prod
- [ ] API key scoping read-only/read-write
- [ ] `npm audit` zero critical

---

## WAVE EXECUTION PLAN

| Wave | Blocks (parallel agents) | Why first |
|------|--------------------------|-----------|
| **W1** | W-1, W-2, W-3, W-4, W-5, W-7, R-1, R-2 | User's 7-item gap list + Run&Govern foundations |
| **W2** | R-3, R-4, R-5, R-6, R-7, R-8, S-1, S-2 | Run runtime + studio compile chain |
| **W3** | S-3, S-4, S-6, S-7, S-9, R-10, R-11, W-6 | Studio surface + tests + wrapper profiling |
| **W4** | S-5, S-8, S-10, R-9, X-2, X-3, X-4, X-5, X-6, X-7 | Docs + content + claim audit + security |

Each wave: many parallel `Agent` calls in a single message. After wave completes, integrate, run release-verify, then launch next wave. NO commits without explicit user authorization.

---

## TASKS (Tracked)
| ID | Block | Status |
|----|-------|--------|
| Studio S-1 GGUF | _pending_ | created |
| ... | one per block | one per block |

See TaskList.
