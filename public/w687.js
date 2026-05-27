// Two effects, both gated on prefers-reduced-motion: no-preference AND pointer: fine
//   1. Mount fade-up on .kolm-hero-terminal via IntersectionObserver (one-shot).
//   2. Subtle pointer-tracking parallax (~3px max) on .ks-hero__bg.
// Total: <2KB minified. No deps. Idempotent — safe to load on every page.
(function () {
 'use strict';
 if (typeof window === 'undefined' || typeof document === 'undefined') return;

 var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: no-preference) and (pointer: fine)') : null;
 if (!mq || !mq.matches) return;

 var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
   if (e.isIntersecting) {
    e.target.classList.add('w687-mounted');
    io.unobserve(e.target);
   }
  });
 }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 }) : null;

 function init() {
  // mount-fade-up: hero terminal + .ks-hero h1
  var terms = document.querySelectorAll('.kolm-hero-terminal, .ks-hero__h1, .ks-lede.hero-quant');
  if (io) {
   terms.forEach(function (t) {
    t.classList.add('w687-init');
    io.observe(t);
   });
  } else {
   terms.forEach(function (t) { t.classList.add('w687-mounted'); });
  }

  // pointer parallax on .ks-hero__bg (~3px max)
  var bg = document.querySelector('.ks-hero__bg');
  var hero = document.querySelector('.ks-hero');
  if (!bg || !hero) return;
  var rect = null;
  var rafId = 0;
  var tx = 0, ty = 0;
  function onMove(ev) {
   if (rafId) return;
   rafId = requestAnimationFrame(function () {
    rafId = 0;
    if (!rect) rect = hero.getBoundingClientRect();
    var cx = (ev.clientX - rect.left) / rect.width - 0.5;
    var cy = (ev.clientY - rect.top) / rect.height - 0.5;
    tx = cx * 6;
    ty = cy * 4;
    bg.style.transform = 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0)';
   });
  }
  function onLeave() {
   if (rafId) cancelAnimationFrame(rafId);
   rafId = 0;
   bg.style.transform = '';
   rect = null;
  }
  function onResize() { rect = null; }
  hero.addEventListener('pointermove', onMove, { passive: true });
  hero.addEventListener('pointerleave', onLeave, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
 }

 if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
 } else {
  init();
 }
})();
