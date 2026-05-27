// Recipe service worker: keeps the registry available offline.
// wave token via regex+threshold (`wave(\d{3,4})` ≥ 835), NOT an explicit
// array, so future waves don't require touching the test.
//   to 7 routes that returned 404 in prod. src/router.js gained POST
//   /v1/devices/add (form-shape translator: nested connection:{host,user,key_path,
//   base_url} -> flat DeviceRegistry payload + URL-parse Ollama base_url), POST
//   /v1/devices/remove (POST shim — fleet.html doesn't issue DELETE), GET
//   /v1/fleet/status, POST /v1/fleet/deploy, POST /v1/fleet/rollback, POST
//   /v1/fleet/stop, GET /v1/fleet/monitor. All wrap the existing Fleet class
//   from src/fleet.js via a _w896BuildFleet(deviceFilter) helper that proxies
//   listDevices() to narrow Fleet ops to a single device when {device} is
//   passed. Browser confirm() pre-gates destructive actions so the routes treat
//   {device} as implicit confirm:true. Smoke: all 7 routes return 200 with
//   sane shapes against a fresh local DB. Bumps CACHE_VERSION 120->121.
//   CLI strings + 8 help-text section banners (HONESTY CONTRACT -> OPERATING
//   CONTRACT, HONEST SCOPE -> SCOPE, HONESTY -> CAVEATS, HONEST DISCLOSURE ->
//   DISCLOSURE); replaced ANSI burnt-sienna accent (208) with cool slate (117)
//   per cool-slate-only directive; replaced warm-tan preview pill in
//   marketplace.html (#a8b3c2) with cool slate dashed border; wired 3 dead
//   Discord href="#" in community.html to https://discord.gg/kolm (canonical
//   from discord-bootstrap.html) with rel="noopener"; added missing
//   #why-footnote anchor target in index.html. Bumps CACHE_VERSION 121->122.
//   (terminal + browser + receipt; 6 chapters, 70s, scrub bar, replay/pause,
//   mobile responsive, cool slate); created /verify hub page that links the
//   three verifier paths (browser drop-in, standalone CLI, hosted registry)
//   with paste-a-CID shortcut; src/router.js + server.js static-handler
//   regexes now accept periods in URL paths (was rejecting /docs/spec/dot-kolm-v1.0
//   because ".0" was treated as a file extension); vercel.json /verify rewrite
//   redirected from /quickstart.html to /verify.html. Bumps CACHE_VERSION 122->123.
//   the public site honestly reflected the state of the build. Fixes:
//   (1) 14 HTML title-tag duplicates "X · kolm.ai · kolm.ai" -> "X · kolm.ai"
//       (index, about, book-demo, 6 docs*.html via scripts/w850-redline-globals.cjs (skipping articles/kolm-ai-vs-kolm-therapeutics.html which is intentional disambiguation content) + og-card.svg -> brand-hero.png on every og:image/twitter:image meta tag. (2) Homepage free tier 10k -> 50k gateway calls to match /pricing claim. (3) "Moved to /compare" 290-line legacy 40-row table block deleted from index.html; replaced with 4-line slim test-anchor preserving #compare/.home-cmp/.kolm-col lock-in selectors + "Full 40-row teardown at /compare" link. (4) NEW "01 / Three surfaces, one product" magazine-spread section inserted above the "Inside the file" rule — three cool-slate cards (Route & Capture / Distill & Compile / Run & Govern) with step numbers, the Distill card carrying Teacher Council copy and the Route card carrying confidence routing lines; .ks-three-surface CSS block (~160 lines) in warm-paper.css with responsive 980px collapse + [data-theme=dark] override. (5) Chat-legitimacy hardening: eyebrow "Live · /v1/free/chat · same classifier as kolm do", h2 "This box is the CLI. Not a demo.", body copy naming src/intent.js + Apache-2.0, new <details> verify-yourself block with one-line curl proving mode:'free' anon + mode:'auth' soft-auth promotion against /v1/free/chat. .ks-cli-chat__verify CSS (~60 lines) added to warm-paper.css. (6) NEW /about.html — Apache-2.0 mission, founder placeholder (name + photo TBA until user supplies), 6-card "where to go next" grid linking quickstart/manifesto/docs/pricing/email/github. (7) vercel.json /about -> /manifesto permanent redirect REMOVED (was blocking the new /about page). (8) End-to-end chat-legitimacy verified live: anon POST returns mode:'free' verb:capture conf:0.95 + 3-step workflow + remaining:19; authed POST returns mode:'auth' verb:tail command:'kolm tail captures' conf:0.99 — same endpoint, same src/intent.js classifier, soft-auth promotion working. v86 -> v87.
//   "bro our keys are on VERCEL" — Railway's /v1/gateway/dispatch can't see
//   the vendor API keys that live on the kolm.ai Vercel deployment, so the
//   benchmark's gateway leg short-circuited at no_upstream_key 10/10. Code-
//   side fix instead of duplicating keys to Railway: when forwardAnthropic /
//   forwardOpenAI / forwardOpenRouter in src/capture.js find NO local
//   upstreamKey, they now POST through https://kolm.ai/v1/teacher/chat
//   (the same Vercel function already used by the Trinity distill worker)
//   carrying the customer's original kolm bearer. api/teacher-chat.js
//   preserves upstream usage tokens so the receipt's cost_usd estimate is
//   accurate. proxyBearer + proxyBase plumb through gateway-router.js
//   chain entries and src/router.js extracts the bearer from
//   req.headers.authorization. Result: gateway runs end-to-end with real
//   tokens flowing and the wrapper tax (~423 ms) + one extra Vercel hop is
//   the only overhead vs direct. CACHE_VERSION 102 -> 103.
//   receipt attachment intact even when upstream API key absent (returns honest
//   no_upstream_key envelope + signed receipt). Backfilled the 17 advertised
//   surfaces under W-I: public/gateway.html product page + public/docs/gateway,
//   gateway-{providers,receipts,captures,pii,confidence-router,namespaces,deploy,
//   cli,api,sdk,toml,compose,byoc,faq,bench}.html (all generated by
//   scripts/wave887-docs-generator.cjs from a single content manifest, ~10-13KB
//   each, ks-nav + design-tokens + warm-paper + theme-script template).
//   vercel.json gains 17 rewrites (16 /docs/gateway-* + /gateway) and removes
//   the stale /gateway -> /capture 308 redirect; /account/gateway[/providers]
//   rewrites land in the same file. CACHE_VERSION 101 -> 102 for invalidation.
const CACHE = 'kolm-v140-2026-05-28-w908b-xss-lint-safehtml-tagged-template';
const CACHE_VERSION = 140;
// 24 loading-state hints (#loading-status injected at top of <main>), 4
// favicons + 4 empty-state blocks (pipelines/_template, pipelines/index,
// quantize/index, receipts/index), 4 breadcrumbs to /account/overview
// (sla, sustainability, quantize/index, receipts/index), 1 form novalidate
// (audit-log filters), 1 receipt-form pattern (cid pattern=rcpt_.+), 1 color
// regression (w605.css --w605-amber #f8dca0 -> #b8bcc4 cool slate). All 14
// audits at zero misses; ship-gate snapshot 52/52 green.
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
