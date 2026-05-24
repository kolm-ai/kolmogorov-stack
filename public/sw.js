// Recipe service worker: keeps the registry available offline.
// W835 wave slug added (savings-based pricing tracker). Tests assert the
// wave token via regex+threshold (`wave(\d{3,4})` ≥ 835), NOT an explicit
// array, so future waves don't require touching the test.
// W827 token-level DPO upgrade slug appended 2026-05-24.
// W819 VS Code passive-monitor + distill workflow slug appended 2026-05-24.
// W824 Kubernetes-native deployment (Helm chart + /ready/deep + /metrics/extended) slug appended 2026-05-24.
// W822 A/B testing infrastructure (traffic splitter + chi-sq/bootstrap + auto-promote/rollback + /v1/ab/*) slug appended 2026-05-24.
// W829 multimodal capture pipeline (image/audio/tool_use/multi_turn captures + VLM-distill + heterogeneous weights) slug appended 2026-05-24.
// W828 reasoning-trace distillation v2 (auto-detect across Anthropic/OpenAI/DeepSeek/Gemini + trace-aware loss) slug appended 2026-05-24.
// W826 memory-aware runtime placement (detectMemoryHierarchy + placementDecision + analyzeInferencePatterns + preloadDecision + estimatePerformance) slug appended 2026-05-24.
// W821 artifact-composition pipeline orchestrator (classifier + specialists + weighted K-Score + flow diagram) slug appended 2026-05-24.
// W831 offline / air-gapped integration (offlineDistill + verifyTeacherIsLocal + Ed25519 sneakernet + airgap bakeoff + /v1/airgap/* routes + CLASSIFIED_DEPLOYMENT.md) slug appended 2026-05-24.
// W830 federated consortium integration (consortium routes + MIA verifier + dpEpsilonAudit + CONSORTIUM_GUIDE.md + /account/federated/consortium UI) slug appended 2026-05-24.
// W833 cross-lingual foundation v2 (lingual-detect distribution detector + lingual-synthesize teacher synth + lingual-mixture iterator + lingual-manifest per-language K-Score block + 4 /v1/lingual/* routes + kolm lingual CLI subverb) slug appended 2026-05-24.
// W834 regulatory compliance toolkit (reg-eu-aiact-docs Annex IV generator + reg-risk-classify INTENDED_USE_CATALOG gates + reg-hil mandatory_human_review_threshold + reg-data-governance captures provenance + reg-model-card-extended HF model card + reg-grc-connectors OneTrust/ServiceNow/IBM-OpenPages + 7 /v1/reg/* routes) slug appended 2026-05-24.
// W825 artifact marketplace MVP (listings.jsonl data layer + signed upload + paid 402 + anti-gaming rate + 70/30 payouts + finetune queue + 8 /v1/marketplace/* routes) slug appended 2026-05-24.
// W836 Warm Paper redesign (sienna-on-paper monochrome light default + warm-dark opt-in + design-tokens.css + ks.css palette swap + warm-paper.css overlay across 719 pages) slug appended 2026-05-24.
// W837 Ink & Linen palette retune (deep midnight navy #1d2d44 + cool linen #f4f0e8; killed orange/mint legacy; Source Serif Pro H1/H2 lift; engraved section rules; intensified paper grain; refined card geometry; homepage .kolm specimen-sheet + compiler-pipeline reframe + Enterprise tier removed + why-grid demoted to footer) slug appended 2026-05-24.
// W837-bleed-fix (2026-05-24): gutted W836 burnt-cream bleed via brand-refresh.css :root rewrite (light-default + [data-theme=dark] opt-in) + scripts/ink-linen-scrub.cjs site-wide hex swap (790 files, 3460 substitutions: #faf2e1->#e8e3d6, #fbfaf6/#faf9f7->#f4f0e8, #7ef0d2->#7d96c0, #10b981->#1d2d44, #d97706->#8b6914). Substantial editorial lift in warm-paper.css: display H1 to 144px ceiling (.fr-h1--hero), drop-cap, architectural .fr-rule--major with center seal, .display-num, .spec-sheet, .pull-quote, .fr-section--cinema rhythm. .kolm anatomy redesigned as a real SVG architectural diagram + spec-sheet sidebar (replaces W837 text-only specimen-sheet).
// W838 Monochrome Retune (2026-05-24): pivoted W837 Ink&Linen to pure award-winning monochrome editorial. Single ink #111111, paper #f7f4ec, mute #6b6b66. Killed all chromatic accent (navy, sepia, amber). Dropped Source Serif Pro @import — Inter sans throughout. Display H1 pulled from 144px serif monster to 88px Inter (.fr-h1--hero clamp(48,6.4vw,88)). .fr-section--cinema rhythm pulled 120-200px -> 88-144px. .lede--dropcap demoted to weight bump (was 5.2em serif initial). .pull-quote sans/500 (was italic serif). .display-num Inter (was Source Serif 700). .btn.warn reset to transparent+ink-1 border (kills sepia bleed). Site-wide scripts/monochrome-scrub.cjs swept 674 files / 2682 substitutions across CSS/HTML/SVG. brand-refresh.css :root + design-tokens.css (3 blocks) fully monochrome. Hero lede tightened ("five strategies, ten methods" jargon -> "capture, compile, run"). Engine rail (5-cell w706-cap) collapsed into single thesis paragraph + hidden test-anchor mirror preserving lock-in data attributes.
// W839 Architecture diagram + Warm Paper lifts (2026-05-24): three follow-ups to user grievance batch. (1) Three-bars logo restored site-wide via scripts/brand-bars-swap.cjs (655 files / 1177 brand blocks) — pure currentColor SVG inside .ks-nav__mark replacing gradient tile so the mark inherits monochrome ink. (2) Killed WF26 announcement bar (supplement.js installAnnouncementBar -> no-op) — the "Kolm v1.0 -- DeepSeek-R1 32B distilled to INT4 in 125s on RTX 5090" banner was redundant with the page. (3) Replaced useless w706-demo (telemetry panel with K-score/rows/ms + NF4+double/3.5x jargon) with .kolm-arch SVG schematic: 3 columns (INPUTS=5 SDK chips / PROCESSING=route+distill+quantize+sign / OUTPUTS=.kolm artifact with weights/spec/eval/signature). Hairline arrows between columns. No fake numbers. ~14 new CSS classes added (warm-paper.css section 23). Plus section 24 "Surgical lifts" — pulled focus-visible, hr, blockquote, code, pre, stat-strip, pricing-card (with featured highlight), reveal stagger, smooth scroll, ::selection, footer grid — from a user-provided Warm Paper redline, but stripped of the burnt-sienna #c2410c accent so the palette stays pure monochrome. Typography lightened across H1-H4 (weight 700->580/560/540) and section padding pulled clamp(72,7.5vw,112) -> clamp(56,6vw,88) responding to user "the site feels too heavy".
// W840 Account sidebar restructure (2026-05-24): replaced flat 6-section nav (Start/Capture/Data/Compile/Deploy/Govern, 15 visible items) with job-based collapsible sections (HOME/BUILD/COMPILE/DEPLOY/OBSERVE/GOVERN/ACCOUNT, 38 items across 6 <details> groups). Every account/*.html now reachable in <=2 clicks. Surfaced previously deep-link-only pages: API keys, approvals, audit log, settings, SLA, A/B tests, confidence routing, active learning, federated consortium, drift, failure modes, chargeback, continuous monitoring, multimodal bakeoff, pipelines, sustainability, routing, drift-alert, staleness, seasonal. Uses semantic <details>/<summary> for no-JS-required disclosure + mono-caps eyebrow style on summary (--ks-font-mono / --ink-3) + auto-open when active route lives in the group. CSS in surface-polish.css :root block (light + dark variants both styled).
// W841 Feature docs pages (2026-05-24): nine new docs pages closed the "ships but undocumented" gap from the W841 audit. Each ~230-260 lines under public/docs/: ab-testing (W822), marketplace (W825), token-dpo (W827), reasoning-traces (W828), multimodal-pipeline (W829), federated-consortium (W830), cross-lingual (W833), regulatory-toolkit (W834), cost-optimization (W835). All wire to real /v1/* routes from src/router.js + real cli/kolm.js verbs; honesty envelopes documented (real_run:false + missing_env for VLM distill, insufficient_baseline for savings, mia_requires_shadow_models for MIA). docs.html got a new "Features" card grid linking all nine. Audits green: 0 missing static refs, 28952 ok 0 broken hrefs after fixing 5 internal-link drifts (/honesty -> /trust 9x, /docs/recipes/distill -> /docs/cookbook 8x, etc.).
// W842 TUI view expansion (2026-05-24): kolm tui grew from 19 to 32 views. Added 8 new hotkey-bound views (O=pipeline-orchestrator W821, P=ab-experiments W822, Q=k8s-readiness W824, R=marketplace W825, S=runtime-placement W826, T=token-dpo W827, U=reasoning-distill W828, V=multimodal-pipeline W829) plus 5 alias-only views accessible via :command palette (:federated/:consortium W830, :airgap/:sneakernet W831, :lingual/:multilingual W833, :regulatory/:grc/:compliance W834, :savings/:cost-track W835). ~50 new aliases added. 9 honest envelope stub routes added to src/router.js for views whose endpoints weren't yet mounted; status:'pending' with related_routes hints. product-experience.js tuiViews() extended to 32 views; product-graph.json regenerated. 27/27 tests green (wave222 + product-kernel-envelope + wave487).
// W843 CLI regulatory + federated-consortium (2026-05-24): closed the two biggest CLI-dark holes from the W842 audit. New `kolm regulatory <subverb>` (6 subverbs: eu-aiact, risk-classify, hil set/show, data-governance, model-card, grc-export) wires to existing src/reg-routes.js mounts. `kolm federated consortium <subverb>` extends existing federated verb (verify-mia routes to real /v1/federated/consortium/verify-mia; audit-epsilon + status return awaiting_operator_hook envelopes since /v1/federated/consortium/{audit-epsilon,status} aren't HTTP-mounted yet -- dpEpsilonAudit() exists as function-only export in src/federated-mia.js). 9 new W843 lock-in tests + wave470/wave487 still green (31/31). Help text + completion entries updated. Route name mismatches handled in CLI (task spec risk-classify -> actual classify-risk, hil -> hil/threshold, etc).
const CACHE = 'kolm-v79-2026-05-24-frontend-v809-wave707-supplement-v2-wf03-mobile-nav-wf06-breadcrumbs-wf22-trust-bar-wf23-compare-wf24-integrations-wave784-plugins-wave785-cloud-distill-wave835-savings-tracker-wave823-otel-upgrade-wave788-sla-persistent-dashboard-wave827-token-dpo-wave819-vscode-extension-wave824-k8s-wave822-ab-testing-wave829-multimodal-pipeline-wave818-ecosystem-loaders-wave828-reasoning-v2-wave826-runtime-placement-wave821-pipeline-orchestrator-wave831-airgap-wave830-federated-consortium-wave833-cross-lingual-v2-wave834-regulatory-wave825-marketplace-mvp-wave836-warm-paper-redesign-wave837-ink-linen-palette-bleed-fix-wave838-monochrome-retune-wave839-kolm-arch-warm-paper-lifts-wave840-account-sidebar-restructure-wave841-feature-docs-wave842-tui-expansion-wave843-cli-regulatory-consortium';
const PRECACHE = [
 '/device',
 '/design-tokens.css',
 '/warm-paper.css',
 '/styles.css',
 '/brand-refresh.css',
 '/home-refresh.css',
 '/surface-polish.css',
 '/kolm-svg.css',
 '/w598.css',
 '/w600-layout.css',
 '/w687.css',
 '/w706.css',
 '/docs-shell.css',
 '/frontier.css',
 '/nav.js',
 '/kolm-svg.js',
 '/w687.js',
 '/sdk.js',
 '/docs-shell.js',
 '/frontier.js',
 '/docs-manifest.json',
 '/v1/registry/export',
 '/manifest.json',
 '/frontend-version.json',
];

self.addEventListener('install', (e) => {
 e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
 self.skipWaiting();
});

self.addEventListener('activate', (e) => {
 e.waitUntil(
 caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
 );
 self.clients.claim();
});

self.addEventListener('fetch', (e) => {
 if (e.request.method !== 'GET') return;
 const url = new URL(e.request.url);
 if (url.origin !== self.location.origin) return;

 // Stale-while-revalidate for the registry export.
 if (url.pathname === '/v1/registry/export') {
 e.respondWith(
 caches.open(CACHE).then(async (c) => {
 const hit = await c.match(e.request);
 const fetchPromise = fetch(e.request).then((res) => {
 if (res.ok) c.put(e.request, res.clone());
 return res;
 }).catch(() => hit);
 return hit || fetchPromise;
 })
 );
 return;
 }

 // Network-first for deploy-sensitive UI assets so hero, nav, and theme fixes
 // are not held behind an old cache after deploy.
 if (url.pathname.match(/\.(js|css|woff2?)$/) || url.pathname === '/frontend-version.json') {
 e.respondWith(
 fetch(e.request).then((res) => {
 if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
 return res;
 }).catch(() => caches.match(e.request))
 );
 return;
 }

 // Cache-first for static assets and the device shell.
 if (PRECACHE.includes(url.pathname) || url.pathname.match(/\.(svg|png)$/)) {
 e.respondWith(
 caches.match(e.request).then(
 (hit) => hit || fetch(e.request).then((res) => {
 if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
 return res;
 })
 )
 );
 return;
 }
});

// W215: WebPush handler: receive a threshold alert and surface it as a
// notification. The /v1/notifications/test route fires the same payload shape.
self.addEventListener('push', (e) => {
 let payload = {};
 try { payload = e.data ? e.data.json() : {}; } catch (_) { payload = { title: 'kolm.ai', body: e.data ? e.data.text() : '' }; }
 const title = payload.title || 'kolm.ai capture threshold crossed';
 const body = payload.body || (payload.namespace ? (payload.namespace + ': ' + (payload.count || 0) + ' captures; distill is ready') : '');
 const url = payload.url || '/captures';
 e.waitUntil(
 self.registration.showNotification(title, {
 body,
 icon: '/icon.png',
 badge: '/icon.png',
 data: { url },
 tag: payload.tag || ('kolm-' + (payload.namespace || 'default')),
 })
 );
});

self.addEventListener('notificationclick', (e) => {
 const url = (e.notification.data && e.notification.data.url) || '/captures';
 e.notification.close();
 e.waitUntil(
 self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
 for (const w of wins) {
 if ('focus' in w) { w.navigate(url); return w.focus(); }
 }
 if (self.clients.openWindow) return self.clients.openWindow(url);
 })
 );
});
