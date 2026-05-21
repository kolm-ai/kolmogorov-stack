# Final UI/UX Product Surface Audit - 2026-05-20

Verdict: LOCAL FRONTEND PRODUCT-SURFACE PASS. NOT PRODUCTION FINAL UNTIL DEPLOYED AND RECHECKED LIVE.

This audit covers the current local workspace after the frontend polish and pricing-contract pass: public website, pricing, docs, quickstart, generated product media, post-auth account console, account product matrix, enterprise/governance surfaces, CLI/TUI help exposure through the UI audit harness, dark mode, light mode, desktop, mobile, navigation, keyboard paths, interaction targets, structured metadata, and screenshots.

It does not claim `https://kolm.ai` is final. Production still needs a deployment of this workspace plus a live post-deploy screenshot and authenticated account pass.

## Current Evidence

| Gate | Result |
| --- | --- |
| Current full all-route UI audit | PASS by split full-route verification: 510 of 510 static routes in dark desktop/mobile, light desktop, and light mobile |
| Dark full all-route report | `reports/ui-surface-audit/2026-05-21Tfrontend-dark-all/report.md` |
| Light desktop full all-route report | `reports/ui-surface-audit/2026-05-21Tfrontend-light-desktop-all/report.md` |
| Light mobile full all-route report | `reports/ui-surface-audit/2026-05-21Tfrontend-light-mobile-all/report.md` |
| Full all-route screenshots | `reports/ui-surface-audit/2026-05-21Tfrontend-dark-all/screenshots/`, `reports/ui-surface-audit/2026-05-21Tfrontend-light-desktop-all/screenshots/`, `reports/ui-surface-audit/2026-05-21Tfrontend-light-mobile-all/screenshots/` |
| Screenshots written | 3060 PNGs for full all-route coverage, plus 120 final focused/hero screenshots after the last hero and enterprise CTA edits |
| UI renders inspected | 2040 full-route renders, plus 80 final focused/hero renders |
| Visible interactive controls reviewed | 79322 full-route controls, plus 4984 final focused/hero controls |
| Product media renders verified | 1920 full-route media renders, plus 68 final focused/hero media renders |
| Full all-route failures | 0 |
| Full all-route warnings | 0 |
| Final touched-route recheck | PASS, 15 touched routes, dark/light, desktop/mobile, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-final-focused/report.md` |
| Final hero/account/pricing/enterprise recheck | PASS, 5 key routes, dark/light, desktop/mobile, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-hero-final/report.md` |
| Artifact object-storage readiness recheck | PASS, `/account/storage`, `/account/overview`, `/enterprise/console`, dark/light, desktop/mobile, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-object-storage-readiness/report.md` |
| Artifact object-storage element screenshots | PASS, direct element screenshots for account storage and account overview panels: `reports/ui-surface-audit/2026-05-21Tfrontend-object-storage-readiness/element-screenshots/` |
| Metadata/pricing/account polish recheck | PASS, 27 affected routes, dark/light, desktop/mobile, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-metadata-pricing-account-polish/report.md` |
| Launch-language/title polish recheck | PASS, 21 affected public routes, dark/light, desktop/mobile, 84 renders, 4,824 visible controls, 80 media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-launch-language-polish-final/report.md` |
| Tail copy polish recheck | PASS, `/how-it-works` and `/vs-predibase`, dark/light, desktop/mobile, 8 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-copy-tail-polish/report.md` |
| Flexible launch-language sweep | PASS, 26 affected public routes, dark/light, desktop/mobile, 104 renders, 5,644 visible controls, 104 media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-flexible-launch-language-sweep/report.md` |
| Legacy nav canonicalization | PASS, 13 affected public routes, dark/light, desktop/mobile, 52 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-legacy-nav-canonicalization/report.md` |
| Community mobile nav fix | PASS, `/community/twitter-thread`, dark/light mobile plus full route retest, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-community-nav-fix/report.md` |
| Metadata snippet cleanup report | PASS, detailed findings and complete affected path list: `reports/ui-surface-audit/2026-05-21Tfrontend-metadata-snippet-cleanup/report.md` |
| Tutorial encoding fix | PASS, `/tutorials/openai-drop-in` and `/tutorials/phi-redactor`, dark/light, desktop/mobile, 8 renders, 356 visible controls, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-tutorial-encoding-fix/report.md` |
| Trust-copy cleanup | PASS, 11 affected public routes, dark/light, desktop/mobile, 44 renders, 2,146 visible controls, 44 media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-trust-copy-cleanup/report.md` |
| `.kolm` artifact-copy polish | PASS, 31 non-CLI page heads normalized, metadata scans clean, and 11 representative routes audited dark/light desktop/mobile with 44 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-kolm-artifact-copy-polish/report.md` |
| Docs accessibility/metadata fix | PASS, `/docs`, dark/light, desktop/mobile, duplicate-ID scan clean, stale count scan clean, 4 renders, 534 visible controls, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-docs-a11y-metadata-fix/report.md` |
| ARIA/dead-link cleanup | PASS, non-CLI ARIA reference scan, dead-anchor scan, and duplicate-ID scan all clean; 9 representative routes audited dark/light desktop/mobile with 36 renders, 2,618 visible controls, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-aria-link-cleanup/report.md` |
| Form accessibility cleanup | PASS, non-CLI form-control accessible-name scan clean; 12 form-heavy routes audited dark/light desktop/mobile with 48 renders, 2,706 visible controls, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-form-a11y-cleanup/report.md` |
| Tab/link semantics cleanup | PASS, form-button, external-link rel, tab semantics, and duplicate-ID scans clean; 10 representative routes audited dark/light desktop/mobile with 40 renders, 2,170 visible controls, 32 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-tab-link-semantics/report.md` |
| Contract recovery and pricing polish | PASS, malformed HTML, stale pricing, metadata snippet, external-link rel, tab semantics, duplicate-ID, and image-alt scans clean; 17 changed routes audited dark/light desktop/mobile with 68 renders, 4,020 visible controls, 52 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-contract-recovery-polish/report.md` |
| Main-landmark accessibility sweep | PASS, every non-CLI public HTML page has one `<main>` landmark, skip links resolve, H1 counts remain one per page, and the 125 changed routes passed dark/light desktop/mobile screenshots with 500 renders, 22,940 visible controls, 496 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-main-landmarks/report.md` |
| Public markdown corruption recovery | PASS, `public/launch-checklist.md` was restored from the clean Git object after separator-stream corruption was detected; follow-up scan covered 694 public non-CLI text assets and found `public_non_cli_corruption_suspects=0` |
| Homepage hero H1 correction | PASS, visible homepage H1 no longer says `Turn model traffic / into owned AI`; it now says `The AI Compiler. Own your model. Run anywhere.` with immediate 11.6x cheaper / 7.4x faster proof and Docker-for-AI lede; `/` audited dark/light desktop/mobile with 0 failures and 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-hero-h1-correction/report.md` |
| Monolithic all-route note | The monolithic combined audit produced screenshots but failed during late cleanup/report generation, so the complete evidence set is the three PASS split reports above |
| Targeted demo screenshots | Homepage, pricing, upgrade, account, and enterprise screenshots were inspected from the final report directories |
| Markup integrity | PASS, scanner found `bad: 0` malformed public HTML files |
| SEO metadata | PASS, scanner found `issues: 0` across public HTML title, description, canonical, and OG/Twitter metadata |
| SEO metadata deep cleanup | PASS, non-CLI public HTML title/description scanner found `metadata_description_issues=0`, `title_issues=0`, and `malformed_meta_lines=0` after targeted cleanup |
| Metadata duplicate sweep | PASS, account pages no longer publish duplicate `Account · Account` titles/social cards, and no public HTML title repeats `kolm.ai · kolm.ai` |
| Stale pricing/CTA sweep | PASS, no old Starter/Business/direct Enterprise signup patterns remained in public pages, API docs, OpenAPI, or AI context |
| Static refs | PASS, latest run `missing static refs: 0`, `broken: 0`, `ok: 31376`; product verifier still 7 certified surfaces, 111 route groups, 373 routes |
| Product surface verifier | PASS, 7 certified surfaces, 111 route groups, 373 routes, 29 research refs |
| JS syntax | PASS, `node --check` on `public/nav.js`, `src/router.js`, `src/stripe.js`, `src/billing-upgrade.js`, `src/assistant.js`, `src/email.js`, and `cli/kolm.js` |
| Plan API contract | PASS, local `/v1/plans` and `/v1/billing/tiers` return Free / Pro $49 / Team $499 / Enterprise custom |
| Enterprise upgrade contract | PASS, `/v1/account/change-plan` returns `sales_required: true` for Enterprise and maps legacy `business` to Enterprise |
| Diff whitespace | PASS, `git diff --check` on `public/launch-checklist.md` and scoped modified non-CLI public/audit files; latest scoped run covered 195 files |

## Product Surface Coverage

| Surface | Current frontend coverage |
| --- | --- |
| API wrapping | Homepage, quickstart, docs, integrations, account connectors, API keys, generated Wrap stage |
| Capture and telemetry | Homepage product loop, `/capture`, `/captures`, account captured events, agent telemetry, opportunities |
| Privacy and lake | Account privacy events, lake, storage truth, docs privacy, security and compliance surfaces |
| Dataset and review | Account labels, datasets, simulations, bakeoffs, docs datasets/evals/training |
| Training and distilling | `/training`, `/distill`, account builds, distill runs, model/compute pages, generated Build stage |
| Multimodal and tokenization | Account multimodal bakeoff, model matrix references, compute/runtime routing copy |
| Model matrix | `/models`, homepage/product copy, account matrix with Gemma/Qwen/Phi/Llama/Mistral/device fit |
| Compute and backends | `/compute`, account matrix, runtime pages, device-transfer pages |
| Artifact object storage | `/account/storage`, `/account/overview`, `/enterprise/console`, API docs for `GET /v1/storage/object-readiness`, provider matrix with local disk, R2 REST, R2 S3-compatible, AWS S3, generic S3, and Supabase S3 |
| Compile and artifacts | `/compile`, `/spec`, account artifacts, K-score/receipt copy, generated signed-artifact media |
| Runtime and devices | `/runtimes`, `/device`, device-transfer pages, account devices, browser/WASM/edge copy |
| Agents and integrations | `/integrations`, docs integrations, account agent telemetry, MCP/Claude/Cursor/Continue/Cline copy |
| Enterprise and billing | `/enterprise`, trust/security/compliance/BAA/SOC2/SLSA/SBOM pages, account billing/audit/settings/storage |

## Edits Made In This Pass

| Area | Change |
| --- | --- |
| Public navigation | Reduced the public product spine from 8 competing pills to 6 clear stages: Wrap, Review, Build, Run, Solutions, Govern |
| Nav polish | Added consistent active underline states, tighter mega-menu cards, better hover/focus states, and light-mode parity |
| Homepage hero | Rewrote the above-the-fold promise to "The AI Compiler. Own your model. Run anywhere." with one-base-URL API wrapping, owned `.kolm` artifacts, cloud/edge/browser/desktop/CLI/TUI/enterprise coverage, and visible speed/cost proof |
| Homepage demo | Fixed light-mode demo contrast by binding the dark demo stage to light-safe ink tokens |
| Demo first frame | Added a useful static first frame and accelerated the scene so a `.kolm` artifact appears immediately instead of an empty panel |
| Pricing | Re-aligned visible pricing to Free, Pro $49/mo, Team $499/mo, Enterprise custom |
| Account plan selector | Removed visible stale Starter/Business pricing options from the account plan UI |
| Account console | Added a full post-auth product matrix covering API wrapper, privacy, multimodal, model matrix, compute, distill runs, agents/MCP, and enterprise proof |
| Account sidebar | Normalized the post-auth sidebar into grouped workflow sections: Start, Capture, Data, Build, Run, Govern |
| Account aesthetics | Tightened account command-center layout and fixed light-mode sidebar contrast |
| Docs/quickstart | Preserved the previous one-line base URL quickstart, docs rail, API/SDK/CLI fast paths, and copy-paste developer flow |
| SEO/structured data | Updated homepage title/description, SoftwareApplication copy, feature list, offers, FAQ pricing, ownership copy, canonical/OG/Twitter metadata, and verified the metadata scanner at zero issues |
| Broken hidden control | Removed legacy hidden homepage CTAs from the accessibility tree and keyboard order |
| Pricing/product contract | Aligned backend `/v1/plans`, `/v1/billing/tiers`, CLI fallback tiers, Stripe amount mapping, assistant plan aliases, welcome/billing emails, AI context, API docs, OpenAPI, upgrade page, ROI page, FAQ, enterprise console, and vertical CTAs to Free / Pro / Team / Enterprise |
| Enterprise CTA | Replaced stale checkout framing with architecture-review framing on Enterprise and Upgrade surfaces |
| Artifact storage readiness UI | Added direct `GET /v1/storage/object-readiness` panels to account storage, account overview, and enterprise console, including selected provider, configured providers, missing provider groups, max object-size notes, R2 REST 300 MB caveat, and `secret_values_included: false` trust label |
| Account metadata | Removed duplicate Account branding from post-auth account page titles, OpenGraph titles, Twitter titles, and JSON-LD page names |
| Trust/pricing copy | Updated remaining SLA/pricing copy to Free $0, Pro $49, Team $499, Enterprise custom; retired visible Teams $149 / Enterprise $2,999 copy |
| Durable launch language | Replaced launch-day phrasing such as "ships today", "what ships today", and duplicated `kolm.ai` title branding with current-release, production-scope, and auditor-ready wording across homepage, pricing, security, roadmap, capture, migration, research, education, fintech, download, build-your-own, spec, Predibase comparison, and use-case pages |
| Deep launch copy sweep | Removed all non-CLI flexible "ship ... today" variants across public site surfaces; only the two CLI-owned generated `public/docs/cli/nl.*` files retain that wording for the CLI/backend owner |
| Legacy nav cleanup | Removed duplicate legacy `nav.primary` blocks from pages that already had the modern mega-nav, converted remaining legacy `.logo` headers to the canonical `.brand` lockup, and added a global no-wrap guard for legacy logo selectors |
| Metadata snippet cleanup | Rewrote clipped search/social descriptions, shortened overlong page titles, fixed the Chinese docs metadata title, and repaired the rationale-distillation metadata so snippets are complete and concise |
| Tutorial encoding cleanup | Replaced corrupted terminal brand separators in OpenAI drop-in and PHI redactor tutorials with clean ASCII output and verified visible text contains no C1 control, private-use, or replacement-character artifacts outside CLI docs |
| Trust-copy cleanup | Repaired malformed drift/runtime metadata, removed visible "fake", "demo catalog", "pre-launch", and "Next hardening" phrasing from public pages, and clarified example/de-identified/runtime copy without changing backend or CLI contracts |
| `.kolm` artifact-copy polish | Normalized head metadata from malformed phrases like `The.kolm`, `signed.kolm`, `compiled.kolm`, and `any.kolm` to readable `.kolm` artifact wording across public non-CLI pages |
| Docs accessibility/metadata fix | Removed duplicate `id="reference"` on the docs map by renaming the second anchor to `reference-tables`, and replaced brittle stale docs metadata counts with stable API/CLI/SDK/docs-map copy |
| ARIA/dead-link cleanup | Added missing `id="site-nav"` targets for mobile nav buttons across modern public headers, fixed AI setup tab label references, and removed `href="#"` defaults from the builder download and ROI share controls |
| Form accessibility cleanup | Added explicit accessible names to account, admin, capture, compile, dashboard, ROI, team, BYOC, trust, signup, vertical ROI, marketplace, and storage-policy form controls; repaired malformed control markup introduced during the first mechanical pass |
| Tab/link semantics cleanup | Added stable tab IDs and `aria-controls` targets to admin, dashboard, enterprise, onboarding, and SDK tabs; added `noopener noreferrer` to new-tab links; preserved existing JS/data attributes while tightening accessibility semantics |
| Contract recovery and pricing polish | Recovered non-CLI HTML from the separator-regression repair path, then reapplied the tab/link semantics fixes, restored clean metadata snippets, and aligned visible pricing/account/signup/enterprise copy to Free, Pro $49, Team $499, and Enterprise architecture review |
| Main-landmark accessibility sweep | Added a skip link and `<main id="main">` landmark to the older public articles, cookbook, compare, research, use-case, trust, status, setup, registry, receipt, and reference pages that still rendered without a main content landmark |
| Public markdown corruption recovery | Repaired `public/launch-checklist.md` from `HEAD:public/launch-checklist.md` after the broad separator-normalization regression left it as a single dash-separated character stream; did not touch CLI-owned generated docs |
| Homepage hero H1 correction | Replaced the visible homepage hero headline from `Turn model traffic / into owned AI / Run anywhere` to `The AI Compiler. Own your model. Run anywhere.`, made speed/cost proof visible immediately below the H1, and tightened the lede around the Docker-for-AI/base-URL/.kolm artifact story |

## Competitive Research Lens

Official references reviewed for positioning standards and product-surface comparison:

| Category | Official sources | Frontend implication |
| --- | --- | --- |
| Developer docs | Stripe API docs: https://docs.stripe.com/api | Docs and quickstart must lead with copy-paste commands and expected outputs |
| Platform pricing | Vercel pricing: https://vercel.com/pricing, Docker pricing: https://www.docker.com/pricing, Datadog pricing: https://www.datadoghq.com/pricing/ | Pricing must be transparent, tiered, enterprise-ready, and tied to workflow value |
| AI gateways | Helicone docs: https://docs.helicone.ai/getting-started/platform-overview, Portkey docs: https://portkey.ai/docs/overview/features-overview, LiteLLM docs: https://docs.litellm.ai/ | Kolm must show that the gateway is only the start; the product continues into data, distill, signed artifacts, runtime, and governance |
| Observability/evals | LangSmith: https://www.langchain.com/langsmith-platform, Langfuse docs: https://langfuse.com/docs/, Braintrust docs: https://www.braintrust.dev/docs/platform/playground | Monitoring and evals should be framed as gates before owned artifacts, not the final product |
| Fine-tuning/distillation | OpenPipe docs: https://docs.openpipe.ai/overview, Predibase docs: https://docs.predibase.com/fine-tuning/overview, Together fine-tuning: https://docs.together.ai/docs/fine-tuning-overview | Training pages must connect capture, review, holdouts, distill, receipts, and deployable runtime targets |
| Runtime/deployment | Baseten docs: https://docs.baseten.co/overview, Replicate deployments: https://replicate.com/docs/topics/deployments/create-a-deployment, Modal docs: https://frontend.modal.com/docs/guide | Runtime pages must prove portability across cloud, edge, browser, device, CLI/TUI, and air-gapped paths |

## Remaining For Production Finality

| Gate | Required action |
| --- | --- |
| Deploy | Ship these frontend changes to production |
| Production all-route screenshots | Run `npm.cmd run ui:audit -- --all --themes=dark,light --base=https://kolm.ai --no-cli --timeout=20000` |
| Production account auth | Re-run account routes with a valid production session/key and confirm post-auth pages render real tenant data |
| Production object storage readiness | On deployed production, confirm `/account/storage`, `/account/overview`, and `/enterprise/console` call `GET /v1/storage/object-readiness` and show the real Railway/Vercel storage provider state without secret values |
| Production demo check | Scroll to the homepage demo in light and dark mode and confirm the generated artifact appears immediately |
| Backend/prod API finality | Separate backend gate: live `/health`, `/ready`, CLI doctor/whoami/verify/billing without logged-out allowance |
| CLI/docs handoff | CLI generated docs and CLI release gates are owned by the backend/CLI worker; this frontend audit intentionally does not claim CLI finality. Read-only broad public diff still reports separator-stream/trailing-whitespace corruption in `public/docs/cli/models.md`, which must be repaired by the CLI owner before a broad `git diff --check -- public` can pass |

## Commands Run

```powershell
node --check public\nav.js
node --check src\router.js
node scripts\build-api-ref.cjs
node scripts\build-openapi.cjs
npm.cmd run lint:refs
git diff --check -- public/index.html public/enterprise.html public/pricing.html public/upgrade.html public/account.html public/api.html public/roadmap.html public/enterprise/console.html
Select-String -Path public\*.html,public\*\*.html,public\*\*\*.html,public\.well-known\*.json,public\docs\api-routes.json,public\openapi.json -Pattern 'Starter \$|Team \$99|Team \$149|Teams - \$149|Teams is \$149|Business \$999|Business plan|Start Business|Self-serve Business|\$999/mo|\$149/mo|\$2,999/month|Developer \(free\)|signup\?plan=business|upgrade\?plan=business|signup\?plan=enterprise|upgrade\?plan=enterprise|Business and Enterprise|business tier|business plan|Pro \$29|\$29/mo|Team \$99|Team \$149' -CaseSensitive:$false
npm.cmd run ui:audit -- --all --themes=dark --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-dark-all --timeout=20000
npm.cmd run ui:audit -- --all --themes=light --viewports=desktop --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-light-desktop-all --timeout=20000
npm.cmd run ui:audit -- --all --themes=light --viewports=mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-light-mobile-all --timeout=20000
npm.cmd run ui:audit -- --routes=/,/pricing,/upgrade,/enterprise,/enterprise/console,/enterprise/inquiry,/account,/account/overview,/legal,/health-insurance,/use-cases/enterprise-search,/byoc,/roadmap,/roi,/docs/tickets --themes=dark,light --out=reports/ui-surface-audit/2026-05-21Tfrontend-final-focused --timeout=20000
npm.cmd run ui:audit -- --routes=/,/pricing,/enterprise,/upgrade,/account --themes=dark,light --out=reports/ui-surface-audit/2026-05-21Tfrontend-hero-final --timeout=20000
npm.cmd run lint:refs
npm.cmd run ui:audit -- --routes=/account/storage,/account/overview,/enterprise/console --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-object-storage-readiness --timeout=20000
node -e "metadata duplicate sweep across public HTML"
npm.cmd run ui:audit -- --routes=/,/admin,/pricing,/trust,/faq,/account/agent-telemetry,/account/api-keys,/account/artifacts,/account/audit-log,/account/bakeoffs,/account/billing,/account/builds,/account/captured,/account/connectors,/account/datasets,/account/devices,/account/distill-runs,/account/labeling,/account/lake,/account/multimodal-bakeoff,/account/opportunities,/account/overview,/account/privacy-events,/account/repeated-workflows,/account/settings,/account/simulations,/account/storage --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-metadata-pricing-account-polish --timeout=20000
Select-String -Path public\*.html,public\use-cases\*.html -Pattern 'shipped today|ship today|ships today|also shipping|What ships today|What we ship today|today via|this minute|not pursuing today|Today the benchmark|<\/g\/span>|kolm.ai · kolm.ai|Account · Account' -CaseSensitive:$false
git diff --check -- public\admin.html public\index.html public\pricing.html public\capture.html public\roadmap.html public\security.html public\use-cases\agentic-coding.html public\build-your-own.html public\download.html public\education.html public\fintech.html public\how-it-works.html public\migrate.html public\research.html public\spec.html public\vs-predibase.html public\use-cases\capture-and-distill.html public\audit-log.html public\glossary.html public\leaderboard.html public\trust.html
npm.cmd run ui:audit -- --routes=/,/admin,/pricing,/audit-log,/capture,/glossary,/leaderboard,/trust,/roadmap,/security,/use-cases/agentic-coding,/use-cases/capture-and-distill,/build-your-own,/download,/education,/fintech,/how-it-works,/migrate,/research,/spec,/vs-predibase --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-launch-language-polish-final --timeout=20000
npm.cmd run ui:audit -- --routes=/how-it-works,/vs-predibase --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-copy-tail-polish --timeout=20000
npm.cmd run ui:audit -- --routes=/,/api,/articles,/articles/ai-compiler,/articles/kolm-file-format,/audit-log,/build-your-own,/community/twitter-thread,/compare,/compile,/drift,/finance,/finance/architecture,/gov,/learn/deploy-to-phone,/learn/from-openpipe,/learn/from-predibase,/privacy,/quickstart/nl,/research,/research/capture-loop-provenance,/research/k-score-correlation,/research/methods-2026-q2,/research/multi-token-prediction,/use-cases/mobile,/use-cases/web3-verifiable --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-flexible-launch-language-sweep --timeout=20000
npm.cmd run ui:audit -- --routes=/community,/product,/why-kolm,/community/devto-article,/community/discord-bootstrap,/community/hn-launch,/community/twitter-thread,/docs/api,/docs/sdk,/integrations/gitlab-ci,/tutorials/code-review,/tutorials/contract-review,/tutorials/support-triage --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-legacy-nav-canonicalization --timeout=20000
npm.cmd run ui:audit -- --routes=/community/twitter-thread --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-community-nav-fix --timeout=20000
node -e "scan non-CLI public HTML metadata descriptions for clipped/dangling/ellipsis snippets"
node -e "scan non-CLI public HTML titles for SEO display length and replacement-character defects"
node -e "scan non-CLI public HTML head metadata for malformed title/description content attributes"
$files = git diff --name-only -- public | Where-Object { $_ -notlike 'public/docs/cli/*' -and $_ -notlike '*.md' }; git diff --check -- $files
node -e "scan non-CLI public HTML visible text for U+FFFD, private-use, and C1-control encoding artifacts"
npm.cmd run ui:audit -- --routes=/tutorials/openai-drop-in,/tutorials/phi-redactor --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-tutorial-encoding-fix --timeout=20000
npm.cmd run ui:audit -- --routes=/artifacts/example/drift,/leaderboard,/healthcare/assessment,/research/provenance-data-generation,/security/halborn-2026-04,/legal,/threat-model,/articles/running-our-marketing-on-distilled-models,/device-transfer,/docs/sdk,/docs/runtime --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-trust-copy-cleanup --timeout=20000
Select-String -Path public\artifacts\example\drift.html,public\leaderboard.html,public\healthcare\assessment.html,public\research\provenance-data-generation.html,public\security\halborn-2026-04.html,public\legal.html,public\threat-model.html,public\articles\running-our-marketing-on-distilled-models.html,public\device-transfer.html,public\docs\sdk.html,public\docs\runtime.html -Pattern "fake|demo catalog|pre-launch|not production matter|placeholder\)|generic passthrough placeholder|Next hardening|cache -> local artifact" -CaseSensitive:$false
node -e "scan non-CLI public HTML heads for malformed .kolm artifact spacing"
npm.cmd run ui:audit -- --routes=/articles/kolm-file-format,/ask,/defense,/device-transfer,/format/v2,/k-score,/marketplace,/quickstart,/registry,/verify-prod,/whitepaper --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-kolm-artifact-copy-polish --timeout=20000
node -e "scan non-CLI public HTML for duplicate id attributes"
node -e "verify /docs has no stale 350-route / 139-CLI metadata and exactly one reference + one reference-tables anchor"
npm.cmd run ui:audit -- --routes=/docs --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-docs-a11y-metadata-fix --timeout=20000
node -e "scan non-CLI public HTML for missing aria-controls / aria-labelledby / aria-describedby targets"
node -e "scan non-CLI public HTML for href='#', empty href, javascript:, and todo: anchors"
npm.cmd run ui:audit -- --routes=/,/docs,/setup-with-ai,/builder,/roi,/pricing,/security,/enterprise,/quickstart --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-aria-link-cleanup --timeout=20000
node -e "scan non-CLI public HTML form controls for missing label, aria-label, aria-labelledby, or title"
node -e "scan patched form-control lines for malformed missing '<' and accidental '<Input' text"
npm.cmd run ui:audit -- --routes=/account/settings,/account/audit-log,/account,/admin,/capture,/captures,/compile,/dashboard,/roi,/teams,/builder,/baa --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-form-a11y-cleanup --timeout=20000
node -e "scan non-CLI public HTML form buttons for missing type"
node -e "scan non-CLI public HTML target=_blank links for noopener noreferrer"
node -e "scan non-CLI public HTML role=tab buttons for id, aria-controls, and aria-selected"
node -e "scan non-CLI public HTML for duplicate id attributes after tab semantics cleanup"
npm.cmd run ui:audit -- --routes=/admin,/dashboard,/enterprise,/onboard/developer,/quickstart/sdk,/setup-with-ai,/enterprise/inquiry,/hub,/leaderboard,/audit-log --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-tab-link-semantics --timeout=20000
node -e "repair separator-regression non-CLI public HTML from HEAD, then reapply pricing/tab/link semantics"
node -e "scan non-CLI public HTML for malformed tags, missing image alt, target=_blank rel, tab semantics, duplicate ids, stale pricing strings, and metadata snippet length"
npm.cmd run lint:refs
npm.cmd run ui:audit -- --routes=/,/pricing,/signup,/account,/enterprise,/enterprise/inquiry,/admin,/dashboard,/onboard/developer,/quickstart/sdk,/setup-with-ai,/docs,/legal,/finance/architecture,/healthcare/architecture,/community/twitter-thread,/lang/de --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-contract-recovery-polish --timeout=20000
node -e "scan non-CLI public HTML for missing main landmarks, skip-link target mismatches, duplicate main landmarks, H1 count drift, and tag-spacing corruption"
npm.cmd run lint:refs
node scripts/ui-surface-audit.cjs --routes=<125 changed main-landmark routes> --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-main-landmarks --timeout=20000
node -e "restore public/launch-checklist.md from HEAD after separator-stream corruption signature"
node -e "scan 694 public non-CLI text assets for dash/question-mark separator corruption and malformed compact HTML tags"
git diff --check -- public/launch-checklist.md
npm.cmd run lint:refs
node -e "run scoped git diff --check across FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md and 195 modified non-CLI public text assets, excluding public/docs/cli"
git diff --check -- public\index.html
npm.cmd run ui:audit -- --routes=/ --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-hero-h1-correction --timeout=20000
```
