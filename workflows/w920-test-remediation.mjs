export const meta = {
  name: 'w920-test-remediation',
  description: 'Drive the failing npm test suite toward 0: per-test-file, classify each failure (stale lock-in vs real regression) using git intent, apply test-side fixes in place, report source-side changes for sequential application',
  phases: [{ title: 'Remediate' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const FAILMAP = {
  "billing-tiers.test.js": [
    "Wave4 #4 — enterprise stays sales-led (self_serve: false) at $1,499"
  ],
  "research-docs.test.js": [
    "research-docs #10 - spec-dec doc is referenced from docs/research/README.md"
  ],
  "wave174-verify-prod-drift-card.test.js": [
    "8. card reuses the existing design tokens (--mono, --ink, --bg, --accent, --warn, --bad)"
  ],
  "wave185-k-score-explained.test.js": [
    "14. /k-score-explained uses the canonical design tokens (--accent #10b981, --warn #f0b86b, --bad #ff6b91)"
  ],
  "wave187-format-v2.test.js": [
    "11. /format/v2 declares the consistent design system tokens --accent, --warn, --bad"
  ],
  "wave188-migrate.test.js": [
    "10. Each per-competitor page names at least one \"stay with competitor\" honest-scope case"
  ],
  "wave189-security-kms.test.js": [
    "15. /security KMS section declares --accent + --warn + --bad design tokens"
  ],
  "wave190-artifact-drift-detail.test.js": [
    "13. design tokens --accent + --warn + --bad present"
  ],
  "wave200-quickstart-nl.test.js": [
    "13. light-theme switch IIFE appears in <head> BEFORE body styles (pre-paint)"
  ],
  "wave201-training-data-sources.test.js": [
    "13. design tokens --accent + --warn + --bad all defined"
  ],
  "wave203-tui-repl.test.js": [
    "4. HELP.repl block is present with USAGE + HONEST SCOPE sections"
  ],
  "wave204-post-auth-ui.test.js": [
    "12. /account light-theme switch IIFE runs pre-paint (in <head> before body styles)"
  ],
  "wave206-docs-audit.test.js": [
    "4. every COMPLETION_VERBS entry has at least one inbound docs reference",
    "16. em-dash count per doc is at most the locked baseline (0)"
  ],
  "wave210-final-sweep.test.js": [
    "6. every COMPLETION_VERBS entry has a dispatcher case in cli/kolm.js"
  ],
  "wave211-ci-hotfix.test.js": [
    "W211 #2 — kolm-compile-on-push.yml gates compile job on KOLM_KEY secret",
    "W211 #6 — kolm-ci-pipeline.yml gates compile-test-publish on KOLM_KEY"
  ],
  "wave214-distill-from-captures.test.js": [
    "W214 #10 - cmdDistill routes --from-captures to cmdDistillFromCaptures"
  ],
  "wave218-hw-tier-presets.test.js": [
    "W218 #5 - cmdCompile parses --tier and sets KOLM_HW_TIER + base-model",
    "W218 #6 - cmdCompile lets explicit --base-model override --tier pick"
  ],
  "wave221-nav-consolidation.test.js": [
    "W221 #6 - /use-cases routes still match the Product tab (use-cases collapsed under Product)",
    "W221 #7 - /research and /training routes still highlight the Docs tab (collapsed under Docs)",
    "W221 #8 - /models and /runtimes both highlight the Models tab"
  ],
  "wave224-slop-cut.test.js": [
    "W224 #2 - cut .html files no longer exist in public/",
    "W224 #3 - every cut path has a permanent: true redirect in vercel.json",
    "W224 #4 - no orphan rewrites pointing to cut .html files",
    "W224 #5 - every 301 destination is itself a real surface (file or rewrite-resolvable)",
    "W224 #7 - cut list members are NOT also rewritten (would mask the redirect)"
  ],
  "wave228-brand-disambig.test.js": [
    "W228 #1 - every indexable page <title> ends with \" · kolm.ai\"",
    "W228 #5 - brand-disambig sweep is idempotent (re-run touches 0)"
  ],
  "wave233-detached-sessions.test.js": [
    "W233 cmdCompile detaches when --detach is passed",
    "W233 sessions / resume / rescue listed in COMPLETION_VERBS"
  ],
  "wave236-hermes-agent.test.js": [
    "W236 COMPLETION_VERBS and COMPLETION_SUBS include agent"
  ],
  "wave237-mesh-cluster.test.js": [
    "W237 COMPLETION_VERBS and COMPLETION_SUBS include mesh"
  ],
  "wave238-init-agent.test.js": [
    "W238 COMPLETION_VERBS and COMPLETION_SUBS include init-agent"
  ],
  "wave249-cross-platform.test.js": [
    "W249 #3 - install.sh repo URL is kolm-stack (post-W254)",
    "W249 #4 - install.ps1 repo URL is kolm-stack (post-W254)"
  ],
  "wave252-backend-fixes.test.js": [
    "W252 #1 — stripe webhook returns 503 when idempotency op throws AND tenant.plan unchanged"
  ],
  "wave256-copy-scrub.test.js": [
    "W256 #6 - cli/kolm.js dispatches kolm migrate / wrap / import"
  ],
  "wave260-copy-refresh.test.js": [
    "W260 #27 - sw.js CACHE slug bumped to wave-floor >= 260"
  ],
  "wave262-mcp-installers.test.js": [
    "W262 page - cursor page uses kolm.ai dark theme tokens + light-theme switch",
    "W262 page - continue page uses kolm.ai dark theme tokens + light-theme switch",
    "W262 page - claude-desktop page uses kolm.ai dark theme tokens + light-theme switch",
    "W262 page - vscode page uses kolm.ai dark theme tokens + light-theme switch",
    "W262 page - windsurf page uses kolm.ai dark theme tokens + light-theme switch"
  ],
  "wave264-self-hosted.test.js": [
    "W264 #11 — workers/compile-server kit files exist + no new npm deps"
  ],
  "wave267-nonprofits.test.js": [
    "W267 #4 - brand-anchor span present (W228 invariant)"
  ],
  "wave273-pricing-tiers.test.js": [
    "W273 #8 - legacy Starter alias maps to Pro $49 with email support",
    "W273 #24 - brand-anchor span preserved (W228 anchor / W273 instruction)",
    "W273 #25 - sw.js CACHE slug wave-floor >= 273"
  ],
  "wave274-comparison-pages.test.js": [
    "W274 kolm-vs-openpipe-2026.html has brand-anchor disambiguation span",
    "W274 kolm-vs-openpipe-2026.html ships header nav + footer cross-links",
    "W274 kolm-vs-openpipe-2026.html has at least one cross-link to a sibling W274 page",
    "W274 kolm-vs-predibase-2026.html has brand-anchor disambiguation span",
    "W274 kolm-vs-predibase-2026.html ships header nav + footer cross-links",
    "W274 kolm-vs-predibase-2026.html has at least one cross-link to a sibling W274 page",
    "W274 kolm-vs-together-2026.html has brand-anchor disambiguation span",
    "W274 kolm-vs-together-2026.html ships header nav + footer cross-links",
    "W274 kolm-vs-together-2026.html has at least one cross-link to a sibling W274 page",
    "W274 kolm-vs-bedrock-distill.html has brand-anchor disambiguation span",
    "W274 kolm-vs-bedrock-distill.html ships header nav + footer cross-links",
    "W274 kolm-vs-bedrock-distill.html has at least one cross-link to a sibling W274 page",
    "W274 kolm-vs-proxis.html has brand-anchor disambiguation span",
    "W274 kolm-vs-proxis.html ships header nav + footer cross-links",
    "W274 kolm-vs-proxis.html has at least one cross-link to a sibling W274 page"
  ],
  "wave278-standards-play.test.js": [
    "W278 /spec/rs-1 banner links to /verify-cli and GitHub",
    "W278 /spec/changelog provides diff links per version"
  ],
  "wave301-value-loop-page.test.js": [
    "W301 #11 — 5-anchor W221 nav is intact (Product/Models/Docs/Pricing/Enterprise)"
  ],
  "wave322-325-quickstart-surfaces.test.js": [
    "W32x cli — invariants: title, canonical, nav, skip-link, JSON-LD",
    "W32x api — invariants: title, canonical, nav, skip-link, JSON-LD",
    "W32x sdk — invariants: title, canonical, nav, skip-link, JSON-LD",
    "W32x embed — invariants: title, canonical, nav, skip-link, JSON-LD"
  ],
  "wave373-website.test.js": [
    "W373 #4 - healthcare.html names ssn|mrn|name|dob|address detector classes"
  ],
  "wave375-account.test.js": [
    "W375 #3 - every page has <nav id=\"account-sidebar\"> with all 15 links",
    "W375 #4 - every page has a skip link + <main id=\"main\">",
    "W375 #7 - every page has a data-empty-state element",
    "W375 #15 - devices.html has a test-button row template (data-action=\"test-device\")",
    "W375 #18 - every page has JSON-LD with WebPage + BreadcrumbList",
    "W375 #19 - brand anchor \"kolm.ai\" in first 1200 chars + em-dash count <= 1"
  ],
  "wave409bb-test-hardening.test.js": [
    "W409bb #5 — router-loading tests authenticate (not silently 401)"
  ],
  "wave409efg-production-routes-models.test.js": [
    "W409f #4 — every URL referenced by public/account/*.html resolves on the server router"
  ],
  "wave409i-cli-tui-account-coherence.test.js": [
    "W409i #7 - every /account page carries the W221 5-anchor primary nav block",
    "W409i #8 - every /account page includes an empty-state guidance hint"
  ],
  "wave409z-integration-recipes.test.js": [
    "W409z #6 - each recipe page has the W228 brand-anchor disambiguator"
  ],
  "wave495-integration-honesty.test.js": [
    "W495 #4 - adapter READMEs and metadata point at the real source repo"
  ],
  "wave496-api-base-honesty.test.js": [
    "W496 #1 - public docs and generated specs do not advertise the legacy api subdomain"
  ],
  "wave511-undocumented-route-wording.test.js": [
    "W511 #3 - OpenAPI uses x-kolm-source-indexed instead of x-kolm-stub"
  ],
  "wave526-release-verify-json-mode.test.js": [
    "W526 #8 — running with --skip on every gate yields one parseable JSON line"
  ],
  "wave538-public-surface-polish.test.js": [
    "W538 #2 - public pages avoid unfinished product-language markers",
    "W538 #3 - every public HTML page has crawlable title and description"
  ],
  "wave554-product-experience.test.js": [
    "W554 #5 - post-auth overview has the product command center, not only metrics"
  ],
  "wave707-supplement-bundle.test.js": [
    "W707 #1 supplement.css present with w707 version marker"
  ],
  "wave730-prometheus.test.js": [
    "W730 #12 — /docs/observability/prometheus.html exists with brand-lock content"
  ],
  "wave732-yaml-gha.test.js": [
    "W732 #6 — kolm-distill.yml exists with kolm-distill job + push-trigger comment"
  ],
  "wave733-otel.test.js": [
    "W733 #7 — /docs/observability/opentelemetry.html exists with brand-lock content"
  ],
  "wave735-tool-use.test.js": [
    "W735 #12 — /docs/agents.html exists with brand-lock content"
  ],
  "wave736-guardrails.test.js": [
    "W736 #14 — public/docs/guardrails.html exists with brand-lock content + required sections"
  ],
  "wave738-pipeline.test.js": [
    "W738 #11 — /docs/pipelines.html exists with brand-lock content + schema example"
  ],
  "wave739-lineage.test.js": [
    "W739 #13 — public/docs/lineage.html exists with brand-lock strings + required sections"
  ],
  "wave740-import.test.js": [
    "W740 #12 — /docs/import.html exists with brand-lock strings"
  ],
  "wave741-diagnose.test.js": [
    "W741 #12 — public/docs/diagnose.html exists with brand-lock + schema content",
    "W741 #13 — public/account/diagnose.html exists with fetch to /v1/diagnose"
  ],
  "wave742-gateway-mode.test.js": [
    "W742 #13 — /docs/gateway-mode.html exists with brand-lock + 4-mode table"
  ],
  "wave743-migrate.test.js": [
    "W743 #13 — /docs/migrate.html exists with brand-lock strings + ollama + lmstudio sections"
  ],
  "wave745-failure-modes.test.js": [
    "W745 #13 — public/account/failure-modes.html exists with W745 panel + W741 diagnostic bridge"
  ],
  "wave746-staleness.test.js": [
    "W746 #19 — public/docs/staleness.html exists with brand-lock + formula",
    "W746 #20 — public/account/staleness.html exists with brand-lock + timeline viz"
  ],
  "wave747-drift-alert.test.js": [
    "W747 #20 — public/account/drift-alert.html exists with brand-lock + JSD pill",
    "W747 #21 — public/docs/drift-alert.html exists with brand-lock + math + W709 note"
  ],
  "wave748-seasonal.test.js": [
    "W748 #18 — public/account/seasonal.html exists with brand-lock + viz"
  ],
  "wave749-synthetic.test.js": [
    "W749 #16 — public/account/synthetic.html exists with brand-lock + gap render",
    "W749 #17 — public/docs/synthetic.html exists with brand-lock + honesty contract section"
  ],
  "wave750-copyright.test.js": [
    "W750-followup #19 — public/docs/copyright-scan.html exists w/ brand-lock + heuristic disclaimer"
  ],
  "wave751-verticals.test.js": [
    "W751 #15 — all 5 public/verticals/<id>.html exist with brand-lock + model_slug + case-study skeleton",
    "W751 #16 — public/docs/verticals.html exists with brand-lock H1 + sortable table + all 5 rows"
  ],
  "wave756-kolmbench.test.js": [
    "W756 #15 — public/bench/kolmbench-v1.html exists with brand-lock + leaderboard-table anchor + W807/CC-BY-4.0"
  ],
  "wave759-numeric-accuracy.test.js": [
    "W759 #21 — public/docs/numeric-accuracy.html exists w/ brand-lock + calculator-spec anchor"
  ],
  "wave764-membership-inference.test.js": [
    "W764 #26 — public/security/membership-inference.html exists w/ brand-lock + data-w764 anchors"
  ],
  "wave766-eu-ai-act.test.js": [
    "W766 #22 — public/compliance/eu-ai-act.html exists w/ brand-lock + anchors"
  ],
  "wave787-efficiency.test.js": [
    "W787 #13 - public/docs/efficiency.html exists with W787 IDs + brand H1"
  ],
  "wave818-ecosystem-loaders.test.js": [
    "W818 #10 — public/sw.js cache version bumped to a W818 marker"
  ],
  "wave823-otel-upgrade.test.js": [
    "W823 #8 — public/sw.js cache key bumped with wave823 suffix"
  ],
  "wave824-k8s.test.js": [
    "W824 #21 — public/sw.js cache slug includes the wave824 suffix"
  ],
  "wave825-marketplace.test.js": [
    "W825 #16 — public/sw.js cache token carries wave(\\d{3,4}) ≥ 825 (regex+threshold, not array)"
  ],
  "wave826-runtime-placement.test.js": [
    "W826 #17 — sw.js CACHE includes -wave826-runtime-placement (wave family regex ≥826)"
  ],
  "wave827-token-dpo.test.js": [
    "W827 #10 — W827 marked SHIPPED in KOLM_W707_SYSTEM_UPGRADE_PLAN.md",
    "W827 #11 — public/sw.js cache slug carries a wave token >= 827"
  ],
  "wave828-reasoning-v2.test.js": [
    "W828 #11 — KOLM_W707_SYSTEM_UPGRADE_PLAN.md marks W828 SHIPPED",
    "W828 #12 — public/sw.js bumped with wave828-reasoning-v2 suffix"
  ],
  "wave829-multimodal-pipeline.test.js": [
    "W829 #9 — sw.js wave token matches `wave(\\d{3,4})` and includes a token >=829"
  ],
  "wave830-federated-consortium.test.js": [
    "W830 #12 - W604 brand-anchor + Frontier H1 regex pattern present"
  ],
  "wave831-airgap.test.js": [
    "W831 #12 — public/sw.js cache name carries the wave831 token"
  ],
  "wave833-cross-lingual.test.js": [
    "W833 #15 — public/sw.js carries the wave833 suffix"
  ],
  "wave834-regulatory.test.js": [
    "W834 #24 — public/sw.js carries -wave834- suffix + W604 wave token regex+threshold (NEVER explicit array)",
    "W834 #25 — KOLM_W707_SYSTEM_UPGRADE_PLAN.md marks W834 SHIPPED 2026-05-24"
  ],
  "wave868-homepage-receipt.test.js": [
    "W868 #4 - receipt artifact markup is rendered in HTML body",
    "W868 #5 - sw.js CACHE slug contains wave868 token"
  ],
  "wave889-11-e2e-ship-gate.test.js": [
    "W889-11.1 #4+5+6+12 — ship-gate runs to completion with 52/52 pass coverage"
  ],
  "wave889-8-12-verticals-vs.test.js": [
    "W889-8.1 #3 — every vertical links to /account/signup + /book-demo with industry=<v>",
    "W889-8.1 #4 — every vertical contains distill / run / verify trio"
  ],
  "wave889-9-10-spec-marketplace.test.js": [
    "W889-10.1 #10 — marketplace.html contains \"coming soon\" (case-insensitive)"
  ],
  "wave890-14-performance.test.js": [
    "lock-in 14: ship-gate reports 52/52 green"
  ],
  "wave890-16-final-verification.test.js": [
    "W890-16 #1 — step 1 test-all passed",
    "W890-16 #10 — aggregate verdict: all-pass OR blockers ⊆ {5, 8, 9}",
    "W890-16 #15 — plan ledger row shows W890-16 status"
  ],
  "wave890-8-storage.test.js": [
    "lock-in 12: ship-gate reports 52/52 green"
  ],
  "wave918-wave2-surfaces.test.js": [
    "W918-W2-15 — public/sw.js declares CACHE_VERSION = 155 and CACHE string includes \"wave918-wave2\""
  ]
}
const entries = Object.entries(FAILMAP)

const SHARED = ['cli/kolm.js', 'src/router.js', 'public/nav.js', 'public/ks.css', 'public/design-tokens.css', 'public/sw.js', 'scripts/ship-gate.cjs', 'scripts/release-verify.cjs', 'scripts/build-api-ref.cjs', 'scripts/build-openapi.cjs']

const SCHEMA = {
  type: 'object',
  required: ['file', 'test_side_fixed', 'needs_source', 'still_failing', 'node_fail_count', 'summary'],
  properties: {
    file: { type: 'string' },
    test_side_fixed: {
      type: 'array', items: {
        type: 'object', required: ['name', 'classification', 'change'],
        properties: {
          name: { type: 'string' },
          classification: { enum: ['stale-literal-pin', 'design-token-migrated', 'brand-evolved', 'wording-scrubbed', 'url-renamed', 'other-stale'] },
          change: { type: 'string' },
          git_evidence: { type: 'string' },
        },
      },
    },
    needs_source: {
      type: 'array', items: {
        type: 'object', required: ['name', 'target_file', 'change', 'reason'],
        properties: {
          name: { type: 'string' },
          target_file: { type: 'string' },
          change: { type: 'string' },
          reason: { enum: ['real-regression-restore', 'missing-cli-feature', 'backend-bug', 'shared-file-change', 'other'] },
          git_evidence: { type: 'string' },
        },
      },
    },
    still_failing: { type: 'array', items: { type: 'string' } },
    node_fail_count: { type: 'number' },
    summary: { type: 'string' },
  },
}

const PROMPT = (file, names) => `You are remediating ONE failing test file so the kolm test suite moves toward 0 failures.
REPO: ${REPO} — run every command from there.
Your file: tests/${file}
Failing test(s):
${names.map(n => '  • ' + n).join('\n')}

PROCEDURE
1. Read tests/${file}; locate each failing test by its title.
2. For each, read the file(s)/exports it asserts on. Use git to learn INTENT:
     git log --oneline -15 -- <target>
     git log -p -S "<missing or changed token>" -- <target>
   The commit MESSAGE reveals whether a change was deliberate.
3. CLASSIFY each failing test as A (stale → fix the TEST) or B (real → REPORT a source change):
   A) STALE LOCK-IN — fix the TEST in place:
      - literal sw.js wave-slug / CACHE_VERSION pins → convert to the repo's documented convention:
        const waves=[...src.matchAll(/wave(\\d{3,4})/g)].map(m=>+m[1]); assert Math.max(...waves) >= <floor>;
        and DELETE any literal-suffix assertion (e.g. includes('wave868')). The W604/W829 rule is regex+threshold, NEVER a literal token/array.
      - old design-token hex pins (e.g. #10b981 / --warn / --bad) the site migrated past (cool-slate) → update the expected value to what ks.css / design-tokens.css NOW defines (read them).
      - brand wording the product DELIBERATELY changed per a git commit (e.g. W917 brand-suffix strip; eyebrow rename) → update the expected string to the current intended one.
      - STANDING USER DIRECTIVE: never use the word "honest"/"honesty" anywhere. Any test asserting 'HONEST SCOPE' / 'honest-scope' wording is stale → update it to the replacement wording the page/CLI now uses (read the target; likely 'SCOPE' / 'LIMITATIONS' / 'CAVEATS').
      - renamed repo/url (kolm-stack → kolm-ai/kolm) → update the expected url to current.
   B) REAL REGRESSION / MISSING — do NOT weaken the test; REPORT a source change in needs_source:
      - content lost as UNINTENTIONAL collateral (no deliberate commit removed it): a missing 'Not Kolm therapeutics' anti-collision line, a dropped ks-foot footer, a missing data-anchor, a dropped required section → report restoring it to the target page (give the exact markup).
      - a CLI verb present in COMPLETION_VERBS but lacking a dispatcher case, or a missing flag → report the source change (verbs represent real features; never delete them to pass).
      - any backend/route/logic assertion (status code, envelope shape, route existence, security gate) → report the source fix.
4. APPLY only category-A fixes, editing ONLY tests/${file}. Touch NO other file.
   Any change to a non-test file (.html/.css/.js/.cjs/.py/.json/.yml) goes in needs_source, NOT applied.
   NEVER edit (even to report-as-applied) these SHARED files: ${SHARED.join(', ')}.
5. VERIFY: run exactly  node --test tests/${file}  and record the resulting 'fail N' number as node_fail_count.
6. Return the schema. Cite git evidence for each classification.

HARD RULES: never make a test pass by deleting a meaningful assertion; never weaken a real behavioral check; prefer the documented regex+threshold convention for version/slug pins; when unsure whether a removal was intentional, treat it as a REAL regression and REPORT a restore (do not silently relax).`

const results = await parallel(entries.map(([file, names]) => () =>
  agent(PROMPT(file, names), { schema: SCHEMA, label: `fix:${file.replace('.test.js', '')}`, phase: 'Remediate' })
))

const ok = results.filter(Boolean)
return {
  files_processed: ok.length,
  total_files: entries.length,
  test_side_fixed_count: ok.reduce((n, r) => n + (r.test_side_fixed || []).length, 0),
  needs_source: ok.flatMap(r => (r.needs_source || []).map(s => ({ from_test: r.file, ...s }))),
  still_failing: ok.flatMap(r => (r.still_failing || []).map(t => ({ file: r.file, test: t }))),
  per_file: ok.map(r => ({ file: r.file, fixed: (r.test_side_fixed || []).length, needs_source: (r.needs_source || []).length, node_fail_count: r.node_fail_count, summary: r.summary })),
}
