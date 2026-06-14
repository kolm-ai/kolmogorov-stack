// kolm-2026.js - shared page behavior for the rebuild. Load with `defer`.
// Dark is the only theme (2026: the theme-toggle path was dead weight, removed).
//   <script defer src="/kolm-2026.js"></script>

(function () {
  'use strict';

  // ---- browser chrome color tracks the live --room token (the page floor;
  // one theme, dark). Note: under KOLM_DESIGN_SYSTEM.md the floor is --room and
  // --paper is now the lit artifact sheet, so we read --room here. Falls back to
  // --paper for any page still on the legacy token. ----
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var cs = getComputedStyle(document.documentElement);
    var room = (cs.getPropertyValue('--room') || cs.getPropertyValue('--paper')).trim();
    if (room && room.charAt(0) === '#') meta.setAttribute('content', room);
  }

  // ---- reveal-on-scroll (gated by prefers-reduced-motion via the CSS rule) ----
  function wireReveal() {
    // Signal that the reveal observer initialized - the inline head failsafe keys
    // off this to tell "observer ran" from "script never loaded" (so it can fail
    // open without falsely disabling the animation when reveals are below the fold).
    document.documentElement.setAttribute('data-reveal-armed', '1');
    // [data-art-reveal] joins the observed set (ART DEPTH v3.1 seam devices):
    // purely additive - same .in class, same fail-open contract as .reveal.
    var els = document.querySelectorAll('.reveal, [data-art-reveal]');
    if (!els.length) return;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });

    // ---- artifact sweep: stagger the register values "in" on enter (motion-allowed
    // only; fail-open end-state is CSS - opacity:1 + lit pip + .is-sealed). The CSS
    // only hides [data-val] while a parent [data-sweep] artifact is NOT sealed, so we
    // briefly unseal, stagger each value into view in read order, then re-seal. ----
    var sweeps = document.querySelectorAll('[data-sweep] .artifact, .artifact[data-sweep]');
    if (!sweeps.length || reduce) return;
    var sio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        sio.unobserve(e.target);
        var art = e.target;
        art.classList.remove('is-sealed');
        var vals = art.querySelectorAll('.register__v[data-val]');
        vals.forEach(function (v, i) {
          v.style.opacity = '';
          setTimeout(function () { v.style.opacity = '1'; }, 120 + i * 70);
        });
        setTimeout(function () {
          art.classList.add('is-sealed');
          vals.forEach(function (v) { v.style.opacity = ''; });
        }, 120 + vals.length * 70 + 160);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.2 });
    sweeps.forEach(function (a) { sio.observe(a); });
  }

  // ---- mobile nav (hamburger panel; desktop unaffected) ----
  function wireNav() {
    var nav = document.querySelector('.nav');
    var toggle = nav && nav.querySelector('.nav__toggle');
    if (!nav || !toggle) return;
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.querySelectorAll('.nav__links a').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('is-open') && !nav.contains(e.target)) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
      // outside click also collapses any open desktop dropdown
      if (!nav.contains(e.target)) {
        nav.querySelectorAll('.nav__top[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
      }
    });

    // dropdown a11y: click toggles aria-expanded; Esc & focus-out close
    nav.querySelectorAll('[data-menu]').forEach(function (g) {
      var btn = g.querySelector('.nav__top'); if (!btn) return;
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        nav.querySelectorAll('.nav__top[aria-expanded]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      g.addEventListener('keydown', function (e) { if (e.key === 'Escape') { btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
      g.addEventListener('focusout', function () { requestAnimationFrame(function () { if (!g.contains(document.activeElement)) btn.setAttribute('aria-expanded', 'false'); }); });
    });
    // glass thickens on scroll
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 8); };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // ---- Phosphor Field: feed --mx/--my (fine pointer + motion-allowed only).
  // No render loop - drift is pure CSS; JS only writes two vars, rAF-throttled.
  // Fail-open: with JS off the field renders its static CSS end-state (drift +
  // masked layers); the reactive depth glow is the only thing this adds. ----
  function wireField() {
    var mqMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
    var mqFine = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)');
    if (!mqFine || !mqFine.matches || (mqMotion && mqMotion.matches)) return;
    document.querySelectorAll('.field').forEach(function (f) {
      var sec = f.parentElement; if (!sec) return; var raf = 0;
      sec.addEventListener('pointermove', function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          var r = sec.getBoundingClientRect();
          f.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
          f.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
          raf = 0;
        });
      }, { passive: true });
    });
  }

  // ---- pointer-tracked card light (CSS renders it; we only feed --mx/--my).
  // Desktop fine-pointer only; rAF-coalesced so pointermove never floods layout. ----
  function wirePointerLight() {
    if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var sel = '.card, .step, .tier, .flow__node';
    var pending = null;
    document.addEventListener('pointermove', function (e) {
      var t = e.target && e.target.closest ? e.target.closest(sel) : null;
      if (!t) return;
      if (pending) { pending.t = t; pending.x = e.clientX; pending.y = e.clientY; return; }
      pending = { t: t, x: e.clientX, y: e.clientY };
      requestAnimationFrame(function () {
        var p = pending; pending = null;
        var r = p.t.getBoundingClientRect();
        if (!r.width || !r.height) return;
        p.t.style.setProperty('--mx', (((p.x - r.left) / r.width) * 100).toFixed(1) + '%');
        p.t.style.setProperty('--my', (((p.y - r.top) / r.height) * 100).toFixed(1) + '%');
      });
    }, { passive: true });
  }

  // ---- metric count-up: opt-in via data-count on a pure-number node.
  // Fail-open: the real value is already in the markup; we only animate toward it. ----
  function wireCount() {
    var els = document.querySelectorAll('[data-count]');
    if (!els.length) return;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        var el = en.target;
        var m = (el.textContent || '').trim().match(/^(\d[\d,]*)(.*)$/);
        if (!m) return;
        var target = parseInt(m[1].replace(/,/g, ''), 10);
        var suffix = m[2] || '';
        var hasComma = m[1].indexOf(',') !== -1;
        if (!isFinite(target) || target <= 0) return;
        var t0 = null, DUR = 900;
        function frame(ts) {
          if (t0 === null) t0 = ts;
          var p = Math.min(1, (ts - t0) / DUR);
          var eased = 1 - Math.pow(1 - p, 3);
          var v = Math.round(target * eased);
          el.textContent = (hasComma ? v.toLocaleString('en-US') : String(v)) + suffix;
          if (p < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
    }, { threshold: 0.4 });
    els.forEach(function (el) { io.observe(el); });
  }

  // ---- Premium backdrop: inject the fixed "Captured Signal" volumetric field
  // once, site-wide (atmosphere + shafts are CSS; we only add the drifting capture
  // motes). Fail-open: no JS = the page's dark floor; CSS carries the static field.
  // Reduced-motion = a calm lit still (frozen shafts + scattered motes). ----
  function wireBackdrop() {
    if (document.querySelector('.bg')) return;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var bg = document.createElement('div');
    bg.className = 'bg'; bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = '<div class="bg__haze"></div><div class="bg__shaft bg__shaft--a"></div><div class="bg__shaft bg__shaft--b"></div><div class="bg__motes"></div>';
    var grain = document.createElement('div');
    grain.className = 'bg__grain'; grain.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(grain, document.body.firstChild);
    document.body.insertBefore(bg, document.body.firstChild);
    var host = bg.querySelector('.bg__motes'); if (!host) return;
    var N = reduce ? 12 : (window.innerWidth < 640 ? 20 : 38);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < N; i++) {
      var m = document.createElement('span');
      m.className = 'bg__mote' + (Math.random() < 0.22 ? ' lg' : '') + (Math.random() < 0.16 ? ' pkt' : '');
      var dur = 14 + Math.random() * 22;
      m.style.left = (Math.random() * 100) + 'vw';
      m.style.setProperty('--dx', (Math.random() * 120 - 60) + 'px');
      m.style.setProperty('--dy', '-' + (90 + Math.random() * 60) + 'vh');
      if (reduce) { m.style.top = (Math.random() * 100) + 'vh'; m.style.opacity = '.4'; m.style.animation = 'none'; }
      else { m.style.top = (60 + Math.random() * 55) + 'vh'; m.style.animationDuration = dur + 's'; m.style.animationDelay = '-' + (Math.random() * dur) + 's'; }
      frag.appendChild(m);
    }
    host.appendChild(frag);
  }

  // ---- EXPLAINER + DIAGRAM KIT (visuals wave 2026-06-14) ----------------------
  // kdef: inline definition affordance. Each .kdef term reveals a short plain-
  // language definition on hover AND keyboard focus. Fully accessible (button-
  // semantics, aria-describedby, aria-expanded, Esc to dismiss) and idempotent
  // (data-kdef-wired guard). Fail-open: with JS off, the .kdef__plain parenthetical
  // stays visible inline and the .kdef-tip never appears, so no information is lost.
  function wireKdef() {
    var defs = document.querySelectorAll('.kdef:not([data-kdef-wired])');
    if (!defs.length) return;
    var uid = 0;
    defs.forEach(function (term) {
      var tip = term.nextElementSibling;
      if (!tip || !tip.classList || !tip.classList.contains('kdef-tip')) return;
      term.setAttribute('data-kdef-wired', '1');
      // promote to a real control without changing the tag
      if (!term.hasAttribute('tabindex') && term.tagName !== 'BUTTON' && term.tagName !== 'A') {
        term.setAttribute('tabindex', '0');
      }
      if (!term.hasAttribute('role') && term.tagName !== 'BUTTON') term.setAttribute('role', 'button');
      if (!tip.id) tip.id = 'kdef-tip-' + (++uid);
      term.setAttribute('aria-describedby', tip.id);
      term.setAttribute('aria-expanded', 'false');
      tip.setAttribute('role', 'tooltip');
      // JS is present: hide the no-JS inline parenthetical (it lives only in the tip now)
      var plain = term.querySelector('.kdef__plain');
      if (plain) plain.hidden = true;

      var open = function () { term.setAttribute('aria-expanded', 'true'); };
      var close = function () { term.setAttribute('aria-expanded', 'false'); };
      term.addEventListener('mouseenter', open);
      term.addEventListener('mouseleave', close);
      term.addEventListener('focus', open);
      term.addEventListener('blur', close);
      term.addEventListener('click', function (e) {
        e.preventDefault();
        if (term.getAttribute('aria-expanded') === 'true') close(); else open();
      });
      term.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { close(); term.blur(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault();
          if (term.getAttribute('aria-expanded') === 'true') close(); else open(); }
      });
    });
  }

  function init() { wireBackdrop(); syncThemeColor(); wireReveal(); wireNav(); wirePointerLight(); wireField(); wireCount(); wireKdef(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
