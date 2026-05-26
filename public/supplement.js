/* W707 supplement bundle (frontend) — WF02 mega-menu, WF03 mobile-nav overlay, WF04 sticky-scroll,
   WF05 Cmd+K, WF06 breadcrumbs, WF25 cookie, WF26 announce.
   Load order: after nav.js. Idempotent — re-invocations are safe. */
(function () {
  'use strict';
  if (window.__kolmSupplementLoaded) return;
  window.__kolmSupplementLoaded = true;

  var SUPPLEMENT_VERSION = 'w707-supp-v2';
  var ANNOUNCE_KEY = 'kolm.announce.dismiss.v1';
  var COOKIE_KEY = 'kolm.cookie.consent.v1';
  var doc = document;

  /* ──────────────── shared helpers ──────────────── */
  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function el(tag, attrs, kids) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (typeof c === 'string') node.appendChild(doc.createTextNode(c));
        else if (c) node.appendChild(c);
      }
    }
    return node;
  }
  function storeGet(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } }
  function storeSet(key, val) { try { window.localStorage.setItem(key, val); } catch (_) {} }

  /* ──────────────── WF26 announcement bar — disabled W838 ────────────────
     User killed the "Kolm v1.0 / DeepSeek-R1 32B distilled to INT4 in 125s"
     banner. The page is the message; no banner needed above it.
     The dismiss-persistence helper is kept (called by future banners) so the
     storage contract stays stable across re-enable cycles. */
  function dismissAnnouncement(reason) { storeSet(ANNOUNCE_KEY, String(reason || '1')); }
  function installAnnouncementBar() { /* no-op; dismissAnnouncement available */ }

  /* ──────────────── WF04 sticky-scroll nav ──────────────── */
  function installStickyNav() {
    var header = $('header.site-header, header.site');
    if (!header) return;
    header.classList.add('kolm-nav--sticky');
    var lastY = window.pageYOffset || 0;
    var ticking = false;
    function tick() {
      var y = window.pageYOffset || 0;
      var dy = y - lastY;
      if (y > 12) header.classList.add('kolm-nav--compact');
      else header.classList.remove('kolm-nav--compact');
      if (y > 240 && dy > 6) header.classList.add('kolm-nav--hidden');
      else if (dy < -2 || y < 80) header.classList.remove('kolm-nav--hidden');
      lastY = y;
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { window.requestAnimationFrame(tick); ticking = true; }
    }, { passive: true });
  }

  /* ──────────────── WF05 Cmd+K palette ──────────────── */
  var CMDK_ITEMS = [
    { group: 'Get started',  title: 'Quickstart',                hint: '/quickstart',       href: '/quickstart' },
    { group: 'Get started',  title: 'Install',                   hint: '/install',          href: '/install' },
    { group: 'Get started',  title: 'Sign up',                   hint: '/signup',           href: '/signup' },
    { group: 'Product',      title: 'Product overview',          hint: '/product',          href: '/product' },
    { group: 'Product',      title: 'How it works',              hint: '/how-it-works',     href: '/how-it-works' },
    { group: 'Product',      title: 'Distill (frontier teacher)',hint: '/distill',          href: '/distill' },
    { group: 'Product',      title: 'Capture (gateway)',         hint: '/capture',          href: '/capture' },
    { group: 'Product',      title: 'Compile (.kolm)',           hint: '/compile',          href: '/compile' },
    { group: 'Product',      title: 'Run (runtime)',             hint: '/runtimes',         href: '/runtimes' },
    { group: 'Product',      title: 'Forge',                     hint: '/forge',            href: '/forge' },
    { group: 'Product',      title: 'Studio',                    hint: '/studio',           href: '/studio' },
    { group: 'Product',      title: 'TUI',                       hint: '/tui',              href: '/tui' },
    { group: 'Quality',      title: 'K-Score methodology',       hint: '/docs/k-score-methodology', href: '/docs/k-score-methodology' },
    { group: 'Quality',      title: 'KolmBench leaderboard',     hint: '/leaderboard',      href: '/leaderboard' },
    { group: 'Quality',      title: 'Benchmarks',                hint: '/benchmarks',       href: '/benchmarks' },
    { group: 'Quality',      title: 'Frozen-eval explainer',     hint: '/frozen-eval',      href: '/frozen-eval' },
    { group: 'Solutions',    title: 'Healthcare',                hint: '/healthcare',       href: '/healthcare' },
    { group: 'Solutions',    title: 'Finance',                   hint: '/finance',          href: '/finance' },
    { group: 'Solutions',    title: 'Legal',                     hint: '/use-cases/legal',  href: '/use-cases/legal' },
    { group: 'Solutions',    title: 'Defense / sovereign AI',    hint: '/defense',          href: '/defense' },
    { group: 'Solutions',    title: 'Enterprise',                hint: '/enterprise',       href: '/enterprise' },
    { group: 'Developer',    title: 'Docs',                      hint: '/docs',             href: '/docs' },
    { group: 'Developer',    title: 'API reference',             hint: '/api',              href: '/api' },
    { group: 'Developer',    title: 'SDKs',                      hint: '/sdks',             href: '/sdks' },
    { group: 'Developer',    title: 'CLI quickstart',            hint: '/docs/quickstart',  href: '/docs/quickstart' },
    { group: 'Developer',    title: 'Keyboard shortcuts',        hint: '/shortcuts',        href: '/shortcuts' },
    { group: 'Developer',    title: 'Changelog',                 hint: '/changelog',        href: '/changelog' },
    { group: 'Developer',    title: 'Integrations',              hint: '/integrations',     href: '/integrations' },
    { group: 'Account',      title: 'Account overview',          hint: '/account',          href: '/account' },
    { group: 'Account',      title: 'Captures',                  hint: '/account/captured', href: '/account/captured' },
    { group: 'Account',      title: 'Artifacts',                 hint: '/account/artifacts',href: '/account/artifacts' },
    { group: 'Account',      title: 'Billing',                   hint: '/account/billing',  href: '/account/billing' },
    { group: 'Account',      title: 'Settings',                  hint: '/account/settings', href: '/account/settings' },
    { group: 'Company',      title: 'Pricing',                   hint: '/pricing',          href: '/pricing' },
    { group: 'Company',      title: 'Security',                  hint: '/security',         href: '/security' },
    { group: 'Company',      title: 'Status',                    hint: '/status',           href: '/status' },
    { group: 'Company',      title: 'Privacy',                   hint: '/privacy',          href: '/privacy' },
    { group: 'Company',      title: 'Terms of service',          hint: '/terms',            href: '/terms' },
    { group: 'Company',      title: 'DPA',                       hint: '/dpa',              href: '/dpa' },
    { group: 'Company',      title: 'Acceptable use',            hint: '/acceptable-use',   href: '/acceptable-use' },
    { group: 'Company',      title: 'Manifesto',                 hint: '/manifesto',        href: '/manifesto' },
    { group: 'Company',      title: 'Community',                 hint: '/community',        href: '/community' }
  ];

  var cmdkOverlay = null;
  var cmdkInput = null;
  var cmdkList = null;
  var cmdkSelected = 0;
  var cmdkFiltered = [];

  function ensureCmdkBuilt() {
    if (cmdkOverlay) return;
    cmdkOverlay = el('div', { class: 'kolm-cmdk__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette', hidden: 'hidden' });
    var panel = el('div', { class: 'kolm-cmdk__panel' });
    cmdkInput = el('input', {
      class: 'kolm-cmdk__input',
      type: 'text',
      placeholder: 'Search pages, docs, account...',
      'aria-label': 'Search',
      autocomplete: 'off',
      spellcheck: 'false'
    });
    cmdkList = el('ul', { class: 'kolm-cmdk__list', role: 'listbox' });
    var footer = el('div', { class: 'kolm-cmdk__footer' });
    footer.innerHTML = '<span><kbd>↑↓</kbd>navigate</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span>';
    panel.appendChild(cmdkInput);
    panel.appendChild(cmdkList);
    panel.appendChild(footer);
    cmdkOverlay.appendChild(panel);
    cmdkOverlay.addEventListener('click', function (e) { if (e.target === cmdkOverlay) closeCmdk(); });
    cmdkInput.addEventListener('input', renderCmdk);
    cmdkInput.addEventListener('keydown', onCmdkKey);
    doc.body.appendChild(cmdkOverlay);
  }

  function openCmdk() {
    ensureCmdkBuilt();
    cmdkInput.value = '';
    cmdkSelected = 0;
    renderCmdk();
    cmdkOverlay.removeAttribute('hidden');
    setTimeout(function () { cmdkInput.focus(); }, 30);
    doc.documentElement.style.overflow = 'hidden';
  }
  function closeCmdk() {
    if (!cmdkOverlay) return;
    cmdkOverlay.setAttribute('hidden', '');
    doc.documentElement.style.overflow = '';
  }

  function renderCmdk() {
    var q = (cmdkInput.value || '').trim().toLowerCase();
    cmdkFiltered = q
      ? CMDK_ITEMS.filter(function (it) {
          return it.title.toLowerCase().indexOf(q) !== -1 ||
                 it.hint.toLowerCase().indexOf(q) !== -1 ||
                 it.group.toLowerCase().indexOf(q) !== -1;
        })
      : CMDK_ITEMS.slice();
    cmdkSelected = 0;
    cmdkList.innerHTML = '';
    if (!cmdkFiltered.length) {
      cmdkList.appendChild(el('li', { class: 'kolm-cmdk__empty', text: 'No matches. Try "docs", "billing", "k-score".' }));
      return;
    }
    var prevGroup = null;
    for (var i = 0; i < cmdkFiltered.length; i++) {
      var it = cmdkFiltered[i];
      if (it.group !== prevGroup) {
        cmdkList.appendChild(el('li', { class: 'kolm-cmdk__group', text: it.group }));
        prevGroup = it.group;
      }
      var li = el('li', {
        class: 'kolm-cmdk__item',
        role: 'option',
        'data-idx': String(i),
        'aria-selected': i === cmdkSelected ? 'true' : 'false'
      }, [
        el('span', { class: 'kolm-cmdk__item-title', text: it.title }),
        el('span', { class: 'kolm-cmdk__item-hint',  text: it.hint })
      ]);
      li.addEventListener('click', (function (item) {
        return function () { window.location.href = item.href; };
      })(it));
      cmdkList.appendChild(li);
    }
  }

  function onCmdkKey(e) {
    var items = $$('.kolm-cmdk__item', cmdkList);
    if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var it = cmdkFiltered[cmdkSelected];
      if (it) window.location.href = it.href;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkSelected = Math.min(cmdkFiltered.length - 1, cmdkSelected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkSelected = Math.max(0, cmdkSelected - 1);
    } else { return; }
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('aria-selected', i === cmdkSelected ? 'true' : 'false');
      if (i === cmdkSelected) items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function installCmdK() {
    doc.addEventListener('keydown', function (e) {
      var meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (cmdkOverlay && !cmdkOverlay.hasAttribute('hidden')) closeCmdk();
        else openCmdk();
      } else if (e.key === '/' && !meta && !e.altKey && !isEditing(doc.activeElement)) {
        e.preventDefault();
        openCmdk();
      }
    });
  }
  function isEditing(node) {
    if (!node) return false;
    var t = (node.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || node.isContentEditable;
  }

  /* Inject a trigger button into header right-side actions when present. */
  function installCmdKTrigger() {
    var actions = $('.site-actions, header.site .right');
    if (!actions) return;
    if (actions.querySelector('.kolm-cmdk__trigger')) return;
    var btn = el('button', { type: 'button', class: 'kolm-cmdk__trigger', 'aria-label': 'Open search (Cmd+K)' }, []);
    btn.innerHTML = '<span>Search</span><kbd>⌘K</kbd>';
    btn.addEventListener('click', openCmdk);
    // place before any CTA button, else just append
    var cta = actions.querySelector('.cta');
    if (cta) actions.insertBefore(btn, cta);
    else actions.appendChild(btn);
  }

  /* ──────────────── WF25 cookie consent ──────────────── */
  function installCookieConsent() {
    if (doc.querySelector('.kolm-cookie')) return;
    if (storeGet(COOKIE_KEY)) return;
    var card = el('div', { class: 'kolm-cookie', role: 'dialog', 'aria-label': 'Cookie preferences' });
    card.innerHTML =
      '<p class="kolm-cookie__title">We use strictly-necessary cookies.</p>' +
      '<p class="kolm-cookie__body">No tracking. No third-party analytics. Just session + theme. ' +
        'Optional analytics is off by default. See <a href="/privacy">privacy</a>.</p>' +
      '<div class="kolm-cookie__row">' +
        '<button type="button" class="kolm-cookie__btn kolm-cookie__btn--primary" data-act="accept">OK</button>' +
        '<button type="button" class="kolm-cookie__btn" data-act="manage">Manage</button>' +
      '</div>' +
      '<p class="kolm-cookie__note">"Manage" opens /privacy where you can opt-in to optional analytics.</p>';
    card.querySelector('[data-act="accept"]').addEventListener('click', function () {
      storeSet(COOKIE_KEY, JSON.stringify({ choice: 'strictly-necessary', ts: Date.now() }));
      card.setAttribute('hidden', '');
    });
    card.querySelector('[data-act="manage"]').addEventListener('click', function () {
      storeSet(COOKIE_KEY, JSON.stringify({ choice: 'managed', ts: Date.now() }));
      window.location.href = '/privacy#cookies';
    });
    doc.body.appendChild(card);
  }

  /* ──────────────── WF02 mega-menu enhancement ──────────────── */
  /* Listens for clicks on nav items annotated with [data-kolm-mega] and renders a panel.
     Falls back gracefully if those triggers don't exist. */
  function installMegaMenu() {
    // W848: KILLED — user reports duplicate dropdowns on the homepage nav.
    // installMegaMenu used to inject .kolm-mega panels whenever a nav item
    // had [data-kolm-mega]. Now stubbed because dropdowns duplicate the
    // already-visible top-level nav links and add no information.
    return;
    /* eslint-disable no-unreachable */
    var triggers = $$('[data-kolm-mega]');
    if (!triggers.length) return;
    var panel = el('div', { class: 'kolm-mega', role: 'menu', 'aria-label': 'Product menu' });
    var inner = el('div', { class: 'kolm-mega__inner' });
    panel.appendChild(inner);
    doc.body.appendChild(panel);
    var schemas = {
      product: [
        { h: 'Build',  items: [
          ['/capture', 'Capture', 'Mirror calls from OpenAI/Anthropic/your gateway'],
          ['/distill', 'Distill', 'Frontier teacher → student'],
          ['/compile', 'Compile', '.kolm artifact, signed + verifiable'],
          ['/forge',   'Forge',   'Quantize, slim, deploy']
        ]},
        { h: 'Run',    items: [
          ['/runtimes',  'Runtimes',     'CPU/GPU/edge/browser'],
          ['/device',    'On-device',    'Mac, Raspberry Pi, Jetson, iPhone'],
          ['/self-host', 'Self-host',    'Docker, Helm, air-gapped'],
          ['/byoc',      'BYOC',         'S3-compatible storage, S3, Azure Blob']
        ]},
        { h: 'Trust',  items: [
          ['/k-score',     'K-Score',     'Quality gate per namespace'],
          ['/leaderboard', 'Leaderboard', 'KolmBench public'],
          ['/security',    'Security',    'Threat model + SBOM'],
          ['/status',      'Status',      'Live system health']
        ]}
      ]
    };
    function open(name) {
      var schema = schemas[name];
      if (!schema) return;
      inner.innerHTML = '';
      for (var i = 0; i < schema.length; i++) {
        var col = el('div', { class: 'kolm-mega__col' });
        col.appendChild(el('h4', { text: schema[i].h }));
        var ul = el('ul');
        for (var j = 0; j < schema[i].items.length; j++) {
          var it = schema[i].items[j];
          var li = el('li');
          var a = el('a', { href: it[0] });
          a.appendChild(doc.createTextNode(it[1]));
          a.appendChild(el('small', { text: it[2] }));
          li.appendChild(a);
          ul.appendChild(li);
        }
        col.appendChild(ul);
        inner.appendChild(col);
      }
      panel.setAttribute('data-open', 'true');
    }
    function close() { panel.removeAttribute('data-open'); }
    triggers.forEach(function (trig) {
      trig.addEventListener('mouseenter', function () { open(trig.getAttribute('data-kolm-mega')); });
      trig.addEventListener('focus',      function () { open(trig.getAttribute('data-kolm-mega')); });
      trig.addEventListener('click', function (e) { e.preventDefault(); open(trig.getAttribute('data-kolm-mega')); });
    });
    panel.addEventListener('mouseleave', close);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  /* ──────────────── WF03 mobile nav full-screen overlay ──────────────── */
  /* Looks for a hamburger trigger via [data-kolm-mobile-nav], a nav element
     (preferred: <nav class="ks-nav">), and projects a curated link list into a
     full-screen sheet. Falls back gracefully if no trigger exists. */
  var MOBILE_NAV_LINKS = [
    { group: 'Product', items: [
      ['/product',     'Product overview'],
      ['/distill',     'Distill'],
      ['/capture',     'Capture'],
      ['/compile',     'Compile'],
      ['/runtimes',    'Run'],
      ['/forge',       'Forge']
    ]},
    { group: 'Trust', items: [
      ['/security',    'Security'],
      ['/status',      'Status'],
      ['/k-score',     'K-Score'],
      ['/leaderboard', 'KolmBench']
    ]},
    { group: 'Developer', items: [
      ['/docs',        'Docs'],
      ['/api',         'API reference'],
      ['/sdks',        'SDKs'],
      ['/shortcuts',   'Shortcuts'],
      ['/changelog',   'Changelog']
    ]},
    { group: 'Company', items: [
      ['/pricing',     'Pricing'],
      ['/enterprise',  'Enterprise'],
      ['/manifesto',   'Manifesto'],
      ['/contact',     'Contact']
    ]}
  ];
  var mobileNavOverlay = null;
  function ensureMobileNavBuilt() {
    if (mobileNavOverlay) return;
    mobileNavOverlay = el('div', {
      class: 'kolm-mobile-nav', role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Site navigation', hidden: 'hidden'
    });
    var sheet = el('div', { class: 'kolm-mobile-nav__sheet' });
    var header = el('div', { class: 'kolm-mobile-nav__head' });
    header.innerHTML = '<span class="kolm-mobile-nav__brand">kolm<b>.ai</b></span>';
    var closeBtn = el('button', {
      type: 'button', class: 'kolm-mobile-nav__close',
      'aria-label': 'Close navigation'
    });
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', closeMobileNav);
    header.appendChild(closeBtn);
    sheet.appendChild(header);
    for (var i = 0; i < MOBILE_NAV_LINKS.length; i++) {
      var g = MOBILE_NAV_LINKS[i];
      var section = el('div', { class: 'kolm-mobile-nav__group' });
      section.appendChild(el('h4', { text: g.group }));
      var ul = el('ul');
      for (var j = 0; j < g.items.length; j++) {
        var it = g.items[j];
        var li = el('li');
        var a = el('a', { href: it[0], text: it[1] });
        li.appendChild(a);
        ul.appendChild(li);
      }
      section.appendChild(ul);
      sheet.appendChild(section);
    }
    var cta = el('div', { class: 'kolm-mobile-nav__cta' });
    cta.innerHTML =
      '<a href="/signup?intent=login" class="kolm-mobile-nav__btn">Sign in</a>' +
      '<a href="/signup" class="kolm-mobile-nav__btn kolm-mobile-nav__btn--primary">Get started</a>';
    sheet.appendChild(cta);
    mobileNavOverlay.appendChild(sheet);
    mobileNavOverlay.addEventListener('click', function (e) {
      if (e.target === mobileNavOverlay) closeMobileNav();
    });
    doc.body.appendChild(mobileNavOverlay);
  }
  function openMobileNav() {
    ensureMobileNavBuilt();
    mobileNavOverlay.removeAttribute('hidden');
    doc.documentElement.style.overflow = 'hidden';
    setTimeout(function () {
      var first = mobileNavOverlay.querySelector('.kolm-mobile-nav__close');
      if (first) first.focus();
    }, 30);
  }
  function closeMobileNav() {
    if (!mobileNavOverlay) return;
    mobileNavOverlay.setAttribute('hidden', '');
    doc.documentElement.style.overflow = '';
  }
  function installMobileNav() {
    // W848: KILLED — second dropdown user reported. The mobile-nav trigger
    // was injecting a hamburger button onto every page (including desktop
    // homepage), then opening a full-screen overlay menu that duplicated
    // the static .ks-nav links already visible. On desktop, two stacked
    // dropdowns appeared. The native nav is already responsive — no
    // separate mobile chrome needed for the launch surfaces.
    return;
    /* eslint-disable no-unreachable */
    var triggers = $$('[data-kolm-mobile-nav]');
    if (!triggers.length) {
      var btn = el('button', {
        type: 'button',
        class: 'kolm-mobile-nav__trigger',
        'aria-label': 'Open navigation',
        'data-kolm-mobile-nav': ''
      });
      btn.innerHTML = '<span></span><span></span><span></span>';
      doc.body.appendChild(btn);
      triggers = [btn];
    }
    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault();
        openMobileNav();
      });
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mobileNavOverlay && !mobileNavOverlay.hasAttribute('hidden')) {
        closeMobileNav();
      }
    });
  }

  /* ──────────────── WF06 breadcrumbs (docs + subpages) ──────────────── */
  /* Auto-generates a breadcrumb trail from window.location.pathname when:
       (a) the page declares <meta name="kolm:breadcrumbs" content="auto">  OR
       (b) the page contains <nav class="kolm-breadcrumbs" data-kolm-auto> placeholder, OR
       (c) the path lives under /docs/ or /account/ and no manual nav.crumbs is present.
     Skips homepage. */
  function installBreadcrumbs() {
    var meta = $('meta[name="kolm:breadcrumbs"]');
    var auto = meta && meta.getAttribute('content') === 'auto';
    var placeholder = $('nav.kolm-breadcrumbs[data-kolm-auto]');
    var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
    var underScopedSection = /^\/(docs|account|use-cases|guides)\//.test(path);
    if (path === '/' || (!auto && !placeholder && !underScopedSection)) return;
    if ($('nav.kolm-breadcrumbs:not([data-kolm-auto])')) return;

    var parts = path.split('/').filter(Boolean);
    var crumbs = [{ href: '/', label: 'Home' }];
    var accum = '';
    for (var i = 0; i < parts.length; i++) {
      accum += '/' + parts[i];
      crumbs.push({ href: accum, label: humanize(parts[i]) });
    }
    var nav = placeholder || el('nav', {
      class: 'kolm-breadcrumbs',
      'aria-label': 'Breadcrumb'
    });
    var ol = el('ol');
    for (var k = 0; k < crumbs.length; k++) {
      var li = el('li');
      if (k === crumbs.length - 1) {
        li.appendChild(el('span', { text: crumbs[k].label, 'aria-current': 'page' }));
      } else {
        li.appendChild(el('a', { href: crumbs[k].href, text: crumbs[k].label }));
        li.appendChild(el('span', { class: 'kolm-breadcrumbs__sep', 'aria-hidden': 'true', text: '/' }));
      }
      ol.appendChild(li);
    }
    nav.innerHTML = '';
    nav.appendChild(ol);
    if (!placeholder) {
      var main = $('main') || doc.body;
      if (main.firstChild) main.insertBefore(nav, main.firstChild);
      else main.appendChild(nav);
    }
  }
  function humanize(seg) {
    var raw = decodeURIComponent(seg).replace(/[-_]+/g, ' ');
    raw = raw.replace(/\.html?$/i, '');
    return raw.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /* ──────────────── bootstrap ──────────────── */
  function boot() {
    try { installAnnouncementBar(); } catch (e) {}
    try { installStickyNav(); }      catch (e) {}
    try { installCmdK(); }           catch (e) {}
    try { installCmdKTrigger(); }    catch (e) {}
    try { installCookieConsent(); }  catch (e) {}
    try { installMegaMenu(); }       catch (e) {}
    try { installMobileNav(); }      catch (e) {}
    try { installBreadcrumbs(); }    catch (e) {}
  }
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.kolmSupplement = {
    version: SUPPLEMENT_VERSION,
    openCmdK: openCmdk,
    closeCmdK: closeCmdk,
    openMobileNav: openMobileNav,
    closeMobileNav: closeMobileNav,
    cmdkItems: CMDK_ITEMS,
    mobileNavLinks: MOBILE_NAV_LINKS
  };
})();
