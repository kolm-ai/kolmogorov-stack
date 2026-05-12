# Source Register

Research pass: 2026-05-12

This register records primary sources used in the first knowledge-base pass. Source pages can change; refresh monthly or before fundraising, launch, enterprise sales, or public claims.

## Kolm Sources

| Ref | URL / File | Type | Used For |
| --- | --- | --- | --- |
| kolm-live-home | https://kolm.ai/ | Live site | Public positioning and artifact claims. |
| kolm-live-pricing | https://kolm.ai/pricing | Live site | Pricing, stale brand/package, savings, enterprise claims. |
| kolm-live-docs | https://kolm.ai/docs | Live site | API documentation, endpoint count, SDK package names. |
| kolm-live-device | https://kolm.ai/device | Live site | On-device recipe-registry demo and offline PWA claims. |
| README.md | `README.md` | Repo file | Current status, caveats, architecture, API surface, product gates. |
| STRATEGY.md | `STRATEGY.md` | Repo file | Spec-layer thesis and roadmap framing. |
| SOTA | `docs/SOTA-2026-05-11.md` | Repo file | Current product/strategy map and 90-day plan. |
| infra-report | `docs/kolm-infra-business-strategy-report-2026-05-06.md` | Repo file | Prior infrastructure, business, GTM, and competitor critique. |
| artifact-code | `src/artifact.js` | Repo file | Artifact internals, K-score, receipt implementation, pointer model. |
| compile-code | `src/compile.js` | Repo file | Current compile pipeline and roadmap caveats. |
| store-code | `src/store.js` | Repo file | JSON/SQLite storage implementation. |
| verifier-code | `src/verifier.js` | Repo file | Recipe sandbox and verifier implementation. |
| router-code | `src/router.js` | Repo file | API routes, receipts, specialists, product endpoints. |

## Gateways And Routers

| Ref | URL | Used For |
| --- | --- | --- |
| portkey-docs | https://portkey.ai/docs/product/ai-gateway | Portkey gateway capabilities. |
| portkey-series-a | https://portkey.ai/blog/series-a-funding | Market traction and positioning context. |
| litellm-docs | https://docs.litellm.ai/docs/ | LiteLLM proxy/router, keys, budgets, fallback context. |
| cloudflare-ai-gateway-docs | https://developers.cloudflare.com/ai-gateway/features/ | Cloudflare AI Gateway capabilities. |
| vercel-ai-gateway-docs | https://vercel.com/docs/ai-gateway/capabilities | Vercel AI Gateway capabilities. |
| openrouter-docs | https://openrouter.ai/docs/model-routing | OpenRouter model routing and fallback context. |

## Observability, Evals, And Prompt Ops

| Ref | URL | Used For |
| --- | --- | --- |
| langsmith-docs | https://docs.langchain.com/langsmith/ | LangSmith observability, evals, prompts, datasets. |
| langgraph-durable | https://docs.langchain.com/oss/python/langgraph/durable-execution | LangGraph durable execution context. |
| langfuse-docs | https://langfuse.com/docs | Langfuse observability, prompt management, evals. |
| braintrust-docs | https://www.braintrust.dev/docs/evaluate | Braintrust evals and experiments. |
| braintrust-series-a | https://www.braintrust.dev/blog/announcing-series-a | Market traction and positioning context. |
| helicone-docs | https://docs.helicone.ai/ | Helicone observability/gateway source. |
| promptlayer-docs | https://docs.promptlayer.com/ | Prompt management, registry, logs, evals. |
| humanloop-docs | https://humanloop.com/docs | Prompt/eval workflow context. |
| vellum-docs | https://docs.vellum.ai/ | Workflow/prompt/eval platform context. |
| phoenix-docs | https://arize.com/docs/phoenix | Arize Phoenix observability/eval context. |
| weave-docs | https://weave-docs.wandb.ai/ | W&B Weave tracing/eval context. |

## Fine-Tuning And Model Customization

| Ref | URL | Used For |
| --- | --- | --- |
| predibase-docs | https://docs.predibase.com/ | Predibase fine-tuning and deployment context. |
| predibase-platform | https://predibase.com/platform | Product positioning for fine-tuning and inference. |
| openpipe-docs | https://docs.openpipe.ai/ | OpenPipe fine-tuning/eval workflow context. |
| together-finetune-docs | https://docs.together.ai/docs/fine-tuning-overview | Together fine-tuning context. |
| openai-finetune-docs | https://platform.openai.com/docs/guides/fine-tuning | OpenAI fine-tuning context. |
| hf-autotrain-docs | https://huggingface.co/docs/autotrain/index | Hugging Face AutoTrain context. |

## RAG, Memory, Agents, And Optimization

| Ref | URL | Used For |
| --- | --- | --- |
| llamaindex-docs | https://docs.llamaindex.ai/ | RAG/agent/data framework context. |
| dspy-docs | https://dspy.ai/ | LM program optimization context. |
| mem0-docs | https://docs.mem0.ai/ | AI memory platform context. |
| zep-docs | https://help.getzep.com/ | Agent memory context. |
| letta-docs | https://docs.letta.com/ | Stateful agent/memory context. |
| haystack-docs | https://docs.haystack.deepset.ai/ | RAG/orchestration context. |

## Local And On-Device Runtime Substrate

| Ref | URL | Used For |
| --- | --- | --- |
| apple-foundation-models | https://developer.apple.com/documentation/FoundationModels | Apple on-device foundation model framework. |
| coreml-docs | https://developer.apple.com/documentation/CoreML | Apple model runtime target. |
| litert-docs | https://ai.google.dev/edge/litert/overview | Google on-device runtime target. |
| onnx-runtime-mobile | https://onnxruntime.ai/docs/tutorials/mobile/ | ONNX Runtime Mobile target. |
| executorch-docs | https://docs.pytorch.org/executorch/stable/intro-overview.html | PyTorch edge runtime target. |
| executorch-site | https://executorch.ai/ | ExecuTorch product context. |
| ollama-docs | https://github.com/ollama/ollama | Local LLM runtime context. |
| llama-cpp | https://github.com/ggml-org/llama.cpp | Local LLM runtime context. |
| mlc-llm-docs | https://llm.mlc.ai/docs/ | MLC local/runtime context. |

## Standards, Protocols, And Regulation

| Ref | URL | Used For |
| --- | --- | --- |
| mcp-docs | https://modelcontextprotocol.io/docs/getting-started/intro | MCP context/tool protocol scope. |
| anthropic-mcp-launch | https://www.anthropic.com/news/model-context-protocol | MCP ecosystem context. |
| openai-structured-outputs | https://platform.openai.com/docs/guides/structured-outputs | Provider-native schema-constrained output context. |
| openai-agents-tracing | https://openai.github.io/openai-agents-python/tracing/ | Agents tracing context. |
| sigstore-docs | https://docs.sigstore.dev/ | Signing/transparency-log analog. |
| rekor-docs | https://docs.sigstore.dev/rekor/overview/ | Transparency log context. |
| eu-ai-act-commission | https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai | EU AI Act official policy context. |
| eu-ai-act-service-desk | https://ai-act-service-desk.ec.europa.eu/en/faq | EU AI Act FAQ context. |

## Market And Macro Sources To Refresh

| Ref | URL | Used For |
| --- | --- | --- |
| gartner-ai-spending-2026 | https://www.gartner.com/en/newsroom/press-releases/2026-1-15-gartner-says-worldwide-ai-spending-will-total-2-point-5-trillion-dollars-in-2026 | AI spending context from prior report. |
| idc-ai-infra | https://www.idc.com/resource-center/blog/ai-infrastructure-spending-caps-historic-year-at-90-billion-in-q4-2025-2029-spending-to-eclipse-1-trillion/ | AI infrastructure spending context from prior report. |
| grandview-edge-ai | https://www.grandviewresearch.com/industry-analysis/edge-ai-software-market-report | Edge AI market sizing context. |
| qualcomm-edge-impulse | https://www.qualcomm.com/news/releases/2025/03/qualcomm-to-bolster-ai-and-iot-capabilities-with-edge-impulse-ac | Edge AI consolidation context. |

## Competitor Evidence Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| portkey-gateway-current | https://portkey.ai/docs/product/ai-gateway | Gateway routing, caching, fallbacks, observability, guardrails, and usage controls. |
| litellm-proxy-current | https://docs.litellm.ai/docs/ | OpenAI-compatible proxy, provider abstraction, virtual keys, budgets, rate limits, and spend controls. |
| cloudflare-ai-gateway-current | https://developers.cloudflare.com/ai-gateway/features/ | AI Gateway analytics, logging, caching, rate limiting, retry, fallback, and provider controls. |
| vercel-ai-gateway-current | https://vercel.com/docs/ai-gateway | Unified provider access, Vercel AI SDK integration, observability, usage, and budgets. |
| openrouter-routing-current | https://openrouter.ai/docs/model-routing | Model routing and fallback behavior. |
| helicone-platform-current | https://docs.helicone.ai/ | AI Gateway, observability, caching, rate limits, prompt management, and security. |
| langsmith-observability-current | https://docs.langchain.com/langsmith/observability | Tracing, monitoring, datasets, evals, and prompt workflows. |
| langfuse-overview-current | https://langfuse.com/docs | Open-source LLM observability, prompts, evals, datasets, metrics, and integrations. |
| braintrust-evaluate-current | https://www.braintrust.dev/docs/evaluate | Datasets, experiments, scoring, and evaluation loops. |
| braintrust-observe-current | https://www.braintrust.dev/docs/guides/observability | Production tracing, logs, monitoring, and feedback workflow. |
| promptlayer-platform-current | https://docs.promptlayer.com/ | Prompt registry, logs, evals, datasets, monitoring, and prompt-management workflows. |
| llamaindex-current | https://docs.llamaindex.ai/ | RAG, agents, workflows, data connectors, indexes, and evaluation tooling. |
| dspy-current | https://dspy.ai/ | LM programming and optimization framework context. |
| mem0-current | https://docs.mem0.ai/ | AI memory API and long-term memory product context. |
| zep-current | https://help.getzep.com/ | Agent memory and temporal knowledge graph context. |
| letta-current | https://docs.letta.com/ | Stateful agent and memory framework context. |
| predibase-finetune-current | https://docs.predibase.com/ | Fine-tuning, adapters, serving, and deployment context. |
| openpipe-current | https://docs.openpipe.ai/ | Trace collection, fine-tuning, evaluation, and deployment context. |
| together-finetune-current | https://docs.together.ai/docs/fine-tuning-overview | Supervised fine-tuning workflow context. |
| hf-autotrain-current | https://huggingface.co/docs/autotrain/index | Automated model training and fine-tuning workflow context. |
| apple-foundation-models-current | https://developer.apple.com/documentation/FoundationModels | Apple on-device foundation model framework. |
| litert-current | https://ai.google.dev/edge/litert/overview | Google AI Edge LiteRT on-device runtime context. |
| executorch-current | https://docs.pytorch.org/executorch/stable/intro-overview.html | PyTorch edge/on-device runtime context. |
| mcp-current | https://modelcontextprotocol.io/docs/getting-started/intro | MCP tool, resource, prompt, and client/server protocol scope. |
| openai-structured-outputs-current | https://platform.openai.com/docs/guides/structured-outputs | JSON Schema constrained output behavior and strict mode. |
| sigstore-rekor-current | https://docs.sigstore.dev/rekor/overview/ | Public transparency log context for verifiable receipts. |
| eu-gpai-code-current | https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai | EU GPAI code-of-practice and documentation context. |

## Pricing Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| portkey-pricing-current | https://portkey.ai/pricing | Gateway pricing, log limits, overages, and open-source/self-host option. |
| litellm-enterprise-current | https://www.litellm.ai/enterprise | LiteLLM enterprise packaging and contact-sales features. |
| cloudflare-ai-gateway-pricing-current | https://developers.cloudflare.com/ai-gateway/reference/pricing/ | Cloudflare AI Gateway free core features, log limits, DLP, guardrails, and Logpush pricing. |
| vercel-ai-gateway-pricing-current | https://vercel.com/docs/ai-gateway/pricing | Vercel AI Gateway pay-as-you-go, free credits, no-markup, and BYOK pricing posture. |
| openrouter-pricing-current | https://openrouter.ai/pricing | OpenRouter free/pay-as-you-go/enterprise pricing, platform fee, BYOK limits, and support tiers. |
| openrouter-byok-current | https://openrouter.ai/docs/use-cases/byok/ | BYOK fee and free request allowance details. |
| openrouter-home-current | https://openrouter.ai/ | Marketplace scale and model/provider positioning. |
| openrouter-providers-current | https://openrouter.ai/providers | Provider catalog, BYOK, no-training, and regional attributes. |
| helicone-pricing-current | https://www.helicone.ai/pricing | Helicone free/Pro/Team/Enterprise pricing and request/storage anchors. |
| helicone-gateway-current | https://docs.helicone.ai/gateway/overview | Helicone gateway beta and no-markup positioning. |
| langfuse-pricing-current | https://langfuse.com/pricing | Langfuse cloud plans, unit pricing, retention, security, and enterprise features. |
| langfuse-selfhost-pricing-current | https://langfuse.com/pricing-self-host | Langfuse self-hosted open-source and enterprise packaging. |
| braintrust-plans-current | https://www.braintrust.dev/docs/plans-and-limits | Braintrust Starter/Pro/Enterprise plan structure. |
| promptlayer-pricing-current | https://docs.promptlayer.com/why-promptlayer/how-it-works | PromptLayer free and Pro pricing shape. |
| predibase-pricing-current | https://predibase.com/pricing | Predibase free tier, private/shared inference pricing, VPC, and fine-tuning rates. |
| together-pricing-current | https://www.together.ai/pricing | Together inference, GPU, sandbox, storage, and fine-tuning rates. |
| together-finetune-pricing-current | https://docs.together.ai/docs/fine-tuning-pricing | Together fine-tuning pricing mechanics. |

## Sandbox And Security Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| node-vm-docs-current | https://nodejs.org/api/vm.html | Official `node:vm` security warning and API context. |
| src-verifier-current | ../src/verifier.js | Current Kolm JS recipe execution implementation. |
| isolated-vm-current | https://www.npmjs.com/package/isolated-vm | isolated-vm project status and V8 isolate model. |
| isolated-vm-security-current | https://www.npmjs.com/package/isolated-vm/v/4.4.2 | isolated-vm security caveats around host reference leakage and hostile code. |
| ses-current | https://docs.endojs.org/modules/ses.html | SES compartments, frozen intrinsics, and principle-of-least-authority model. |
| wasmtime-security-current | https://docs.wasmtime.dev/security.html | Wasmtime sandbox and defense-in-depth model. |
| wasmtime-api-current | https://docs.wasmtime.dev/lang.html | Wasmtime embedding API support. |
| webassembly-security-current | https://webassembly.org/docs/security/ | WebAssembly sandbox security model. |
| deno-security-current | https://docs.deno.com/runtime/fundamentals/security/ | Deno permission model and untrusted-code cautions. |
| deno-permissions-current | https://docs.deno.com/api/deno/permissions | Deno permission descriptors. |
| deno-sandbox-current | https://docs.deno.com/runtime/reference/cli/sandbox/ | Deno Sandbox CLI and microVM use. |
| deno-sandbox-security-current | https://docs.deno.com/sandbox/security | Deno Sandbox secret, outbound network, and isolation model. |
| gvisor-current | https://gvisor.dev/ | gVisor container sandbox positioning and defense-in-depth. |
| firecracker-seccomp-current | https://github.com/firecracker-microvm/firecracker/blob/main/docs/seccomp.md | Firecracker seccomp and microVM hardening context. |

## Auth And Tenant Data Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| src-auth-current | ../src/auth.js | API key, anon claim, admin fallback, public API allowlist, and credential precedence review. |
| src-oauth-current | ../src/oauth.js | OAuth state, safe return, session cookie, and existing-tenant key rotation review. |
| src-router-current | ../src/router.js | Route boundary, public/protected status, account lifecycle, recall source, capture, telemetry, and data lifecycle review. |
| src-registry-current | ../src/registry.js | Concept read/write/delete tenant scoping review. |
| src-runtime-current | ../src/runtime.js | Runtime authorization, invocation logging, and cache usage review. |
| src-compile-current | ../src/compile.js | Compile job tenant ownership and artifact status review. |
| src-store-current | ../src/store.js | JSON/SQLite storage facade and app-enforced tenant isolation review. |
| src-cache-current | ../src/cache.js | Runtime L1/L2 cache key, storage root, and retention review. |
| src-recall-current | ../src/recall.js | Recall namespace sanitization and tenant prefixing review. |
| tests-auth-current | ../tests/auth.test.js | Existing admin/readiness auth coverage review. |
| tests-e2e-current | ../tests/e2e.test.js | Existing HTTP e2e auth and route coverage review. |
| src-stripe-current | ../src/stripe.js | Stripe signature, amount-to-plan mapping, and checkout URL helper review. |
| tests-stripe-current | ../tests/stripe.test.js | Stripe helper unit coverage and test gap review. |
| public-api-current | ../public/api.html | Billing, quota, account, and response-shape docs drift review. |
| public-account-current | ../public/account.html | Cancel/delete account UI semantics review. |
| public-pricing-current-local | ../public/pricing.html | Plan-feature and entitlement-copy review. |
| cli-kolm-current | ../cli/kolm.js | Canonical root CLI command and flag review. |
| package-root-current | ../package.json | Root package metadata, private flag, and bin review. |
| public-sdk-current | ../public/sdk.js | Browser SDK syntax and runtime contract review. |
| sdk-node-current | ../sdk/node/index.mjs | Node SDK API contract and public helper review. |
| sdk-node-package-current | ../sdk/node/package.json | Node SDK package metadata review. |
| sdk-node-tests-current | ../sdk/node/test/sdk.test.mjs | Node SDK test harness review. |
| sdk-python-current | ../sdk/python | Python SDK package, client, CLI, and docs review. |
| sdk-mcp-current | ../sdk/mcp/server.mjs | MCP server tool contract and package dependency review. |
| public-quickstart-current | ../public/quickstart.html | CLI quickstart install and command review. |
| public-docs-current | ../public/docs.html | Public docs package names, versions, and CLI examples review. |

## CI Test Deploy Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| workflow-lint-current | ../.github/workflows/lint.yml | Lint/static/audit CI coverage and missing root test gate review. |
| workflow-smoke-current | ../.github/workflows/smoke.yml | Local server smoke workflow coverage and missing root test gate review. |
| workflow-compile-current | ../.github/workflows/kolm-compile-on-push.yml | Artifact compile automation trigger and dependency on reusable action. |
| action-kolm-compile-current | ../.github/actions/kolm-compile/action.yml | Reusable GitHub compile action flag/output contract review. |
| scripts-smoke-live-current | ../scripts/smoke-live.sh | Live/local smoke coverage, default target, and browser SDK check review. |
| tests-site-current | ../tests/site.test.js | Stale positioning, clean encoding, static route, and source hygiene test review. |
| vercel-config-current | ../vercel.json | Static/API proxy, CSP, function, and route rewrite review. |
| railway-config-current | ../railway.toml | Railway start command and healthcheck review. |
| docker-config-current | ../Dockerfile | Container Node version and production entrypoint review. |
| api-index-current | ../api/index.js | Vercel serverless adapter and managed-store deployment note review. |

## Compliance Security Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| public-security-current | ../public/security.html | Security posture, supply-chain, disclosure, PGP, and compliance claim review. |
| public-privacy-current | ../public/privacy.html | Privacy retention, account rights, hosted-service, and data-category claim review. |
| public-terms-current | ../public/terms.html | Terms data ownership, retention, artifact, billing, and acceptable-use claim review. |
| public-baa-current | ../public/baa.html | BAA/DPA, subprocessor, termination, HIPAA, and GDPR processor claim review. |
| public-healthcare-current | ../public/healthcare.html | PHI, healthcare deployment, reference artifact, and BAA-boundary claim review. |
| public-enterprise-current | ../public/enterprise.html | Procurement, compliance binder, design partner, and contract artifact claim review. |
| public-legal-current | ../public/legal.html | Legal runtime, privilege, compile-time data flow, and receipt claim review. |
| public-audit-log-current | ../public/audit-log.html | Durable audit log, opt-in, raw-text retention, purge, and export claim review. |
| well-known-security-current | ../public/.well-known/security.txt | RFC 9116 disclosure contact file review. |
| well-known-pgp-current | ../public/.well-known/pgp-key.txt | PGP disclosure key material review. |
| hhs-hipaa-business-associates-current | https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html | HIPAA business associate assurance and safeguard context. |
| eurlex-gdpr-art28-current | https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng | GDPR Article 28 processor obligations context. |
| ftc-health-breach-rule-current | https://www.ftc.gov/business-guidance/resources/health-breach-notification-rule-basics-business | Non-HIPAA health breach notification context. |
| rfc9116-current | https://www.rfc-editor.org/rfc/rfc9116 | security.txt format and well-known vulnerability disclosure context. |

## API Docs Contract Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| public-api-reference-current | ../public/api.html | Hand-authored API reference coverage and request/response schema review. |
| public-docs-reference-current | ../public/docs.html | Quickstart, live-output, install, API example, and receipt docs review. |
| public-quickstart-current | ../public/quickstart.html | CLI quickstart command and compile/run examples review. |
| readme-api-inventory-current | ../README.md | Repo-level API surface inventory and install/API docs review. |
| docs-authoring-current | ../docs/AUTHORING.md | CLI authoring command examples and artifact flow review. |
| src-router-contract-current | ../src/router.js | Route declaration, request/response, auth, and error contract source review. |
| src-compile-contract-current | ../src/compile.js | Compile job id/status/schema source review. |
| tests-site-contract-current | ../tests/site.test.js | Existing static docs/link/encoding test coverage review. |

## Benchmark Reproducibility Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| public-benchmarks-current | ../public/benchmarks.html | Artifact benchmark claims, fixture table, sample report, egress wording, and K-score framing review. |
| public-k-score-current | ../public/k-score.html | 0..1 K-score gate, no-eval/no-ship, gate override, and example output review. |
| public-how-we-benchmark-current | ../public/articles/how-we-benchmark.html | SWE-bench/Opus reproducer claim, statistical method, cost, and methodology review. |
| docs-benchmark-results-current | ../docs/benchmark-results-v0.1.0.md | Reference sample report, reproducibility notes, and byte-stability caveat review. |
| docs-product-current | ../docs/PRODUCT.md | Product-level byte-reproducible and zero-egress benchmark claim review. |
| src-benchmark-current | ../src/benchmark.js | Artifact benchmark implementation, report schema, egress monitor, and K-score source review. |
| src-artifact-current | ../src/artifact.js | K-score implementation, artifact packaging, receipt timestamps, and gate enforcement review. |
| src-compile-current-benchmark | ../src/compile.js | Cloud compile eval embedding and packaging path review. |
| src-spec-compile-current | ../src/spec-compile.js | Local spec compile eval validation and default training stats review. |
| src-synthesis-current | ../src/synthesis.js | Candidate quality gate and acceptance logic review. |
| mcp-server-current | ../services/mcp/server.js | MCP `k_min` filtering behavior review. |
| bench-readme-current | ../bench/README.md | SWE-bench reproducer local build and statistical claim review. |
| bench-run-current | ../bench/run.py | Checked-in reproducer implementation and evaluator placeholder review. |
| fixture-sample-bench-current | ../test/fixtures/sample-bench.json | Machine-readable sample fixture benchmark report review. |
| fixtures-kolm-current | ../test/fixtures | Public fixture presence, local smoke inputs, and artifact inventory review. |
| tests-artifact-current | ../tests/artifact-end-to-end.test.js | Fixture verification and benchmark coverage review. |
| tests-server-benchmark-current | ../tests/server.test.js | Temporary artifact benchmark and CLI alias coverage review. |
| script-smoke-bench-current | ../scripts/smoke-bench-cli.mjs | Benchmark CLI smoke script coverage and CI-wiring review. |

## Public Registry Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| src-router-registry-current | ../src/router.js | Public concepts, public run, registry export, registry public alias, synthesize, publish, public submit, featured, and admin submission route review. |
| src-registry-governance-current | ../src/registry.js | Concept/version schema, public read behavior, list/detail shape, source exposure, sanitization, and delete semantics review. |
| src-verifier-publish-current | ../src/verifier.js | Manual publish verification behavior, empty-eval scoring, quality gate constant, and JS source safety scan review. |
| src-auth-public-api-current | ../src/auth.js | Public API allowlist and auth boundary review for public concepts, public run, public submit, and registry public alias. |
| server-registry-routes-current | ../server.js | `/registry`, `/atlas`, dynamic route absence, and public seed bootstrapping review. |
| public-registry-current | ../public/registry.html | Atlas public registry claims, fetch path, K-score derivation, signed badge, and detail link review. |
| public-leaderboard-current | ../public/leaderboard.html | Leaderboard ranking claims, vertical filters, K-score derivation, signed badge, and detail link review. |
| public-api-registry-current | ../public/api.html | Public API docs for registry public/export surfaces and NDJSON contract drift review. |
| public-device-registry-current | ../public/device.html | Browser/offline registry export execution and trust wording review. |
| public-trust-registry-current | ../public/trust.html | Trust page registry status and read/write positioning review. |
| public-rs1-registry-current | ../public/docs/rs-1.md | Artifact contract registry export, deterministic artifact, and co-signing language review. |
| public-sdk-registry-current | ../public/sdk.js | Browser SDK registry export loading and offline executable-source cache review. |
| public-sw-registry-current | ../public/sw.js | Service worker precache/stale-while-revalidate behavior for registry export review. |
| sdk-node-registry-current | ../sdk/node/index.mjs | Node SDK public concepts, public run, and public helper review. |
| sdk-node-registry-tests-current | ../sdk/node/test/sdk.test.mjs | SDK public submit test coverage review. |
| examples-public-seeds-current | ../examples | Boot-seeded public example visibility and provenance review. |
| tests-e2e-registry-current | ../tests/e2e.test.js | Existing public concepts coverage and missing registry governance tests review. |
| tests-site-registry-current | ../tests/site.test.js | Static-link coverage limitations for JS-generated registry detail links review. |

## Capture Distillation Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| src-router-capture-current | ../src/router.js | Bridge observe, suggestions, observations, auto-synthesize, label export, specialist train/run/weights, and auto-distill route review. |
| src-capture-current | ../src/capture.js | Provider proxy upstream selection, namespace sanitization, prompt extraction, completion extraction, provider key forwarding, and prompt hash review. |
| src-synthesis-capture-current | ../src/synthesis.js | Auto-synthesize persistence boundary and result shape review. |
| src-tune-current | ../src/tune.js | Local capture, tune step, eval, promotion, rollback, watch, and adapter-effect review. |
| cli-capture-current | ../cli/kolm.js | Capture, labels, distill, and tune CLI command behavior and threshold wording review. |
| public-captures-current | ../public/captures.html | Capture inbox claims, keep/discard/promote UI, ready-to-distill button, retention wording, and hosted capture data path review. |
| public-api-capture-current | ../public/api.html | Capture and auto-distill API docs, bridge unavailable behavior, and signed artifact download wording review. |
| public-evolve-current | ../public/evolve.html | Local tune capture, airgap, adapter step, eval, promotion, and local-only wording review. |
| public-glossary-capture-current | ../public/glossary.html | Capture, distill, LoRA, compile flywheel, and terminology review. |
| public-vs-openpipe-current | ../public/vs-openpipe.html | Capture-then-fine-tune competitive positioning and artifact ownership claims review. |
| docs-tune-current | ../docs/TUNE.md | Local tune verb reference, adapter eval caveat, thresholds, and failure modes review. |
| docs-evolve-current | ../docs/EVOLVE.md | Local-only capture and airgap loop source claims review. |
| sdk-node-capture-current | ../sdk/node/index.mjs | Node SDK label-corpus helper and missing capture-export helper review. |
| sdk-node-capture-tests-current | ../sdk/node/test/sdk.test.mjs | Existing SDK label-corpus coverage and missing capture export tests review. |
| sdk-mcp-specialist-current | ../sdk/mcp/server.mjs | MCP specialist training/run descriptions and fallback behavior review. |
| tests-capture-current | ../tests | Absence of capture, bridge, labels, auto-distill, and tune tests review. |

## Audit Observability Evidence Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| src-router-audit-observability-current | ../src/router.js | Health, readiness, telemetry, receipt verification, audit-log stub, admin diagnostics, capture, label export, auto-distill, account, and webhook route review. |
| src-env-readiness-current | ../src/env.js | Runtime readiness check schema, public labels, hints, and production-like gate review. |
| src-runtime-invocation-current | ../src/runtime.js | Invocation logging payload, cache/error behavior, and receipt metric source review. |
| src-artifact-runner-audit-current | ../src/artifact-runner.js | Local `kolm-audit-1` callback payload, input preview, and receipt shape review. |
| src-store-audit-current | ../src/store.js | Store table facade, stats, absence of audit table, and persistence behavior review. |
| src-auth-usage-current | ../src/auth.js | Usage charge, tenant update, key/account behavior, and missing audit hook review. |
| public-audit-log-current | ../public/audit-log.html | Per-tenant audit log, export, opt-in, raw-text, purge, and signed-entry claims review. |
| public-status-current | ../public/status.html | Live probe, readiness rendering, uptime, incident, and status evidence review. |
| public-trust-observability-current | ../public/trust.html | Trust-center uptime, status, receipt, SLA, and monitor wording review. |
| public-security-receipts-current | ../public/security.html | Receipt, data boundary, retention, export, and evidence wording review. |
| public-api-errors-current | ../public/api.html | Error envelope, request-id, health, ready, receipt verifier, and API status-code contract review. |
| public-privacy-retention-current | ../public/privacy.html | Edge log, export/delete, retention, and processor data wording review. |
| public-enterprise-evidence-current | ../public/enterprise.html | Compliance binder, incident log, sign-off package, and audit evidence claims review. |
| public-healthcare-audit-current | ../public/healthcare.html | BAA-scoped events, outage/audit language, receipt mirroring, and audit log claims review. |
| tests-e2e-observability-current | ../tests/e2e.test.js | Existing telemetry, health, ready, and receipt verification smoke coverage review. |
| tests-artifact-audit-current | ../tests/artifact-end-to-end.test.js | Local audit callback and input preview coverage review. |
| tests-site-status-current | ../tests/site.test.js | Static site forbidden text, link, and missing status/audit contract coverage review. |

## Recall RAG Memory Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| src-router-recall-current | ../src/router.js | Recall, embed, recall status, source preview, wrap/verified grounding, compile, assistant, and memory recall route review. |
| src-recall-current | ../src/recall.js | qmd namespace prefixing, ingest/query/status behavior, qmd failure handling, and sidecar tokenization orchestration review. |
| services-qmd-current | ../services/index/qmd.js | qmd CLI/HTTP adapter, availability, collection add, embed, query, and status behavior review. |
| services-multimodal-current | ../services/embed/multimodal.js | Modality detection, PDF/image/audio/video placeholder behavior, sidecar contents, and optional provider path review. |
| src-rag-current | ../src/rag.js | Local BM25 index/query/list/attach behavior, sidecar attachment, absolute path storage, and `ragLibFor` review. |
| cli-rag-current | ../cli/kolm.js | `kolm compile --data`, `kolm rag` CLI help, index/query/attach/list commands, and hosted data path review. |
| src-compile-recall-current | ../src/compile.js | Compile recall stage, chunk usage, package inputs, and recall namespace packaging review. |
| src-artifact-recall-current | ../src/artifact.js | `index.sqlite-vec` slot, KOLMIDX container, manifest recall field, and artifact packaging review. |
| src-artifact-runner-recall-current | ../src/artifact-runner.js | Artifact index decoding, recipe execution options, audit, and missing `lib.rag` integration review. |
| src-verifier-lib-current | ../src/verifier.js | Sandbox library shape, `pack`, `index`, `params`, and absence of `rag` review. |
| public-recall-current | ../public/recall.html | Recall hero, multimodal/vector/RRF/rerank claims, backend choices, and honest-disclosure wording review. |
| public-api-recall-current | ../public/api.html | Recall and embed API docs, request/response drift, and server-mounted path disclosure review. |
| public-docs-rag-current | ../public/docs.html | Recall docs, BM25 sidecar wording, and CLI examples review. |
| docs-rag-current | ../docs/RAG.md | Local BM25 RAG contract, attach behavior, `lib.rag` docs, and shipped status review. |
| docs-evolve-rag-current | ../docs/EVOLVE.md | RAG/tune integration, attach claims, and local loop wording review. |
| public-security-recall-current | ../public/security.html | Recall corpus storage, encryption, durability, and roadmap wording review. |
| public-whitepaper-recall-current | ../public/whitepaper.html | Normative recall index slot, implementation-status note, and conformance wording review. |
| tests-recall-current | ../tests | Absence of recall, embed, qmd, local RAG, and artifact-bound recall tests review. |

## Agent MCP Install Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| kolm-live-integrations-current | https://kolm.ai/integrations | Live integration status labels, Claude/Cursor/GitHub Actions/package-manager claims, and MCP setup examples. |
| kolm-live-agentic-coding-current | https://kolm.ai/use-cases/agentic-coding | Live agentic coding MCP, repo-aware artifact, egress, K-score, and receipt claims. |
| kolm-live-docs-current | https://kolm.ai/docs | Live CLI install, assistant, MCP serve, harness install, and docs-version claims. |
| kolm-live-claude-skill-current | https://kolm.ai/docs/claude-skill.md | Live Claude skill command, K-score, receipt, and verification guidance. |
| kolm-live-cursor-rules-current | https://kolm.ai/docs/cursor-rules.txt | Live Cursor rule command, artifact, K-score, and error guidance. |
| public-serve-mcp-current | ../public/serve.html | Local serve-page claims for discovery, SSE, well-known manifest, token exchange, receipts, and examples. |
| public-integrations-mcp-current | ../public/integrations.html | Local integration status labels and setup snippets. |
| public-agentic-coding-current | ../public/use-cases/agentic-coding.html | Local agentic coding MCP and egress claim review. |
| public-docs-mcp-current | ../public/docs.html | Local docs install, MCP serve, and harness install examples. |
| public-quickstart-mcp-current | ../public/quickstart.html | Quickstart harness install and doctor-wiring claims. |
| public-claude-skill-current | ../public/docs/claude-skill.md | Local Claude skill command and K-score guidance review. |
| public-cursor-rules-current | ../public/docs/cursor-rules.txt | Local Cursor rule command and K-score guidance review. |
| services-mcp-artifact-current | ../services/mcp/server.js | Artifact MCP protocol, discovery, K-score filtering, tools/call, HTTP transport, and missing logging review. |
| sdk-mcp-legacy-current | ../sdk/mcp/server.mjs | Legacy cloud MCP package, tool names, auth model, and specialist-tool drift review. |
| cli-install-mcp-current | ../cli/kolm.js | `kolm serve`, `kolm install`, `kolm doctor`, skill sidecar, logs, CLI command dispatch, and harness snippets review. |
| src-project-mcp-current | ../src/project.js | `kolm.yaml` parser, artifact globs, MCP transport settings, `allowed_tools`, and `k_min` review. |
| src-hooks-mcp-current | ../src/hooks.js | CLI hook parser and execution model review. |
| src-artifact-runner-mcp-current | ../src/artifact-runner.js | Local artifact run receipt, audit payload, signature verification, and runtime behavior review. |
| src-benchmark-egress-mcp-current | ../src/benchmark.js | Egress monitor scope and benchmark-only network patching review. |
| src-verifier-mcp-current | ../src/verifier.js | Recipe vm sandbox, dangerous-source scan, and runtime library shape review. |
| action-kolm-compile-mcp-current | ../.github/actions/kolm-compile/action.yml | GitHub Action contract against current CLI flags and verify command availability. |
| tests-agent-mcp-current | ../tests | Absence of MCP, harness install, doctor, sidecar, and MCP log tests review. |

## Device Offline Browser Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| kolm-live-device-current | https://kolm.ai/device | Live device page copy, module-script lines, offline/PWA claims, and trust-gate wording. |
| kolm-live-sdk-current | https://kolm.ai/sdk.js | Live browser SDK syntax and runtime-claim comparison. |
| kolm-live-worker-current | https://kolm.ai/recipe-worker.js | Live worker syntax and sandbox implementation comparison. |
| kolm-live-sw-current | https://kolm.ai/sw.js | Live service-worker precache and stale-revalidate behavior comparison. |
| kolm-live-sdk-current-json | https://kolm.ai/sdk-current.json | Live current SDK pointer and pinned asset metadata review. |
| kolm-live-registry-export-current | https://kolm.ai/v1/registry/export | Live export shape, recipe count, source hashes, registry hash, and signature absence review. |
| public-device-browser-current | ../public/device.html | Device page module script, PWA registration, network counter, offline claims, trust gate, and UI status review. |
| public-sdk-browser-current | ../public/sdk.js | Browser SDK load/cache/run/receipt/wrap behavior and syntax check review. |
| public-sdk-versioned-current | ../public/sdk-current.json | Current SDK pointer and versioned asset manifest review. |
| public-worker-browser-current | ../public/recipe-worker.js | Browser worker compile/cache/lockdown behavior and syntax check review. |
| public-sw-browser-current | ../public/sw.js | Service worker precache list, registry stale-revalidate, static asset caching, and offline behavior review. |
| public-pwa-manifests-current | ../public/manifest.json | PWA start URL, scope, icon, and device-install behavior review. |
| scripts-build-sdk-version-current | ../scripts/build-sdk-version.js | SDK stamping, content-addressed asset, and missing syntax gate review. |
| src-router-device-export-current | ../src/router.js | Registry export route, source hash, cache-control, and missing signature envelope review. |
| src-registry-device-current | ../src/registry.js | Public concept visibility, source storage, and public string sanitization review. |
| src-artifact-runner-device-current | ../src/artifact-runner.js | Local artifact run receipt/audit behavior for comparison against browser run receipts. |
| src-verifier-device-current | ../src/verifier.js | Node recipe sandbox warning, dangerous-source scan, and timeout model comparison. |
| public-security-device-current | ../public/security.html | On-device/offline/runtime/security copy and caveats review. |
| public-hipaa-device-current | ../public/articles/hipaa-on-device.html | Healthcare local-PHI, zero-egress, offline-mode, and implementation-caveat wording review. |
| public-whitepaper-device-current | ../public/whitepaper.html | RS-1 portability/offline claims and v0.1 implementation-status caveat review. |
| docs-product-device-current | ../docs/PRODUCT.md | Local runtime, no phone-home, and zero-egress positioning review. |
| tests-site-device-current | ../tests/site.test.js | Static public claim checks, inline script parse behavior, module-script skip, and external script coverage review. |

## Release Distribution Governance Refresh 2026-05-12

| Ref | URL | Used For |
| --- | --- | --- |
| kolm-live-integrations-release-current | https://kolm.ai/integrations | Live integration/package-manager shipped labels, install snippets, Node/Python/Docker/GitHub Action claims. |
| kolm-live-docs-release-current | https://kolm.ai/docs | Live CLI install tabs, missing npm package command, brew tab, source install, and CLI verb docs. |
| kolm-live-security-release-current | https://kolm.ai/security | Live supply-chain, SLSA, Sigstore, SBOM, and signed-release wording review. |
| npm-cli-package-current | https://registry.npmjs.org/ | `npm view @kolm/cli` registry availability check. |
| npm-node-sdk-package-current | https://registry.npmjs.org/ | `npm view @kolmogorov/kolm-sdk` registry availability check. |
| npm-root-package-current | https://registry.npmjs.org/ | `npm view kolmogorov-stack` registry availability check. |
| pypi-kolm-current | https://pypi.org/pypi/kolm/json | PyPI package-name ownership and collision review. |
| github-homebrew-tap-current | https://github.com/kolm/homebrew-kolm | Documented Homebrew tap existence check. |
| github-winget-current | https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/k/Kolmogorov/kolm/0.1.0 | Windows package-manager manifest existence check. |
| github-scoop-current | https://github.com/ScoopInstaller/Main/blob/master/bucket/kolm.json | Scoop manifest existence check. |
| root-package-current | ../package.json | Root CLI bin, private flag, scripts, engine, and package metadata review. |
| root-npm-pack-current | npm pack dry-run | Root package size, entry count, package contents, lockfile omission, and license-file absence review. |
| node-sdk-package-current | ../sdk/node/package.json | Node SDK package metadata, files list, bin, and publication state review. |
| python-sdk-package-current | ../sdk/python/pyproject.toml | Python package name, scripts, package discovery, and PyPI collision review. |
| python-sdk-client-current | ../sdk/python/kolm/client.py | Python CLI wrapper contract, compile/run/verify behavior, and env behavior review. |
| mcp-sdk-package-current | ../sdk/mcp/package.json | Legacy MCP package metadata, package status, and artifact-MCP separation review. |
| vscode-package-current | ../sdk/vscode/package.json | VS Code extension package metadata, activation, commands, and release state review. |
| vscode-extension-current | ../sdk/vscode/extension.js | VS Code API host, replacement import, command implementation, and syntax review. |
| github-action-current | ../.github/actions/kolm-compile/action.yml | Composite action install/config/compile/upload/verify contract review. |
| github-workflows-release-current | ../.github/workflows | Existing lint/smoke workflows and absence of publish, provenance, signing, and SBOM workflows. |
| docker-release-current | ../Dockerfile | Server Dockerfile base image pin and release-image distinction review. |
| brew-stub-current | ../scripts/brew/kolm.rb | Homebrew preview status, placeholder SHA, and formula test review. |
| winget-stub-current | ../scripts/winget/kolm.yaml | Windows package-manager preview status, missing companion manifests, and package claims review. |
| tests-release-current | ../tests | Absence of package-manager, action, package dry-run, and release-signing tests review. |
