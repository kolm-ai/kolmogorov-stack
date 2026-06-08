// kolm-2026.js - shared page behavior for the rebuild. Load with `defer`.
// The pre-paint theme bootstrap stays inline in each <head> (it must run before
// first paint to avoid a flash); everything non-critical lives here so the 2026
// pages don't each re-declare it.
//
//   <script>(function(){try{if(localStorage.getItem('kolm-2026-theme')==='light')
//     document.documentElement.setAttribute('data-theme','light');}catch(e){}})();</script>
//   <script defer src="/kolm-2026.js"></script>

(function () {
  'use strict';

  // ---- theme toggle (dark canonical; light is the opt-in) ----
  function wireToggle() {
    var btn = document.getElementById('themeToggle') || document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      try {
        if (light) {
          document.documentElement.removeAttribute('data-theme');
          localStorage.setItem('kolm-2026-theme', 'dark');
        } else {
          document.documentElement.setAttribute('data-theme', 'light');
          localStorage.setItem('kolm-2026-theme', 'light');
        }
      } catch (e) {}
    });
  }

  // ---- reveal-on-scroll (gated by prefers-reduced-motion via the CSS rule) ----
  function wireReveal() {
    // Signal that the reveal observer initialized - the inline head failsafe keys
    // off this to tell "observer ran" from "script never loaded" (so it can fail
    // open without falsely disabling the animation when reveals are below the fold).
    document.documentElement.setAttribute('data-reveal-armed', '1');
    var els = document.querySelectorAll('.reveal');
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
  }

  // ---- nav CTA fill: ghost while the hero is in view, solid green once it scrolls
  // past (and solid on pages with no hero), so exactly one green action is in view. ----
  function wireNavCta() {
    var cta = document.querySelector('.nav__cta');
    if (!cta) return;
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

  function init() { wireToggle(); wireReveal(); wireNav(); wireNavCta(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
