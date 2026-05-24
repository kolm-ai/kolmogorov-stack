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
const CACHE = 'kolm-v75-2026-05-24-frontend-v807-wave707-supplement-v2-wf03-mobile-nav-wf06-breadcrumbs-wf22-trust-bar-wf23-compare-wf24-integrations-wave784-plugins-wave785-cloud-distill-wave835-savings-tracker-wave823-otel-upgrade-wave788-sla-persistent-dashboard-wave827-token-dpo-wave819-vscode-extension-wave824-k8s-wave822-ab-testing-wave829-multimodal-pipeline-wave818-ecosystem-loaders-wave828-reasoning-v2-wave826-runtime-placement-wave821-pipeline-orchestrator-wave831-airgap-wave830-federated-consortium-wave833-cross-lingual-v2-wave834-regulatory-wave825-marketplace-mvp-wave836-warm-paper-redesign-wave837-ink-linen-palette-bleed-fix';
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
