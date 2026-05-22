/* w605.js — homepage interaction layer. Calm, opt-in, accessibility-first.
   - Cursor-reactive orb (CSS custom prop on .w605-hero, RAF-lerped).
   - Magnetic primary CTAs (lerp 0.22, max 9px offset).
   - 3D-tilt on hero showcase (max 3deg).
   All effects gate on (hover: hover) AND (pointer: fine) AND no prefers-reduced-motion. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var reduce = false, fine = false;
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch (_) {}

  function lerp(a, b, t) { return a + (b - a) * t; }

  // 1. Cursor-reactive orb on hero
  function initOrb() {
    if (reduce || !fine) return;
    var hero = document.querySelector('.w605-hero');
    if (!hero) return;
    var tx = 50, ty = 38, x = tx, y = ty, ticking = false;
    function loop() {
      x = lerp(x, tx, 0.14);
      y = lerp(y, ty, 0.14);
      hero.style.setProperty('--mx', x.toFixed(2) + '%');
      hero.style.setProperty('--my', y.toFixed(2) + '%');
      if (Math.abs(x - tx) > 0.05 || Math.abs(y - ty) > 0.05) {
        requestAnimationFrame(loop);
      } else {
        ticking = false;
      }
    }
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 100;
      ty = ((e.clientY - r.top) / r.height) * 100;
      if (!ticking) { ticking = true; requestAnimationFrame(loop); }
    });
    hero.addEventListener('mouseleave', function () {
      tx = 50; ty = 38;
      if (!ticking) { ticking = true; requestAnimationFrame(loop); }
    });
  }

  // 2. Magnetic CTAs
  function initMagnetic() {
    if (reduce || !fine) return;
    var els = document.querySelectorAll('.w605-magnetic');
    els.forEach(function (el) {
      var tx = 0, ty = 0, x = 0, y = 0, ticking = false;
      var STRENGTH = 0.22, MAX = 9;
      function loop() {
        x = lerp(x, tx, 0.22);
        y = lerp(y, ty, 0.22);
        el.style.setProperty('--w605-mag-x', x.toFixed(2) + 'px');
        el.style.setProperty('--w605-mag-y', y.toFixed(2) + 'px');
        if (Math.abs(x - tx) > 0.05 || Math.abs(y - ty) > 0.05) {
          requestAnimationFrame(loop);
        } else {
          ticking = false;
        }
      }
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        tx = Math.max(-MAX, Math.min(MAX, (e.clientX - cx) * STRENGTH));
        ty = Math.max(-MAX, Math.min(MAX, (e.clientY - cy) * STRENGTH));
        if (!ticking) { ticking = true; requestAnimationFrame(loop); }
      });
      el.addEventListener('mouseleave', function () {
        tx = 0; ty = 0;
        if (!ticking) { ticking = true; requestAnimationFrame(loop); }
      });
    });
  }

  // 3. 3D tilt on hero showcase
  function initTilt() {
    if (reduce || !fine) return;
    var els = document.querySelectorAll('.w605-tilt');
    els.forEach(function (el) {
      var tx = 0, ty = 0, x = 0, y = 0, ticking = false;
      var MAX = 3;
      function apply() {
        x = lerp(x, tx, 0.18);
        y = lerp(y, ty, 0.18);
        el.style.transform = 'perspective(900px) rotateX(' + (-y).toFixed(2) + 'deg) rotateY(' + x.toFixed(2) + 'deg)';
        if (Math.abs(x - tx) > 0.02 || Math.abs(y - ty) > 0.02) {
          requestAnimationFrame(apply);
        } else {
          ticking = false;
        }
      }
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        tx = ((e.clientX - cx) / (r.width / 2)) * MAX;
        ty = ((e.clientY - cy) / (r.height / 2)) * MAX;
        if (!ticking) { ticking = true; requestAnimationFrame(apply); }
      });
      el.addEventListener('mouseleave', function () {
        tx = 0; ty = 0;
        if (!ticking) { ticking = true; requestAnimationFrame(apply); }
      });
    });
  }

  function boot() {
    try { initOrb(); } catch (_) {}
    try { initMagnetic(); } catch (_) {}
    try { initTilt(); } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
