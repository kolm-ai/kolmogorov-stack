
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var reduce =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine =
    window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- 1. cursor-reactive ambient hero orb ----------
     Writes --mx/--my custom properties on .w604-hero so the CSS
     radial-gradient tracks the cursor. lerp for smooth follow, RAF for
     frame-locked updates, single listener per page. */
  function initHeroOrb() {
    if (reduce || !fine) return;
    var hero = document.querySelector('.w604-hero');
    if (!hero) return;

    var targetX = 50, targetY = 40;
    var currentX = 50, currentY = 40;
    var raf = 0;

    function onMove(e) {
      var rect = hero.getBoundingClientRect();
      var x = ((e.clientX - rect.left) / rect.width) * 100;
      var y = ((e.clientY - rect.top) / rect.height) * 100;
      targetX = Math.max(0, Math.min(100, x));
      targetY = Math.max(0, Math.min(100, y));
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function onLeave() {
      targetX = 50; targetY = 40;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick() {
      currentX += (targetX - currentX) * 0.14;
      currentY += (targetY - currentY) * 0.14;
      hero.style.setProperty('--mx', currentX.toFixed(2) + '%');
      hero.style.setProperty('--my', currentY.toFixed(2) + '%');
      if (Math.abs(targetX - currentX) > 0.2 || Math.abs(targetY - currentY) > 0.2) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    }

    hero.addEventListener('mousemove', onMove, { passive: true });
    hero.addEventListener('mouseleave', onLeave, { passive: true });
  }

  /* ---------- 2. magnetic CTAs ----------
     Subtle pull toward cursor while hovered inside expanded hit area.
     Max translation 8px, lerp on enter and release. Buttons keep their
     own hover background style; this only adds the translate. */
  function initMagneticButtons() {
    if (reduce || !fine) return;
    var els = document.querySelectorAll('.w604-magnetic');
    if (!els.length) return;
    els.forEach(function (el) {
      var bounds = null;
      var raf = 0;
      var tx = 0, ty = 0, cx = 0, cy = 0;
      var strength = 0.22;        // 0.22 = up to ~8px pull at full extension
      var maxOffset = 9;
      function pickBounds() { bounds = el.getBoundingClientRect(); }
      function loop() {
        cx += (tx - cx) * 0.22;
        cy += (ty - cy) * 0.22;
        el.style.setProperty('--w604-mag-x', cx.toFixed(2) + 'px');
        el.style.setProperty('--w604-mag-y', cy.toFixed(2) + 'px');
        if (Math.abs(tx - cx) > 0.1 || Math.abs(ty - cy) > 0.1) {
          raf = requestAnimationFrame(loop);
        } else {
          raf = 0;
        }
      }
      el.addEventListener('mouseenter', function () {
        pickBounds();
      });
      el.addEventListener('mousemove', function (e) {
        if (!bounds) pickBounds();
        var dx = (e.clientX - (bounds.left + bounds.width / 2)) * strength;
        var dy = (e.clientY - (bounds.top + bounds.height / 2)) * strength;
        tx = Math.max(-maxOffset, Math.min(maxOffset, dx));
        ty = Math.max(-maxOffset, Math.min(maxOffset, dy));
        if (!raf) raf = requestAnimationFrame(loop);
      });
      el.addEventListener('mouseleave', function () {
        tx = 0; ty = 0;
        if (!raf) raf = requestAnimationFrame(loop);
      });
      window.addEventListener('resize', function () { bounds = null; }, { passive: true });
    });
  }

  /* ---------- 3. 3D-tilt cards (vanilla-tilt minimal) ----------
     For elements marked .w604-tilt. Max rotation 3deg so the card stays
     trustworthy not toy-like. */
  function initTiltCards() {
    if (reduce || !fine) return;
    var els = document.querySelectorAll('.w604-tilt');
    if (!els.length) return;
    els.forEach(function (el) {
      var bounds = null;
      var raf = 0;
      var rxT = 0, ryT = 0, rxC = 0, ryC = 0;
      var maxDeg = 3;
      function pickBounds() { bounds = el.getBoundingClientRect(); }
      function loop() {
        rxC += (rxT - rxC) * 0.18;
        ryC += (ryT - ryC) * 0.18;
        el.style.transform =
          'perspective(900px) rotateX(' + rxC.toFixed(2) + 'deg) rotateY(' + ryC.toFixed(2) + 'deg)';
        if (Math.abs(rxT - rxC) > 0.05 || Math.abs(ryT - ryC) > 0.05) {
          raf = requestAnimationFrame(loop);
        } else {
          raf = 0;
        }
      }
      el.addEventListener('mouseenter', pickBounds);
      el.addEventListener('mousemove', function (e) {
        if (!bounds) pickBounds();
        var px = (e.clientX - bounds.left) / bounds.width;
        var py = (e.clientY - bounds.top) / bounds.height;
        ryT = (px - 0.5) * (maxDeg * 2);
        rxT = -(py - 0.5) * (maxDeg * 2);
        if (!raf) raf = requestAnimationFrame(loop);
      });
      el.addEventListener('mouseleave', function () {
        rxT = 0; ryT = 0;
        if (!raf) raf = requestAnimationFrame(loop);
      });
      window.addEventListener('resize', function () { bounds = null; }, { passive: true });
    });
  }

  function boot() {
    try { initHeroOrb(); } catch (e) {}
    try { initMagneticButtons(); } catch (e) {}
    try { initTiltCards(); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
