# Final UI/UX Product Surface Audit - 2026-05-20

Verdict: LOCAL UI/UX SURFACE PASS, MARKET-POSITIONED FRONTEND READY FOR DEPLOYMENT REVIEW.

This audit covers the public website, authenticated account console, enterprise console, CLI/TUI help surfaces, product positioning, generated media, navigation, typography, light mode, dark mode, desktop, mobile, static route integrity, and the product-surface taxonomy.

It does not claim live production is final. The verified state is this local workspace after the frontend edits. Production still needs deployment and a post-deploy run against `https://kolm.ai`.

## Exact Evidence

| Evidence | Result |
| --- | --- |
| Full UI sweep after shared polish | PASS, 510 routes, desktop and mobile, dark and light |
| Full all-surface report | `reports/ui-surface-audit/2026-05-20T17-31-01/report.md` |
| Full all-surface screenshots | `reports/ui-surface-audit/2026-05-20T17-31-01/screenshots/` |
| Full all-surface CLI/TUI transcripts | `reports/ui-surface-audit/2026-05-20T17-31-01/cli-tui/` |
| Post-market main-surface recheck | PASS, 10 key routes, desktop and mobile, dark and light, `reports/ui-surface-audit/2026-05-20T18-23-22/report.md` |
| Post-market homepage recheck | PASS, `/`, desktop and mobile, dark and light, `reports/ui-surface-audit/2026-05-20T18-25-42/report.md` |
| Static refs | PASS, `missing static refs: 0`, `broken: 0` |
| Product surface verifier | PASS, 7 certified surfaces, 108 route groups, 357 routes, 29 research refs |
| JS syntax | PASS, `node --check public/nav.js`; `node --check scripts/ui-surface-audit.cjs` |

## Interaction And Media Coverage

| Gate | Evidence |
| --- | --- |
| Full interaction scan | 2040 UI renders, 76890 visible interactive controls reviewed |
| Full generated media scan | 1920 product media renders verified |
| Strengthened interaction checks | Accessible names, invalid hrefs, missing hash targets, `target="_blank"` rel safety, action target size, keyboard tab path |
| Theme checks | Dark and light rendering, early theme activation, theme toggle behavior |
| Navigation checks | Desktop mega menus, mobile menu open state, route-aware product spine |
| CLI/TUI checks | Root help, doctor JSON, whoami JSON, billing tiers JSON, TUI help, chat TUI help all exit 0 |

## Surfaces Covered

| Product surface | UI coverage now present |
| --- | --- |
| API wrapping and gateway | Homepage hero, `/product`, `/capture`, `/captures`, `/api`, `/quickstart`, docs routes, generated gateway media |
| Capture lake and privacy | Product spine, generated capture media, account capture pages, privacy/compliance pages |
| Training and evals | Homepage hero, `/training`, `/train`, docs, research, bakeoff/account pages, generated training media |
| Distillation and compile | Homepage hero, `/distill`, `/compile`, `/models`, marketplace, compare pages, generated distill media |
| Runtime and device | `/runtimes`, `/device`, device-transfer pages, setup/install pages, generated runtime media |
| Enterprise and governance | `/enterprise`, `/enterprise/console`, trust/security/compliance/BAA/SOC2/SLSA/SBOM pages, generated enterprise media |
| Account and post-auth | Account overview, keys, billing, datasets, labeling, builds, audit, privacy, storage, security 2FA |
| CLI and TUI | CLI/TUI help transcripts captured by the audit harness |

## Market-Positioned Edits Made

| Area | Change |
| --- | --- |
| Homepage category claim | Reframed the hero as an AI control plane for gateway, capture, training, distillation, runtime, and governance |
| Homepage H1 | Changed to `Turn model traffic / into owned AI. / Run anywhere.` so the first viewport owns the full traffic-to-runtime outcome |
| Homepage proof copy | Rewrote proof chips around gateway coverage, redacted trace promotion, evals, receipts, and specialist runtimes |
| Homepage CTAs | Moved from generic app/capture language to `Route your first model call` and `See capture to runtime` |
| Homepage product media | Added a pipeline strip: route, redact, score, label, distill, sign |
| Homepage console | Expanded the media from generic cards to the full loop: API gateway, capture lake, privacy membrane, datasets, evals and bakeoffs, training and distill, runtimes, enterprise |
| Light mode polish | Added matching pipeline and console colors so the hero media stays visible in light mode |
| Global finish layer | Shared `surface-polish.css` and `nav.js` keep navigation, generated product media, forms, target sizes, and repaired control labels consistent across public and post-auth pages |

## Competitive Lens

Official sources reviewed on 2026-05-21:

| Competitor | Official positioning reviewed | Implication for kolm UI |
| --- | --- | --- |
| LangSmith | Agent observability and evals platform: https://www.langchain.com/langsmith-platform | Kolm must show observability plus the next step: turning traces into reviewed datasets, distillation, signed artifacts, and local runtimes |
| Langfuse | Open-source LLM engineering platform with tracing, prompts, evals, experiments, and human annotation: https://langfuse.com/docs/ | Kolm must avoid looking like only observability or prompt management; the UI now emphasizes the full owned-AI loop |
| Helicone | AI gateway and observability platform: https://docs.helicone.ai/getting-started/platform-overview | Kolm's gateway surface starts with base-url wrapping but continues into train, eval, distill, runtime, and audit |
| Portkey | AI gateway, observability, guardrails, governance, and prompt management: https://portkey.ai/docs/overview/features-overview | Kolm enterprise UI foregrounds receipts, signed artifacts, self-host, air-gap, and route evidence, not only governance dashboards |
| OpenPipe | Request logs, data capture, fine-tuning, model hosting, and evaluations: https://docs.openpipe.ai/overview | Kolm positions capture-to-model as one stage in a broader signed-runtime and enterprise-evidence path |
| Predibase | Dataset upload, adapters, evaluation, production deployment, and multi-LoRA serving: https://docs.predibase.com/fine-tuning/overview | Kolm training and distill pages tie adapter workflows to capture, evals, receipts, runtime targets, and enterprise controls |
| Vellum | Prompts, workflows, deployments, and evaluation: https://docs.vellum.ai/ | Kolm avoids workflow-builder framing and instead explains the traffic-to-artifact control plane |
| Braintrust | AI observability, evals, playgrounds, and prompt iteration: https://www.braintrust.dev/docs/platform/playground | Kolm copy must show that evals are not the destination; they are the gate before training, distillation, signing, and deployment |

Expanded official benchmark coverage reviewed on 2026-05-21:

| Category | Official sources reviewed | Frontend standard applied to kolm |
| --- | --- | --- |
| Frontier API labs | OpenAI platform evals and fine-tuning docs: https://platform.openai.com/docs/guides/evals, Anthropic evaluation tooling: https://docs.claude.com/en/docs/test-and-evaluate/eval-tool, Google DeepMind Gemini/API surface: https://deepmind.google/gemini, Mistral La Plateforme: https://mistral.ai/en/products/la-plateforme | Keep the homepage direct, technical, and product-led: one category claim, immediate developer action, and evidence that the product works across multiple model providers rather than imitating a single lab console |
| AI gateways and routers | Helicone, Portkey, LiteLLM: https://docs.litellm.ai/, OpenRouter: https://openrouter.ai/docs/api-reference/overview, TensorZero: https://github.com/tensorzero/tensorzero | Make the first viewport show base-url wrapping, provider neutrality, routing, redaction, and observability, then differentiate by showing the downstream training/distill/runtime loop |
| Observability and eval platforms | LangSmith, Langfuse, Arize Phoenix: https://arize.com/docs/phoenix, HoneyHive: https://docs.honeyhive.ai/v2/concepts, Braintrust | Every monitoring/eval surface must answer what failed, what data is trusted, what is promoted, and what gate blocks unsafe promotion |
| Fine-tuning and distillation platforms | OpenPipe, Predibase, Together AI: https://docs.together.ai/docs/fine-tuning-overview, Fireworks AI: https://fireworks.ai/docs/fine-tuning/finetuning-intro, OpenAI fine-tuning | Training pages should not read as generic model customization; they must connect trace capture, privacy review, holdouts, evals, receipts, and deployable artifacts |
| Inference and runtime platforms | Baseten: https://docs.baseten.co/overview, Fireworks AI, Together AI inference: https://docs.together.ai/docs/inference/overview, Replicate deployments: https://replicate.com/docs/topics/deployments/create-a-deployment, Modal: https://frontend.modal.com/docs/guide | Runtime pages must show portability and operational proof: cloud, edge, browser, desktop, CLI/TUI, device targets, signed artifacts, and enterprise audit |
| Workflow and prompt platforms | Vellum, Humanloop: https://humanloop.com/docs/quickstart, Braintrust playground, Langfuse prompt management | Kolm pages avoid looking like another prompt/workflow builder; copy emphasizes traffic, evidence, artifacts, and governed ownership |

The frontend standard after this pass: every product page must answer four questions fast: what surface am I on, how it fits the traffic-to-runtime loop, what proof exists, and what action comes next.

## Remaining For 100 Percent Production Certification

These are not local UI blockers. They are deployment and live-environment gates:

| Gate | Required action |
| --- | --- |
| Production deploy | Deploy this workspace to the production hosting path |
| Production screenshot audit | Run `npm run ui:audit:all:themes -- --base=https://kolm.ai --timeout=20000` after deploy |
| Production authenticated account pass | Run the audit with a valid production API key/session so post-auth pages hit real prod data |
| Browser visual spot check | Open representative prod screenshots for `/`, `/product`, `/enterprise/console`, `/device`, `/account/overview`, `/docs/cli`, and `/training` |
| Backend/prod API finality | Separate from this UI pass: run live `/health`, `/ready`, CLI doctor/whoami/verify/billing without logged-out allowance |

## Commands Run

```powershell
node --check public\nav.js
node --check scripts\ui-surface-audit.cjs
npm run ui:audit -- --routes=/,/product,/pricing,/enterprise,/docs,/models,/captures,/training,/distill,/runtimes --themes=dark,light --timeout=20000
npm run ui:audit -- --routes=/ --themes=dark,light --timeout=20000
npm run lint:refs
```

## Commands To Reproduce

```powershell
node --check public\nav.js
node --check scripts\ui-surface-audit.cjs
npm run lint:refs
npm run ui:audit:all:themes -- --timeout=20000
npm run ui:audit -- --routes=/,/product,/pricing,/enterprise,/docs,/models,/captures,/training,/distill,/runtimes --themes=dark,light --timeout=20000
git diff --check
git status --short --branch
```
