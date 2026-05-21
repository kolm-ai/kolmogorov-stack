(function () {
 function installSurfaceGuard() {
 if (document.getElementById('kolm-surface-guard')) return;
 var style = document.createElement('style');
 style.id = 'kolm-surface-guard';
 style.textContent = [
 'h1:not(#kolm-noop),h2:not(#kolm-noop),h3:not(#kolm-noop),h4:not(#kolm-noop),h5:not(#kolm-noop),h6:not(#kolm-noop),.hero h1:not(#kolm-noop),.home-hero h1:not(#kolm-noop),.page-head h1:not(#kolm-noop),.head h1:not(#kolm-noop),.research-hero h1:not(#kolm-noop),h1.hero-h1:not(#kolm-noop){letter-spacing:0!important;}',
 '.site-nav .nav-item>a{min-width:44px!important;min-height:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;padding-left:8px!important;padding-right:8px!important;}',
 '.mega-menu a{min-height:44px!important;display:flex!important;align-items:center!important;}',
 '.site-actions .theme-toggle{width:44px!important;min-width:44px!important;min-height:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;}',
 '@media (min-width:921px){.nav-toggle{display:none!important;}}@media (max-width:920px){.nav-toggle{width:44px!important;min-width:44px!important;min-height:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;}}',
 '@media (min-width:721px){.site-actions>a:not(.cta):not(.kolm-auth-pill){min-height:44px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;padding-left:8px!important;padding-right:8px!important;}.kolm-auth-pill{min-height:38px!important;display:inline-flex!important;align-items:center!important;}}',
 '@media (max-width:720px){.site-actions>a:not(.cta),header.site .right>a:not(.cta){display:none!important;}.site-actions,header.site .right{gap:6px!important;min-width:0!important;}.site-actions .cta,header.site .right .cta{position:relative!important;width:82px!important;flex:0 0 82px!important;min-width:0!important;padding-left:8px!important;padding-right:8px!important;overflow:hidden!important;white-space:nowrap!important;font-size:0!important;color:transparent!important;-webkit-text-fill-color:transparent!important;}.site-actions .cta::before,header.site .right .cta::before{content:attr(data-mobile-label)!important;position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;color:#08090c!important;-webkit-text-fill-color:#08090c!important;font:650 12px/1 system-ui,sans-serif!important;}[data-theme="light"] .site-actions .cta::before,[data-theme="light"] header.site .right .cta::before{color:#fff3df!important;-webkit-text-fill-color:#fff3df!important;}}'
 ].join('');
 document.head.appendChild(style);
 }
 installSurfaceGuard();
 document.documentElement.classList.add('kolm-sota-ui-v560');

 // Two header conventions in the repo:
 // newer: <header class="site-header"> + .site-nav + .site-actions
 // older: <header class="site"> with .left>nav + .right
 // nav.js handles both: applies the active class on whichever pre-baked
 // 3-item nav already lives in the HTML, then wires mobile toggle clicks.
 // It does NOT rewrite innerHTML; that caused visible layout shift on
 // every navigation as the DOM mutated mid-paint.
 var header = document.querySelector('header.site-header, header.site');
 if (!header) return;
 var brandLink = header.querySelector('a.brand, a.logo');
 if (brandLink && brandLink.textContent.replace(/\s+/g, '').toLowerCase() === 'kolm') {
 brandLink.textContent = 'kolm.ai';
 }

 var isLegacy = header.classList.contains('site') && !header.classList.contains('site-header');
 var nav = isLegacy ? header.querySelector('.left nav, nav') : header.querySelector('.site-nav');
 var actions = isLegacy ? header.querySelector('.right') : header.querySelector('.site-actions');
 if (!nav) return;
 if (!actions && !isLegacy) {
 actions = document.createElement('div');
 actions.className = 'site-actions';
 var wrapForActions = header.querySelector('.wrap') || header;
 wrapForActions.appendChild(actions);
 }
 if (!actions) return;

 // Final guard for legacy pages that still contain late inline CSS blocks.
 // The stylesheet file is the source of truth; this small runtime layer keeps
 // old body-level styles from reintroducing compressed headlines or tiny
 // shared header controls after the finish layer has loaded.
 installSurfaceGuard();

 // Active state only. Path-driven; idempotent; never rewrites innerHTML.
 // W221: canonical six-stage nav
 // (Product | Models | Docs | Pricing | Enterprise plus product-spine stages).
 // Use cases collapse under Product; Research + Training collapse under Docs.
 // /models + /runtimes both activate the Models tab.
 var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
 var prdRe = /^\/(product|use-cases|healthcare|finance|legal|defense|edge|insure|health-insurance|whitepaper|motion|captures|quickstart|compile|run|recall|serve|evolve|anatomy|k-score|build-your-own|integrations)(\/|$)/;
 var modRe = /^\/(models|runtimes|frontier-stack|compute|device|hub|registry|atlas)(\/|$)/;
 var devRe = /^\/(docs|research|training|spec|api|sdk|articles|cookbook|architecture|launch|troubleshooting|faq|press|changelog|benchmarks|leaderboard|kscore-bench|kscore-leaderboard)(\/|$)/;
 var entRe = /^\/(enterprise|customers|roi|baa|teams|tunnels|byoc|airgap|hipaa-mapping|soc2|security|subprocessors|trust|threat-model|slsa|sbom|compliance|compliance-packs|self-host|cloud)(\/|$)/;
 var prRe = /^\/pricing(\/|$)/;

 (function repairInteractiveContracts() {
 function cleanLabel(s) {
 return String(s || '')
 .replace(/[-_]+/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 }
 function labelForControl(el) {
 if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return '';
 var explicit = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
 var wrap = el.closest('label');
 var rowField = el.closest('tr') ? el.closest('tr').querySelector('.field-name') : null;
 var fieldLabel = el.closest('[aria-labelledby]');
 var fieldLabelText = fieldLabel ? document.getElementById(fieldLabel.getAttribute('aria-labelledby')) : null;
 return cleanLabel(
 (explicit && explicit.textContent) ||
 (wrap && wrap.textContent) ||
 (rowField && rowField.textContent) ||
 (fieldLabelText && fieldLabelText.textContent) ||
 el.getAttribute('placeholder') ||
 el.getAttribute('name') ||
 el.id ||
 el.getAttribute('type') ||
 el.tagName
 );
 }
 function repairControls(root) {
 Array.prototype.forEach.call((root || document).querySelectorAll('input:not([type="hidden"]), textarea, select'), function (el) {
 var label = labelForControl(el);
 if (label) el.setAttribute('aria-label', label);
 if ((el.type === 'checkbox' || el.type === 'radio') && !el.closest('.kolm-check-hit')) {
 var hit = el.closest('label');
 if (hit) {
 hit.classList.add('kolm-check-hit');
 } else if (el.parentNode) {
 hit = document.createElement('label');
 hit.className = 'kolm-check-hit';
 hit.setAttribute('aria-label', el.getAttribute('aria-label') || 'Toggle setting');
 el.parentNode.insertBefore(hit, el);
 hit.appendChild(el);
 }
 }
 });
 }
 repairControls(document);
 if (window.MutationObserver && !document.__kolm_control_observer) {
 document.__kolm_control_observer = true;
 new MutationObserver(function (records) {
 for (var i = 0; i < records.length; i++) {
 for (var j = 0; j < records[i].addedNodes.length; j++) {
 var node = records[i].addedNodes[j];
 if (node && node.nodeType === 1) repairControls(node);
 }
 }
 }).observe(document.body, { childList: true, subtree: true });
 }
 var apiFilter = document.getElementById('hide-preview');
 if (apiFilter && !apiFilter.__kolm_wired) {
 apiFilter.__kolm_wired = true;
 if (!apiFilter.getAttribute('aria-label')) apiFilter.setAttribute('aria-label', 'Show reference-ready routes only');
 apiFilter.addEventListener('change', function () {
 document.body.setAttribute('data-api-filter', apiFilter.checked ? 'live' : 'all');
 });
 }
 if (!document.__kolm_copy_wired) {
 document.__kolm_copy_wired = true;
 document.addEventListener('click', function (e) {
 var btn = e.target && e.target.closest ? e.target.closest('button.copy[data-copy-text]') : null;
 if (!btn) return;
 var text = btn.getAttribute('data-copy-text') || '';
 if (!text) return;
 var done = function () {
 btn.textContent = 'copied';
 window.setTimeout(function () { btn.textContent = btn.getAttribute('data-copy-label') || 'copy'; }, 1400);
 };
 if (navigator.clipboard && navigator.clipboard.writeText) {
 navigator.clipboard.writeText(text).then(done, done);
 } else {
 var ta = document.createElement('textarea');
 ta.value = text;
 document.body.appendChild(ta);
 ta.select();
 try { document.execCommand('copy'); } catch (err) {}
 document.body.removeChild(ta);
 done();
 }
 });
 }
 })();

 var anchors = nav.querySelectorAll('a');
 for (var i = 0; i < anchors.length; i++) {
 var a = anchors[i];
 var href = a.getAttribute('href') || '';
 var isActive =
 (href === '/product' && prdRe.test(path)) ||
 (href === '/models' && modRe.test(path)) ||
 (href === '/docs' && devRe.test(path)) ||
 (href === '/pricing' && prRe.test(path)) ||
 (href === '/enterprise'&& entRe.test(path));
 if (isActive) {
 a.classList.add('active');
 a.setAttribute('aria-current', 'page');
 } else {
 a.classList.remove('active');
 a.removeAttribute('aria-current');
 }
 }

 // Reliable desktop mega menus. CSS hover alone left a dead gap between the
 // top tab and the panel on multiple pages. Keep one panel open while the
 // pointer or keyboard focus is inside either the tab or the menu.
 var megaItems = nav.querySelectorAll('.nav-item.has-mega');
 var megaCloseTimer = 0;
 function desktopMegaEnabled() {
 return window.innerWidth > 920;
 }
 function setMegaOpen(item, open) {
 if (!item) return;
 item.classList.toggle('is-open', !!open);
 var top = item.querySelector(':scope > a.nav-top, :scope > a');
 if (top) top.setAttribute('aria-expanded', String(!!open));
 }
 function closeMegas(except) {
 for (var m = 0; m < megaItems.length; m++) {
 if (megaItems[m] !== except) setMegaOpen(megaItems[m], false);
 }
 }
 function openMega(item) {
 if (!desktopMegaEnabled()) return;
 window.clearTimeout(megaCloseTimer);
 closeMegas(item);
 setMegaOpen(item, true);
 }
 function scheduleMegaClose(item) {
 if (!desktopMegaEnabled()) return;
 window.clearTimeout(megaCloseTimer);
 megaCloseTimer = window.setTimeout(function () { setMegaOpen(item, false); }, 120);
 }
 for (var mi = 0; mi < megaItems.length; mi++) {
 (function (item) {
 var top = item.querySelector(':scope > a.nav-top, :scope > a');
 var menu = item.querySelector(':scope > .mega-menu');
 if (!top || !menu) return;
 top.setAttribute('aria-haspopup', 'true');
 top.setAttribute('aria-expanded', 'false');
 item.addEventListener('pointerenter', function () { openMega(item); });
 item.addEventListener('pointerleave', function () { scheduleMegaClose(item); });
 menu.addEventListener('pointerenter', function () { openMega(item); });
 menu.addEventListener('pointerleave', function () { scheduleMegaClose(item); });
 item.addEventListener('focusin', function () { openMega(item); });
 item.addEventListener('focusout', function (e) {
 if (!item.contains(e.relatedTarget)) scheduleMegaClose(item);
 });
 top.addEventListener('keydown', function (e) {
 if (e.key !== 'ArrowDown') return;
 e.preventDefault();
 openMega(item);
 var first = menu.querySelector('a, button, [tabindex]:not([tabindex="-1"])');
 if (first) first.focus();
 });
 })(megaItems[mi]);
 }
 document.addEventListener('pointerdown', function (e) {
 if (!desktopMegaEnabled()) return;
 if (!nav.contains(e.target)) closeMegas();
 });

 // Strip github star button; keep right side compact (theme + sign in + CTA).
 var gh = actions.querySelector('#gh-star, .gh-star');
 if (gh && gh.parentNode) gh.parentNode.removeChild(gh);

 if (!isLegacy && !actions.querySelector('.theme-toggle')) {
 var themeBtn = document.createElement('button');
 themeBtn.type = 'button';
 themeBtn.className = 'theme-toggle';
 themeBtn.setAttribute('aria-label', 'Toggle theme');
 themeBtn.innerHTML = '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
 actions.appendChild(themeBtn);
 }
 if (!isLegacy && !actions.querySelector('a[href="/signin"]')) {
 var signIn = document.createElement('a');
 signIn.href = '/signin';
 signIn.className = 'signin';
 signIn.textContent = 'sign in';
 actions.appendChild(signIn);
 }
 var isAccountShell = /^\/(account|dashboard)(\/|$)/.test(path);
 if (!isLegacy && !actions.querySelector('.cta')) {
 var cta = document.createElement('a');
 cta.href = isAccountShell ? '/account/builds' : '/signup';
 cta.className = 'cta';
 cta.textContent = isAccountShell ? 'New build' : 'Get API key';
 actions.appendChild(cta);
 }
 (function normalizeHeaderCtas() {
 var ctas = actions.querySelectorAll('.cta');
 for (var ci = 0; ci < ctas.length; ci++) {
 var item = ctas[ci];
 if (isAccountShell) {
 item.href = item.getAttribute('href') || '/account/builds';
 if (/start\s+free|get api key|get a key|sign up/i.test(item.textContent || '')) item.textContent = 'New build';
 item.setAttribute('data-mobile-label', 'Build');
 } else {
 item.href = item.getAttribute('href') || '/signup';
 item.textContent = 'Get API key';
 item.setAttribute('data-mobile-label', 'API key');
 }
 }
 })();

 // Auth-aware status pill. Validates the session before showing anything;
 // localStorage alone is not trusted (stale keys from deleted tenants would
 // falsely render "signed in"). Single source of truth = /v1/account 200
 // with api_key in the payload. Cookie session OR x-api-key header
 // authenticates the call; on 401 we wipe stale keys so the pill stays off.
 //
 // wave 100 P1-3: writes go to ks_api_key only (cuts XSS exfil surface 75%);
 // reads still scan READ_FALLBACK so users who logged in pre-migration work,
 // and every successful auth proactively drains the LEGACY_KEYS aliases.
 var WRITE_KEY = 'ks_api_key';
 var READ_FALLBACK = ['kolm_api_key', 'apiKey', 'recipeApiKey', 'ks_api_key'];
 var LEGACY_KEYS = ['kolm_api_key', 'apiKey', 'recipeApiKey'];
 function readKey() {
 try { for (var i = 0; i < READ_FALLBACK.length; i++) { var v = localStorage.getItem(READ_FALLBACK[i]); if (v) return v; } } catch (e) {}
 return '';
 }
 function clearKeys() {
 try { READ_FALLBACK.forEach(function (n) { localStorage.removeItem(n); }); } catch (e) {}
 }
 var existingPill = actions.querySelector('.kolm-auth-pill');
 if (existingPill && existingPill.parentNode) existingPill.parentNode.removeChild(existingPill);
 function renderPill() {
 if (actions.querySelector('.kolm-auth-pill')) return;
 var pill = document.createElement('a');
 pill.href = '/dashboard';
 pill.className = 'kolm-auth-pill kolm-auth-pill--in';
 pill.setAttribute('aria-label', 'Signed in - open dashboard');
 pill.innerHTML = '<span class="dot"></span><span class="lbl">signed in</span>';
 actions.insertBefore(pill, actions.firstChild);
 var signLink = actions.querySelector('a[href="/signin"]');
 if (signLink) {
 signLink.hidden = true;
 signLink.setAttribute('aria-hidden', 'true');
 signLink.style.setProperty('display', 'none', 'important');
 }
 var primary = actions.querySelector('.cta');
 if (primary && !isAccountShell) {
 primary.href = '/dashboard';
 primary.textContent = 'Dashboard';
 primary.setAttribute('data-mobile-label', 'Dash');
 }
 }
 (function validateSession() {
 var localKey = readKey();
 var headers = { accept: 'application/json' };
 if (localKey) headers['x-api-key'] = localKey;
 try {
 fetch('/v1/account', { credentials: 'include', headers: headers })
 .then(function (r) {
 if (r.status === 401 || r.status === 403) { clearKeys(); return null; }
 return r.ok ? r.json() : null;
 })
 .then(function (j) {
 // Canonical signed-in signal = presence of tenant `id` field.
 // /v1/account returns `{admin, tenant}` (no id) for unauth /
 // admin-token responses, and `{id, name, ..., api_key}` for
 // an authenticated real tenant.
 if (j && j.id) {
 if (j.api_key) {
 try {
 localStorage.setItem(WRITE_KEY, j.api_key);
 LEGACY_KEYS.forEach(function (n) { localStorage.removeItem(n); });
 } catch (e) {}
 }
 renderPill();
 } else if (localKey) {
 // 200 but no tenant id (admin token or anon response shape);
 // the localStorage key did not authenticate as a real tenant.
 clearKeys();
 }
 })
 .catch(function () {});
 } catch (e) {}
 })();

 // Theme toggle is pre-baked. Wire the click handler.
 var tt = actions.querySelector('.theme-toggle');
 if (tt && !tt.__kolm_wired) {
 tt.__kolm_wired = true;
 tt.addEventListener('click', function () {
 var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
 var nxt = cur === 'light' ? 'dark' : 'light';
 document.documentElement.setAttribute('data-theme', nxt);
 try { localStorage.setItem('kolm-theme', nxt); } catch (e) {}
 });
 }

 // Mobile nav-toggle is pre-baked. Wire its handler. (Only create if a page
 // didn't get the pre-bake; covers legacy templates we haven't touched.)
 var btn = header.querySelector('.nav-toggle');
 if (!btn) {
 btn = document.createElement('button');
 btn.type = 'button';
 btn.className = 'nav-toggle';
 btn.setAttribute('aria-label', 'Toggle navigation');
 btn.setAttribute('aria-expanded', 'false');
 btn.innerHTML = '<span></span><span></span><span></span>';
 if (!nav.id) nav.id = 'site-nav';
 btn.setAttribute('aria-controls', nav.id);
 actions.insertBefore(btn, actions.firstChild);
 }
 if (btn.__kolm_wired) return;
 btn.__kolm_wired = true;
 if (!nav.id) nav.id = 'site-nav';
 if (!btn.getAttribute('aria-controls')) btn.setAttribute('aria-controls', nav.id);

 function setOpen(open) {
 btn.setAttribute('aria-expanded', String(open));
 nav.classList.toggle('is-open', open);
 document.body.classList.toggle('nav-open', open);
 }
 btn.addEventListener('click', function () {
 setOpen(btn.getAttribute('aria-expanded') !== 'true');
 });
 nav.addEventListener('click', function (e) {
 if (e.target && e.target.tagName === 'A') setOpen(false);
 });
 document.addEventListener('keydown', function (e) {
 if (e.key === 'Escape') {
 closeMegas();
 if (nav.classList.contains('is-open')) setOpen(false);
 }
 });
 window.addEventListener('resize', function () {
 if (window.innerWidth > 920 && nav.classList.contains('is-open')) setOpen(false);
 if (!desktopMegaEnabled()) closeMegas();
 });

 // Product spine: a compact orientation layer for deep pages. It keeps the
 // site from feeling like hundreds of disconnected landing pages while leaving
 // auth/app consoles uncluttered.
 (function injectProductSpine() {
 if (document.querySelector('.kolm-product-spine')) return;
 if (/^\/(account|admin|signin|signup|password-reset|teams-accept)(\/|$)/.test(path)) return;
 var main = document.querySelector('main');
 if (!main || main.querySelector('.home-hero')) return;
 if (main.closest('.app')) return;
 function spineActive(re) { return re.test(path) ? ' aria-current="page"' : ''; }
 var spine = document.createElement('nav');
 spine.className = 'kolm-product-spine';
 spine.setAttribute('aria-label', 'kolm product operating map');
 spine.innerHTML =
 '<a href="/capture"' + spineActive(/^\/(capture|captures|quickstart|api|integrations|docs\/connect|sdks|migrate)(\/|$)/) + '><span>01</span><b>API</b><em>one endpoint</em></a>' +
 '<a href="/captures"' + spineActive(/^\/(captures|docs\/lake|lake|privacy|datasets|labeling)(\/|$)/) + '><span>02</span><b>Data</b><em>capture + review</em></a>' +
 '<a href="/training"' + spineActive(/^\/(training|train|benchmarks|leaderboard|kscore|research|distill|compile|models|registry|marketplace|compare|vs-)(\/|$)/) + '><span>03</span><b>Build</b><em>train + distill</em></a>' +
 '<a href="/runtimes"' + spineActive(/^\/(runtimes|run|device|device-transfer|compute|setup|install)(\/|$)/) + '><span>04</span><b>Run</b><em>edge + devices</em></a>' +
 '<a href="/use-cases"' + spineActive(/^\/(use-cases|healthcare|finance|legal|defense|edge|devtools|insure|saas|eu|gov)(\/|$)/) + '><span>05</span><b>Cases</b><em>buyers + workflows</em></a>' +
 '<a href="/enterprise"' + spineActive(/^\/(enterprise|trust|security|compliance|baa|soc2|slsa|sbom|self-host|airgap|byoc|teams|status|sla)(\/|$)/) + '><span>06</span><b>Trust</b><em>security + audit</em></a>';
 main.parentNode.insertBefore(spine, main);
 })();

 (function injectAccountCommandCenter() {
 if (!/^\/(account|dashboard)(\/|$)/.test(path)) return;
 if (document.querySelector('.kolm-account-command')) return;
 var main = document.querySelector('main');
 if (!main) return;
 document.body.classList.add('kolm-account-surface');
 function escAccount(s) {
 return String(s == null ? '' : s)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 }
 function currentLabel() {
 var h1 = main.querySelector('h1');
 var text = h1 ? h1.textContent.replace(/\s+/g, ' ').replace(/\.$/, '').trim() : '';
 return text || (path === '/dashboard' ? 'Dashboard' : 'Account');
 }
 var current = currentLabel();
 var accountNavGroups = [
 { h: 'Start', links: [['Overview', '/account/overview'], ['Connectors', '/account/connectors'], ['API keys', '/account/api-keys']] },
 { h: 'Capture', links: [['Captured', '/account/captured'], ['Agents', '/account/agent-telemetry'], ['Privacy', '/account/privacy-events']] },
 { h: 'Data', links: [['Lake', '/account/lake'], ['Workflows', '/account/repeated-workflows'], ['Opportunities', '/account/opportunities'], ['Labels', '/account/labeling'], ['Datasets', '/account/datasets']] },
 { h: 'Build', links: [['Simulations', '/account/simulations'], ['Bakeoffs', '/account/bakeoffs'], ['Multimodal', '/account/multimodal-bakeoff'], ['Builds', '/account/builds'], ['Distill runs', '/account/distill-runs'], ['Artifacts', '/account/artifacts']] },
 { h: 'Run', links: [['Devices', '/account/devices'], ['Storage', '/account/storage']] },
 { h: 'Govern', links: [['Billing', '/account/billing'], ['Audit log', '/account/audit-log'], ['Settings', '/account/settings'], ['2FA', '/account/security/2fa']] }
 ];
 function renderAccountSidebar() {
 var side = document.getElementById('account-sidebar');
 if (!side) return;
 side.innerHTML = '<p class="kac-sidebar-note">Product loop</p>' + accountNavGroups.map(function(group) {
 return '<div class="kac-side-group"><h2>' + escAccount(group.h) + '</h2><ul>' + group.links.map(function(pair) {
 var active = path === pair[1] ? ' aria-current="page"' : '';
 return '<li><a href="' + escAccount(pair[1]) + '"' + active + '>' + escAccount(pair[0]) + '</a></li>';
 }).join('') + '</ul></div>';
 }).join('');
 }
 var command = path.indexOf('/account/billing') === 0 ? 'kolm billing usage --json'
 : path.indexOf('/account/connectors') === 0 ? 'kolm capture status --json'
 : path.indexOf('/account/lake') === 0 ? 'kolm lake stats --json'
 : path.indexOf('/account/datasets') === 0 ? 'kolm dataset list --json'
 : path.indexOf('/account/labeling') === 0 ? 'kolm label next --json'
 : path.indexOf('/account/builds') === 0 ? 'kolm jobs --json'
 : path.indexOf('/account/distill') === 0 ? 'kolm distill runs --json'
 : path.indexOf('/account/artifacts') === 0 ? 'kolm artifacts --json'
 : path.indexOf('/account/devices') === 0 ? 'kolm devices list --json'
 : path.indexOf('/account/audit') === 0 ? 'kolm audit --json'
 : 'kolm next --json';
 var band = document.createElement('section');
 band.className = 'kolm-account-command';
 band.setAttribute('aria-label', 'Account command center');
 band.innerHTML =
 '<div class="kac-copy">' +
 '<p class="kac-kicker">operator console</p>' +
 '<h1>' + escAccount(current) + '</h1>' +
 '<p>Your AI operations console: API gateway, data lake, training, artifacts, devices, storage, billing, and governance.</p>' +
 '</div>' +
 '<div class="kac-console" role="img" aria-label="Account product loop">' +
 '<div class="kac-top"><span></span><span></span><span></span><b>' + escAccount(command) + '</b></div>' +
 '<div class="kac-steps">' +
 '<a href="/account/connectors"><span>01</span><b>Gateway</b><em>providers + keys</em></a>' +
 '<a href="/account/captured"><span>02</span><b>Capture</b><em>calls + cost</em></a>' +
 '<a href="/account/privacy-events"><span>03</span><b>Privacy</b><em>policy + vault</em></a>' +
 '<a href="/account/datasets"><span>04</span><b>Datasets</b><em>labels + holdouts</em></a>' +
 '<a href="/account/builds"><span>05</span><b>Train</b><em>distill + eval</em></a>' +
 '<a href="/account/artifacts"><span>06</span><b>Artifacts</b><em>.kolm + receipt</em></a>' +
 '<a href="/account/devices"><span>07</span><b>Devices</b><em>edge + fleet</em></a>' +
 '<a href="/account/audit-log"><span>08</span><b>Govern</b><em>audit + billing</em></a>' +
 '</div>' +
 '<div class="kac-matrix" aria-label="Complete account product matrix">' +
 '<a href="/account/connectors"><b>API wrapper</b><span>One key, base URLs, routing, BYOK.</span></a>' +
 '<a href="/account/privacy-events"><b>Privacy</b><span>PII, PHI, consent, policy, vault.</span></a>' +
 '<a href="/account/multimodal-bakeoff"><b>Multimodal</b><span>Image, audio, video, PDF evals.</span></a>' +
 '<a href="/models"><b>Models</b><span>Gemma, Qwen, Phi, Llama, Mistral.</span></a>' +
 '<a href="/compute"><b>Compute</b><span>Local, SSH, BYOC, GPU, managed.</span></a>' +
 '<a href="/account/distill-runs"><b>Distill</b><span>Teacher, student, adapter, gates.</span></a>' +
 '<a href="/account/agent-telemetry"><b>Agents</b><span>Claude, Cursor, MCP, tool logs.</span></a>' +
 '<a href="/account/storage"><b>Enterprise</b><span>Storage, audit, BAA, air-gap.</span></a>' +
 '</div>' +
 '</div>';
 main.insertBefore(band, main.firstElementChild || main.firstChild);
 renderAccountSidebar();
 })();

 // Generated product media. Each public surface gets a route-aware visual
 // instead of a generic hero decoration, so the site consistently explains
 // how gateway, capture, training, distillation, runtime, and enterprise fit.
 (function injectSurfaceMedia() {
 if (document.querySelector('.kolm-surface-media')) return;
 if (/^\/($|account|admin|dashboard|signin|signup|password-reset|teams-accept|status)(\/|$)/.test(path)) return;
 var main = document.querySelector('main') || document.body;
 if (!main) return;

 function esc(s) {
 return String(s == null ? '' : s)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 }
 function profile(key, eyebrow, title, body, command, steps, stats, primary) {
 return { key: key, eyebrow: eyebrow, title: title, body: body, command: command, steps: steps, stats: stats, primary: primary };
 }
 function surfaceFor(p) {
 if (/^\/(integrations|docs\/connect|sdks|migrate)(\/|$)/.test(p)) {
 return profile('integrations', 'Surface 07 / Integrations', 'Keep your SDK. Change one endpoint.', 'Kolm fits existing SDKs, agents, CI, MCP, Docker, and IDE workflows with one routed endpoint.',
 'kolm capture --port 7402',
 [['Swap', 'Point existing clients at kolm', 'OpenAI, Anthropic, OpenRouter, LangChain'], ['Wire', 'Install into agents and CI', 'Cursor, Claude Code, GitHub, GitLab'], ['Capture', 'Record AI calls with policy', 'Namespace, redact, replay'], ['Compile', 'Promote repeated work', 'Artifact path stays the same']],
 [['sdks', 'ready'], ['agents', 'MCP'], ['ci', 'gated']], '/integrations');
 }
 if (/^\/(use-cases|healthcare|finance|legal|defense|edge|devtools|insure|saas|eu|gov)(\/|$)/.test(p)) {
 return profile('solutions', 'Surface 06 / Solutions', 'Sell the first artifact.', 'Each vertical page names the pain, artifact, compliance proof, and next step.',
 'kolm solution inspect --vertical current',
 [['Pain', 'Cost, latency, privacy, lock-in', 'Say the buyer problem first'], ['Artifact', 'Show the first .kolm', 'PHI redactor, clause extractor, invoice parser'], ['Control', 'Map compliance and review', 'BAA, SOC 2, audit, air-gap'], ['Proof', 'Show benchmark and next step', 'K-score, receipt, quickstart']],
 [['verticals', 'mapped'], ['artifact', 'visible'], ['proof', 'ready']], '/use-cases');
 }
 if (/^\/(capture|captures|quickstart|api|docs\/api|tutorials\/openai-drop-in)(\/|$)/.test(p)) {
 return profile('gateway', 'Surface 01 / API gateway', 'One endpoint captures the work.', 'OpenAI-compatible calls route through Kolm with cost, latency, privacy, and review state attached.',
 'OPENAI_BASE_URL=/v1',
 [['Route', 'Provider calls enter one gateway', 'OpenAI, Anthropic, OpenRouter, local, internal'], ['Observe', 'Trace cost, latency, tools, failures', 'Every event is queryable and replayable'], ['Protect', 'Redact before promotion', 'Secrets and PHI stay out of train rows'], ['Promote', 'Create eval and train candidates', 'Only reviewed rows move forward']],
 [['providers', '5+'], ['trace rows', 'live'], ['review gate', 'on']], '/quickstart');
 }
 if (/^\/(training|train|docs\/training|docs\/eval|docs\/datasets|docs\/tickets|benchmarks|leaderboard|kscore|kscore-bench|kscore-leaderboard|labeling|research)(\/|$)/.test(p)) {
 return profile('training', 'Surface 02 / Training and evals', 'Reviewed data becomes training signal.', 'Capture only matters when reviewed rows, frozen holdouts, evals, and approvals stay visible.',
 'kolm train --from lake --gate k-score',
 [['Mine', 'Find repeated workflows', 'Cluster by namespace, template, and outcome'], ['Review', 'Human-approved labels only', 'Reject noisy or unsafe rows before training'], ['Evaluate', 'Frozen holdouts and bakeoffs', 'Compare candidates against real work'], ['Promote', 'Publish only above threshold', 'Receipts bind data, model, and score']],
 [['holdout', 'frozen'], ['rows', 'approved'], ['score', 'gated']], '/training');
 }
 if (/^\/(distill|compile|build-your-own|models|registry|marketplace|spec|spec-grammar|vs-fine-tune|compare)(\/|$)/.test(p)) {
 return profile('distill', 'Surface 03 / Distill and compile', 'Repeated work becomes a .kolm file.', 'Teacher outputs, smaller specialists, eval gates, quantization, signing, and handoff belong in one build system.',
 'kolm distill namespace --target edge',
 [['Teacher', 'Use frontier outputs as supervision', 'Cross-provider answers can be compared'], ['Student', 'Train a smaller specialist', 'LoRA, adapters, rules, or compiled recipes'], ['Gate', 'Measure against holdout', 'No score, no promotion'], ['Sign', 'Emit a verified .kolm', 'Receipt chain and runtime metadata included']],
 [['artifact', '.kolm'], ['gate', 'K>=0.85'], ['receipt', 'signed']], '/distill');
 }
 if (/^\/(runtimes|run|device|device-transfer|compute|download|hub|setup|install)(\/|$)/.test(p)) {
 return profile('runtime', 'Surface 04 / Runtime targets', 'Run the artifact where the work happens.', 'The same signed artifact moves across browser, WASM, native, GPU, edge, mobile, and air-gap targets.',
 'kolm runtime build --target wasm',
 [['Package', 'Bind model, verifier, and target', 'No ambiguous deployment bundle'], ['Transfer', 'Move through registry or air-gap media', 'Hashes survive the handoff'], ['Run', 'Execute locally or at edge', 'JS, WASM, native, GGUF, ONNX'], ['Report', 'Return receipts and drift signals', 'Operators can prove what ran']],
 [['targets', '6'], ['offline', 'yes'], ['drift', 'tracked']], '/runtimes');
 }
 if (/^\/(enterprise|self-host|airgap|byoc|baa|soc2|slsa|sbom|security|trust|threat-model|compliance|teams|tunnels|status|sla)(\/|$)/.test(p)) {
 return profile('enterprise', 'Surface 08 / Enterprise control', 'Governed AI with receipts.', 'Tenancy, RBAC, redaction policy, audit, self-host, air-gap, billing, and evidence stay explicit.',
 'kolm enterprise verify --tenant acme',
 [['Govern', 'Tenant, role, and key policy', 'Team controls are visible before deploy'], ['Comply', 'BAA, audit log, SBOM, SLSA', 'Evidence links back to runs'], ['Isolate', 'Self-host and air-gap paths', 'No hidden cloud dependency'], ['Attest', 'Receipts for every artifact', 'Who built what, from which data, for which target']],
 [['rbac', 'on'], ['audit', 'append-only'], ['deploy', 'self-host']], '/enterprise');
 }
 if (/^\/(pricing|roi|upgrade|nonprofits)(\/|$)/.test(p)) {
 return profile('pricing', 'Surface 06 / Commercial model', 'Price the loop clearly.', 'Plans map to captured spend, reviewed training inventory, runtime replacement, seats, and controls.',
 'kolm billing tiers',
 [['Measure', 'See spend before changing models', 'Provider and workflow cost by route'], ['Estimate', 'Find repeatable replacement candidates', 'Savings tied to actual captured volume'], ['Choose', 'Match plan to team controls', 'Free, Pro, Team, Enterprise'], ['Expand', 'Add governance when risk grows', 'Seats, audit, BAA, self-host']],
 [['plans', '4'], ['billing', 'usage-aware'], ['controls', 'tiered']], '/pricing');
 }
 if (/^\/(docs|articles|cookbook|tutorials|learn|faq|glossary|whitepaper|why|what-is|how-it-works|changelog|press|community)(\/|$)/.test(p)) {
 return profile('docs', 'Surface 07 / Docs and recipes', 'Docs follow the product loop.', 'Every doc maps back to gateway, lake, training, distillation, runtime, and verification.',
 'kolm docs open --surface current',
 [['Explain', 'Route-specific concept first', 'No orphan content islands'], ['Show', 'Concrete commands and payloads', 'Readers can copy the real path'], ['Verify', 'Link claims to product evidence', 'Receipts, API docs, and examples stay close'], ['Continue', 'Next best action is explicit', 'Docs lead back to a working surface']],
 [['routes', 'indexed'], ['recipes', 'ready'], ['refs', 'linked']], '/docs');
 }
 if (/^\/(vs-|how-vs|migrate|use-cases|case-studies|saas|frontier-stack|sovereign-ai|why-now|why-kolm)(\/|$)/.test(p)) {
 return profile('comparison', 'Surface 08 / Differentiation', 'Comparisons map to migration.', 'Show where alternatives stop and where Kolm continues into data, artifacts, runtimes, and evidence.',
 'kolm compare --path current',
 [['Contrast', 'Name what the alternative owns', 'Gateway, evals, fine-tune, or observability'], ['Prove', 'Show what kolm owns end-to-end', 'Calls to artifact to runtime to receipt'], ['Migrate', 'Map the first switch', 'Base URL, import, or dataset bridge'], ['Close', 'Give the next route', 'Quickstart, product, enterprise, docs']],
 [['gap', 'named'], ['path', 'mapped'], ['proof', 'receipt']], '/product');
 }
 return profile('platform', 'Surface / Product context', 'Every page maps to the owned-AI loop.', 'Wrap calls, capture evidence, improve repeated work, ship artifacts, and operate with governance.',
 'kolm surface inspect',
 [['Wrap', 'One gateway for model calls', 'Start without rewriting the application'], ['Capture', 'Create replayable product evidence', 'Trace, redact, and review'], ['Improve', 'Train or distill what repeats', 'Use reviewed calls and frozen evals'], ['Operate', 'Run and audit the artifact', 'Receipts close the loop']],
 [['loop', 'closed'], ['surface', 'mapped'], ['proof', 'visible']], '/product');
 }

 var cfg = surfaceFor(path);
 var pageTitle = '';
 function isVisibleNode(el) {
 if (!el) return false;
 var cur = el;
 while (cur && cur !== document.documentElement) {
 if (cur.hidden) return false;
 var cs = window.getComputedStyle ? getComputedStyle(cur) : null;
 if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
 cur = cur.parentElement;
 }
 return true;
 }
 var allH1 = Array.prototype.slice.call(main.querySelectorAll('h1'));
 var h1 = allH1.filter(isVisibleNode)[0] || null;
 if (h1) pageTitle = h1.textContent.replace(/\s+/g, ' ').trim();
 var band = document.createElement('section');
 band.className = 'kolm-surface-media kolm-surface-media--' + cfg.key;
 band.setAttribute('aria-label', cfg.eyebrow);
 band.innerHTML =
 '<div class="ksm-shell">' +
 '<div class="ksm-copy">' +
 '<p class="ksm-kicker">' + esc(cfg.eyebrow) + '</p>' +
 '<h2>' + esc(cfg.title) + '</h2>' +
 '<p>' + esc(cfg.body) + '</p>' +
 '<a class="ksm-link" href="' + esc(cfg.primary) + '">Open this surface</a>' +
 '</div>' +
 '<figure class="ksm-console" role="img" aria-label="' + esc(cfg.eyebrow + ': generated media for ' + (pageTitle || path)) + '">' +
 '<div class="ksm-top"><span class="ksm-dot"></span><span class="ksm-dot"></span><span class="ksm-dot"></span><b>' + esc(cfg.command) + '</b></div>' +
 '<div class="ksm-flow">' + cfg.steps.map(function (step, idx) {
 return '<div class="ksm-step"><span>' + String(idx + 1).padStart(2, '0') + '</span><b>' + esc(step[0]) + '</b><strong>' + esc(step[1]) + '</strong><em>' + esc(step[2]) + '</em></div>';
 }).join('') + '</div>' +
 '<div class="ksm-stats">' + cfg.stats.map(function (stat) {
 return '<span><b>' + esc(stat[1]) + '</b>' + esc(stat[0]) + '</span>';
 }).join('') + '</div>' +
 '</figure>' +
 '</div>';

 var pricingBlock = path === '/pricing' ? main.querySelector('.w373-pricing-block') : null;
 if (pricingBlock) {
 var pricingSection = pricingBlock.closest('section') || pricingBlock;
 pricingSection.insertAdjacentElement('afterend', band);
 return;
 }
 var hero = Array.prototype.slice.call(main.querySelectorAll(':scope > section.hero, :scope > .hero, :scope > section[class*="hero"]')).filter(isVisibleNode)[0] || null;
 if (hero && hero.parentNode === main) {
 hero.insertAdjacentElement('afterend', band);
 return;
 }
 if (h1) {
 var after = h1;
 var next = h1.nextElementSibling;
 if (next && /^(P|DIV)$/i.test(next.tagName) && /(lede|kicker|summary|sub|hero)/.test(next.className || '')) after = next;
 band.classList.add('kolm-surface-media--inline');
 after.insertAdjacentElement('afterend', band);
 return;
 }
 main.insertBefore(band, main.firstChild);
 })();
})();
