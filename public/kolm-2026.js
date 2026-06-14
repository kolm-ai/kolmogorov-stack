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
    });
  }

  // ---- nav CTA fill: ghost while the hero is in view, solid green once it scrolls
  // past (and solid on pages with no hero), so exactly one green action is in view. ----
  function wireNavCta() {
    var cta = document.querySelector('.nav__cta');
    if (!cta) return;
    if (document.body && document.body.classList.contains('compiler-site--paper')) {
      cta.classList.add('is-solid');
      return;
    }
    var hero = document.querySelector('.hero');
    if (!hero || !('IntersectionObserver' in window)) { cta.classList.add('is-solid'); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) cta.classList.remove('is-solid');
        else cta.classList.add('is-solid');
      });
    }, { threshold: 0 });
    io.observe(hero);
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

  function init() { syncThemeColor(); wireReveal(); wireNav(); wireNavCta(); wirePointerLight(); wireCount(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
