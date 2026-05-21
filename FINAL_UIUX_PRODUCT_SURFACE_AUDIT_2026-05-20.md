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
| Homepage hero H1 correction | PASS, visible homepage H1 no longer says `Turn model traffic / into owned AI`; it now says `Compile AI. Own it. Run anywhere.` with immediate 11.6x lower cost / 7.4x lower latency proof and Docker-for-AI category framing; `/` audited dark/light desktop/mobile with 0 failures and 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-hero-h1-correction/report.md` |
| Product-grade facelift recheck | PASS, `/`, `/account`, `/pricing`, `/docs`, and `/enterprise` audited in dark/light desktop/mobile after hero, account, nav, mobile-menu, and pricing-first-screen edits, 20 renders, 1,954 visible controls, 16 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-system-facelift-pass5/report.md` |
| Pricing plan-first recheck | PASS, `/pricing` audited in dark/light desktop/mobile after moving generated product media below the pricing grid and pulling plan cards into the first meaningful scroll, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-pricing-plan-first4/report.md` |
| Stale launch/demo copy cleanup | PASS, 705 non-CLI public text assets scanned with `bad: 0` for old hero, demo-catalog, pre-launch, placeholder, fake, and retired low-tier pricing strings; 30 affected routes audited in dark/light desktop/mobile with 120 renders, 6,846 visible controls, 120 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-stale-launch-copy-cleanup/report.md` |
| Account final console pass | PASS, `/account` audited in dark/light desktop/mobile after post-auth product-matrix polish with 4 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-account-final-pass/report.md` |
| Homepage narrative compression | PASS, `/` audited in dark/light desktop/mobile after hiding the old long proof/value-loop blocks, adding the six-surface product band, moving the live product loop directly after the hero, fixing mobile next-section visibility, and tightening CTA arrow contrast; 4 renders, 460 visible controls, 4 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-home-narrative-compression-final/report.md` |
| Buyer trust snippet cleanup | PASS, `/docs`, `/pricing`, and `/enterprise` audited in dark/light desktop/mobile after metadata, route-count, pricing, and enterprise hero copy cleanup; 12 renders, 1,674 visible controls, 12 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-buyer-trust-snippets/report.md` |
| Product/use-case copy density | PASS, `/product`, `/use-cases`, and `/enterprise` audited in dark/light desktop/mobile after shortening long visible paragraphs and removing the last non-CLI `model traffic` metadata phrase; 12 renders, 670 visible controls, 12 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-copy-density-product-surfaces/report.md` plus final `/product` metadata recheck `reports/ui-surface-audit/2026-05-21Tfrontend-product-metadata-final/report.md` |
| Commercial/vertical copy density | PASS, `/healthcare`, `/finance`, `/legal`, `/compare`, `/security`, `/use-cases/agentic-coding`, `/migrate`, and `/api` audited in dark/light desktop/mobile after shortening buyer-facing hero/lede copy; 32 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-commercial-copy-density-final/report.md` |
| Commercial lede density scan | PASS, those 8 commercial/trust/API routes now have `long_total=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 230 visible characters |
| Migration/comparison teardown density | PASS, `/migrate/predibase`, `/migrate/hyperscaler`, `/migrate/diy`, `/migrate/lorax`, `/migrate/openpipe`, `/how-vs-anthropic`, `/how-vs-diy`, `/how-vs-openai-fine-tune`, `/how-vs-hyperscaler`, and `/how-vs-predibase` audited in dark/light desktop/mobile after cutting comparison hero ledes; 40 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-migration-vs-copy-density/report.md` |
| Migration/comparison lede scan | PASS, those 10 routes now have `long_total=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 320 visible characters |
| Artifact/eval/drift copy density | PASS, `/format/v2`, `/frozen-eval`, `/drift`, `/value-loop`, `/compare/kolm-vs-bedrock-distill`, and `/compare/kolm-vs-proxis` audited in dark/light desktop/mobile after cutting artifact, eval, lifecycle, and comparison ledes; 24 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-artifact-eval-drift-copy-density/report.md` |
| Artifact/eval/drift lede scan | PASS, those 6 routes now have `long_total=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 320 visible characters |
| Insurance template copy density | PASS, `/health-insurance` plus 11 payer template pages audited in dark/light desktop/mobile after tightening first-screen template copy; 48 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-insurance-template-copy-density/report.md` |
| Insurance template lede scan | PASS, those 12 routes now have `long_total=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 360 visible characters |
| Research/cookbook copy density | PASS, 11 research, cookbook, article, docs, and capture/distill routes audited in dark/light desktop/mobile after tightening first-screen proof copy; 44 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-research-cookbook-copy-density/report.md` |
| Research/cookbook lede scan | PASS, those 11 routes now have `long_total=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 360 visible characters |
| Final long-lede cleanup | PASS, `/lang/fr`, `/lang/de`, `/use-cases/mobile`, `/articles/ai-compiler-comparison`, `/docs/dev-agents`, and `/compare/kolm-vs-openpipe-2026` audited dark/light desktop/mobile after clearing the final overlong public non-CLI ledes; 24 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-final-long-lede-cleanup/report.md` |
| Public long-lede density | PASS, non-CLI public HTML scan now has `long_count=0` for `.lede`, `.sec-lede`, and `.hero-lede` paragraphs over 360 visible characters across 458 files |
| Final jargon/density sweep | PASS, 519 public non-CLI text assets scanned with `bad=0` for stale hero/demo/launch/pricing/jargon strings including `model traffic`; 19 affected routes audited dark/light desktop/mobile with 76 renders, 2,986 visible controls, 72 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-final-jargon-density/report.md` |
| Hero product-loop v2 | PASS, `/` audited in dark/light desktop/mobile after replacing the dense internal matrix with a clearer `OpenAI call -> signed .kolm -> runs anywhere` story, tighter CTAs, and artifact-led proof; 4 renders, 460 visible controls, 4 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-hero-product-loop-v2/report.md` |
| Frontend deploy fingerprint | PASS, `public/frontend-version.json` added so production can prove it is serving this frontend pass at `https://kolm.ai/frontend-version.json` |
| Frontend cache-bust v2 | PASS, `public/sw.js` cache key bumped to `kolm-v8-2026-05-21-hero-product-loop-v2`, `public/frontend-version.json` added to the precache list, stale-copy scan returned `bad=0`, and `/` re-audited dark/light desktop/mobile with 0 failures and 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-hero-product-loop-cache-v2/report.md` |
| Frontend cache-bust v3 | PASS, `public/sw.js` cache key bumped to `kolm-v9-2026-05-21-account-mobile-nav-v1`, JavaScript changed to network-first in the service worker, and `public/frontend-version.json` now reports `2026-05-21-account-mobile-nav-v1` |
| Production drift recheck | NOT FINAL, live `https://kolm.ai/` still served old homepage copy during this pass, including `Compile your own classifier AI` and `What ships in v0.2 today`; production must be redeployed from this worktree and rechecked before any final claim |
| Demo/media coherence v2 | PASS, `/`, `/account/overview`, and `/case-studies` audited dark/light desktop/mobile after aligning the below-fold demo with the hero story, removing remaining `capture traffic` language, and fixing light-mode demo-stage text contrast; 12 renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-demo-media-coherence-v2/report.md` |
| Manual demo media screenshots | PASS, scrolled demo-region screenshots captured in dark and light mode after the fix; artifact preview is visible immediately and light-mode prompt/artifact text is readable: `reports/ui-surface-audit/2026-05-21Tfrontend-demo-media-coherence/manual-v3/` |
| Account product-matrix/mobile-nav pass | PASS, `/account`, `/account/overview`, `/account/agent-telemetry`, `/account/multimodal-bakeoff`, and `/account/opportunities` audited dark/light desktop/mobile after account-shell copy cleanup, mobile header overflow repair, and light-mode CTA contrast fix; 20 renders, 1,230 visible controls, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-account-mobile-nav-v5/report.md` |
| Global nav/account recheck | PASS, 15 representative routes (`/`, `/product`, `/quickstart`, `/docs`, `/pricing`, `/enterprise`, `/account`, `/account/overview`, `/capture`, `/training`, `/distill`, `/compile`, `/runtimes`, `/integrations`, `/security`) audited dark/light desktop/mobile after the shared nav guard and account console copy changes; 60 renders, 3,970 visible controls, 52 product media renders, 0 failures, 0 warnings: `reports/ui-surface-audit/2026-05-21Tfrontend-global-nav-account-v1/report.md` |
| Monolithic all-route note | The monolithic combined audit produced screenshots but failed during late cleanup/report generation, so the complete evidence set is the three PASS split reports above |
| Targeted demo screenshots | Homepage, pricing, capture, leaderboard, account, upgrade, and enterprise screenshots were inspected from the final report directories |
| Markup integrity | PASS, scanner found `bad: 0` malformed public HTML files |
| SEO metadata | PASS, scanner found `issues: 0` across public HTML title, description, canonical, and OG/Twitter metadata |
| SEO metadata deep cleanup | PASS, non-CLI public HTML title/description scanner found `metadata_description_issues=0`, `title_issues=0`, and `malformed_meta_lines=0` after targeted cleanup |
| Metadata duplicate sweep | PASS, account pages no longer publish duplicate `Account · Account` titles/social cards, and no public HTML title repeats `kolm.ai · kolm.ai` |
| Stale pricing/CTA sweep | PASS, no old Starter/Business/direct Enterprise signup patterns remained in public pages, API docs, OpenAPI, or AI context |
| Static refs | PASS, latest run `missing static refs: 0`, `broken: 0`, `ok: 31379`; product verifier still 7 certified surfaces, 112 route groups, 378 routes |
| Product surface verifier | PASS, 7 certified surfaces, 112 route groups, 378 routes, 29 research refs |
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
| Nav polish | Removed competing underline styles, added consistent active/focus states, tightened mega-menu cards, fixed mobile menu opacity, and restored light-mode parity |
| Homepage hero | Rewrote the above-the-fold promise to `Compile AI. Own it. Run anywhere.` with one-base-URL API wrapping, owned `.kolm` artifacts, cloud/edge/browser/CLI/TUI/enterprise coverage, and visible speed/cost proof |
| Homepage demo | Fixed light-mode demo contrast by binding the dark demo stage to light-safe ink tokens |
| Demo first frame | Added a useful static first frame and accelerated the scene so a `.kolm` artifact appears immediately instead of an empty panel |
| Pricing | Re-aligned visible pricing to Free, Pro $49/mo, Team $499/mo, Enterprise custom; moved generated media below the tier grid and compressed the hero so plan cards are visible immediately |
| Account plan selector | Removed visible stale Starter/Business pricing options from the account plan UI |
| Account console | Rebuilt the post-auth first screen into one operator console, removed duplicate page-head hierarchy, and kept a concise product matrix covering API wrapper, privacy, multimodal, models, compute, distill, agents/MCP, and enterprise |
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
| Homepage hero H1 correction | Replaced the visible homepage hero headline from `Turn model traffic / into owned AI / Run anywhere` to `Compile AI. Own it. Run anywhere.`, made speed/cost proof visible immediately below the H1, and tightened the lede around the Docker-for-AI/base-URL/.kolm artifact story |
| Final stale-copy cleanup | Removed remaining non-CLI public copy that made production surfaces feel unfinished: `demo catalog`, `placeholder)`, `ship(s) today`, `pre-launch`, `$99/mo`, fake/garbage language, and stale classifier/traffic hero phrasing; kept the wording concise and artifact-led across leaderboard, capture, build-your-own, download, education, fintech, security, spec, comparison, threat model, device transfer, use-case, changelog, article, finance, migration, pricing, research, roadmap, and security report surfaces |
| Homepage narrative compression | Replaced the remaining visible "approved model traffic" hero phrasing with direct AI-call/artifact language, shortened the right-side product loop copy, added a compact Wrap/Capture/Review/Build/Run/Govern surface band, hid the older W404/W410 long proof sections from the visible story, pulled the live loop immediately after the hero, and ensured both desktop and mobile show the next product section within the first viewport |
| Buyer trust snippets | Updated docs metadata and visible API-reference count to the current `378` routes / `112` groups, removed stale exact CLI-verb count from docs copy, simplified pricing snippets to Free / Pro / Team / Enterprise, and rewrote Enterprise metadata plus hero copy around governed owned AI, self-host/air-gap, BAA, SSO, audit logs, SBOM/SLSA, private registry, and architecture review |
| Product/use-case copy density | Shortened overlong enterprise pilot, procurement, demo, and architecture-review copy; compressed `/use-cases` hero and vertical descriptions; rewrote `/product` away from "model traffic" toward AI-call, dataset, eval, distill, artifact, runtime, and audit language |
| Commercial/vertical copy density | Shortened healthcare, finance, legal, comparison, security, agentic-coding, migration, and API buyer copy; removed the compare `ship-day` phrasing; made API, security, and migration pages read as public product surfaces instead of internal specs |
| Migration/comparison teardown copy | Rewrote five migration subpages and five comparison teardowns so each first screen states the tradeoff directly: keep existing serving where it works, use frontier APIs as teachers where useful, and choose kolm when the deliverable must be a signed portable artifact |
| Artifact/eval/drift copy density | Rewrote `.kolm` format v2, frozen evals, drift/supersession, value loop, Bedrock distillation comparison, and Proxis comparison ledes so technical pages open with the buyer meaning before the verifier internals |
| Insurance template copy density | Rewrote health-insurance and payer-template ledes so claims, prior-auth, EDI, FHIR, HEDIS, CMS Star, NPI, MLR, and ICD/CPT surfaces read as product workflows before showing clinical/regulatory details |
| Research/cookbook copy density | Rewrote methods, file-format, drift-detail, document-ingestion, capture/distill, federated compile, PHI/SOAP redactor, judges, K-score methodology, and rent-vs-buy compute ledes so search-entry pages start with product value before implementation proof |
| Final long-lede cleanup | Shortened the remaining localized, mobile, dev-agent, comparison, and AI compiler comparison ledes; removed the remaining visible `Shipping today` phrasing from the mobile use-case page |
| Sitewide jargon cleanup | Removed the remaining public non-CLI `model traffic` phrasing from metadata, AI context, LLM context, generated media copy, and the public-surface generator; replaced it with clearer AI-call/workflow language |
| Hero product-loop v2 | Rewrote the homepage lede, artifact proof line, CTAs, and right-side demo panel around the concrete flow: change one base URL, capture real AI calls, compile repeated work into a signed `.kolm`, then run it without the original API |
| Frontend deploy fingerprint | Added `public/frontend-version.json` with the expected hero H1, product-loop phrase, pricing model, source commit at edit time, and stale strings that must not appear after deploy |
| Frontend cache-bust v2 | Bumped the service worker cache key for the latest hero/product-loop pass, precached the frontend fingerprint endpoint, and removed the old cache-key label from public non-CLI text so returning visitors get a clean activation boundary after deploy |
| Demo/media coherence v2 | Added a product-led demo heading, rewrote the cinematic demo labels around `API call -> score -> signed artifact -> run anywhere`, made the first artifact card visible immediately instead of leaving a blank stage, and fixed light-mode contrast inside the dark demo canvas |
| Residual traffic-language cleanup | Replaced remaining non-CLI `capture traffic` copy in account overview empty state, case-study index lede, and homepage metadata with direct `capture AI calls` language |
| Account command center polish | Enabled the polished account shell directly on `/account/overview`, rewrote the overview and product-matrix copy around connect/capture/review/compile/run/govern, renamed `Captured traffic` to `Captured AI calls`, and cleaned post-auth empty states for agent telemetry, multimodal bakeoffs, opportunities, and account landing copy |
| Mobile nav repair | Changed the runtime header guard so non-CTA header links are desktop-only, reduced the mobile CTA to a single compact `Start` label, fixed light-mode CTA contrast, and verified no clipped header controls on account and representative marketing/docs/product routes |
| Frontend cache-bust v3 | Bumped the service worker cache to `kolm-v9-2026-05-21-account-mobile-nav-v1`, made JavaScript network-first so nav fixes are not trapped behind cache-first `nav.js`, updated the frontend fingerprint version, and cleaned the service-worker notification copy |

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
node --check public\nav.js
git diff --check -- public\nav.js public\surface-polish.css public\home-refresh.css public\index.html public\account.html public\pricing.html FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
npm.cmd run ui:audit -- --routes=/,/account,/pricing,/docs,/enterprise --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-system-facelift-pass5 --timeout=20000
npm.cmd run ui:audit -- --routes=/pricing --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-pricing-plan-first4 --timeout=20000
node -e "scan 705 public non-CLI text assets for stale launch/demo/placeholder/pricing/jargon strings; result bad=0"
git diff --check -- FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md public/account.html public/home-refresh.css public/index.html public/nav.js public/pricing.html public/surface-polish.css public/capture.html public/build-your-own.html public/download.html public/education.html public/fintech.html public/security.html public/spec.html public/vs-predibase.html public/threat-model.html public/device-transfer.html public/use-cases/capture-and-distill.html public/use-cases/index.html public/use-cases/ai-saas.html public/changelog.html public/articles/ai-compiler.html public/articles/index.html public/articles/running-our-marketing-on-distilled-models.html public/finance/architecture.html public/how-it-works.html public/leaderboard.html public/learn/from-openpipe.html public/manifesto.html public/migrate.html public/research/multi-token-prediction.html public/research.html public/roadmap.html public/security/halborn-2026-04.html public/og/articles-running-our-marketing-on-distilled-models.svg public/og/leaderboard.svg public/spec/rs-1.html
npm.cmd run ui:audit -- --routes=/,/capture,/build-your-own,/download,/education,/fintech,/security,/spec,/vs-predibase,/threat-model,/device-transfer,/use-cases/capture-and-distill,/use-cases,/use-cases/ai-saas,/changelog,/articles/ai-compiler,/articles,/articles/running-our-marketing-on-distilled-models,/finance/architecture,/how-it-works,/leaderboard,/learn/from-openpipe,/manifesto,/migrate,/pricing,/research/multi-token-prediction,/research,/roadmap,/security/halborn-2026-04,/spec/rs-1 --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-stale-launch-copy-cleanup --timeout=20000
npm.cmd run ui:audit -- --routes=/account --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-account-final-pass --timeout=20000
git diff --check -- public\index.html public\home-refresh.css FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
node -e "scan 705 public non-CLI text assets for stale launch/demo/placeholder/pricing/jargon strings after homepage narrative compression; result bad=0"
npm.cmd run lint:refs
npm.cmd run ui:audit -- --routes=/ --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-home-narrative-compression-final --timeout=20000
npm.cmd run ui:audit -- --routes=/docs,/pricing,/enterprise --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-buyer-trust-snippets --timeout=20000
Select-String -Path public\docs.html -Pattern "350 routes|139 CLI|350 documented|106 groups|Docs guide" -CaseSensitive:$false
git diff --check -- public\docs.html public\pricing.html public\enterprise.html
npm.cmd run lint:refs
node -e "scan public non-CLI HTML paragraphs >=260 chars to identify copy-density hotspots"
npm.cmd run ui:audit -- --routes=/product,/use-cases,/enterprise --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-copy-density-product-surfaces --timeout=20000
node -e "scan product/use-case/enterprise for stale model-traffic, launch, demo, placeholder, fake, and retired pricing phrases"
npm.cmd run ui:audit -- --routes=/product --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-product-metadata-final --timeout=20000
node -e "scan 705 public non-CLI text assets for stale launch/demo/placeholder/pricing/jargon strings after copy-density pass; result bad=0"
npm.cmd run lint:refs
git diff --check -- public\security.html public\use-cases\agentic-coding.html public\migrate.html public\api.html public\healthcare.html public\finance.html public\legal.html public\compare.html
node -e "scan 8 commercial/trust/API routes for .lede/.sec-lede/.hero-lede paragraphs >230 visible characters; result long_total=0"
node -e "scan 705 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings after commercial copy-density pass; result bad=0"
npm.cmd run lint:refs
npm.cmd run ui:audit -- --routes=/healthcare,/finance,/legal,/compare,/security,/use-cases/agentic-coding,/migrate,/api --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-commercial-copy-density-final --timeout=20000
git diff --check -- public\migrate\predibase.html public\migrate\hyperscaler.html public\migrate\diy.html public\migrate\lorax.html public\migrate\openpipe.html public\how-vs-anthropic.html public\how-vs-diy.html public\how-vs-openai-fine-tune.html public\how-vs-hyperscaler.html public\how-vs-predibase.html
node -e "scan 10 migration/comparison routes for .lede/.sec-lede/.hero-lede paragraphs >320 visible characters; result long_total=0"
npm.cmd run ui:audit -- --routes=/migrate/predibase,/migrate/hyperscaler,/migrate/diy,/migrate/lorax,/migrate/openpipe,/how-vs-anthropic,/how-vs-diy,/how-vs-openai-fine-tune,/how-vs-hyperscaler,/how-vs-predibase --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-migration-vs-copy-density --timeout=20000
node -e "scan 705 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings after migration/comparison pass; result bad=0"
npm.cmd run lint:refs
git diff --check -- public\format\v2.html public\frozen-eval.html public\drift.html public\value-loop.html public\compare\kolm-vs-bedrock-distill.html public\compare\kolm-vs-proxis.html
node -e "scan 6 artifact/eval/drift routes for .lede/.sec-lede/.hero-lede paragraphs >320 visible characters; result long_total=0"
npm.cmd run ui:audit -- --routes=/format/v2,/frozen-eval,/drift,/value-loop,/compare/kolm-vs-bedrock-distill,/compare/kolm-vs-proxis --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-artifact-eval-drift-copy-density --timeout=20000
node -e "scan 705 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings after artifact/eval/drift pass; result bad=0"
npm.cmd run lint:refs
git diff --check -- public\health-insurance.html public\insurance\templates\denial-appeal-letter.html public\insurance\templates\hedis-cbp.html public\insurance\templates\prior-auth-letter.html public\insurance\templates\fhir-uscdi.html public\insurance\templates\icd10-cpt-crosswalk.html public\insurance\templates\mlr-rebate.html public\insurance\templates\cms-star.html public\insurance\templates\npi-directory.html public\insurance\templates\edi-278.html public\insurance\templates\edi-834.html public\insurance\templates\edi-270-271.html
node -e "scan 12 insurance/product-template routes for .lede/.sec-lede/.hero-lede paragraphs >360 visible characters; result long_total=0"
npm.cmd run ui:audit -- --routes=/health-insurance,/insurance/templates/denial-appeal-letter,/insurance/templates/hedis-cbp,/insurance/templates/prior-auth-letter,/insurance/templates/fhir-uscdi,/insurance/templates/icd10-cpt-crosswalk,/insurance/templates/mlr-rebate,/insurance/templates/cms-star,/insurance/templates/npi-directory,/insurance/templates/edi-278,/insurance/templates/edi-834,/insurance/templates/edi-270-271 --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-insurance-template-copy-density --timeout=20000
node -e "scan 705 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings after insurance-template pass; result bad=0"
npm.cmd run lint:refs
git diff --check -- public\research\methods-2026-q2.html public\articles\kolm-file-format.html public\artifacts\example\drift.html public\research\document-ingestion.html public\use-cases\capture-and-distill.html public\research\federated-compile.html public\cookbook\phi-redactor.html public\research\judges.html public\cookbook\soap-redactor.html public\docs\k-score-methodology.html public\articles\rent-vs-buy-compute.html
node -e "scan 11 research/cookbook/article/docs routes for .lede/.sec-lede/.hero-lede paragraphs >360 visible characters; result long_total=0"
npm.cmd run ui:audit -- --routes=/research/methods-2026-q2,/articles/kolm-file-format,/artifacts/example/drift,/research/document-ingestion,/use-cases/capture-and-distill,/research/federated-compile,/cookbook/phi-redactor,/research/judges,/cookbook/soap-redactor,/docs/k-score-methodology,/articles/rent-vs-buy-compute --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-research-cookbook-copy-density --timeout=20000
node -e "scan 705 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings after research/cookbook pass; result bad=0"
npm.cmd run lint:refs
git diff --check -- public\lang\fr\index.html public\lang\de\index.html public\use-cases\mobile.html public\articles\ai-compiler-comparison.html public\docs\dev-agents.html public\compare\kolm-vs-openpipe-2026.html
node -e "scan final localized/mobile/dev-agent/comparison routes for .lede/.sec-lede/.hero-lede paragraphs >360 visible characters; result long_total=0"
npm.cmd run ui:audit -- --routes=/lang/fr,/lang/de,/use-cases/mobile,/articles/ai-compiler-comparison,/docs/dev-agents,/compare/kolm-vs-openpipe-2026 --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-final-long-lede-cleanup --timeout=20000
node -e "scan 519 public non-CLI text assets for stale hero/demo/launch/placeholder/pricing/jargon strings including model traffic; result bad=0"
node -e "scan 458 non-CLI public HTML files for .lede/.sec-lede/.hero-lede paragraphs >360 visible characters; result long_count=0"
npm.cmd run lint:refs
node --check public\nav.js
node --check scripts\finish-public-surface.mjs
git diff --check -- public\.well-known\ai-context.json public\articles\kolm-ai-vs-kolm-therapeutics.html public\articles\kolm-artifact-walkthrough.html public\case-studies\finance-sr11-7.html public\case-studies\index.html public\case-studies\legal-contract-extraction.html public\compliance\index.html public\cookbook\daily-recap.html public\docs\cve-in-kscore.html public\finance-v2.html public\integrations\zed.html public\lang\ja\index.html public\llms.txt public\nav.js public\research\k-sampling.html public\teams-accept.html scripts\finish-public-surface.mjs public\lang\fr\index.html public\lang\de\index.html public\use-cases\mobile.html public\articles\ai-compiler-comparison.html public\docs\dev-agents.html public\compare\kolm-vs-openpipe-2026.html
npm.cmd run ui:audit -- --routes=/lang/fr,/lang/de,/use-cases/mobile,/articles/ai-compiler-comparison,/docs/dev-agents,/compare/kolm-vs-openpipe-2026,/finance-v2,/teams-accept,/articles/kolm-ai-vs-kolm-therapeutics,/articles/kolm-artifact-walkthrough,/case-studies/finance-sr11-7,/case-studies,/case-studies/legal-contract-extraction,/compliance,/cookbook/daily-recap,/docs/cve-in-kscore,/integrations/zed,/lang/ja,/research/k-sampling --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-final-jargon-density --timeout=20000
git diff --check -- public\index.html public\frontend-version.json FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
node -e "JSON.parse(require('fs').readFileSync('public/frontend-version.json','utf8')); console.log('frontend-version: ok')"
npm.cmd run ui:audit -- --routes=/ --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-hero-product-loop-v2 --timeout=20000
npm.cmd run lint:refs
node --check public\sw.js
node -e "scan public non-CLI text assets for stale hero/demo/launch/pricing/cache-key strings after service-worker cache-bust; result bad=0"
git diff --check -- public\sw.js public\index.html public\frontend-version.json FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
npm.cmd run ui:audit -- --routes=/ --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-hero-product-loop-cache-v2 --timeout=20000
npm.cmd run lint:refs
git diff --check -- public\index.html public\home-refresh.css public\account\overview.html public\case-studies\index.html public\sw.js public\frontend-version.json FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
node -e "scan public non-CLI text assets for stale hero/demo/launch/pricing/cache-key/traffic strings after demo-media pass; result bad=0"
node --check public\sw.js
node --check public\nav.js
node -e "JSON.parse(require('fs').readFileSync('public/frontend-version.json','utf8')); console.log('frontend-version: ok')"
npm.cmd run ui:audit -- --routes=/,/account/overview,/case-studies --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-demo-media-coherence-v2 --timeout=20000
node --input-type=module -e "manual Playwright demo-region dark/light screenshots written to reports/ui-surface-audit/2026-05-21Tfrontend-demo-media-coherence/manual-v3"
npm.cmd run lint:refs
node --check public\nav.js
node --check public\sw.js
node -e "JSON.parse(require('fs').readFileSync('public/frontend-version.json','utf8')); console.log('frontend-version: ok')"
node -e "scan public non-CLI text assets for stale hero/demo/launch/pricing/cache-key/traffic strings after account mobile-nav pass; result bad=0"
git diff --check -- public\nav.js public\surface-polish.css public\account.html public\account\overview.html public\account\agent-telemetry.html public\account\multimodal-bakeoff.html public\account\opportunities.html public\sw.js public\frontend-version.json public\index.html public\home-refresh.css public\case-studies\index.html FINAL_UIUX_PRODUCT_SURFACE_AUDIT_2026-05-20.md
npm.cmd run lint:refs
npm.cmd run ui:audit -- --routes=/account,/account/overview,/account/agent-telemetry,/account/multimodal-bakeoff,/account/opportunities --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-account-mobile-nav-v5 --timeout=20000
npm.cmd run ui:audit -- --routes=/,/product,/quickstart,/docs,/pricing,/enterprise,/account,/account/overview,/capture,/training,/distill,/compile,/runtimes,/integrations,/security --themes=dark,light --viewports=desktop,mobile --no-cli --out=reports/ui-surface-audit/2026-05-21Tfrontend-global-nav-account-v1 --timeout=20000
```
